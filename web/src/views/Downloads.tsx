import {
  ArrowCircleDownIcon,
  ArrowClockwiseIcon,
  DotsThreeIcon,
  PauseIcon,
  PlayIcon,
  ShuffleIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Artwork } from "../components/Artwork";
import { Cover } from "../components/Cover";
import { IconButton, PlayDisc } from "../components/IconButton";
import { Modal } from "../components/Modal";
import { EmptyState, PageHeader } from "../components/Page";
import { TrackList } from "../components/TrackList";
import { useT } from "../i18n";
import { cn, formatBytes, shuffled } from "../lib/format";
import { paths } from "../lib/routes";
import type { DownloadJob } from "../lib/types";
import { usePlayer } from "../player/player";
import { useDownloads } from "../stores/downloads";

/** One download that hasn't finished: how far it is, with a way to cancel it, or why it failed and a way to retry. */
function JobRow({ job }: { job: DownloadJob }) {
  const download = useDownloads((s) => s.download);
  const remove = useDownloads((s) => s.remove);
  const t = useT();
  const { track, status } = job;
  const pct = job.total > 0 ? Math.min(100, Math.round((job.received / job.total) * 100)) : 0;
  const failed = status === "error";

  return (
    <li className="flex items-center gap-3 rounded-xl px-2 py-1.5 md:px-3">
      <Artwork src={track.thumb} trackId={track.id} className="size-11 rounded-[10px]" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] leading-tight font-medium">{track.title}</p>
        {failed ? (
          <p className="mt-0.5 line-clamp-2 text-[13px] text-danger">{job.error}</p>
        ) : (
          <div className="mt-1.5 flex items-center gap-2">
            <span
              role="progressbar"
              aria-label={t.downloads.downloading}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              className="h-1 flex-1 overflow-hidden rounded-full bg-surface-4"
            >
              <span
                className={cn("block h-full rounded-full bg-accent transition-[width] duration-500 ease-out", status === "queued" && "opacity-0")}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="w-24 shrink-0 text-right font-mono text-[12px] text-fg-3 tabular-nums">
              {status === "queued"
                ? t.downloads.waitingShort
                : job.total > 0
                  ? `${formatBytes(job.received, t.locale)} · ${pct}%`
                  : formatBytes(job.received, t.locale)}
            </span>
          </div>
        )}
      </div>
      {failed && (
        <IconButton label={t.downloads.retry} size="sm" onClick={() => void download([track])}>
          <ArrowClockwiseIcon size={17} />
        </IconButton>
      )}
      <IconButton label={failed ? t.downloads.dismiss : t.downloads.cancel} size="sm" onClick={() => void remove([track.id])}>
        <XIcon size={17} />
      </IconButton>
    </li>
  );
}

