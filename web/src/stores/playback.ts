import { create } from "zustand";

/**
 * How music plays on this device: speed, equalizer and data saver. Kept per device (like the language), since what
 * suits headphones on the phone may not suit the computer's speakers.
 */

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** The equalizer's bands (Hz), the same six Spotify uses. The lowest is a low shelf, the highest a high shelf. */
export const BANDS = [60, 150, 400, 1000, 2400, 15000] as const;
export const MAX_GAIN = 12;

export const PRESETS = {
  flat: [0, 0, 0, 0, 0, 0],
  bassBoost: [6, 4, 1, 0, 0, 0],
  bassCut: [-6, -4, -1, 0, 0, 0],
  trebleBoost: [0, 0, 0, 1, 4, 6],
  vocal: [-2, -1, 2, 4, 3, 0],
  acoustic: [3, 2, 1, 1, 2, 3],
  electronic: [5, 3, 0, -1, 2, 4],
  rock: [4, 2, -1, 0, 2, 4],
  pop: [-1, 1, 3, 3, 1, -1],
  loudness: [5, 2, 0, 0, 2, 5],
} as const satisfies Record<string, readonly number[]>;
export type Preset = keyof typeof PRESETS | "custom";

/** Off, only on mobile data (the phone app), or always. */
export type DataSaver = "off" | "mobile" | "always";

interface Saved {
  speed: number;
  eqOn: boolean;
  preset: Preset;
  gains: number[];
  dataSaver: DataSaver;
}

interface PlaybackState extends Saved {
  setSpeed: (speed: number) => void;
  setEqOn: (on: boolean) => void;
  setPreset: (preset: Exclude<Preset, "custom">) => void;
  setGain: (band: number, gain: number) => void;
  setDataSaver: (mode: DataSaver) => void;
}

const KEY = "musike:playback";
const clampGain = (g: number) => Math.max(-MAX_GAIN, Math.min(MAX_GAIN, Math.round(g * 2) / 2));

function read(): Saved {
  const fallback: Saved = { speed: 1, eqOn: false, preset: "flat", gains: [...PRESETS.flat], dataSaver: "off" };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Saved>;
    const gains = Array.isArray(s.gains) && s.gains.length === BANDS.length && s.gains.every((g) => typeof g === "number") ? s.gains.map(clampGain) : fallback.gains;
    return {
      speed: SPEEDS.includes(s.speed as (typeof SPEEDS)[number]) ? (s.speed as number) : 1,
      eqOn: s.eqOn === true,
      preset: typeof s.preset === "string" && (s.preset === "custom" || s.preset in PRESETS) ? s.preset : "flat",
      gains,
      dataSaver: s.dataSaver === "mobile" || s.dataSaver === "always" ? s.dataSaver : "off",
    };
  } catch {
    return fallback;
  }
}

export const usePlayback = create<PlaybackState>((set) => ({
  ...read(),
  setSpeed: (speed) => set({ speed: SPEEDS.includes(speed as (typeof SPEEDS)[number]) ? speed : 1 }),
  setEqOn: (eqOn) => set({ eqOn }),
  setPreset: (preset) => set({ preset, gains: [...PRESETS[preset]] }),
  setGain: (band, gain) =>
    set((s) => {
      const gains = s.gains.slice();
      gains[band] = clampGain(gain);
      const same = (Object.keys(PRESETS) as (keyof typeof PRESETS)[]).find((p) => PRESETS[p].every((g, i) => g === gains[i]));
      return { gains, preset: same ?? "custom" };
    }),
  setDataSaver: (dataSaver) => set({ dataSaver }),
}));

usePlayback.subscribe((s) => {
  try {
    const { speed, eqOn, preset, gains, dataSaver } = s;
    localStorage.setItem(KEY, JSON.stringify({ speed, eqOn, preset, gains, dataSaver }));
  } catch {
    /* storage unavailable: kept for this session */
  }
});

/** Whether the data saver applies right now: always, or on mobile data when the phone says that's what it's on. */
export function savingData(): boolean {
  const mode = usePlayback.getState().dataSaver;
  if (mode === "always") return true;
  if (mode === "off") return false;
  const connection = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection;
  return connection?.type === "cellular" || connection?.saveData === true;
}
