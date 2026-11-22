import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Updates from the app on Windows: the web app finds a newer release on GitHub and asks for it here. The installer
 * is downloaded, checked against the size and SHA-256 GitHub lists for it, and run silently over this install; it
 * starts Musike again when it's done.
 */

/** Only installers from this fork's releases are downloaded and run. */
export const RELEASES = "https://github.com/Safoueenmarcoo/musike/releases/download/";

export interface UpdateRequest {
  url: string;
  version: string;
  size: number;
  sha256?: string;
}

export function validRequest(value: unknown): value is UpdateRequest {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.url === "string" &&
    r.url.startsWith(RELEASES) &&
    !r.url.includes("..") &&
    typeof r.version === "string" &&
    /^\d+\.\d+\.\d+$/.test(r.version) &&
    typeof r.size === "number" &&
    Number.isSafeInteger(r.size) &&
    r.size > 0 &&
    (r.sha256 === undefined || (typeof r.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.sha256)))
  );
}

type Fetch = (url: string) => Promise<Response>;

/** Downloads the installer into `dir` and returns its path. `progress` gets a fraction between 0 and 1. */
export async function downloadUpdate(req: UpdateRequest, dir: string, fetchFn: Fetch, progress: (fraction: number) => void): Promise<string> {
  await mkdir(dir, { recursive: true });
  // Installers from earlier updates.
  for (const name of await readdir(dir)) await rm(path.join(dir, name), { force: true, recursive: true });

  const file = path.join(dir, `Musike-Setup-${req.version}.exe`);
  const part = `${file}.part`;
  const res = await fetchFn(req.url);
  if (!res.ok || !res.body) throw new Error(`GitHub answered ${res.status}`);

  const hash = createHash("sha256");
  const out = createWriteStream(part);
  let received = 0;
  let reported = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      received += chunk.length;
      if (received > req.size) throw new Error("The download is bigger than the release says");
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
      const now = Date.now();
      if (now - reported > 200) {
        reported = now;
        progress(received / req.size);
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    if (received !== req.size) throw new Error("The download stopped before the end");
    if (req.sha256 && hash.digest("hex") !== req.sha256) throw new Error("The downloaded file doesn't match the release");
  } catch (err) {
    out.destroy();
    await rm(part, { force: true });
    throw err;
  }
  await rename(part, file);
  progress(1);
  return file;
}

/**
 * Runs the installer the way electron-updater does: silently (/S), as an update (--updated keeps the install folder
 * and shortcuts) and starting Musike again afterwards (--force-run). It waits for this app to close.
 */
export function runInstaller(file: string): void {
  spawn(file, ["--updated", "/S", "--force-run"], { detached: true, stdio: "ignore" }).unref();
}
