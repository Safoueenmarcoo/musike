import type { Track } from "./types.js";

// No Node-only imports here: the Android app runs this same module (the LAN host is in connectLan.ts, Node only).

/**
 * Musike Connect: see on one device what another is playing, and control it (play, pause, skip, seek).
 *
 * Devices linked with the same GitHub token (sync.ts) share a secret: messages are encrypted with a key derived from
 * it (AES-GCM), so only those devices can read or forge them. They travel two ways:
 *  - on the same network, directly: the desktop app listens on the LAN (connectLan.ts) and the phone asks it for news
 *    every second;
 *  - otherwise through a public relay (ntfy.sh), on a topic named after the same secret.
 * The relay's free tier allows a few hundred messages a day, so nothing is sent on a timer while playing: only what
 * changes (song, play/pause, seek, a command), and the position is worked out from the time a state arrived.
 */

export type DeviceKind = "desktop" | "android" | "web";
export type Action = "play" | "pause" | "next" | "previous" | "seek";

export interface PlayState {
  track: Track;
  status: "playing" | "paused";
  /** Seconds, when the state was sent. */
  position: number;
  duration: number;
}

export interface Peer {
  id: string;
  name: string;
  kind: DeviceKind;
  /** How it was last heard from. */
  via: "lan" | "relay";
  /** Its state and when it arrived here (this device's clock), so the position can be extrapolated. */
  state: (PlayState & { receivedAt: number }) | null;
  lastSeen: number;
}

export interface Command {
  seq: number;
  from: string;
  action: Action;
  position?: number;
}

export interface ConnectSnapshot {
  enabled: boolean;
  self: { id: string; name: string; kind: DeviceKind } | null;
  peers: Peer[];
  /** Commands for this device, newer than the `since` asked for. */
  commands: Command[];
  seq: number;
  /** "limited": the relay's daily allowance is used up (devices on the same Wi-Fi still talk). */
  relay: "off" | "connecting" | "ok" | "down" | "limited";
}

/** Small named files: this device's id. */
export interface ConnectStore {
  read(name: string): Promise<string | null>;
  write(name: string, text: string): Promise<void>;
}

export interface ConnectOptions {
  token: string;
  store: ConnectStore;
  name: string;
  kind: DeviceKind;
  relayUrl: string;
  /** For the relay (https). */
  fetch: typeof fetch;
  /** A device that hosts the LAN endpoint (the desktop app) gives its addresses; the others poll a host. */
  host?: { urls: () => string[] };
  /** For the LAN (plain http to the host): the Android app goes through its native HTTP. */
  lanFetch?: typeof fetch;
}

interface Msg {
  id: string;
  from: string;
  name: string;
  kind: DeviceKind;
  ts: number;
  type: "hello" | "here" | "state" | "cmd" | "bye" | "poll";
  to?: string;
  lan?: string[];
  state?: PlayState | null;
  action?: Action;
  position?: number;
}

const LAN_POLL_MS = 1000;
const LAN_GONE_MS = 15_000;
const RELAY_GONE_MS = 35 * 60_000;
const KEEPALIVE_MS = 15 * 60_000;
const MAX_SKEW_MS = 10 * 60_000;
const ANSWER_MS = 8000;
const ID_FILE = "connect.json";

const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const unref = (t: unknown) => (t as { unref?: () => void } | undefined)?.unref?.();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomId = () => hex(crypto.getRandomValues(new Uint8Array(8)).buffer as ArrayBuffer);

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** The secret both devices derive from the token: a key, and the relay topic name. */
export async function secretsFor(token: string) {
  const key = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", enc.encode(`musike-connect-key:${token}`)), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  const topic = `musike-${hex(await crypto.subtle.digest("SHA-256", enc.encode(`musike-connect-topic:${token}`))).slice(0, 32)}`;
  return { key, topic };
}

export async function seal(key: CryptoKey, msg: Msg): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(msg))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toBase64(out);
}

