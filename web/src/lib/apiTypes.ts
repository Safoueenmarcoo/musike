import type { AlbumCard, AlbumPage, ArtistPage, DownloadsInfo, Genre, GenreArtist, GenrePage, Library, Playlist, Track } from "./types";

/**
 * What the app needs from a backend. The web app and the desktop app talk to the Musike server over HTTP
 * (lib/api.ts); the Android app does the same work on the phone (native/api.ts). The build picks one.
 */

export type ErrorCode = "tool_missing" | "maybe_outdated" | "bot_check";

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: ErrorCode) {
    super(message);
  }
}

export type Channel = "stable" | "nightly";

export interface ImportResult {
  playlistsAdded: number;
  playlistsMerged: number;
  tracksAdded: number;
  favoritesAdded: number;
}

export interface SystemJob {
  kind: "update" | "install";
  channel: Channel;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  from: string | null;
  to: string | null;
  message: string;
  log: string[];
}

export interface SystemInfo {
  ytdlp: {
    path: string | null;
    version: string | null;
    channel: Channel;
    latest: Record<Channel, string | null>;
    updateAvailable: boolean;
  };
  deno: string | null;
  ffmpeg: string | null;
  canInstall: boolean;
  job: SystemJob | null;
}

/** Sync between devices through a GitHub gist (see server/src/sync.ts). */
export interface SyncStatus {
  connected: boolean;
  /** The GitHub account linked. */
  login: string | null;
  gistUrl: string | null;
  lastSync: number | null;
  syncing: boolean;
  error: string | null;
  /** Goes up whenever changes from another device land here. */
  revision: number;
}

/** Remote playback between devices (server/src/connect.ts). */
export type RemoteAction = "play" | "pause" | "next" | "previous" | "seek";
export interface RemoteState {
  track: Track;
  status: "playing" | "paused";
  position: number;
  duration: number;
}
export interface RemotePeer {
  id: string;
  name: string;
  kind: "desktop" | "android" | "web";
  via: "lan" | "relay";
  state: (RemoteState & { receivedAt: number }) | null;
  lastSeen: number;
}
export interface ConnectSnapshot {
  enabled: boolean;
  self: { id: string; name: string; kind: RemotePeer["kind"] } | null;
  peers: RemotePeer[];
  commands: { seq: number; from: string; action: RemoteAction; position?: number }[];
  seq: number;
  relay: "off" | "connecting" | "ok" | "down" | "limited";
}

/** Keeps a whole collection downloaded, or stops. */
export type OfflineCollection = { favorites: boolean } | { playlist: { id: string; on: boolean } };

export interface Prepared {
  id: string;
  title: string;
  duration: number;
  hasSdVideo: boolean;
}

/**
 * The operating system's media controls (notification, lock screen, headphone buttons) when the browser's
 * Media Session can't reach them: the Android app. Absent elsewhere.
 */
export interface SystemMedia {
  setTrack(track: { title: string; artist: string; album: string; artwork: string }): void;
  setState(state: { playing: boolean; position: number; duration: number }): void;
  onAction(handler: (action: "play" | "pause" | "next" | "previous" | "seek", position?: number) => void): void;
}

export interface MusikeApi {
  search(q: string, type: "song" | "video", signal?: AbortSignal): Promise<Track[]>;
  suggest(q: string, signal?: AbortSignal): Promise<string[]>;
  radio(id: string): Promise<Track[]>;
  genres(): Promise<Genre[]>;
  genre(id: string, signal?: AbortSignal): Promise<GenrePage>;
  genreArtists(id: string, offset: number): Promise<{ artists: GenreArtist[]; hasMore: boolean }>;
  artist(id: string, signal?: AbortSignal): Promise<ArtistPage>;
  album(id: string, signal?: AbortSignal): Promise<AlbumPage>;
  searchAlbums(q: string, signal?: AbortSignal): Promise<AlbumCard[]>;
  /** The music video matching a song, or null when YouTube has none. */
  videoFor(t: Track): Promise<Track | null>;
  prepare(id: string, signal?: AbortSignal): Promise<Prepared>;

  library(): Promise<Library>;
  addFavorite(t: Track): Promise<{ favorites: Track[] }>;
  addFavorites(tracks: Track[]): Promise<{ favorites: Track[] }>;
  removeFavorite(id: string): Promise<{ favorites: Track[] }>;
  pushHistory(t: Track): Promise<{ history: Track[] }>;
  createPlaylist(name: string, tracks?: Track[]): Promise<Playlist>;
  renamePlaylist(id: string, name: string): Promise<Playlist>;
  deletePlaylist(id: string): Promise<void>;
  addToPlaylist(id: string, t: Track | Track[]): Promise<Playlist>;
  removeFromPlaylist(id: string, trackId: string): Promise<Playlist>;
  importLibrary(backup: unknown, mode: "merge" | "replace"): Promise<ImportResult>;

  /** Songs saved for offline listening, and the downloads under way. */
  downloads(): Promise<DownloadsInfo>;
  /** Queues tracks for download; answers at once, the progress comes with `downloads()`. */
  download(tracks: Track[]): Promise<DownloadsInfo>;
  /** Removes saved songs and cancels downloads under way; `null` removes them all. */
  removeDownloads(ids: string[] | null): Promise<DownloadsInfo>;
  /** Keeps a playlist or the favorites downloaded (songs added later too), or stops. */
  setOffline(change: OfflineCollection): Promise<DownloadsInfo>;

  /** Long poll: the devices around and the commands for this one, once something newer than `since` happens. */
  connectWait(since: number): Promise<ConnectSnapshot>;
  /** This device's playback, sent when it changes. */
  connectState(state: RemoteState | null): Promise<void>;
  /** Asks another device to play, pause, skip or seek; false when it isn't answering. */
  connectCommand(to: string, action: RemoteAction, position?: number): Promise<boolean>;

  syncStatus(): Promise<SyncStatus>;
  /** Links this device to GitHub with a token and syncs. */
  syncConnect(token: string): Promise<SyncStatus>;
  syncNow(): Promise<SyncStatus>;
  syncDisconnect(): Promise<SyncStatus>;

  system(): Promise<SystemInfo>;
  updateYtdlp(channel: Channel): Promise<SystemJob>;
}

/** A release file this device can update itself with. */
export interface UpdateFile {
  url: string;
  version: string;
  size: number;
  sha256?: string;
}

/** Updating from the app, where the platform allows it (the Windows app and the Android app). */
export interface Updater {
  platform: "windows" | "android";
  /** How this platform's file is named in a release. */
  file: RegExp;
  /** Downloads and starts the install. "permission": Android wasn't allowed to install apps from Musike+. */
  install(file: UpdateFile, progress: (fraction: number) => void): Promise<"started" | "permission">;
}
