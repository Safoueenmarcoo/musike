import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { handleLanPoll } from "./connect.js";

/**
 * The desktop app's door for the other devices on the same network (remote playback, connect.ts): one route, which
 * only answers messages sealed with the devices' shared key. Everything else gets a 404, and the rest of the Musike
 * server stays on 127.0.0.1.
 */

let server: Server | null = null;
let port = 0;

/** Where this computer can be reached on the local network. */
export function lanUrls(): string[] {
  if (!port) return [];
  // Bound to one address (tests): that is the only way in.
  const only = process.env.MUSIKE_CONNECT_HOST;
  if (only && only !== "0.0.0.0") return [`http://${only}:${port}`];
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254."))
    .map((i) => `http://${i!.address}:${port}`)
    .slice(0, 6);
}

export async function startLanHost(preferred = Number(process.env.MUSIKE_CONNECT_PORT ?? 4285)): Promise<number> {
  if (server) return port;
  const s = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/musike-connect") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 512 * 1024) req.destroy();
    });
    req.on("end", async () => {
      let reply: { msgs: string[] } | null = null;
      try {
        reply = await handleLanPoll(JSON.parse(body));
      } catch {
        reply = null;
      }
      if (!reply) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(reply));
    });
  });
  for (let p = preferred; p < preferred + 10; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      s.once("error", () => resolve(false));
      s.listen(p, process.env.MUSIKE_CONNECT_HOST ?? "0.0.0.0", () => resolve(true));
    });
    if (ok) {
      server = s;
      port = p;
      return p;
    }
  }
  return 0; // no free port: devices on the same network go through the relay instead
}

export function stopLanHost() {
  server?.close();
  server = null;
  port = 0;
}
