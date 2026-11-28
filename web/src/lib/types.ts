export interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration: number;
  thumb: string;
  art: string;
  kind: "song" | "video";
}

export interface Playlist {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  tracks: Track[];
}

/** What is kept downloaded on every device: whole collections (their new songs too) and single songs. */
export interface Offline {
  favorites: boolean;
  /** Playlist ids. */
  playlists: string[];
  tracks: Track[];
}

export interface Library {
  favorites: Track[];
  playlists: Playlist[];
  history: Track[];
  /** Missing in libraries from before 1.7: filled in from what was already downloaded. */
  offline?: Offline;
}

/** A song saved for offline listening. */
export interface DownloadItem {
  track: Track;
  /** Bytes on disk. */
  size: number;
  addedAt: number;
  /** Whether its cover was saved too (see `downloadCover` in lib/api.ts). */
  cover: boolean;
}

/** A download that is waiting, under way, or failed (it stays listed until retried or dismissed). */
export interface DownloadJob {
  track: Track;
  status: "queued" | "downloading" | "error";
  received: number;
  /** 0 until the size is known. */
  total: number;
  /** Why it failed, in the app's language. */
  error?: string;
}

export interface DownloadsInfo {
  /** Newest first. */
  items: DownloadItem[];
  jobs: DownloadJob[];
  /** Space the saved songs take. */
  bytes: number;
  /** Collections kept downloaded: their new songs download by themselves. */
  offline: { favorites: boolean; playlists: string[] };
}

export interface Genre {
  id: string;
  name: string;
}

export interface GenreArtist {
  id: string;
  name: string;
  /** Cover of one of their releases in the genre. */
  thumb: string;
  art: string;
  /** A few of their songs in the genre. */
  hits: string[];
}

export interface GenrePage {
  id: string;
  name: string;
  /** First page of artists; `api.genreArtists` brings the next ones. */
  artists: GenreArtist[];
  hasMoreArtists: boolean;
  tracks: Track[];
}

/** An album or single as a cover in a list. */
export interface AlbumCard {
  id: string;
  title: string;
  /** Empty on an artist's own page. */
  artist: string;
  year: string;
  thumb: string;
  art: string;
}

/** A YouTube playlist as a cover in search results. */
export interface PlaylistCard {
  id: string;
  title: string;
  author: string;
  /** YouTube Music's own line under the title: "Spotify • 1.2M views". */
  info: string;
  thumb: string;
  art: string;
}

export interface ArtistPage {
  id: string;
  name: string;
  description: string;
  banner: string;
  tracks: Track[];
  albums: AlbumCard[];
  singles: AlbumCard[];
}

export interface AlbumPage {
  id: string;
  title: string;
  artist: string;
  artistId: string | null;
  /** YouTube Music's own lines, already in the app language: "Album • 1991", "13 songs • 49 minutes". */
  kind: string;
  info: string;
  thumb: string;
  art: string;
  tracks: Track[];
}
