import { msg, tr, type Lang, type Text } from "./i18n.js";
import * as library from "./library.js";
import { sanitizeTrack } from "./library.js";
import { HttpError, type Library, type Offline, type Track } from "./types.js";

// No Node-only imports here: the Android app runs this same module, with its own storage (like library.ts).

/** A song saved for offline listening. */
export interface DownloadEntry {
  track: Track;
  /** Audio file name inside the downloads folder. */
  file: string;
  mime: string;
  size: number;
  /** Cover image file name, when one could be saved. */
  cover: string | null;
  addedAt: number;
}

export interface StoredAudio {
  file: string;
  mime: string;
  size: number;
}

/**
 * Where downloads are kept and how they get there: plain files fetched through yt-dlp's stream on the server and the
 * desktop app (downloadsFile.ts), the app's own storage on Android (web/src/native/downloads.ts).
 */
export interface DownloadsBackend {
  readIndex(): Promise<string | null>;
  writeIndex(json: string): Promise<void>;
  /** Names and sizes of the files kept. Called once, at startup: leftovers of interrupted downloads can be cleared. */
  list(): Promise<Map<string, number>>;
  /** Saves a track's audio, reporting bytes as they arrive. Rejects with an AbortError when `signal` fires. */
  saveAudio(id: string, onProgress: (received: number, total: number) => void, signal: AbortSignal): Promise<StoredAudio>;
  /** Saves the first of `urls` that loads. Null when none does: the song still plays, with no cover offline. */
  saveCover(id: string, urls: string[], signal: AbortSignal): Promise<string | null>;
  remove(files: string[]): Promise<void>;
}

interface Job {
  track: Track;
  status: "queued" | "downloading" | "error";
  received: number;
  total: number;
  error?: Text;
  abort?: AbortController;
}

/**
 * What the app shows: saved songs (newest first), downloads under way, the space they take, and which collections
 * are kept downloaded (their new songs download by themselves).
 */
export interface DownloadsSnapshot {
  items: { track: Track; size: number; addedAt: number; cover: boolean }[];
  jobs: { track: Track; status: Job["status"]; received: number; total: number; error?: string }[];
  bytes: number;
  offline: { favorites: boolean; playlists: string[] };
}

/** Two at a time: quick enough for a playlist, gentle on YouTube and on a slow connection. */
const MAX_ACTIVE = 2;
const MAX_PER_REQUEST = 500;

let backend: DownloadsBackend | null = null;
let entries: DownloadEntry[] | null = null;
let loading: Promise<DownloadEntry[]> | null = null;
let writeChain: Promise<void> = Promise.resolve();
/** Insertion order is the queue order. Failed jobs stay until retried or dismissed. */
const jobs = new Map<string, Job>();
let active = 0;
/** Failed downloads the person dismissed: not tried again by themselves until asked. */
const dismissed = new Set<string>();
let unsubscribe: (() => void) | null = null;

/**
 * Set once at startup, before any request. From then on the downloads follow the library: whatever it says to keep
 * offline is downloaded, whatever it no longer does is removed.
 */
