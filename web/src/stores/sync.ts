import { create } from "zustand";
import { api, type SyncStatus } from "../lib/api";
import { useDownloads } from "./downloads";
import { useLibrary } from "./library";
import { toast } from "./ui";

interface SyncState {
  status: SyncStatus | null;
  busy: "connect" | "sync" | "disconnect" | null;
  load: () => Promise<void>;
  connect: (token: string) => Promise<boolean>;
  syncNow: () => Promise<void>;
  disconnect: () => Promise<void>;
}

let polling: ReturnType<typeof setInterval> | undefined;
let seenRevision = -1;

export const useSync = create<SyncState>((set, get) => {
  /** Takes in the backend's answer; when another device's changes landed here, the library is read again. */
  function apply(status: SyncStatus) {
    set({ status });
    if (seenRevision >= 0 && status.revision !== seenRevision) {
      void useLibrary.getState().load();
      void useDownloads.getState().load();
    }
    seenRevision = status.revision;
    // Linked: keep an eye out for changes (cheap: the sync itself runs on the backend, every couple of minutes).
    if (status.connected && !polling) polling = setInterval(() => void get().load(), 15_000);
    if (!status.connected && polling) {
      clearInterval(polling);
      polling = undefined;
    }
  }

  return {
    status: null,
    busy: null,

    load: async () => {
      try {
        apply(await api.syncStatus());
      } catch {
        // not vital: asked again later
      }
    },

    connect: async (token) => {
      set({ busy: "connect" });
      try {
        apply(await api.syncConnect(token));
        return true;
      } catch (e) {
        toast((e as Error).message, "error");
        return false;
      } finally {
        set({ busy: null });
      }
    },

    syncNow: async () => {
      set({ busy: "sync" });
      try {
        apply(await api.syncNow());
      } catch (e) {
        toast((e as Error).message, "error");
      } finally {
        set({ busy: null });
      }
    },

    disconnect: async () => {
      set({ busy: "disconnect" });
      try {
        apply(await api.syncDisconnect());
      } catch (e) {
        toast((e as Error).message, "error");
      } finally {
        set({ busy: null });
      }
    },
  };
});

// Back online: sync right away rather than at the next tick.
addEventListener("online", () => {
  if (useSync.getState().status?.connected) void useSync.getState().syncNow();
});
