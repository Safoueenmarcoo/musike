import { create } from "zustand";
import { useOnline } from "../hooks/useOnline";
import { getT } from "../i18n";
import { api, capabilities, downloadCover } from "../lib/api";
import type { DownloadItem, DownloadJob, DownloadsInfo, Track } from "../lib/types";
import { toast } from "./ui";

/** Where a track stands: not saved, waiting its turn, on its way, failed, or saved on this device. */
export type DownloadStatus = "none" | DownloadJob["status"] | "done";

interface DownloadsState {
  /** Saved songs, newest first. */
  items: DownloadItem[];
  /** Downloads waiting, under way or failed. */
  jobs: DownloadJob[];
  bytes: number;
  /** The same two lists by track id, for the many rows that ask about one track. */
  saved: Record<string, DownloadItem>;
  active: Record<string, DownloadJob>;
  /** Saved covers by track id, and by the image address they stand in for when there is no internet. */
  covers: Record<string, string>;
  coverByUrl: Record<string, string>;
  status: "idle" | "ready";
  load: () => Promise<void>;
  /** Starts downloading the tracks that aren't saved yet. */
  download: (tracks: Track[]) => Promise<void>;
  /** Removes saved songs, or cancels (or dismisses) their downloads. */
  remove: (ids: string[]) => Promise<void>;
  removeAll: () => Promise<void>;
}

const running = (jobs: DownloadJob[]) => jobs.filter((j) => j.status !== "error");
const byId = <T extends { track: Track }>(list: T[]) => Object.fromEntries(list.map((x) => [x.track.id, x])) as Record<string, T>;

let polling: ReturnType<typeof setTimeout> | null = null;
/** Songs that finished since the downloads now running began, to announce them together at the end. */
let finished: Track[] = [];

export const useDownloads = create<DownloadsState>((set, get) => {
  /** Takes in the backend's answer, announcing what changed since the last one, and keeps watching while work remains. */
  function apply(info: DownloadsInfo) {
    const before = get();
    const saved = byId(info.items);
    const active = byId(info.jobs);
    const covers: Record<string, string> = {};
    const coverByUrl: Record<string, string> = {};
    for (const { track, cover } of info.items) {
      if (!cover) continue;
      const local = downloadCover(track.id);
      covers[track.id] = local;
      if (track.thumb) coverByUrl[track.thumb] = local;
      if (track.art) coverByUrl[track.art] = local;
    }
    set({ items: info.items, jobs: info.jobs, bytes: info.bytes, saved, active, covers, coverByUrl, status: "ready" });
    if (before.status !== "ready") {
      if (running(info.jobs).length) watch();
      return;
    }

    const t = getT().downloads.toasts;
    const failed = info.jobs.filter((j) => j.status === "error" && before.active[j.track.id]?.status !== "error");
    if (failed.length === 1) {
      const { track, error } = failed[0];
      toast(t.failed(track.title, error ?? ""), "error", { label: getT().common.retry, run: () => void get().download([track]) });
    } else if (failed.length > 1) {
      toast(t.failedMany(failed.length), "error");
    }

    finished.push(...info.items.filter((i) => before.active[i.track.id] && !before.saved[i.track.id]).map((i) => i.track));
    if (running(info.jobs).length) return watch();
    if (finished.length === 1) toast(t.done(finished[0].title));
    else if (finished.length > 1) toast(t.doneMany(finished.length));
    finished = [];
  }

  function watch() {
    if (polling) return;
    polling = setTimeout(async () => {
      polling = null;
      try {
        apply(await api.downloads());
      } catch {
        watch(); // the server is restarting, or busy: ask again
      }
    }, 600);
  }

  return {
    items: [],
    jobs: [],
    bytes: 0,
    saved: {},
    active: {},
    covers: {},
    coverByUrl: {},
    status: "idle",

    load: async () => {
      if (!capabilities.downloads) return;
      try {
        apply(await api.downloads());
      } catch {
        // Not vital at startup: the next action that needs it asks again.
      }
    },

    download: async (tracks) => {
      const { saved, active } = get();
      const seen = new Set<string>();
      const fresh = tracks.filter((track) => {
        if (seen.has(track.id) || saved[track.id]) return false;
        seen.add(track.id);
        const job = active[track.id];
        return !job || job.status === "error";
      });
      const t = getT().downloads.toasts;
      if (!fresh.length) return toast(tracks.length === 1 ? t.already : t.allAlready);
      try {
        const info = await api.download(fresh);
        toast(fresh.length === 1 ? t.started(fresh[0].title) : t.startedMany(fresh.length));
        apply(info);
      } catch (e) {
        toast((e as Error).message, "error");
      }
    },

    remove: async (ids) => {
      if (!ids.length) return;
      const { saved, active } = get();
      const wasSaved = ids.filter((id) => saved[id]).length;
      const wasRunning = ids.filter((id) => active[id] && active[id].status !== "error").length;
      // A cancelled download is not "finished" when the others end.
      finished = finished.filter((track) => !ids.includes(track.id));
      try {
        apply(await api.removeDownloads(ids));
        const t = getT().downloads.toasts;
        if (wasSaved) toast(wasSaved === 1 ? t.removed : t.removedMany(wasSaved));
        else if (wasRunning) toast(t.cancelled);
      } catch (e) {
        toast((e as Error).message, "error");
      }
    },

    removeAll: async () => {
      const count = get().items.length;
      finished = [];
      try {
        apply(await api.removeDownloads(null));
        if (count) toast(getT().downloads.toasts.removedMany(count));
      } catch (e) {
        toast((e as Error).message, "error");
      }
    },
  };
});

/** Whether a track is saved on this device (for code outside React, like the player). */
export const isDownloaded = (id: string) => !!useDownloads.getState().saved[id];

export const downloadStatus = (s: DownloadsState, id: string): DownloadStatus => (s.saved[id] ? "done" : (s.active[id]?.status ?? "none"));

/** One track's download status; the row re-renders only when it changes. */
export const useDownloadStatus = (id: string | undefined): DownloadStatus => useDownloads((s) => (id ? downloadStatus(s, id) : "none"));

/** How far a track's download is, 0 to 1, or null while its size isn't known (or it is still waiting). */
export const useDownloadProgress = (id: string | undefined): number | null =>
  useDownloads((s) => {
    const job = id ? s.active[id] : undefined;
    return job && job.status === "downloading" && job.total > 0 ? Math.min(1, job.received / job.total) : null;
  });

/** The saved cover standing in for an image: by track when the caller knows it, else by the image's address. */
export const useLocalArt = (src: string | undefined, fallback: string | undefined, trackId: string | undefined): string | undefined =>
  useDownloads((s) => (trackId && s.covers[trackId]) || (src && s.coverByUrl[src]) || (fallback && s.coverByUrl[fallback]) || undefined);

/** With no internet, a track that isn't downloaded can't play: lists show it dimmed and say so when it is tapped. */
export function useUnavailable(id: string): boolean {
  const online = useOnline();
  const saved = useDownloads((s) => !!s.saved[id]);
  return capabilities.downloads && !online && !saved;
}

/** A track's small image for decoration (blurred backdrops): its saved cover when there is no internet. */
export function useThumb(track: Track): string {
  const online = useOnline();
  const local = useDownloads((s) => s.covers[track.id]);
  return !online && local ? local : track.thumb;
}