export async function unseal(key: CryptoKey, text: unknown): Promise<Msg | null> {
  if (typeof text !== "string" || text.length > 16_000) return null;
  try {
    const bytes = fromBase64(text.trim());
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
    const msg = JSON.parse(dec.decode(plain)) as Msg;
    return msg && typeof msg.id === "string" && typeof msg.from === "string" && typeof msg.ts === "number" ? msg : null;
  } catch {
    return null; // not ours, or tampered with
  }
}

// ---- State ----

let opts: ConnectOptions | null = null;
let key: CryptoKey | null = null;
let topic = "";
let selfId = "";
let generation = 0;
let relayStatus: ConnectSnapshot["relay"] = "off";
let relayLimitedUntil = 0;
let relayAbort: AbortController | null = null;
const peers = new Map<string, Peer>();
const seen = new Set<string>();
const commands: Command[] = [];
let seq = 0;
let localState: PlayState | null = null;
let localAt = 0;
const waiters = new Set<() => void>();
let timers: ReturnType<typeof setInterval>[] = [];

// LAN, host side: what each client polling this device hasn't picked up yet, and when it last asked.
const mailboxes = new Map<string, string[]>();
const clientsSeen = new Map<string, number>();
// LAN, client side: messages waiting for the next poll, the host addresses known, the one that answers.
let outbox: string[] = [];
let lanHosts: string[] = [];
let lanUp: string | null = null;
let lanHostId: string | null = null;

function changed() {
  seq++;
  for (const w of [...waiters]) w();
}

const isHost = () => !!opts?.host;

function base(type: Msg["type"]): Msg {
  return { id: randomId(), from: selfId, name: opts!.name, kind: opts!.kind, ts: Date.now(), type, ...(isHost() ? { lan: opts!.host!.urls() } : {}) };
}

/** Whether the relay is worth a message: someone may only be reachable through it. */
function relayNeeded(msg: Msg): boolean {
  if (msg.to) return peers.get(msg.to)?.via !== "lan";
  if (msg.type === "hello") return true;
  return [...peers.values()].some((p) => p.via === "relay") || (!isHost() && !lanUp && peers.size === 0);
}

async function send(msg: Msg) {
  if (!key) return;
  const sealed = await seal(key, msg);
  // Same network: straight to the clients polling this device, or to the host this device polls.
  if (isHost()) {
    const now = Date.now();
    for (const [client, at] of clientsSeen) {
      if (now - at > LAN_GONE_MS || (msg.to && msg.to !== client)) continue;
      const box = mailboxes.get(client) ?? [];
      box.push(sealed);
      mailboxes.set(client, box.slice(-200));
    }
  } else if (lanUp && (!msg.to || peers.get(msg.to)?.via === "lan")) {
    outbox.push(sealed);
    outbox = outbox.slice(-200);
  }
  if (relayNeeded(msg)) await relaySend(sealed);
}

async function relaySend(sealed: string) {
  const o = opts;
  if (!o || Date.now() < relayLimitedUntil) return;
  try {
    const res = await o.fetch(`${o.relayUrl}/${topic}?cache=no&firebase=no`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: sealed,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after")) || 3600;
      relayLimitedUntil = Date.now() + Math.min(wait, 24 * 3600) * 1000;
      relayStatus = "limited";
      changed();
    }
    await res.body?.cancel().catch(() => {});
  } catch {
    // offline: the state goes out again with the next change
  }
}

