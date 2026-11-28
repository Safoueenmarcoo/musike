import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import {
  album as albumPage,
  ALBUM_ID,
  artist as artistPage,
  ARTIST_ID,
  GENRE_ID,
  genre as genrePage,
  genreArtists,
  genres,
  playlist as playlistPage,
  PLAYLIST_ID,
  searchAlbums,
  searchPlaylists,
} from "../../../server/src/browse";
import * as downloads from "../../../server/src/downloads";
import { msg, tr, type MsgKey } from "../../../server/src/i18n";
import * as library from "../../../server/src/library";
import * as sync from "../../../server/src/sync";
import * as remote from "../../../server/src/connect";
import { findVideoFor, radio, search, suggestions } from "../../../server/src/search";
import { HttpError, VIDEO_ID } from "../../../server/src/types";
import { getLang, getT } from "../i18n";
import { ApiError, type MusikeApi, type SystemInfo } from "../lib/apiTypes";
import type { DownloadsInfo } from "../lib/types";
import "./android";
import { lanFetch } from "./connect";
import { androidDownloads, downloadsAvailable, downloadsReady, fileUrl } from "./downloads";
import { media } from "./media";
import { nativeStorage, nativeStore } from "./storage";
import { config } from "./shims/config";
import { forgetUrl, resolveAudio } from "./streams";
import { streamAddress } from "./streamUrl";
import { everRouted } from "../lib/equalizer";
import { savingData } from "../stores/playback";

export { updater } from "./update";

// The Android backend: the Musike server's own code (search, genres, artists, albums, library), running on the
// phone instead of behind HTTP. The build swaps lib/api.ts for this module (see vite.config.ts).
export * from "../lib/apiTypes";

library.useLibraryStorage(nativeStorage);
if (downloadsAvailable) {
  downloads.useDownloadsBackend(androidDownloads);
  // What the library says to keep downloaded, including what failed last time; again when the connection is back.
  void downloads.reconcile("all").catch(() => {});
  addEventListener("online", () => void downloads.reconcile("all").catch(() => {}));
}
// The web view's own fetch: GitHub's API answers web pages (CORS), and it honours timeouts.
sync.useSync({ storage: nativeStore, fetch: (...args) => globalThis.fetch(...args), api: config.githubApi });
sync.startAutoSync();
addEventListener("online", () => void sync.syncNow());

// Remote playback, while this phone is linked: the relay through the web view's fetch (it streams), the desktop app on
// the same Wi-Fi through Android's HTTP.
const startRemote = async (token: string | null) => {
  if (!token) return remote.stopConnect();
  await remote.startConnect({
    token,
    store: nativeStore,
    name: document.documentElement.dataset.tv === "1" ? "Android TV" : "Android phone",
    kind: "android",
    relayUrl: "https://ntfy.sh",
    fetch: (...args) => globalThis.fetch(...args),
    lanFetch,
  });
};
sync.onSyncLink((token) => void startRemote(token).catch(() => {}));
void sync.syncToken().then(startRemote).catch(() => {});

const NO_DOWNLOADS: DownloadsInfo = { items: [], jobs: [], bytes: 0, offline: { favorites: false, playlists: [] } };

const fail = (status: number, key: MsgKey) => new ApiError(status, tr(getLang(), msg(key)));

/** Runs a server function and turns its errors into what the app expects, in the app's language. */
async function call<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  try {
    const result = await fn();
    // The work can't be cancelled midway, but a caller that gave up must not get the result.
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return result;
  } catch (e) {
    if (e instanceof HttpError) throw new ApiError(e.status, tr(getLang(), e.text), e.code);
    if (e instanceof ApiError || (e as Error).name === "AbortError") throw e;
    throw new ApiError(500, (e as Error).message || getT().player.serverDown);
  }
}

const tracks = (list: unknown[]) => list.slice(0, 500).map(library.sanitizeTrack);

const SYSTEM: SystemInfo = {
  ytdlp: { path: "built-in", version: null, channel: "stable", latest: { stable: null, nightly: null }, updateAvailable: false },
  deno: "built-in",
  ffmpeg: null,
  canInstall: false,
  job: null,
};