export function useDownloadsBackend(b: DownloadsBackend) {
  for (const job of jobs.values()) job.abort?.abort();
  jobs.clear();
  dismissed.clear();
  active = 0;
  backend = b;
  entries = null;
  loading = null;
  unsubscribe?.();
  unsubscribe = library.onLibraryChange(() => scheduleReconcile());
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** The saved index, checked against the files really there: a download only counts while its audio exists. */
async function read(b: DownloadsBackend): Promise<DownloadEntry[]> {
  const files = await b.list().catch(() => new Map<string, number>());
  let stored: unknown[] | null = null;
  try {
    const json = await b.readIndex();
    const parsed = json ? (JSON.parse(json) as { entries?: unknown }) : { entries: [] };
    if (Array.isArray(parsed.entries)) stored = parsed.entries;
  } catch {
    // unreadable index: start over, but leave the files alone (see below)
  }
  const kept: DownloadEntry[] = [];
  const seen = new Set<string>();
  for (const raw of stored ?? []) {
    try {
      const e = (raw ?? {}) as Record<string, unknown>;
      const track = sanitizeTrack(e.track);
      const file = str(e.file);
      const size = files.get(file);
      if (!file || size === undefined || seen.has(track.id)) continue;
      seen.add(track.id);
      const cover = str(e.cover);
      kept.push({
        track,
        file,
        mime: str(e.mime) || "audio/mp4",
        size,
        cover: cover && files.has(cover) ? cover : null,
        addedAt: typeof e.addedAt === "number" && Number.isFinite(e.addedAt) ? e.addedAt : Date.now(),
      });
    } catch {
      // skip an invalid entry instead of losing the whole list
    }
  }
  // Files the index doesn't know (a crash between saving a song and recording it) would only waste space.
  // Only when the index itself was readable: otherwise every song would look like a stray.
  if (stored) {
    const known = new Set(kept.flatMap((e) => (e.cover ? [e.file, e.cover] : [e.file])));
    const strays = [...files.keys()].filter((name) => !known.has(name));
    if (strays.length) await b.remove(strays).catch(() => {});
  }
  return kept;
}

function load(): Promise<DownloadEntry[]> {
  if (entries) return Promise.resolve(entries);
  if (!backend) return Promise.reject(new Error("Downloads storage not configured"));
  const b = backend;
  loading ??= read(b).then((list) => {
    // A backend swapped in meanwhile (tests) starts its own load.
    if (backend === b) entries = list;
    return list;
  });
  return loading;
}

/** Serialized writes so concurrent downloads never interleave. A failed write doesn't block the next one. */
function persist(): Promise<void> {
  const snapshot = JSON.stringify({ version: 1, entries }, null, 2);
  const b = backend!;
  writeChain = writeChain.catch(() => {}).then(() => b.writeIndex(snapshot));
  return writeChain;
}

function present(list: DownloadEntry[], lang: Lang, lib: Library): DownloadsSnapshot {
  return {
    offline: { favorites: !!lib.offline?.favorites, playlists: lib.offline?.playlists ?? [] },
    items: list.map((e) => ({ track: e.track, size: e.size, addedAt: e.addedAt, cover: !!e.cover })),
    jobs: [...jobs.values()].map((j) => ({
      track: j.track,
      status: j.status,
      received: j.received,
      total: j.total,
      error: j.error === undefined ? undefined : tr(lang, j.error),
    })),
    bytes: list.reduce((sum, e) => sum + e.size, 0),
  };
}

export async function getDownloads(lang: Lang = "en"): Promise<DownloadsSnapshot> {
  const list = await load();
  return present(list, lang, await library.getLibrary());
}

/**
 * Libraries from before 1.7 say nothing about what to keep offline: the songs already downloaded are what to keep.
 * Runs before anything reads the list (downloads, sync), so nothing already saved is mistaken for unwanted.
 */
export async function ensureOffline(): Promise<Offline> {
  const lib = await library.getLibrary();
  if (lib.offline) return lib.offline;
  const kept = backend ? (await load()).map((e) => e.track) : [];
  const waiting = [...jobs.values()].map((j) => j.track).filter((t) => !kept.some((k) => k.id === t.id));
  return library.changeOffline({}, { favorites: false, playlists: [], tracks: [...kept, ...waiting] });
}

/** Every song the library says to keep downloaded, by id. */
function wantedBy(lib: Library): Map<string, Track> {
  const wanted = new Map<string, Track>();
  const o = lib.offline;
  if (!o) return wanted;
  const add = (t: Track) => wanted.has(t.id) || wanted.set(t.id, t);
  if (o.favorites) lib.favorites.forEach(add);
  for (const p of lib.playlists) if (o.playlists.includes(p.id)) p.tracks.forEach(add);
  o.tracks.forEach(add);
  return wanted;
}

let reconcileChain: Promise<void> = Promise.resolve();
let reconcileTimer: ReturnType<typeof setTimeout> | undefined;

/** After a change to the library (a song added to a downloaded playlist, a sync), once things settle. */
function scheduleReconcile() {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => void reconcile().catch(() => {}), 250);
}

/**
 * Makes the files match the library: downloads the wanted songs that are missing, removes the saved ones nobody
 * wants any more and cancels their downloads. Failed downloads are tried again only when `retry` says so (an id, or
 * "all": at startup and when the connection comes back).
 */
export function reconcile(retry: Iterable<string> | "all" = []): Promise<void> {
  const again = retry === "all" ? null : new Set(retry);
  const run = async () => {
    const b = backend;
    if (!b) return;
    await ensureOffline();
    const lib = await library.getLibrary();
    const wanted = wantedBy(lib);
    const list = await load();
    if (backend !== b) return;

    for (const [id, job] of [...jobs]) {
      if (wanted.has(id)) continue;
      jobs.delete(id);
      job.abort?.abort();
    }
    const unwanted = list.filter((e) => !wanted.has(e.track.id));
    if (unwanted.length) {
      entries = list.filter((e) => wanted.has(e.track.id));
      await persist();
      await b.remove(unwanted.flatMap((e) => (e.cover ? [e.file, e.cover] : [e.file]))).catch(() => {});
    }

    const saved = new Set((entries ?? list).map((e) => e.track.id));
    for (const [id, track] of wanted) {
      if (saved.has(id)) continue;
      const retrying = again === null || again.has(id);
      if (retrying) dismissed.delete(id);
      const job = jobs.get(id);
      if (job && (job.status !== "error" || !retrying)) continue;
      if (!job && dismissed.has(id)) continue;
      jobs.delete(id); // a retried one goes to the back of the queue
      jobs.set(id, { track, status: "queued", received: 0, total: 0 });
    }
    for (const id of dismissed) if (!wanted.has(id)) dismissed.delete(id);
    pump();
  };
  reconcileChain = reconcileChain.catch(() => {}).then(run);
  return reconcileChain;
}

