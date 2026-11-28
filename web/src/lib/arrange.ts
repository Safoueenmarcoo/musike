import type { Track } from "./types";

/** How a collection's songs are listed. "custom" is the collection's own order (a playlist's, or newest first). */
export type SortKey = "custom" | "added" | "title" | "artist" | "album" | "duration";
export type CollectionKind = "playlist" | "favorites" | "history";

/** The sorts each collection offers; the first is its own order. */
export const SORTS: Record<CollectionKind, SortKey[]> = {
  playlist: ["custom", "added", "title", "artist", "album", "duration"],
  // Favorites are kept newest first, and history most recent first: their own order already is "date added".
  favorites: ["custom", "title", "artist", "album", "duration"],
  history: ["custom", "title", "artist", "album", "duration"],
};

/** Case and accents don't matter: "jose" finds "José". */
export const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();

/** Every word of the query is somewhere in the title, artist or album. */
export function matches(track: Track, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold(`${track.title} ${track.artist} ${track.album ?? ""}`);
  return words.every((w) => hay.includes(w));
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** The songs to show: filtered by `query`, in the order `sort` asks for. The input isn't changed. */
export function arrange(tracks: Track[], sort: SortKey, query: string): Track[] {
  const indexed = tracks.map((track, i) => ({ track, i })).filter(({ track }) => matches(track, query));
  const text = (a: string | undefined, b: string | undefined) => {
    // Empty values (no album) go last.
    if (!a !== !b) return a ? -1 : 1;
    return collator.compare(a ?? "", b ?? "");
  };
  switch (sort) {
    case "added":
      // Newest first. Songs saved before dates were kept count as oldest, in the order they were added.
      indexed.sort((a, b) => (b.track.addedAt ?? 0) - (a.track.addedAt ?? 0) || b.i - a.i);
      break;
    case "title":
      indexed.sort((a, b) => text(a.track.title, b.track.title) || a.i - b.i);
      break;
    case "artist":
      indexed.sort((a, b) => text(a.track.artist, b.track.artist) || text(a.track.album, b.track.album) || a.i - b.i);
      break;
    case "album":
      indexed.sort((a, b) => text(a.track.album, b.track.album) || a.i - b.i);
      break;
    case "duration":
      indexed.sort((a, b) => (a.track.duration || 0) - (b.track.duration || 0) || a.i - b.i);
      break;
    default:
      break;
  }
  return indexed.map(({ track }) => track);
}

const KEY = "musike:sort";

/** The sort last picked for a collection (a playlist's id, "favorites" or "history"). */
export function savedSort(kind: CollectionKind, id: string): SortKey {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, SortKey>;
    const s = all[id];
    return s && SORTS[kind].includes(s) ? s : "custom";
  } catch {
    return "custom";
  }
}

export function saveSort(id: string, sort: SortKey) {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, SortKey>;
    if (sort === "custom") delete all[id];
    else all[id] = sort;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: kept until the page is left */
  }
}
