import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import type { DownloadsBackend, StoredAudio } from "../../../server/src/downloads";
import { msg } from "../../../server/src/i18n";
import { HttpError } from "../../../server/src/types";
import { getT } from "../i18n";
import { forgetUrl, resolveAudio } from "./streams";

/**
 * Downloads on the phone: the job downloadsFile.ts does on a computer. The audio is the same stream the player
 * would get, saved by the app's Android side (MusikeDownloadsPlugin.java) into the app's own storage, where the
 * web view can play it back with no internet. The list of what is saved lives next to the library.
 */

interface DownloadsPlugin {
  folder(): Promise<{ path: string }>;
  files(): Promise<{ files: { name: string; size: number }[] }>;
  save(options: { id: string; url: string; name: string; headers?: Record<string, string> }): Promise<{ size: number }>;
  cancel(options: { id: string }): Promise<void>;
  discard(options: { names: string[] }): Promise<void>;
  addListener(event: "progress", fn: (e: { id: string; received: number; total: number }) => void): Promise<PluginListenerHandle>;
}

const Downloads = registerPlugin<DownloadsPlugin>("MusikeDownloads");

/** Only the Android app keeps songs on the phone for now: iOS has no native side for it yet. */
export const downloadsAvailable = Capacitor.getPlatform() === "android";

const INDEX = "downloads.json";
const INDEX_TMP = "downloads.tmp.json";
const where = { directory: Directory.Data, encoding: Encoding.UTF8 } as const;
/** Covers only come from where YouTube serves them. */
const COVER_HOST = /(^|\.)ytimg\.com$|(^|\.)googleusercontent\.com$|(^|\.)ggpht\.com$/;

let folder = "";
let ready: Promise<void> | null = null;

/** Resolves once the downloads folder is known; from then on `fileUrl` can build addresses. */
export function downloadsReady(): Promise<void> {
  ready ??= Downloads.folder().then(({ path }) => {
    folder = path;
  });
  return ready;
}

/** The address the web view reads a downloaded file from (audio and covers alike). */
export const fileUrl = (name: string): string => Capacitor.convertFileSrc(`${folder}/${name}`);

/** The path on the phone behind such an address, or null for any other URL. */
export function filePathOf(url: string): string | null {
  const prefix = Capacitor.convertFileSrc("/");
  return prefix !== "/" && url.startsWith(prefix) ? url.slice(prefix.length - 1) : null;
}

// One listener for every download: the plugin's progress events carry the id they belong to.
const watchers = new Map<string, (received: number, total: number) => void>();
let listening: Promise<unknown> | null = null;
const listen = () => (listening ??= Downloads.addListener("progress", (e) => watchers.get(e.id)?.(e.received, e.total)));

const abortError = () => new DOMException("Aborted", "AbortError");
const codeOf = (err: unknown) => String((err as { code?: unknown } | null)?.code ?? "");

async function readText(path: string): Promise<string | null> {
  try {
    const { data } = await Filesystem.readFile({ path, ...where });
    return typeof data === "string" ? data : await data.text();
  } catch {
    return null;
  }
}

async function saveAudio(id: string, onProgress: (received: number, total: number) => void, signal: AbortSignal): Promise<StoredAudio> {
  await downloadsReady();
  await listen();
  const cancel = () => void Downloads.cancel({ id }).catch(() => {});
  signal.addEventListener("abort", cancel);
  watchers.set(id, onProgress);
  try {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw abortError();
      if (!navigator.onLine) throw new HttpError(503, msg("offline"));
      const stream = await resolveAudio(id);
      if (signal.aborted) throw abortError();
      const name = `${id}.${stream.mime === "audio/webm" ? "webm" : "m4a"}`;
      try {
        // The same browser the stream was resolved for, as when the player reads it.
        const { size } = await Downloads.save({ id, url: stream.url, name, headers: { "User-Agent": navigator.userAgent } });
        return { file: name, mime: stream.mime, size };
      } catch (err) {
        const code = codeOf(err);
        if (code === "cancelled" || signal.aborted) throw abortError();
        // An address YouTube no longer honours: ask for a fresh one, once.
        if ((code === "http_403" || code === "http_410") && attempt === 0) {
          forgetUrl(stream.url);
          continue;
        }
        if (!navigator.onLine) throw new HttpError(503, msg("offline"));
        if (code.startsWith("http_")) throw new Error(getT().player.streamFailed);
        throw new HttpError(502, msg("downloadIncomplete"));
      }
    }
  } finally {
    watchers.delete(id);
    signal.removeEventListener("abort", cancel);
  }
}

async function saveCover(id: string, urls: string[], signal: AbortSignal): Promise<string | null> {
  await downloadsReady();
  const name = `${id}.jpg`;
  for (const url of urls) {
    if (signal.aborted) throw abortError();
    try {
      if (!COVER_HOST.test(new URL(url).hostname)) continue;
      await Downloads.save({ id: `${id}.cover`, url, name });
      return name;
    } catch {
      // try the next image; a song without a cover still plays
    }
  }
  return null;
}

export const androidDownloads: DownloadsBackend = {
  // Like the library: a temp file first, then swapped in, so a crash mid-write can't leave half a list.
  readIndex: async () => (await readText(INDEX)) ?? (await readText(INDEX_TMP)),
  writeIndex: async (json) => {
    await Filesystem.writeFile({ path: INDEX_TMP, data: json, ...where });
    await Filesystem.deleteFile({ path: INDEX, directory: Directory.Data }).catch(() => {});
    await Filesystem.rename({ from: INDEX_TMP, to: INDEX, directory: Directory.Data, toDirectory: Directory.Data });
  },
  list: async () => new Map((await Downloads.files()).files.map((f) => [f.name, f.size])),
  saveAudio,
  saveCover,
  remove: async (names) => {
    await Downloads.discard({ names });
  },
};
