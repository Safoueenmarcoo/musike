import { ArrowCircleDownIcon, CheckCircleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useT } from "../i18n";
import { api, capabilities } from "../lib/api";
import { cn } from "../lib/format";
import { paths } from "../lib/routes";
import type { AlbumCard, PlaylistCard } from "../lib/types";
import { saveAndDownload, savedCopy } from "../lib/youtubePlaylists";
import { useDownloads } from "../stores/downloads";
import { useLibrary } from "../stores/library";
import { toast } from "../stores/ui";
import { Artwork } from "./Artwork";
import { ProgressRing } from "./Download";

/** An album cover with its title; opens the album. */
export function AlbumTile({ album, className }: { album: AlbumCard; className?: string }) {
  const sub = [album.artist, album.year].filter(Boolean).join(" · ");
  return (
    <Link to={paths.album(album.id)} state={{ name: album.title }} className={cn("group flex flex-col gap-2", className)}>
      <span className="block overflow-hidden rounded-[14px]">
        <Artwork
          src={album.art}
          fallback={album.thumb}
          className="aspect-square w-full transition-transform duration-300 ease-out-expo group-hover:scale-[1.04]"
        />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold">{album.title}</span>
        {sub && <span className="block truncate text-xs text-fg-2">{sub}</span>}
      </span>
    </Link>
  );
}

/** A titled, horizontally scrolling row of albums (an artist's albums or singles). */
export function AlbumRow({ title, albums }: { title: string; albums: AlbumCard[] }) {
  return (
    <section className="flex flex-col gap-3 pt-6">
      <h2 className="px-4 text-xl font-semibold tracking-tight md:px-6">{title}</h2>
      <ul className="no-scrollbar flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 md:scroll-px-6 md:px-6">
        {albums.map((a) => (
          <li key={a.id} className="w-36 shrink-0 snap-start md:w-44">
            <AlbumTile album={a} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Albums as a responsive grid (search results). */
export function AlbumGrid({ albums }: { albums: AlbumCard[] }) {
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-5 px-2 sm:grid-cols-3 md:px-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
      {albums.map((a) => (
        <li key={a.id}>
          <AlbumTile album={a} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Downloads a YouTube playlist straight from its cover: fetches its songs, saves it to the library and keeps it
 * downloaded. Once it is, the button opens the saved copy instead.
 */
function PlaylistDownloadButton({ playlist }: { playlist: PlaylistCard }) {
  const t = useT();
  const navigate = useNavigate();
  const copy = useLibrary((s) => savedCopy(s.playlists, playlist.title));
  const kept = useDownloads((s) => !!copy && s.offline.playlists.includes(copy.id));
  const [busy, setBusy] = useState(false);
  if (!capabilities.downloads) return null;

  const label = kept ? t.youtubePlaylist.openSaved : t.youtubePlaylist.downloadTitle(playlist.title);
  const run = async () => {
    if (kept && copy) return navigate(paths.playlist(copy.id));
    setBusy(true);
    try {
      const page = await api.youtubePlaylist(playlist.id);
      if (!page.tracks.length) throw new Error(t.youtubePlaylist.noTracksBody);
      await saveAndDownload({ ...page, title: page.title || playlist.title });
    } catch (e) {
      toast(t.youtubePlaylist.failed(playlist.title, (e as Error).message), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      disabled={busy}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void run();
      }}
      title={label}
      aria-label={label}
      className={cn(
        "absolute right-2 bottom-2 grid size-10 place-items-center rounded-full shadow-[0_6px_20px_rgb(0_0_0/0.35)] transition-transform active:scale-95",
        kept ? "bg-accent text-accent-ink" : "bg-surface-3/90 text-fg backdrop-blur hover:bg-surface-4",
      )}
    >
      {busy ? <ProgressRing value={null} size={20} /> : kept ? <CheckCircleIcon size={22} weight="fill" /> : <ArrowCircleDownIcon size={22} />}
    </button>
  );
}

/** A YouTube playlist's cover with its title; opens it, and its button downloads it. */
export function PlaylistTile({ playlist }: { playlist: PlaylistCard }) {
  return (
    <div className="group relative flex flex-col gap-2">
      <Link to={paths.youtubePlaylist(playlist.id)} state={{ name: playlist.title }} className="flex flex-col gap-2">
        <span className="block overflow-hidden rounded-[14px]">
          <Artwork
            src={playlist.art}
            fallback={playlist.thumb}
            className="aspect-square w-full transition-transform duration-300 ease-out-expo group-hover:scale-[1.04]"
          />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{playlist.title}</span>
          {(playlist.info || playlist.author) && <span className="block truncate text-xs text-fg-2">{playlist.info || playlist.author}</span>}
        </span>
      </Link>
      <span className="pointer-events-none absolute inset-x-0 top-0 block aspect-square">
        <span className="pointer-events-auto">
          <PlaylistDownloadButton playlist={playlist} />
        </span>
      </span>
    </div>
  );
}

/** YouTube playlists as a responsive grid (search results). */
export function PlaylistGrid({ playlists }: { playlists: PlaylistCard[] }) {
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-5 px-2 sm:grid-cols-3 md:px-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
      {playlists.map((p) => (
        <li key={p.id}>
          <PlaylistTile playlist={p} />
        </li>
      ))}
    </ul>
  );
}
