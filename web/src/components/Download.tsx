import { ArrowCircleDownIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useT } from "../i18n";
import { capabilities } from "../lib/api";
import { cn } from "../lib/format";
import type { Track } from "../lib/types";
import { useDownloadProgress, useDownloads, useDownloadStatus } from "../stores/downloads";
import { IconButton } from "./IconButton";
import { Modal } from "./Modal";

/** A ring that fills as a download arrives. It turns while the song waits its turn or its size isn't known yet. */
export function ProgressRing({ value, size = 18, className }: { value: number | null; size?: number; className?: string }) {
  const radius = 8;
  const around = 2 * Math.PI * radius;
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      aria-hidden="true"
      className={cn("shrink-0", value === null && "animate-spin", className)}
    >
      <circle cx="10" cy="10" r={radius} fill="none" stroke="currentColor" strokeWidth="2.4" opacity="0.25" />
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeDasharray={around}
        strokeDashoffset={around * (1 - (value ?? 0.25))}
        transform="rotate(-90 10 10)"
      />
    </svg>
  );
}

/** A small mark beside a track's artist: saved on this device, on its way, or failed. Nothing when it isn't downloaded. */
export function DownloadBadge({ id, size = 14 }: { id: string; size?: number }) {
  const status = useDownloadStatus(id);
  const progress = useDownloadProgress(id);
  const t = useT();
  if (status === "none") return null;
  if (status === "done") {
    return <ArrowCircleDownIcon size={size} weight="fill" className="shrink-0 text-accent-text" aria-label={t.downloads.downloaded} />;
  }
  if (status === "error") {
    return <WarningCircleIcon size={size} weight="fill" className="shrink-0 text-danger" aria-label={t.downloads.retry} />;
  }
  return (
    <span role="img" aria-label={status === "queued" ? t.downloads.waiting : t.downloads.downloading} className="shrink-0 text-accent-text">
      <ProgressRing value={progress} size={size - 1} />
    </span>
  );
}

/** One track's download switch: download it, cancel it while it's on its way, remove it once saved. */
export function DownloadButton({ track, size = "md", className }: { track: Track | null; size?: "sm" | "md" | "lg"; className?: string }) {
  const status = useDownloadStatus(track?.id);
  const progress = useDownloadProgress(track?.id);
  const download = useDownloads((s) => s.download);
  const remove = useDownloads((s) => s.remove);
  const t = useT();
  if (!capabilities.downloads) return null;

  const glyph = size === "lg" ? 24 : 19;
  const busy = status === "queued" || status === "downloading";
  const label =
    status === "done" ? t.downloads.remove : busy ? t.downloads.cancel : status === "error" ? t.downloads.retry : t.downloads.download;

  return (
    <IconButton
      label={label}
      active={status === "done" || busy}
      size={size}
      disabled={!track}
      className={className}
      onClick={() => track && void (status === "done" || busy ? remove([track.id]) : download([track]))}
    >
      {busy ? (
        <ProgressRing value={progress} size={glyph - 1} />
      ) : (
        <ArrowCircleDownIcon size={glyph} weight={status === "done" ? "fill" : "regular"} />
      )}
      {status === "error" && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-danger" />}
    </IconButton>
  );
}

/**
 * Downloads a whole list (a playlist, the favorites, an album). While songs arrive it shows how far along the list
 * is, and tapping cancels what is left; once everything is saved it offers to remove the list from the device.
 */
export function DownloadAllButton({ tracks, variant = "icon" }: { tracks: Track[]; variant?: "icon" | "pill" }) {
  const ids = useMemo(() => [...new Set(tracks.map((track) => track.id))], [tracks]);
  const { saved, busy, portion } = useDownloads(
    useShallow((s) => {
      let saved = 0;
      let busy = 0;
      let portion = 0;
      for (const id of ids) {
        if (s.saved[id]) saved++;
        else {
          const job = s.active[id];
          if (!job || job.status === "error") continue;
          busy++;
          if (job.total) portion += job.received / job.total;
        }
      }
      // Rounded, so the button redraws about a hundred times per list instead of on every chunk of every song.
      return { saved, busy, portion: Math.round(((saved + portion) / Math.max(1, ids.length)) * 100) / 100 };
    }),
  );
  const download = useDownloads((s) => s.download);
  const remove = useDownloads((s) => s.remove);
  const [confirming, setConfirming] = useState(false);
  const t = useT();
  if (!capabilities.downloads || !ids.length) return null;

  const total = ids.length;
  const complete = saved === total;
  const label = complete
    ? t.downloads.allDownloaded
    : busy
      ? t.downloads.cancelAll
      : saved
        ? t.downloads.downloadMissing(total - saved)
        : t.downloads.downloadAll;

  const onClick = () => {
    if (complete) return setConfirming(true);
    if (busy) {
      const { active } = useDownloads.getState();
      return void remove(ids.filter((id) => active[id] && active[id].status !== "error"));
    }
    void download(tracks);
  };

  const glyph = busy ? (
    <ProgressRing value={portion} size={variant === "pill" ? 18 : 23} />
  ) : (
    <ArrowCircleDownIcon size={variant === "pill" ? 18 : 24} weight={complete ? "fill" : "regular"} />
  );

  return (
    <>
      {variant === "pill" ? (
        <button
          type="button"
          onClick={onClick}
          title={label}
          aria-label={label}
          className={cn(
            "flex h-11 items-center gap-2 rounded-full px-4 text-sm font-medium transition-transform active:scale-[0.97]",
            complete || busy ? "bg-accent-soft text-accent-text" : "bg-surface-3 hover:bg-surface-4",
          )}
        >
          {glyph}
          {complete ? t.downloads.downloaded : busy ? t.downloads.downloadingOf(saved, total) : t.downloads.download}
        </button>
      ) : (
        <IconButton label={label} size="lg" active={complete || busy > 0} onClick={onClick}>
          {glyph}
        </IconButton>
      )}

      <Modal open={confirming} onClose={() => setConfirming(false)} title={t.downloads.removeTitle}>
        <p className="text-sm text-fg-2">{t.downloads.removeBody(saved)}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => setConfirming(false)} className="h-11 rounded-full px-5 text-sm font-medium text-fg-2 hover:text-fg">
            {t.common.cancel}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              void remove(ids);
            }}
            className="h-11 rounded-full bg-danger px-6 text-sm font-semibold text-white"
          >
            {t.downloads.removeConfirm}
          </button>
        </div>
      </Modal>
    </>
  );
}