/** Every song saved on this device, newest first, with the downloads still under way on top. */
export default function Downloads() {
  const items = useDownloads((s) => s.items);
  const jobs = useDownloads((s) => s.jobs);
  const bytes = useDownloads((s) => s.bytes);
  const ready = useDownloads((s) => s.status === "ready");
  const remove = useDownloads((s) => s.remove);
  const removeAll = useDownloads((s) => s.removeAll);
  const playList = usePlayer((s) => s.playList);
  const toggle = usePlayer((s) => s.toggle);
  const queue = usePlayer((s) => s.queue);
  const status = usePlayer((s) => s.status);
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const t = useT();

  const tracks = useMemo(() => items.map((item) => item.track), [items]);
  const running = jobs.filter((job) => job.status !== "error");
  // The queue holds exactly these tracks, so this page is the current playback context.
  const isThisPlaying = tracks.length > 0 && queue.length === tracks.length && queue.every((q) => tracks.some((x) => x.id === q.id));
  const playing = isThisPlaying && (status === "playing" || status === "loading");

  return (
    <div className="pb-8">
      <PageHeader title={t.downloads.title} mobileOnly />

      <div className="relative">
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-20 h-72 bg-linear-to-b from-accent-soft to-transparent" />
        <div className="relative flex flex-col items-center gap-5 px-4 pt-2 pb-6 md:flex-row md:items-end md:gap-6 md:px-6 md:pt-10">
          <Cover
            kind="downloads"
            tracks={[]}
            iconSize={64}
            className="size-44 shrink-0 rounded-[18px] shadow-[0_24px_60px_rgb(0_0_0/0.4)] md:size-52"
          />
          <div className="flex min-w-0 flex-col items-center gap-2 text-center md:items-start md:text-left">
            <span className="hidden text-xs font-medium text-fg-2 md:block">{t.downloads.label}</span>
            <h1 className="max-w-full text-[28px] leading-[1.1] font-bold tracking-tight break-words md:text-5xl lg:text-6xl">
              {t.downloads.title}
            </h1>
            <p className="font-mono text-[13px] text-fg-2">{t.downloads.summary(items.length, formatBytes(bytes, t.locale))}</p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 px-4 pb-4 md:px-6">
        <PlayDisc
          label={playing ? t.common.pause : t.common.playX(t.downloads.title)}
          px={56}
          disabled={!tracks.length}
          onClick={() => (isThisPlaying ? toggle() : playList(tracks, 0))}
        >
          {playing ? <PauseIcon size={24} weight="fill" /> : <PlayIcon size={24} weight="fill" />}
        </PlayDisc>
        <IconButton label={t.collection.shuffle} size="lg" disabled={!tracks.length} onClick={() => playList(shuffled(tracks), 0)}>
          <ShuffleIcon size={24} />
        </IconButton>
        <IconButton label={t.downloads.more} size="lg" disabled={!tracks.length} onClick={() => setMoreOpen(true)}>
          <DotsThreeIcon size={26} weight="bold" />
        </IconButton>
      </div>

      {jobs.length > 0 && (
        <section className="mb-4 px-2 md:px-3">
          <div className="flex items-center justify-between gap-3 px-2 pb-1 md:px-3">
            <h2 className="text-xs font-medium tracking-wide text-fg-3">
              {running.length ? `${t.downloads.inProgress} · ${running.length}` : `${t.downloads.notDownloadedTitle} · ${jobs.length}`}
            </h2>
            {running.length > 1 && (
              <button
                type="button"
                onClick={() => void remove(running.map((job) => job.track.id))}
                className="h-8 rounded-full px-3 text-[13px] font-medium text-fg-2 hover:bg-surface-3 hover:text-fg"
              >
                {t.downloads.cancelAll}
              </button>
            )}
          </div>
          <ul className="flex flex-col">
            {jobs.map((job) => (
              <JobRow key={job.track.id} job={job} />
            ))}
          </ul>
        </section>
      )}

      <div className="px-2 md:px-3">
        {tracks.length > 0 ? (
          <TrackList tracks={tracks} showAlbum />
        ) : (
          ready &&
          jobs.length === 0 && (
            <EmptyState
              icon={<ArrowCircleDownIcon size={28} />}
              title={t.downloads.emptyTitle}
              body={t.downloads.emptyBody}
              action={
                <Link to={paths.search} className="mt-2 h-11 rounded-full bg-accent px-6 text-sm leading-[44px] font-semibold text-accent-ink">
                  {t.common.searchMusic}
                </Link>
              }
            />
          )
        )}
      </div>

      <Modal open={moreOpen} onClose={() => setMoreOpen(false)} title={t.downloads.title}>
        <div className="flex flex-col">
          <button
            type="button"
            onClick={() => {
              setMoreOpen(false);
              setConfirming(true);
            }}
            className="flex items-center gap-3 rounded-xl px-3 py-3 text-left text-danger hover:bg-surface-3"
          >
            <TrashIcon size={18} /> {t.downloads.removeAll}
          </button>
        </div>
      </Modal>

      <Modal open={confirming} onClose={() => setConfirming(false)} title={t.downloads.removeTitle}>
        <p className="text-sm text-fg-2">{t.downloads.removeBody(items.length)}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => setConfirming(false)} className="h-11 rounded-full px-5 text-sm font-medium text-fg-2 hover:text-fg">
            {t.common.cancel}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              void removeAll();
            }}
            className="h-11 rounded-full bg-danger px-6 text-sm font-semibold text-white"
          >
            {t.downloads.removeConfirm}
          </button>
        </div>
      </Modal>
    </div>
  );
}