function touch(msg: Msg, via: Peer["via"]): Peer {
  const now = Date.now();
  let peer = peers.get(msg.from);
  if (!peer) {
    peer = { id: msg.from, name: msg.name, kind: msg.kind, via, state: null, lastSeen: now };
    peers.set(msg.from, peer);
  }
  peer.name = String(msg.name || "").slice(0, 60) || peer.name;
  peer.kind = msg.kind === "android" || msg.kind === "web" ? msg.kind : "desktop";
  // A device heard on the LAN a moment ago stays a LAN device even if its message also came through the relay.
  if (via === "lan" || !(peer.via === "lan" && now - peer.lastSeen < LAN_GONE_MS)) peer.via = via;
  peer.lastSeen = now;
  if (Array.isArray(msg.lan)) {
    const urls = msg.lan.filter((u) => typeof u === "string" && /^http:\/\/[\w.:[\]-]+$/.test(u)).slice(0, 8);
    if (urls.length && !isHost()) {
      lanHosts = [...new Set([...urls, ...lanHosts])].slice(0, 8);
      void opts?.store.write("connect-hosts.json", JSON.stringify(lanHosts)).catch(() => {});
    }
  }
  return peer;
}

async function receive(msg: Msg | null, via: Peer["via"]) {
  if (!msg || msg.from === selfId || seen.has(msg.id)) return;
  if (Math.abs(Date.now() - msg.ts) > MAX_SKEW_MS) return;
  seen.add(msg.id);
  if (seen.size > 1000) seen.delete(seen.values().next().value!);
  if (msg.to && msg.to !== selfId) return;
  if (msg.type === "bye") {
    peers.delete(msg.from);
    return changed();
  }
  const peer = touch(msg, via);
  if (via === "lan" && msg.lan?.length) lanHostId = msg.from;
  if (msg.type === "state") peer.state = msg.state ? { ...msg.state, receivedAt: Date.now() } : null;
  if (msg.type === "hello") {
    // Someone new (or back): tell it who's here and what's playing, the way it came.
    await send({ ...base("here"), to: msg.from });
    if (localState) await send({ ...base("state"), to: msg.from, state: currentState() });
  }
  if (msg.type === "cmd" && msg.action) {
    commands.push({ seq: seq + 1, from: msg.from, action: msg.action, ...(typeof msg.position === "number" ? { position: msg.position } : {}) });
    if (commands.length > 50) commands.shift();
  }
  changed();
}

/** The local state with its position brought up to now. */
function currentState(): PlayState | null {
  if (!localState || localState.status !== "playing") return localState;
  const position = localState.position + (Date.now() - localAt) / 1000;
  return { ...localState, position: localState.duration ? Math.min(position, localState.duration) : position };
}

// ---- Relay ----

async function relayLoop(gen: number) {
  let backoff = 1000;
  while (gen === generation && opts) {
    relayAbort = new AbortController();
    try {
      relayStatus = Date.now() < relayLimitedUntil ? "limited" : "connecting";
      const res = await opts.fetch(`${opts.relayUrl}/${topic}/json`, { signal: relayAbort.signal });
      if (!res.ok || !res.body) throw new Error(`relay ${res.status}`);
      if (Date.now() >= relayLimitedUntil) relayStatus = "ok";
      changed();
      backoff = 1000;
      let hello = false;
      let buffer = "";
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let event: { event?: string; message?: string };
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.event === "open" && !hello) {
            hello = true;
            // Listening now: say hello, so the others answer through here.
            void send(base("hello"));
          }
          if (event.event === "message" && key) await receive(await unseal(key, event.message), "relay");
        }
      }
    } catch {
      // dropped, or offline
    }
    if (gen !== generation) return;
    if (relayStatus !== "limited") relayStatus = "down";
    changed();
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 60_000);
  }
}

// ---- LAN, client side ----

