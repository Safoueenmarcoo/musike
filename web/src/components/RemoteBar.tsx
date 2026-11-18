import { DesktopIcon, DeviceMobileIcon, PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon, SpeakerHighIcon } from "@phosphor-icons/react";
import { MD, useMediaQuery } from "../hooks/useMediaQuery";
import { useT } from "../i18n";
import { cn } from "../lib/format";
import { useRemote, useRemotePeer } from "../stores/remote";
import { Artwork } from "./Artwork";
import { IconButton } from "./IconButton";

/** "Playing on <device>": what another linked device plays, with its controls and "Play here". */
export function RemoteBar({ above }: { above: boolean }) {
  const peer = useRemotePeer();
  const pending = useRemote((s) => (peer ? s.pending[peer.id] : undefined));
  const command = useRemote((s) => s.command);
  const playHere = useRemote((s) => s.playHere);
  const isMd = useMediaQuery(MD);
  const t = useT();
  if (!peer?.state) return null;

  const { track } = peer.state;
  const playing = (pending ?? peer.state.status) === "playing";
  const Device = peer.kind === "android" ? DeviceMobileIcon : DesktopIcon;

  const body = (
    <div className="island-core flex h-14 items-center gap-3 pr-1.5 pl-1.5" role="region" aria-label={t.remote.controls(peer.name)}>
      <Artwork src={track.thumb} trackId={track.id} className="size-11 rounded-[10px]" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{track.title}</p>
        <p className="flex items-center gap-1.5 truncate text-xs text-accent-text">
          <SpeakerHighIcon size={13} weight="fill" className="shrink-0" />
          <Device size={13} className="shrink-0" />
          {/* Phones are narrow: the device's name says it, next to the speaker and device icons. */}
          <span className="truncate" title={playing ? t.remote.playingOn(peer.name) : t.remote.pausedOn(peer.name)}>
            {isMd ? (playing ? t.remote.playingOn(peer.name) : t.remote.pausedOn(peer.name)) : peer.name}
          </span>
        </p>
      </div>
      {isMd && (
        <IconButton label={t.player.previous} size="sm" onClick={() => void command(peer, "previous")}>
          <SkipBackIcon size={17} weight="fill" />
        </IconButton>
      )}
      <IconButton label={playing ? t.common.pause : t.common.play} onClick={() => void command(peer, playing ? "pause" : "play")} className="text-fg">
        {playing ? <PauseIcon size={20} weight="fill" /> : <PlayIcon size={20} weight="fill" />}
      </IconButton>
      <IconButton label={t.player.next} size="sm" onClick={() => void command(peer, "next")}>
        <SkipForwardIcon size={17} weight="fill" />
      </IconButton>
      <button
        type="button"
        onClick={() => playHere(peer)}
        className="h-9 shrink-0 rounded-full bg-accent px-3.5 text-[13px] font-semibold text-accent-ink transition-transform active:scale-95"
      >
        {t.remote.playHere}
      </button>
    </div>
  );

  if (isMd) return <div className="island shrink-0 !py-1">{body}</div>;
  return (
    <div
      className={cn("fixed inset-x-2 z-20", above ? "bottom-[calc(142px+env(safe-area-inset-bottom))]" : "bottom-[calc(72px+env(safe-area-inset-bottom))]")}
    >
      <div className="island p-1! shadow-[0_10px_30px_rgb(0_0_0/0.35)]">{body}</div>
    </div>
  );
}
