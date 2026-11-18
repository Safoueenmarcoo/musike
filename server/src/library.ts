import { msg } from "./i18n.js";
import { HttpError, VIDEO_ID, type Library, type Offline, type Playlist, type Track } from "./types.js";

// No Node-only imports here: the Android app runs this same module, with its own storage.

const HISTORY_LIMIT = 60;

/** Where the library is kept: a file on the server and the desktop app, app storage on Android. */
export interface LibraryStorage {
  read(): Promise<string | null>;
  write(json: string): Promise<void>;
}

let storage: LibraryStorage | null = null;
let state: Library | null = null;
let writeChain: Promise<void> = Promise.resolve();
/** Told after every change, once it is saved: downloads follow the library, sync sends it on. */
const listeners = new Set<() => void>();

export function onLibraryChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Set once at startup, before any request. */
export function useLibraryStorage(s: LibraryStorage) {
  storage = s;
  state = null;
}

const randomUUID = () => globalThis.crypto.randomUUID();

async function load(): Promise<Library> {
  if (state) return state;
  if (!storage) throw new Error("Library storage not configured");
  const json = await storage.read();
  state = json ? (JSON.parse(json) as Library) : { favorites: [], playlists: [], history: [] };
  if (state.offline) state.offline = cleanOffline(state.offline, state.playlists);
  return state;
}

/** Serialized writes so concurrent requests never interleave. */
function persist(): Promise<void> {
  const snapshot = JSON.stringify(state, null, 2);
  writeChain = writeChain.catch(() => {}).then(() => storage!.write(snapshot));
  const saved = writeChain;
  void saved.then(() => listeners.forEach((fn) => fn()), () => {});
  return saved;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

export function sanitizeTrack(input: unknown): Track {
  const t = (input ?? {}) as Record<string, unknown>;
  const id = str(t.id, 11);
  if (!VIDEO_ID.test(id)) throw new HttpError(400, msg("invalidTrack"));
  const url = (v: unknown) => {
    const s = str(v, 500);
    return /^https:\/\//.test(s) ? s : "";
  };
  return {
    id,
    title: str(t.title, 300) || "Untitled",
    artist: str(t.artist, 300),
    album: str(t.album, 300) || undefined,
    duration: typeof t.duration === "number" && Number.isFinite(t.duration) ? Math.max(0, Math.round(t.duration)) : 0,
    thumb: url(t.thumb),
    art: url(t.art),
    kind: t.kind === "video" ? "video" : "song",
  };
}

function findPlaylist(lib: Library, pid: string): Playlist {
  const p = lib.playlists.find((x) => x.id === pid);
  if (!p) throw new HttpError(404, msg("playlistNotFound"));
  return p;
}

export async function getLibrary(): Promise<Library> {
  return load();
}

export async function addFavorite(track: Track): Promise<Track[]> {
  const lib = await load();
  lib.favorites = [track, ...lib.favorites.filter((t) => t.id !== track.id)];
  await persist();
  return lib.favorites;
}

/** Adds many at once (in the given order, on top), skipping ones already there. */
export async function addFavorites(tracks: Track[]): Promise<Track[]> {
  const lib = await load();
  const seen = new Set(lib.favorites.map((t) => t.id));
  const added = tracks.filter((t) => !seen.has(t.id) && !!seen.add(t.id));
  lib.favorites = [...added, ...lib.favorites];
  await persist();
  return lib.favorites;
}

export async function removeFavorite(id: string): Promise<Track[]> {
  const lib = await load();
  lib.favorites = lib.favorites.filter((t) => t.id !== id);
  await persist();
  return lib.favorites;
}

export async function pushHistory(track: Track): Promise<Track[]> {
  const lib = await load();
  lib.history = [track, ...lib.history.filter((t) => t.id !== track.id)].slice(0, HISTORY_LIMIT);
  await persist();
  return lib.history;
}

export async function createPlaylist(name: string, tracks: Track[] = []): Promise<Playlist> {
  const lib = await load();
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new HttpError(400, msg("playlistNameRequired"));
  const now = Date.now();
  const playlist: Playlist = { id: randomUUID(), name: clean, createdAt: now, updatedAt: now, tracks };
  lib.playlists.unshift(playlist);
  await persist();
  return playlist;
}

export async function renamePlaylist(pid: string, name: string): Promise<Playlist> {
  const lib = await load();
  const p = findPlaylist(lib, pid);
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new HttpError(400, msg("playlistNameRequired"));
  p.name = clean;
  p.updatedAt = Date.now();
  await persist();
  return p;
}

export async function deletePlaylist(pid: string): Promise<void> {
  const lib = await load();
  findPlaylist(lib, pid);
  lib.playlists = lib.playlists.filter((p) => p.id !== pid);
  if (lib.offline) lib.offline.playlists = lib.offline.playlists.filter((id) => id !== pid);
  await persist();
}

export async function addToPlaylist(pid: string, tracks: Track | Track[]): Promise<Playlist> {
  const lib = await load();
  const p = findPlaylist(lib, pid);
  for (const track of Array.isArray(tracks) ? tracks : [tracks]) {
    if (!p.tracks.some((t) => t.id === track.id)) p.tracks.push(track);
  }
  p.updatedAt = Date.now();
  await persist();
  return p;
}

export async function removeFromPlaylist(pid: string, trackId: string): Promise<Playlist> {
  const lib = await load();
  const p = findPlaylist(lib, pid);
  p.tracks = p.tracks.filter((t) => t.id !== trackId);
  p.updatedAt = Date.now();
  await persist();
  return p;
}

// Backup import: a library exported from any Musike instance (web, desktop, another computer).

const MAX_PLAYLISTS = 1000;
const MAX_TRACKS = 5000;

/** Keeps the valid tracks of an untrusted list, without duplicates. */
function cleanTracks(input: unknown, limit = MAX_TRACKS): Track[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const raw of input.slice(0, limit * 2)) {
    try {
      const t = sanitizeTrack(raw);
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
      if (out.length >= limit) break;
    } catch {
      // skip invalid entries instead of rejecting the whole backup
    }
  }
  return out;
}

