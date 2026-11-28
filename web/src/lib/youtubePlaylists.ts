import { useDownloads } from "../stores/downloads";
import { useLibrary } from "../stores/library";
import { capabilities } from "./api";
import type { AlbumPage, Playlist } from "./types";

/** The name a YouTube playlist gets in the library (the library keeps names to 80 characters). */
export const libraryName = (title: string) => title.trim().slice(0, 80);

/**
 * The library playlist saved from a YouTube playlist. It's found by name, so a copy saved on another synced
 * device counts too.
 */
export function savedCopy(playlists: Playlist[], title: string): Playlist | null {
  const name = libraryName(title);
  return name ? (playlists.find((p) => p.name === name) ?? null) : null;
}

/**
 * Saves a YouTube playlist to the library (or adds what's new to the copy saved earlier) and keeps that copy
 * downloaded, so its songs play with no internet and show up on the other devices as one playlist.
 */
export async function saveAndDownload(page: AlbumPage): Promise<Playlist | null> {
  const library = useLibrary.getState();
  let copy = savedCopy(library.playlists, page.title);
  if (copy) {
    const have = new Set(copy.tracks.map((t) => t.id));
    const missing = page.tracks.filter((t) => !have.has(t.id));
    if (missing.length) await library.addToPlaylist(copy.id, missing);
  } else {
    copy = await library.createPlaylist(libraryName(page.title), page.tracks);
  }
  if (!copy) return null;
  if (capabilities.downloads) await useDownloads.getState().setCollection({ playlist: { id: copy.id, on: true } });
  return copy;
}
