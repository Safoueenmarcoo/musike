import { BANDS, MAX_GAIN } from "../stores/playback";

/**
 * The equalizer: the media elements' sound goes through six filters before reaching the speakers (Web Audio).
 *
 * An element is only routed through it once the equalizer is first turned on: from then on its sound can only come
 * out through the graph (that's how Web Audio works), so turning it off sets every band to 0 dB instead. The stream
 * has to come from the page's own origin (the Musike server, or the Android app's stream proxy) or the browser
 * silences it.
 */

let ctx: AudioContext | null = null;
let filters: BiquadFilterNode[] = [];
let preamp: GainNode | null = null;
const routed = new WeakSet<HTMLMediaElement>();

function graph(): AudioContext | null {
  if (ctx) return ctx;
  const Ctx = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  ctx = new Ctx();
  preamp = ctx.createGain();
  filters = BANDS.map((hz, i) => {
    const f = ctx!.createBiquadFilter();
    f.type = i === 0 ? "lowshelf" : i === BANDS.length - 1 ? "highshelf" : "peaking";
    f.frequency.value = hz;
    f.Q.value = 1.1;
    f.gain.value = 0;
    return f;
  });
  let node: AudioNode = preamp;
  for (const f of filters) {
    node.connect(f);
    node = f;
  }
  node.connect(ctx.destination);
  return ctx;
}

/** True when this platform can equalize (a real media element and Web Audio). */
export function equalizerSupported(media: unknown): boolean {
  return media instanceof HTMLMediaElement && !!(globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext);
}

/** Routes `media` through the equalizer (once; later calls do nothing). */
export function route(media: HTMLMediaElement): boolean {
  if (routed.has(media)) return true;
  const c = graph();
  if (!c || !preamp) return false;
  try {
    c.createMediaElementSource(media).connect(preamp);
    routed.add(media);
    any = true;
    return true;
  } catch {
    return false;
  }
}

export const isRouted = (media: HTMLMediaElement) => routed.has(media);

let any = false;
/** Whether anything has been routed through the equalizer since the app started (streams must be same-origin). */
export const everRouted = () => any;

/** Sets the bands (dB). Boosts are paid for with a lower overall level, so loud songs don't clip. */
export function setGains(gains: readonly number[], on: boolean) {
  if (!ctx || !preamp) return;
  const now = ctx.currentTime;
  filters.forEach((f, i) => f.gain.setTargetAtTime(on ? Math.max(-MAX_GAIN, Math.min(MAX_GAIN, gains[i] ?? 0)) : 0, now, 0.03));
  const boost = on ? Math.max(0, ...gains) : 0;
  preamp.gain.setTargetAtTime(Math.pow(10, -(boost * 0.6) / 20), now, 0.03);
}

/** Browsers start audio graphs suspended until the page is interacted with; playing counts. */
export function wake() {
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
}
