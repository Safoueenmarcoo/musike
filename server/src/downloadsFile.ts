import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { DownloadsBackend, StoredAudio } from "./downloads.js";
import { msg } from "./i18n.js";
import { HttpError } from "./types.js";
import { invalidate, resolveStreams, type StreamFormat } from "./ytdlp.js";

/** yt-dlp reads YouTube streams in chunks of about this size too: bigger requests get slowed down. */
const CHUNK = 8 * 1024 * 1024;
/** No bytes for this long means the connection died without saying so. */
const STALL_MS = 30_000;
/** How many times in a row a broken transfer is picked up again without having gained a single byte. */
const RETRIES = 3;
const COVER_MAX = 5 * 1024 * 1024;
/** Covers only come from where YouTube serves them (the track's image URLs are sent by the app). */
const COVER_HOST = /(^|\.)ytimg\.com$|(^|\.)googleusercontent\.com$|(^|\.)ggpht\.com$/;
const INDEX = "index.json";
/** Only files named the way Musike names them are ever listed, and so ever deleted: `<video id>.m4a`, `.webm`, `.jpg`. */
const OWN_FILE = /^[A-Za-z0-9_-]{11}\.(m4a|webm|jpg)$/;

const abortError = () => new DOMException("Aborted", "AbortError");

/** DNS and routing failures: the computer is offline, not YouTube refusing. */
const isOffline = (err: unknown) => {
  const code = ((err as { cause?: { code?: string } } | null)?.cause?.code ?? "").toUpperCase();
  return ["ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH"].includes(code);
};

/** The absolute path of a file kept in the downloads folder. */
export const downloadPath = (name: string, dir = config.downloadsDir) => path.join(dir, path.basename(name));

/**
 * Downloads as files in one folder: `<video id>.m4a` (or .webm), its cover as `<video id>.jpg`, and index.json
 * listing them. The audio is the same stream the player gets, read in chunks straight from YouTube.
 */
export function fileDownloads(dir = config.downloadsDir): DownloadsBackend {
  const at = (name: string) => downloadPath(name, dir);

  async function saveAudio(
    id: string,
    onProgress: (received: number, total: number) => void,
    signal: AbortSignal,
  ): Promise<StoredAudio> {
    if (signal.aborted) throw abortError();
    await mkdir(dir, { recursive: true });
    let fmt: StreamFormat = (await resolveStreams(id)).audio;
    if (signal.aborted) throw abortError();
    const tmp = at(`${id}.part`);
    const handle = await open(tmp, "w");
    let received = 0;
    let total = 0;
    let refreshed = false;
    // A dropped or stalled connection is picked up where it stopped, a few times in a row before giving up.
    let failures = 0;
    let failedAt = -1;

    try {
      for (;;) {
        // Stops the request when nothing arrives for a while; every chunk of data pushes the deadline back.
        const stall = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const alive = () => {
          clearTimeout(timer);
          timer = setTimeout(() => stall.abort(), STALL_MS);
        };
        try {
          alive();
          const last = total ? Math.min(received + CHUNK, total) - 1 : received + CHUNK - 1;
          const res = await fetch(fmt.url, {
            headers: { ...fmt.headers, Range: `bytes=${received}-${last}` },
            signal: AbortSignal.any([signal, stall.signal]),
          });
          // Expired or rejected URL: resolve again once, like the stream proxy does.
          if ((res.status === 403 || res.status === 410) && !refreshed) {
            await res.body?.cancel().catch(() => {});
            refreshed = true;
            invalidate(id);
            fmt = (await resolveStreams(id)).audio;
            continue;
          }
          // Asked past the end of a stream whose size wasn't known: everything is here.
          if (res.status === 416 && received > 0) break;
          if (!res.ok || !res.body) {
            await res.body?.cancel().catch(() => {});
            throw new HttpError(502, msg("streamRefused", { status: res.status }), "maybe_outdated");
          }
          const whole = res.status === 200; // the server ignored Range and is sending the entire file
          if (whole) {
            if (received > 0) await handle.truncate(0);
            received = 0;
            total = Number(res.headers.get("content-length")) || 0;
          } else {
            const size = /\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "")?.[1];
            if (size) total = Number(size);
          }
          const before = received;
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            await handle.write(chunk, 0, chunk.length, received);
            received += chunk.length;
            alive();
            onProgress(received, total);
          }
          if (whole || received === before) break;
          if (total ? received >= total : received - before < CHUNK) break;
        } catch (err) {
          if (signal.aborted) throw abortError();
          if (err instanceof HttpError) throw err;
          if (isOffline(err)) throw new HttpError(503, msg("offline"));
          if ((err as { code?: string } | null)?.code === "ENOSPC") throw new HttpError(507, msg("noSpace"));
          if (received > failedAt) failures = 0;
          failedAt = received;
          if (++failures > RETRIES) throw stall.signal.aborted ? new HttpError(504, msg("downloadIncomplete")) : err;
          await new Promise((resolve) => setTimeout(resolve, 400 * failures));
        } finally {
          clearTimeout(timer);
        }
      }
      await handle.close();
      if (!received || (total && received < total)) throw new HttpError(502, msg("downloadIncomplete"));
      const file = `${id}.${fmt.mime === "audio/webm" ? "webm" : "m4a"}`;
      await rename(tmp, at(file));
      return { file, mime: fmt.mime, size: received };
    } catch (err) {
      await handle.close().catch(() => {});
      await rm(tmp, { force: true }).catch(() => {});
      if (signal.aborted) throw abortError();
      // What fetch says about a broken transfer ("terminated", "fetch failed") means nothing to a person.
      throw err instanceof HttpError ? err : new HttpError(502, msg("downloadIncomplete"));
    }
  }

  async function saveCover(id: string, urls: string[], signal: AbortSignal): Promise<string | null> {
    for (const url of urls) {
      if (signal.aborted) throw abortError();
      try {
        if (!COVER_HOST.test(new URL(url).hostname)) continue;
        const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
        if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) {
          await res.body?.cancel().catch(() => {});
          continue;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (!bytes.length || bytes.length > COVER_MAX) continue;
        const name = `${id}.jpg`;
        await writeFile(at(name), bytes);
        return name;
      } catch {
        // try the next image; a song without a cover still plays
      }
    }
    return null;
  }

  return {
    readIndex: async () => (existsSync(at(INDEX)) ? readFile(at(INDEX), "utf8") : null),
    writeIndex: async (json) => {
      await mkdir(dir, { recursive: true });
      const tmp = at(`${INDEX}.tmp`);
      await writeFile(tmp, json, "utf8");
      await rename(tmp, at(INDEX));
    },
    list: async () => {
      const files = new Map<string, number>();
      if (!existsSync(dir)) return files;
      for (const name of await readdir(dir)) {
        // What an interrupted download left behind.
        if (/^[A-Za-z0-9_-]{11}\.part$/.test(name)) {
          await rm(at(name), { force: true }).catch(() => {});
          continue;
        }
        if (!OWN_FILE.test(name)) continue;
        const info = await stat(at(name)).catch(() => null);
        if (info?.isFile()) files.set(name, info.size);
      }
      return files;
    },
    saveAudio,
    saveCover,
    remove: async (names) => {
      await Promise.all(names.map((name) => rm(at(name), { force: true })));
    },
  };
}