const isAbort = (err: unknown) => (err as { name?: string } | null)?.name === "AbortError";

async function run(b: DownloadsBackend, job: Job) {
  const { track } = job;
  const abort = new AbortController();
  job.abort = abort;
  job.status = "downloading";
  job.error = undefined;
  job.received = 0;
  job.total = 0;
  try {
    const audio = await b.saveAudio(
      track.id,
      (received, total) => {
        job.received = received;
        job.total = total;
      },
      abort.signal,
    );
    const cover = await b.saveCover(track.id, [track.art, track.thumb].filter(Boolean), abort.signal).catch(() => null);
    // Cancelled, or the backend replaced, while the last bytes arrived: drop what was saved.
    if (abort.signal.aborted || jobs.get(track.id) !== job || backend !== b) {
      await b.remove(cover ? [audio.file, cover] : [audio.file]).catch(() => {});
      return;
    }
    const list = await load();
    entries = [{ track, ...audio, cover, addedAt: Date.now() }, ...list.filter((e) => e.track.id !== track.id)];
    jobs.delete(track.id);
    await persist();
  } catch (err) {
    if (jobs.get(track.id) !== job) return; // cancelled: already forgotten
    if (isAbort(err) || abort.signal.aborted) {
      jobs.delete(track.id);
      return;
    }
    job.status = "error";
    job.error = err instanceof HttpError ? err.text : (err as Error)?.message || msg("songDownloadFailed");
  } finally {
    job.abort = undefined;
  }
}

function pump() {
  const b = backend;
  if (!b) return;
  for (const job of jobs.values()) {
    if (active >= MAX_ACTIVE) return;
    if (job.status !== "queued") continue;
    active++;
    // Marked before the first await, so the next pass of this loop doesn't pick it again.
    job.status = "downloading";
    void run(b, job).finally(() => {
      if (backend !== b) return;
      active--;
      pump();
    });
  }
}

/** Keeps tracks downloaded (on every synced device). Ones that failed get another try. */
export async function enqueue(input: unknown, lang: Lang = "en"): Promise<DownloadsSnapshot> {
  if (!Array.isArray(input)) throw new HttpError(400, msg("tracksRequired"));
  const tracks = input.slice(0, MAX_PER_REQUEST).map(sanitizeTrack);
  await ensureOffline();
  await library.changeOffline({ addTracks: tracks });
  await reconcile(tracks.map((t) => t.id));
  return getDownloads(lang);
}

/**
 * Stops keeping songs downloaded (or dismisses their failed downloads). Without `ids`, nothing is kept downloaded
 * any more: no collection, no song. A song a downloaded playlist or the favorites still hold stays.
 */
export async function removeDownloads(ids: string[] | null, lang: Lang = "en"): Promise<DownloadsSnapshot> {
  await ensureOffline();
  if (ids) {
    for (const id of ids) {
      const job = jobs.get(id);
      if (job?.status === "error") {
        jobs.delete(id);
        dismissed.add(id);
      }
    }
  }
  await library.changeOffline(ids ? { removeTracks: ids } : { clear: true });
  await reconcile();
  return getDownloads(lang);
}

/** Keeps a whole collection downloaded, or stops: `{ favorites: true }`, `{ playlist: { id, on } }`. */
export async function setOffline(change: library.OfflineChange, lang: Lang = "en"): Promise<DownloadsSnapshot> {
  await ensureOffline();
  await library.changeOffline({ favorites: change.favorites, playlist: change.playlist });
  await reconcile();
  return getDownloads(lang);
}

/** The saved audio for a track, if it was downloaded. */
export async function downloadOf(id: string): Promise<DownloadEntry | null> {
  if (!backend) return null;
  return (await load()).find((e) => e.track.id === id) ?? null;
}

/** Forgets a download whose file is gone (deleted by hand), so the song streams again instead of failing. */
export async function forgetDownload(id: string): Promise<void> {
  const list = await load();
  const entry = list.find((e) => e.track.id === id);
  if (!entry) return;
  entries = list.filter((e) => e.track.id !== id);
  await persist().catch(() => {});
  // Its cover has no song to go with any more.
  if (entry.cover) await backend!.remove([entry.cover]).catch(() => {});
  // Still wanted: it downloads again.
  scheduleReconcile();
}
