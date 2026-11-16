import { useSyncExternalStore } from "react";

// One pair of window listeners for the whole app, however many components watch the connection.
const watchers = new Set<() => void>();
const notify = () => watchers.forEach((fn) => fn());

function subscribe(fn: () => void) {
  if (!watchers.size) {
    window.addEventListener("online", notify);
    window.addEventListener("offline", notify);
  }
  watchers.add(fn);
  return () => {
    watchers.delete(fn);
    if (!watchers.size) {
      window.removeEventListener("online", notify);
      window.removeEventListener("offline", notify);
    }
  };
}

/** Whether the device has a network connection at all. Without one, only downloaded songs can play. */
export const isOnline = () => navigator.onLine;

/** `isOnline`, re-rendering when the connection comes or goes. */
export const useOnline = () => useSyncExternalStore(subscribe, isOnline, () => true);
