import { ensureOffline } from "./downloads.js";
import { msg, tr, type Lang, type Text } from "./i18n.js";
import * as library from "./library.js";
import { mergeLibraries } from "./syncMerge.js";
import { HttpError, type Library } from "./types.js";

// No Node-only imports here: the Android app runs this same module, with its own storage and fetch.

/**
 * Keeps the library the same on every device through a secret GitHub gist: playlists, favorites, history and what
 * is kept downloaded. Each device pulls the gist, merges it with its own library (syncMerge.ts) and pushes the result.
 * One GitHub token, pasted on each device, is all the setup: the devices find the same gist through it.
 */

/** Small named files: the token and gist id, and the last library the devices agreed on. */
export interface SyncStorage {
  read(name: string): Promise<string | null>;
  write(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
}

interface SyncConfig {
  token: string;
  gistId: string;
  login: string;
}

export interface SyncStatus {
  connected: boolean;
  login: string | null;
  gistUrl: string | null;
  lastSync: number | null;
  syncing: boolean;
  error: string | null;
  /** Goes up whenever changes from another device land here, so the app knows to reload. */
  revision: number;
}

const GIST_FILE = "musike-sync.json";
const CONFIG = "sync.json";
const BASE = "sync-base.json";
const EVERY_MS = 2 * 60_000;
const AFTER_CHANGE_MS = 4000;

let storage: SyncStorage | null = null;
let doFetch: typeof fetch = (...args) => fetch(...args);
let api = "https://api.github.com";
let config: SyncConfig | null | undefined;
let lastSync: number | null = null;
let lastError: Text | null = null;
let revision = 0;
let running: Promise<void> | null = null;
let again = false;
/** Set while this module writes the library, so its own write doesn't ask for another sync. */
let applying = false;
let changeTimer: ReturnType<typeof setTimeout> | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;
let unsubscribe: (() => void) | null = null;

export function useSync(options: { storage: SyncStorage; fetch?: typeof fetch; api?: string }) {
  storage = options.storage;
  if (options.fetch) doFetch = options.fetch;
  if (options.api) api = options.api.replace(/\/$/, "");
  config = undefined;
  lastSync = null;
  lastError = null;
}

async function readConfig(): Promise<SyncConfig | null> {
  if (config !== undefined) return config;
  try {
    const c = JSON.parse((await storage!.read(CONFIG)) ?? "null") as Partial<SyncConfig> | null;
    config = c && typeof c.token === "string" && typeof c.gistId === "string" ? { token: c.token, gistId: c.gistId, login: c.login ?? "" } : null;
  } catch {
    config = null;
  }
  return config;
}

const unref = (t: unknown) => (t as { unref?: () => void } | undefined)?.unref?.();

/** GitHub's API, with this device's token. Errors become messages a person can act on. */
async function gh<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await doFetch(path.startsWith("https://") ? path : api + path, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new HttpError(503, msg("syncOffline"));
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(401, msg("syncBadToken"));
  if (!res.ok) throw new HttpError(502, msg("syncFailed", { status: res.status }));
  return (await res.json()) as T;
}

interface Gist {
  id: string;
  html_url: string;
  updated_at: string;
  history?: { version: string }[];
  files: Record<string, { content?: string; truncated?: boolean; raw_url?: string } | null>;
}

const versionOf = (g: Gist) => g.history?.[0]?.version ?? g.updated_at;

async function findOrCreateGist(token: string, library: Library): Promise<Gist> {
  for (let page = 1; page <= 10; page++) {
    const list = await gh<Gist[]>(token, `/gists?per_page=100&page=${page}`);
    const mine = list.find((g) => g.files && GIST_FILE in g.files);
    if (mine) return mine;
    if (list.length < 100) break;
  }
  return gh<Gist>(token, "/gists", {
    method: "POST",
    body: { description: "Musike library sync (managed by the app)", public: false, files: { [GIST_FILE]: { content: docOf(library) } } },
  });
}

const docOf = (library: Library) => JSON.stringify({ format: "musike-sync", version: 1, updatedAt: new Date().toISOString(), library });

async function readGist(c: SyncConfig): Promise<{ library: Library | null; version: string; url: string }> {
  const g = await gh<Gist>(c.token, `/gists/${c.gistId}`);
  const file = g.files[GIST_FILE];
  let text = file?.content ?? "";
  // Big libraries come cut in the gist's answer; the whole file is at its raw address.
  if (file?.truncated && file.raw_url) {
    try {
      const raw = await doFetch(file.raw_url, { headers: { authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(20_000) });
      if (raw.ok) text = await raw.text();
    } catch {
      throw new HttpError(503, msg("syncOffline"));
    }
  }
  let lib: Library | null = null;
  try {
    const doc = JSON.parse(text) as { format?: unknown; library?: unknown };
    if (doc.format === "musike-sync") lib = library.cleanLibrary(doc.library);
  } catch {
    // empty or damaged: this device's library becomes the gist's
  }
  return { library: lib, version: versionOf(g), url: g.html_url };
}

async function readBase(): Promise<Library | null> {
  try {
    const text = await storage!.read(BASE);
    return text ? library.cleanLibrary(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function syncOnce(c: SyncConfig) {
  await ensureOffline();
  for (let attempt = 0; attempt < 3; attempt++) {
    const remote = await readGist(c);
    const local = library.cleanLibrary(await library.getLibrary());
    const base = await readBase();
    const merged = remote.library ? mergeLibraries(base, local, remote.library) : local;

    if (!same(merged, local)) {
      applying = true;
      try {
        await library.replaceLibrary(merged);
      } finally {
        applying = false;
      }
      revision++;
    }
    if (!remote.library || !same(merged, remote.library)) {
      // Another device may have pushed while this one merged: then merge again with that.
      const now = await gh<Gist>(c.token, `/gists/${c.gistId}`);
      if (versionOf(now) !== remote.version) continue;
      await gh(c.token, `/gists/${c.gistId}`, { method: "PATCH", body: { files: { [GIST_FILE]: { content: docOf(merged) } } } });
    }
    await storage!.write(BASE, JSON.stringify(merged));
    return;
  }
}

/** Syncs now (or, if a sync is already running, once more right after it). */
export function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      const c = await readConfig();
      if (!c) return;
      try {
        await syncOnce(c);
        lastSync = Date.now();
        lastError = null;
      } catch (err) {
        lastError = err instanceof HttpError ? err.text : (err as Error).message || msg("syncFailed", { status: "?" });
      }
    } while (again);
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Links this device to the user's GitHub with a token, finds (or makes) the shared gist and syncs. */
export async function connect(token: unknown): Promise<void> {
  const t = typeof token === "string" ? token.trim() : "";
  if (!t || t.length > 300 || /\s/.test(t)) throw new HttpError(400, msg("syncNoToken"));
  const user = await gh<{ login: string }>(t, "/user");
  await ensureOffline();
  const gist = await findOrCreateGist(t, library.cleanLibrary(await library.getLibrary()));
  const c: SyncConfig = { token: t, gistId: gist.id, login: user.login };
  await storage!.write(CONFIG, JSON.stringify(c));
  // A new link starts without a base: the first sync puts the two libraries together and removes nothing.
  await storage!.remove(BASE).catch(() => {});
  config = c;
  lastError = null;
  await syncNow();
}

/** Unlinks this device. The gist stays on GitHub, for the other devices. */
export async function disconnect(): Promise<void> {
  await storage!.remove(CONFIG).catch(() => {});
  await storage!.remove(BASE).catch(() => {});
  config = null;
  lastSync = null;
  lastError = null;
}

export async function syncStatus(lang: Lang): Promise<SyncStatus> {
  const c = await readConfig();
  return {
    connected: !!c,
    login: c?.login || null,
    gistUrl: c ? `https://gist.github.com/${c.gistId}` : null,
    lastSync,
    syncing: !!running,
    error: lastError === null ? null : tr(lang, lastError),
    revision,
  };
}

/** Syncs at start, a few seconds after each change, every couple of minutes, and when asked to. */
export function startAutoSync() {
  unsubscribe?.();
  unsubscribe = library.onLibraryChange(() => {
    if (applying) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => void syncNow(), AFTER_CHANGE_MS);
    unref(changeTimer);
  });
  clearInterval(ticker);
  ticker = setInterval(() => void syncNow(), EVERY_MS);
  unref(ticker);
  const first = setTimeout(() => void syncNow(), 1000);
  unref(first);
}

export function stopAutoSync() {
  unsubscribe?.();
  unsubscribe = null;
  clearInterval(ticker);
  clearTimeout(changeTimer);
}