function cleanOffline(input: unknown, playlists: Playlist[]): Offline {
  const o = (input ?? {}) as Record<string, unknown>;
  const ids = new Set(playlists.map((p) => p.id));
  return {
    favorites: o.favorites === true,
    playlists: [...new Set(Array.isArray(o.playlists) ? o.playlists.filter((id): id is string => typeof id === "string" && ids.has(id)) : [])],
    tracks: cleanTracks(o.tracks),
  };
}

/** A library from outside (a backup, another device): only valid entries, without duplicates. */
export function cleanLibrary(input: unknown): Library {
  const lib = (input ?? {}) as Record<string, unknown>;
  const playlists = (Array.isArray(lib.playlists) ? lib.playlists : []).slice(0, MAX_PLAYLISTS).flatMap((raw): Playlist[] => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const name = str(p.name, 80).trim();
    if (!name) return [];
    const now = Date.now();
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : now);
    const id = str(p.id, 64);
    return [{ id: /^[\w-]{8,64}$/.test(id) ? id : randomUUID(), name, createdAt: num(p.createdAt), updatedAt: num(p.updatedAt), tracks: cleanTracks(p.tracks) }];
  });
  const clean: Library = { favorites: cleanTracks(lib.favorites), playlists, history: cleanTracks(lib.history, HISTORY_LIMIT) };
  if (lib.offline !== undefined) clean.offline = cleanOffline(lib.offline, playlists);
  return clean;
}

/** The whole library, as another device has it (sync). Checked like a backup. */
export async function replaceLibrary(input: unknown): Promise<Library> {
  await load();
  state = cleanLibrary(input);
  await persist();
  return state;
}

export interface OfflineChange {
  favorites?: boolean;
  playlist?: { id: string; on: boolean };
  addTracks?: Track[];
  removeTracks?: string[];
  /** Nothing kept downloaded any more. */
  clear?: boolean;
}

/** What should stay downloaded. The downloads themselves follow (see downloads.ts). */
export async function changeOffline(change: OfflineChange, fallback: Offline = { favorites: false, playlists: [], tracks: [] }): Promise<Offline> {
  const lib = await load();
  const o: Offline = lib.offline ? { ...lib.offline } : { ...fallback };
  if (change.clear) Object.assign(o, { favorites: false, playlists: [], tracks: [] });
  if (change.favorites !== undefined) o.favorites = change.favorites;
  if (change.playlist) {
    findPlaylist(lib, change.playlist.id);
    o.playlists = o.playlists.filter((id) => id !== change.playlist!.id);
    if (change.playlist.on) o.playlists.push(change.playlist.id);
  }
  if (change.removeTracks?.length) {
    const gone = new Set(change.removeTracks);
    o.tracks = o.tracks.filter((t) => !gone.has(t.id));
  }
  if (change.addTracks?.length) {
    const have = new Set(o.tracks.map((t) => t.id));
    o.tracks = [...o.tracks, ...change.addTracks.filter((t) => !have.has(t.id) && !!have.add(t.id))];
  }
  lib.offline = o;
  await persist();
  return o;
}

export interface ImportResult {
  playlistsAdded: number;
  playlistsMerged: number;
  tracksAdded: number;
  favoritesAdded: number;
}

/**
 * "merge" adds what is missing and never deletes (playlists match by id, then by name).
 * "replace" swaps the whole library for the backup's.
 */
export async function importLibrary(input: unknown, mode: "merge" | "replace"): Promise<ImportResult> {
  const incoming = cleanLibrary(input);
  const lib = await load();
  const result: ImportResult = { playlistsAdded: 0, playlistsMerged: 0, tracksAdded: 0, favoritesAdded: 0 };

  if (mode === "replace") {
    // What this device keeps downloaded stays as it is (minus playlists that are gone).
    state = { ...incoming, offline: lib.offline && cleanOffline(lib.offline, incoming.playlists) };
    if (!state.offline) delete state.offline;
    result.playlistsAdded = incoming.playlists.length;
    result.favoritesAdded = incoming.favorites.length;
    result.tracksAdded = incoming.playlists.reduce((n, p) => n + p.tracks.length, 0);
    await persist();
    return result;
  }

  const union = (mine: Track[], theirs: Track[]) => {
    const have = new Set(mine.map((t) => t.id));
    const added = theirs.filter((t) => !have.has(t.id));
    return { list: [...mine, ...added], added: added.length };
  };

  const fav = union(lib.favorites, incoming.favorites);
  lib.favorites = fav.list;
  result.favoritesAdded = fav.added;

  for (const p of incoming.playlists) {
    const match =
      lib.playlists.find((x) => x.id === p.id) ??
      lib.playlists.find((x) => x.name.toLocaleLowerCase("pt-BR") === p.name.toLocaleLowerCase("pt-BR"));
    if (match) {
      const merged = union(match.tracks, p.tracks);
      if (!merged.added) continue; // already had every track: nothing changed
      match.tracks = merged.list.slice(0, MAX_TRACKS);
      match.updatedAt = Date.now();
      result.tracksAdded += merged.added;
      result.playlistsMerged++;
    } else {
      lib.playlists.push(p);
      result.tracksAdded += p.tracks.length;
      result.playlistsAdded++;
    }
  }

  lib.history = union(lib.history, incoming.history).list.slice(0, HISTORY_LIMIT);
  await persist();
  return result;
}
