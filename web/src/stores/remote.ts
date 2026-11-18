import { create } from "zustand";
import { getT } from "../i18n";
import { api, type ConnectSnapshot, type RemoteAction, type RemotePeer, type RemoteState } from "../lib/api";
import { usePlayer } from "../player/player";
import { toast } from "./ui";

/**
 * Remote playback in the app: listens to the other devices (long poll on the backend, server/src/connect.ts), does
 * what they ask this one to do, tells them what plays here when it changes, and lets one control another.
 */

interface RemoteStore {
  snap: ConnectSnapshot | null;
  /** Commands sent from here, shown right away (the device confirms with its new state). */
  pending: Record<string, RemoteState["status"]>;
  command: (peer: RemotePeer, action: RemoteAction, position?: number) => Promise<void>;
  /** Moves what another device plays to this one, at the same spot, and pauses it there. */
  playHere: (peer: RemotePeer) => void;
}

/** Where a remote song is now, worked out from when its state arrived. */
export function positionOf(state: NonNullable<RemotePeer["state"]>, now = Date.now()): number {
  const p = state.status === "playing" ? state.position + (now - state.receivedAt) / 1000 : state.position;
  return state.duration ? Math.min(p, state.duration) : p;
}

export const useRemote = create<RemoteStore>((set, get) => ({
  snap: null,
  pending: {},

  command: async (peer, action, position) => {
    if (action === "play" || action === "pause") set((s) => ({ pending: { ...s.pending, [peer.id]: action === "play" ? "playing" : "paused" } }));
    const answered = await api.connectCommand(peer.id, action, position).catch(() => false);
    set((s) => {
      const { [peer.id]: _done, ...pending } = s.pending;
      return { pending };
    });
    if (!answered) toast(getT().remote.notAnswering(peer.name), "error");
  },

  playHere: (peer) => {
    if (!peer.state) return;
    const at = positionOf(peer.state);
    const player = usePlayer.getState();
    player.playList([peer.state.track], 0);
    usePlayer.getState().seek(at);
    if (peer.state.status === "playing") void get().command(peer, "pause");
  },
}));

/** The device to show in the "Playing on…" bar: one that plays, or failing that one paused lately while this one is idle. */
export function useRemotePeer(): RemotePeer | null {
  const snap = useRemote((s) => s.snap);
  const localPlaying = usePlayer((s) => s.status === "playing" || s.status === "loading");
  if (!snap?.enabled) return null;
  const now = Date.now();
  const live = snap.peers.filter((p) => {
    if (!p.state) return false;
    if (p.state.status === "playing") return !p.state.duration || positionOf(p.state, now) < p.state.duration + 15;
    return !localPlaying && now - p.state.receivedAt < 30 * 60_000;
  });
  return live.find((p) => p.state!.status === "playing") ?? live.sort((a, b) => b.state!.receivedAt - a.state!.receivedAt)[0] ?? null;
}

// ---- Listening ----

let since = -1;
let handled = 0;

function apply(cmd: ConnectSnapshot["commands"][number]) {
  const p = usePlayer.getState();
  const playing = p.status === "playing" || p.status === "loading";
  if (cmd.action === "play" && !playing) p.toggle();
  else if (cmd.action === "pause" && playing) p.toggle();
  else if (cmd.action === "next") p.next();
  else if (cmd.action === "previous") p.prev();
  else if (cmd.action === "seek" && typeof cmd.position === "number") p.seek(cmd.position);
  // The new state is the answer. When nothing changed (already paused), send it anyway, so the other device knows
  // this one heard: once the player has settled, and only if no state went out meanwhile.
  const before = sent;
  setTimeout(() => sent === before && report(true), 800);
}

async function listen() {
  for (;;) {
    try {
      const snap = await api.connectWait(since);
      // The first answer only says where things stand: commands from before this app opened aren't for now.
      if (since < 0) handled = Math.max(handled, ...snap.commands.map((c) => c.seq), 0);
      since = snap.seq;
      useRemote.setState({ snap });
      for (const cmd of snap.commands) {
        if (cmd.seq <= handled) continue;
        handled = cmd.seq;
        apply(cmd);
      }
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// ---- Telling the others ----

let last: { id: string; status: RemoteState["status"]; position: number; at: number } | null = null;
let sent = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Sends this device's state if it changed in a way the others would see (song, play/pause, a jump). */
function report(force = false) {
  if (!useRemote.getState().snap?.enabled) return;
  const s = usePlayer.getState();
  const track = s.queue[s.index];
  if (!track || s.status === "idle") {
    if (last || force) {
      sent++;
      void api.connectState(null).catch(() => {});
    }
    last = null;
    return;
  }
  // A song that is loading is about to play.
  const status: RemoteState["status"] = s.status === "playing" || s.status === "loading" ? "playing" : "paused";
  const now = Date.now();
  const expected = last ? last.position + (last.status === "playing" ? (now - last.at) / 1000 : 0) : 0;
  const same = last && last.id === track.id && last.status === status && Math.abs(s.position - expected) < 4;
  if (same && !force) return;
  last = { id: track.id, status, position: s.position, at: now };
  sent++;
  void api.connectState({ track, status, position: s.position, duration: s.duration || track.duration }).catch(() => {});
}

usePlayer.subscribe((now, before) => {
  // Starting here pauses the others: one device plays at a time.
  const wasPlaying = before.status === "playing" || before.status === "loading";
  if (now.status === "playing" && !wasPlaying) {
    for (const peer of useRemote.getState().snap?.peers ?? []) {
      if (peer.state?.status === "playing") void useRemote.getState().command(peer, "pause");
    }
  }
  clearTimeout(timer);
  timer = setTimeout(() => report(), 400);
});

// When the link comes on (or the app opens linked), the others learn what plays here.
useRemote.subscribe((now, before) => {
  if (now.snap?.enabled && !before.snap?.enabled) report(true);
});

void listen();
