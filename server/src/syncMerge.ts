import type { Library, Offline, Playlist, Track } from "./types.js";

// No Node-only imports here: the Android app runs this same module.

/**
 * Three-way merge of a library: `base` is what this device and the other devices last agreed on, `local` what this
 * device has now, `remote` what the others have now. What one side added is added, what one side removed is removed,
 * and a list only one side touched is taken from that side as it is (so two devices never undo each other's order).
 * Without a base (the first sync of a device) nothing is removed: the two libraries are put together.
 *
 * All three must already be cleaned (cleanLibrary), so equal content is equal text.
 */

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const EMPTY: Offline = { favorites: false, playlists: [], tracks: [] };
const offlineOf = (lib: Library): Offline => lib.offline ?? EMPTY;

function mergeItems<T extends { id: string }>(
  base: T[] | null,
  local: T[],
  remote: T[],
  newFirst: boolean,
  combine?: (base: T | undefined, local: T, remote: T) => T,
): T[] {
  if (base) {
    if (same(local, base)) return remote;
    if (same(remote, base)) return local;
  } else {
    // First sync: what the other devices already share keeps its order; this device's own items join it.
    const inLocal = new Map(local.map((x) => [x.id, x]));
    const inRemote = new Set(remote.map((x) => x.id));
    const shared = remote.map((r) => {
      const l = inLocal.get(r.id);
      return l ? (combine ? combine(undefined, l, r) : l) : r;
    });
    const mine = local.filter((l) => !inRemote.has(l.id));
    return newFirst ? [...mine, ...shared] : [...shared, ...mine];
  }
  const inBase = new Map((base ?? []).map((x) => [x.id, x]));
  const inLocal = new Set(local.map((x) => x.id));
  const inRemote = new Map(remote.map((x) => [x.id, x]));
  const kept: T[] = [];
  for (const l of local) {
    const r = inRemote.get(l.id);
    if (r) kept.push(combine ? combine(inBase.get(l.id), l, r) : l);
    else if (!inBase.has(l.id)) kept.push(l); // added on this device
    // else: removed on another device
  }
  // Added on another device (one this device removed is in the base, and stays removed).
  const added = remote.filter((r) => !inLocal.has(r.id) && !inBase.has(r.id));
  return newFirst ? [...added, ...kept] : [...kept, ...added];
}

/** A value only one side changed comes from that side; changed on both, this device's wins. */
const pick = <T>(base: T | undefined, local: T, remote: T, hasBase: boolean): T =>
  hasBase && same(local, base) ? remote : local;

function mergePlaylist(base: Playlist | undefined, local: Playlist, remote: Playlist): Playlist {
  return {
    id: local.id,
    name: pick(base?.name, local.name, remote.name, !!base),
    createdAt: Math.min(local.createdAt, remote.createdAt),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    tracks: mergeItems<Track>(base?.tracks ?? null, local.tracks, remote.tracks, false),
  };
}

/**
 * First sync of a device: a playlist made on both sides under the same name (say, both imported the same backup
 * long ago) becomes one, under the other side's id, rather than two of the same name.
 */
function alignByName(local: Library, remote: Library): Library {
  const byName = new Map(remote.playlists.map((p) => [p.name.toLocaleLowerCase(), p]));
  const remoteIds = new Set(remote.playlists.map((p) => p.id));
  const renamed = new Map<string, string>();
  const playlists = local.playlists.map((p) => {
    if (remoteIds.has(p.id)) return p;
    const twin = byName.get(p.name.toLocaleLowerCase());
    if (!twin || [...renamed.values()].includes(twin.id) || local.playlists.some((x) => x.id === twin.id)) return p;
    renamed.set(p.id, twin.id);
    // The name it already has on the other devices.
    return { ...p, id: twin.id, name: twin.name };
  });
  if (!renamed.size) return local;
  const offline = local.offline && { ...local.offline, playlists: local.offline.playlists.map((id) => renamed.get(id) ?? id) };
  return { ...local, playlists, ...(offline ? { offline } : {}) };
}

export function mergeLibraries(base: Library | null, local: Library, remote: Library): Library {
  if (!base) local = alignByName(local, remote);
  const playlists = mergeItems(base?.playlists ?? null, local.playlists, remote.playlists, true, mergePlaylist);

  const b = base ? offlineOf(base) : undefined;
  const l = offlineOf(local);
  const r = offlineOf(remote);
  const ids = (list: string[]) => list.map((id) => ({ id }));
  const existing = new Set(playlists.map((p) => p.id));
  const offline: Offline = {
    favorites: base ? pick(b!.favorites, l.favorites, r.favorites, true) : l.favorites || r.favorites,
    playlists: mergeItems(b ? ids(b.playlists) : null, ids(l.playlists), ids(r.playlists), false)
      .map((x) => x.id)
      .filter((id) => existing.has(id)),
    tracks: mergeItems(b?.tracks ?? null, l.tracks, r.tracks, false),
  };

  return {
    favorites: mergeItems(base?.favorites ?? null, local.favorites, remote.favorites, true),
    playlists,
    history: mergeItems(base?.history ?? null, local.history, remote.history, true).slice(0, 60),
    offline,
  };
}