async function lanLoop(gen: number) {
  const o = opts!;
  if (!o.lanFetch) return;
  try {
    const saved = JSON.parse((await o.store.read("connect-hosts.json")) ?? "[]") as unknown;
    if (Array.isArray(saved)) lanHosts = saved.filter((u): u is string => typeof u === "string").slice(0, 8);
  } catch {
    // none known yet: the relay's answers bring them
  }
  let saidHello = false;
  while (gen === generation) {
    const candidates = lanUp ? [lanUp, ...lanHosts.filter((u) => u !== lanUp)] : lanHosts;
    let ok = false;
    for (const url of candidates) {
      if (gen !== generation || !key) return;
      const msgs = outbox;
      outbox = [];
      try {
        const res = await o.lanFetch(`${url}/musike-connect`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from: selfId, auth: await seal(key, base("poll")), msgs }),
          signal: AbortSignal.timeout(lanUp === url ? 4000 : 2000),
        });
        if (!res.ok) throw new Error(String(res.status));
        const reply = (await res.json()) as { msgs?: unknown[] };
        const first = lanUp !== url;
        lanUp = url;
        ok = true;
        if (lanHostId && peers.get(lanHostId)) peers.get(lanHostId)!.lastSeen = Date.now();
        for (const m of reply.msgs ?? []) await receive(await unseal(key, m), "lan");
        if (first || !saidHello) {
          saidHello = true;
          void send(base("hello"));
        }
        break;
      } catch {
        outbox = [...msgs, ...outbox];
      }
    }
    if (!ok && lanUp) {
      lanUp = null;
      if (lanHostId) peers.get(lanHostId) && (peers.get(lanHostId)!.via = "relay");
      changed();
    }
    await sleep(ok ? LAN_POLL_MS : 5000);
  }
}

// ---- LAN, host side ----

/** A poll from a device on the LAN (connectLan.ts): its messages in, what is waiting for it out. Null: not one of ours. */
export async function handleLanPoll(body: unknown): Promise<{ msgs: string[] } | null> {
  if (!key || !isHost()) return null;
  const b = (body ?? {}) as { from?: unknown; auth?: unknown; msgs?: unknown };
  const auth = await unseal(key, b.auth);
  if (!auth || auth.type !== "poll" || auth.from !== b.from || Math.abs(Date.now() - auth.ts) > 2 * 60_000) return null;
  const client = auth.from;
  clientsSeen.set(client, Date.now());
  const peer = peers.get(client);
  if (peer) {
    peer.lastSeen = Date.now();
    peer.via = "lan";
  }
  for (const raw of Array.isArray(b.msgs) ? b.msgs.slice(0, 50) : []) {
    const msg = await unseal(key, raw);
    if (!msg || msg.from !== client) continue;
    // Passed on to the other devices polling here, so two phones on the Wi-Fi see each other too.
    if (!msg.to || msg.to !== selfId) {
      for (const [other, at] of clientsSeen) {
        if (other === client || Date.now() - at > LAN_GONE_MS || (msg.to && msg.to !== other)) continue;
        const box = mailboxes.get(other) ?? [];
        box.push(raw as string);
        mailboxes.set(other, box.slice(-200));
      }
    }
    await receive(msg, "lan");
  }
  const out = mailboxes.get(client) ?? [];
  mailboxes.set(client, []);
  return { msgs: out };
}

// ---- Housekeeping ----

function sweep() {
  const now = Date.now();
  let gone = false;
  for (const [id, p] of peers) {
    if (now - p.lastSeen > (p.via === "lan" ? LAN_GONE_MS : RELAY_GONE_MS)) {
      // A LAN device that went quiet may still be out there on the internet.
      if (p.via === "lan" && now - p.lastSeen < RELAY_GONE_MS) {
        p.via = "relay";
        continue;
      }
      peers.delete(id);
      gone = true;
    }
  }
  for (const [client, at] of clientsSeen) if (now - at > LAN_GONE_MS) clientsSeen.delete(client), mailboxes.delete(client);
  if (gone) changed();
}

// ---- API ----