export const api: MusikeApi = {
  search: (q, type, signal) =>
    call(async () => {
      if (!q.trim()) throw fail(400, "emptyQuery");
      return search(q.trim().slice(0, 200), type, getLang());
    }, signal),
  suggest: (q, signal) => call(() => suggestions(q.trim().slice(0, 100), getLang()).catch(() => []), signal),
  radio: (id) => call(() => radio(id)),
  genres: () => call(() => genres(getLang())),
  genre: (id, signal) =>
    call(async () => {
      if (!GENRE_ID.test(id)) throw fail(400, "invalidGenre");
      return genrePage(id, getLang());
    }, signal),
  genreArtists: (id, offset) => call(() => genreArtists(id, offset, getLang())),
  artist: (id, signal) =>
    call(async () => {
      if (!ARTIST_ID.test(id)) throw fail(400, "invalidArtist");
      return artistPage(id, getLang());
    }, signal),
  album: (id, signal) =>
    call(async () => {
      if (!ALBUM_ID.test(id)) throw fail(400, "invalidAlbum");
      return albumPage(id, getLang());
    }, signal),
  searchAlbums: (q, signal) => call(() => searchAlbums(q.trim().slice(0, 200), getLang()), signal),
  youtubePlaylist: (id, signal) =>
    call(async () => {
      if (!PLAYLIST_ID.test(id)) throw fail(400, "invalidPlaylist");
      return playlistPage(id, getLang());
    }, signal),
  searchPlaylists: (q, signal) => call(() => searchPlaylists(q.trim().slice(0, 200), getLang()), signal),
  videoFor: (t) => call(() => findVideoFor(t.id, t.title, t.artist, t.duration)),
  prepare: (id, signal) =>
    call(async () => {
      if (!VIDEO_ID.test(id)) throw fail(400, "invalidVideoId");
      // A downloaded song has nothing to resolve (and may be all there is to play, with no internet).
      const saved = downloadsAvailable ? await downloads.downloadOf(id) : null;
      if (saved) return { id, title: saved.track.title, duration: saved.track.duration, hasSdVideo: false };
      const r = await resolveAudio(id);
      return { id, title: r.title, duration: r.duration, hasSdVideo: false };
    }, signal),

  library: () => call(() => library.getLibrary()),
  addFavorite: (t) => call(async () => ({ favorites: await library.addFavorite(library.sanitizeTrack(t)) })),
  addFavorites: (list) => call(async () => ({ favorites: await library.addFavorites(tracks(list)) })),
  removeFavorite: (id) => call(async () => ({ favorites: await library.removeFavorite(id) })),
  pushHistory: (t) => call(async () => ({ history: await library.pushHistory(library.sanitizeTrack(t)) })),
  createPlaylist: (name, list = []) => call(() => library.createPlaylist(name, tracks(list))),
  renamePlaylist: (id, name) => call(() => library.renamePlaylist(id, name)),
  deletePlaylist: (id) => call(() => library.deletePlaylist(id)),
  addToPlaylist: (id, t) => call(() => library.addToPlaylist(id, Array.isArray(t) ? tracks(t) : library.sanitizeTrack(t))),
  removeFromPlaylist: (id, trackId) => call(() => library.removeFromPlaylist(id, trackId)),
  reorderPlaylist: (id, ids) => call(() => library.reorderPlaylist(id, ids.filter((x) => typeof x === "string").slice(0, 5000))),
  importLibrary: (backup, mode) =>
    call(async () => {
      const b = (backup ?? {}) as { format?: unknown; version?: unknown; library?: unknown };
      if (b.format !== "musike-backup") throw fail(400, "notBackup");
      if (typeof b.version !== "number" || b.version > 1) throw fail(400, "newerBackup");
      return library.importLibrary(b.library, mode);
    }),

  downloads: () =>
    downloadsAvailable
      ? call(async () => {
          // The folder first: the app builds the saved covers' addresses from it as soon as this answers.
          await downloadsReady();
          return downloads.getDownloads(getLang());
        })
      : Promise.resolve(NO_DOWNLOADS),
  download: (list) => call(() => downloads.enqueue(list, getLang())),
  removeDownloads: (ids) => call(() => downloads.removeDownloads(ids, getLang())),
  setOffline: (change) => call(() => downloads.setOffline(change, getLang())),

  connectWait: (since) => remote.waitConnect(since),
  connectState: (state) => remote.setLocalState(state ? { ...state, track: library.sanitizeTrack(state.track) } : null),
  connectCommand: (to, action, position) => remote.sendCommand(to, action, position),

  syncStatus: () => call(() => sync.syncStatus(getLang())),
  syncConnect: (token) =>
    call(async () => {
      await sync.connect(token);
      return sync.syncStatus(getLang());
    }),
  syncNow: () =>
    call(async () => {
      await sync.syncNow();
      return sync.syncStatus(getLang());
    }),
  syncDisconnect: () =>
    call(async () => {
      await sync.disconnect();
      return sync.syncStatus(getLang());
    }),

  system: async () => SYSTEM,
  updateYtdlp: async () => {
    throw new ApiError(400, "yt-dlp isn't used on this device.");
  },
};

/**
 * On the phone, the media element plays YouTube's stream directly: resolved here, no proxy needed.
 * A downloaded song plays from its file instead: at once, and with no internet at all.
 */
export async function streamSource(id: string): Promise<string> {
  const saved = downloadsAvailable ? await downloads.downloadOf(id).catch(() => null) : null;
  if (saved) {
    await downloadsReady();
    return fileUrl(saved.file);
  }
  return streamAddress(await resolveAudio(id), { saveData: savingData(), proxy: everRouted(), origin: location.origin });
}

/** Where a downloaded song's saved cover is: an image that loads with no internet. */
export const downloadCover = (id: string): string => fileUrl(`${id}.jpg`);

export async function explainStreamError(url: string): Promise<{ message: string }> {
  forgetUrl(url);
  return { message: navigator.onLine ? getT().player.streamFailed : getT().player.offline };
}

/** Backups are shared through Android's share sheet (save to Files, Drive, send to the computer…). */
export async function saveFile(name: string, text: string) {
  const { uri } = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
  await Share.share({ title: name, files: [uri] });
}

export const systemMedia = media;

export const capabilities = { video: false, engineSettings: false, retryOnError: true, downloads: downloadsAvailable, dataSaver: true };
