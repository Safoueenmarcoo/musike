import { MusicNotesIcon } from "@phosphor-icons/react";
import { useCallback, useState } from "react";
import { useOnline } from "../hooks/useOnline";
import { cn } from "../lib/format";
import { useLocalArt } from "../stores/downloads";

interface Props {
  src?: string;
  /** Used when `src` fails, e.g. hq720 thumbnails that do not exist for older videos. */
  fallback?: string;
  /** The track this image belongs to, when there is one: a downloaded track's saved cover can then stand in for it. */
  trackId?: string;
  alt?: string;
  className?: string;
  iconSize?: number;
}

export function Artwork({ src, fallback, trackId, ...rest }: Props) {
  // A downloaded song keeps its cover on the device. It is the last resort while there is a connection (the remote
  // image is the right size and already cached) and the first choice without one, so nothing waits on a dead request.
  const local = useLocalArt(src, fallback, trackId);
  const online = useOnline();
  const sources = [...new Set((online ? [src, fallback, local] : [local, src, fallback]).filter((s): s is string => !!s))];
  // Keyed by its sources so a new image starts from a clean loading state, without a reset effect
  // (an effect could run after a cached image already fired onLoad and leave it stuck invisible).
  return <ArtworkImage key={sources.join("|")} sources={sources} {...rest} />;
}

function ArtworkImage({ sources, alt = "", className, iconSize = 20 }: Omit<Props, "src" | "fallback" | "trackId"> & { sources: string[] }) {
  const [at, setAt] = useState(0);
  const current = sources[at];
  const [state, setState] = useState<"loading" | "ok" | "error">(current ? "loading" : "error");

  // Images served from cache can be complete before React attaches onLoad.
  const imgRef = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth > 0) setState("ok");
  }, []);

  return (
    <div className={cn("relative shrink-0 overflow-hidden bg-surface-3", className)}>
      {state !== "error" && current && (
        <img
          ref={imgRef}
          src={current}
          alt={alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onLoad={() => setState("ok")}
          onError={() => {
            if (at + 1 < sources.length) setAt(at + 1);
            else setState("error");
          }}
          className={cn(
            "h-full w-full object-cover transition-opacity duration-300 ease-out-expo",
            state === "ok" ? "opacity-100" : "opacity-0",
          )}
        />
      )}
      {state === "loading" && <div className="skeleton absolute inset-0" />}
      {state === "error" && (
        <div className="absolute inset-0 grid place-items-center text-fg-3">
          <MusicNotesIcon size={iconSize} />
        </div>
      )}
    </div>
  );
}