export async function startConnect(o: ConnectOptions) {
  stopConnect(false);
  const gen = ++generation;
  opts = o;
  ({ key, topic } = await secretsFor(o.token));
  if (gen !== generation) return;
  try {
    const saved = JSON.parse((await o.store.read(ID_FILE)) ?? "{}") as { id?: unknown };
    selfId = typeof saved.id === "string" && /^[0-9a-f]{16}$/.test(saved.id) ? saved.id : "";
  } catch {
    selfId = "";
  }
  if (!selfId) {
    selfId = randomId();
    await o.store.write(ID_FILE, JSON.stringify({ id: selfId })).catch(() => {});
  }
  timers = [
    setInterval(sweep, 5000),
    // While someone is only reachable through the relay, say "still here" now and then.
    setInterval(() => [...peers.values()].some((p) => p.via === "relay") && void send(base("here")), KEEPALIVE_MS),
  ];
  timers.forEach(unref);
  void relayLoop(gen);
  if (!o.host) void lanLoop(gen);
  changed();
}

/** Tells the others this device is leaving, with what it had before everything below is cleared. */
async function farewell(o: ConnectOptions, k: CryptoKey, t: string, msg: Msg, lan: string | null) {
  const sealed = await seal(k, msg);
  // Sealed before any request starts: a request failing while another await runs would go unhandled.
  const auth = await seal(k, { ...msg, id: randomId(), type: "poll" });
  const quick = { signal: AbortSignal.timeout(3000) };
  await Promise.allSettled([
    o.fetch(`${o.relayUrl}/${t}?cache=no&firebase=no`, { method: "POST", headers: { "content-type": "text/plain" }, body: sealed, ...quick }),
    lan && o.lanFetch
      ? o.lanFetch(`${lan}/musike-connect`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from: msg.from, auth, msgs: [sealed] }),
          ...quick,
        })
      : null,
  ]);
}

export function stopConnect(sayBye = true) {
  if (sayBye && opts && key) void farewell(opts, key, topic, base("bye"), lanUp).catch(() => {});
  generation++;
  relayAbort?.abort();
  timers.forEach(clearInterval);
  timers = [];
  peers.clear();
  mailboxes.clear();
  clientsSeen.clear();
  outbox = [];
  lanUp = null;
  relayStatus = "off";
  opts = null;
  key = null;
  changed();
}

/** This device's playback, as the app reports it (on changes only). Null: nothing loaded. */
export async function setLocalState(state: PlayState | null) {
  localState = state;
  localAt = Date.now();
  if (opts) await send({ ...base("state"), state });
}

/** Asks another device to play, pause, skip or seek. Resolves false when it isn't answering. */
export async function sendCommand(to: string, action: Action, position?: number): Promise<boolean> {
  const peer = peers.get(to);
  if (!opts || !peer) return false;
  const sentAt = Date.now();
  await send({ ...base("cmd"), to, action, ...(position !== undefined ? { position } : {}) });
  // Its new state (or anything from it) is the answer.
  for (let waited = 0; waited < ANSWER_MS; waited += 250) {
    await sleep(250);
    const p = peers.get(to);
    if (!p) return false;
    if (p.lastSeen > sentAt) return true;
  }
  if (peers.get(to)?.via !== "lan") {
    peers.delete(to);
    changed();
  }
  return false;
}

export function connectSnapshot(since = 0): ConnectSnapshot {
  return {
    enabled: !!opts,
    self: opts ? { id: selfId, name: opts.name, kind: opts.kind } : null,
    peers: [...peers.values()].map((p) => ({ ...p })),
    commands: commands.filter((c) => c.seq > since),
    seq,
    relay: opts ? (Date.now() < relayLimitedUntil ? "limited" : relayStatus) : "off",
  };
}

/** The snapshot as soon as something newer than `since` happens, or after `timeoutMs` (long polling). */
export function waitConnect(since: number, timeoutMs = 25_000): Promise<ConnectSnapshot> {
  if (seq > since) return Promise.resolve(connectSnapshot(since));
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      waiters.delete(done);
      resolve(connectSnapshot(since));
    };
    const timer = setTimeout(done, timeoutMs);
    unref(timer);
    waiters.add(done);
  });
}
