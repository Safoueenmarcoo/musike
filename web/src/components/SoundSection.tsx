import { useT } from "../i18n";
import { capabilities } from "../lib/api";
import { cn } from "../lib/format";
import { canEqualize } from "../player/player";
import { BANDS, MAX_GAIN, PRESETS, SPEEDS, usePlayback, type DataSaver } from "../stores/playback";
import { Segmented } from "./Segmented";
import { Slider } from "./Slider";

/** An on/off switch styled like the rest of Settings. */
function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cn("relative h-6 w-10 shrink-0 rounded-full transition-colors duration-200", on ? "bg-accent" : "bg-surface-4")}
    >
      <span
        className={cn(
          "absolute top-1 left-1 size-4 rounded-full transition-transform duration-200 ease-out-expo",
          on ? "translate-x-4 bg-accent-ink" : "bg-fg-2",
        )}
      />
    </button>
  );
}

/** Settings: playback speed, the equalizer and (on the phone) the data saver. */
export function SoundSection() {
  const { speed, eqOn, preset, gains, dataSaver, setSpeed, setEqOn, setPreset, setGain, setDataSaver } = usePlayback();
  const t = useT();
  const s = t.sound;

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-medium text-fg-3">{s.title}</h3>

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">{s.speed}</p>
        <Segmented dense label={s.speed} value={String(speed)} onChange={(v) => setSpeed(Number(v))} options={SPEEDS.map((x) => [String(x), s.speedValue(x)])} />
      </div>

      {canEqualize && (
        <div className="flex flex-col gap-3 rounded-[16px] bg-surface-1 p-4 ring-1 ring-line">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">{s.equalizer}</p>
              <p className="text-xs text-fg-2">{s.equalizerBody}</p>
            </div>
            <Switch on={eqOn} label={s.equalizer} onChange={setEqOn} />
          </div>
          <div className={cn("flex flex-col gap-3 transition-opacity", !eqOn && "pointer-events-none opacity-40")} aria-disabled={!eqOn}>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="text-fg-2">{s.preset}</span>
              <select
                value={preset}
                disabled={!eqOn}
                onChange={(e) => e.target.value !== "custom" && setPreset(e.target.value as keyof typeof PRESETS)}
                className="h-9 min-w-0 rounded-full bg-surface-2 px-3 text-sm ring-1 ring-line"
              >
                {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((p) => (
                  <option key={p} value={p}>
                    {s.presets[p]}
                  </option>
                ))}
                {preset === "custom" && <option value="custom">{s.presets.custom}</option>}
              </select>
            </label>
            {BANDS.map((hz, i) => (
              <div key={hz} className="grid grid-cols-[4rem_1fr_3.5rem] items-center gap-3">
                <span className="font-mono text-xs text-fg-2 tabular-nums">{s.band(hz)}</span>
                <Slider
                  label={s.band(hz)}
                  value={(gains[i] ?? 0) + MAX_GAIN}
                  max={MAX_GAIN * 2}
                  step={0.5}
                  live
                  showThumb
                  onChange={(v) => setGain(i, v - MAX_GAIN)}
                  valueText={(v) => s.gain(v - MAX_GAIN)}
                />
                <span className="text-right font-mono text-xs text-fg-2 tabular-nums">{s.gain(gains[i] ?? 0)}</span>
              </div>
            ))}
            {preset !== "flat" && (
              <button type="button" onClick={() => setPreset("flat")} className="self-end text-xs font-medium text-fg-2 hover:text-fg">
                {s.reset}
              </button>
            )}
          </div>
        </div>
      )}

      {capabilities.dataSaver && (
        <div className="flex flex-col gap-2">
          <div>
            <p className="text-sm font-medium">{s.dataSaver}</p>
            <p className="text-xs text-fg-2">{s.dataSaverBody}</p>
          </div>
          <Segmented<DataSaver>
            label={s.dataSaver}
            value={dataSaver}
            onChange={setDataSaver}
            options={[
              ["off", s.dataSaverOff],
              ["mobile", s.dataSaverMobile],
              ["always", s.dataSaverAlways],
            ]}
          />
        </div>
      )}
    </section>
  );
}
