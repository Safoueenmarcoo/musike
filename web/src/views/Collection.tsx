import { DotsThreeIcon, MagnifyingGlassIcon, PauseIcon, PencilSimpleIcon, PlayIcon, ShuffleIcon, SortAscendingIcon, TrashIcon, XCircleIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Cover, type CoverKind } from "../components/Cover";
import { NamePlaylistDialog } from "../components/Dialogs";
import { DownloadAllButton } from "../components/Download";
import { IconButton, PlayDisc } from "../components/IconButton";
import { Modal } from "../components/Modal";
import { EmptyState, PageHeader } from "../components/Page";
import { TrackList } from "../components/TrackList";
import { useT } from "../i18n";
import { arrange, savedSort, saveSort, SORTS, type SortKey } from "../lib/arrange";
import { shuffled } from "../lib/format";
import { paths } from "../lib/routes";
import type { Track } from "../lib/types";
import { usePlayer } from "../player/player";
import { useLibrary } from "../stores/library";

interface Props {
  kind: Exclude<CoverKind, "downloads">;
}

/** Playlist, Favorites and History share one layout. */
export default function Collection({ kind }: Props) {
  const { id } = useParams();
  const navigate = useNavigate();
  const lib = useLibrary();
  const playList = usePlayer((s) => s.playList);
  const toggle = usePlayer((s) => s.toggle);
  const queue = usePlayer((s) => s.queue);
  const status = usePlayer((s) => s.status);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [query, setQuery] = useState("");
  const sortId = kind === "playlist" ? (id ?? "") : kind;
  const [sort, setSortState] = useState<SortKey>(() => savedSort(kind, sortId));
  const [sortFor, setSortFor] = useState(sortId);
  // Another playlist opened in the same view: its own sort, and no leftover search.
  if (sortFor !== sortId) {
    setSortFor(sortId);
    setSortState(savedSort(kind, sortId));
    setQuery("");
  }
  const setSort = (next: SortKey) => {
    setSortState(next);
    saveSort(sortId, next);
  };
  const t = useT();

  const playlist = kind === "playlist" ? lib.playlists.find((p) => p.id === id) : undefined;
  const tracks: Track[] = kind === "favorites" ? lib.favorites : kind === "history" ? lib.history : playlist?.tracks ?? [];
  const name = kind === "favorites" ? t.nav.favorites : kind === "history" ? t.nav.recentlyPlayed : playlist?.name ?? "";
  const shown = useMemo(() => arrange(tracks, sort, query), [tracks, sort, query]);
  const moveInPlaylist = lib.moveInPlaylist;
  // Dragging only makes sense in the playlist's own order, with every song showing.
  const canReorder = kind === "playlist" && !!playlist && sort === "custom" && !query.trim() && tracks.length > 1;
  const label =
    kind === "playlist" ? t.collection.labelPlaylist : kind === "favorites" ? t.collection.labelFavorites : t.collection.labelHistory;

  if (kind === "playlist" && !playlist) {
    if (lib.status !== "ready") return <PageHeader />;
    return (
      <>
        <PageHeader />
        <EmptyState
          icon={<MagnifyingGlassIcon size={28} />}
          title={t.collection.notFoundTitle}
          body={t.collection.notFoundBody}
          action={
            <Link to={paths.library} className="mt-2 h-11 rounded-full bg-surface-3 px-6 text-sm leading-[44px] font-medium">
              {t.collection.goToLibrary}
            </Link>
          }
        />
      </>
    );
  }

  const total = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  // The queue holds exactly these tracks, so this collection is the current playback context.
  const isThisPlaying = shown.length > 0 && queue.length === shown.length && queue.every((t) => shown.some((x) => x.id === t.id));
  const playing = isThisPlaying && (status === "playing" || status === "loading");

  return (
    <div className="pb-8">
      <PageHeader title={name} mobileOnly />

      <div className="relative">
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-20 h-72 bg-linear-to-b from-accent-soft to-transparent" />
        <div className="relative flex flex-col items-center gap-5 px-4 pt-2 pb-6 md:flex-row md:items-end md:gap-6 md:px-6 md:pt-10">
          <Cover
            kind={kind}
            tracks={tracks}
            iconSize={64}
            className="size-44 shrink-0 rounded-[18px] shadow-[0_24px_60px_rgb(0_0_0/0.4)] md:size-52"
          />
          <div className="flex min-w-0 flex-col items-center gap-2 text-center md:items-start md:text-left">
            <span className="hidden text-xs font-medium text-fg-2 md:block">{label}</span>
            <h1 className="max-w-full text-[28px] leading-[1.1] font-bold tracking-tight break-words md:text-5xl lg:text-6xl">{name}</h1>
            <p className="font-mono text-[13px] text-fg-2">
              {t.common.tracks(tracks.length)}
              {total > 0 && <> · {t.time.total(total)}</>}
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 px-4 pb-4 md:px-6">
        <PlayDisc
          label={playing ? t.common.pause : t.common.playX(name)}
          px={56}
          disabled={!shown.length}
          onClick={() => (isThisPlaying ? toggle() : playList(shown, 0))}
        >
          {playing ? <PauseIcon size={24} weight="fill" /> : <PlayIcon size={24} weight="fill" />}
        </PlayDisc>
        <IconButton
          label={t.collection.shuffle}
          size="lg"
          disabled={!shown.length}
          onClick={() => {
            const order = shuffled(shown);
            playList(order, 0);
          }}
        >
          <ShuffleIcon size={24} />
        </IconButton>
        {/* A playlist or the favorites can be kept on the device; the history changes with every song played. */}
        {kind !== "history" && (
          <DownloadAllButton
            tracks={tracks}
            collection={kind === "favorites" ? { kind: "favorites" } : playlist ? { kind: "playlist", id: playlist.id } : undefined}
          />
        )}
        {kind === "playlist" && (
          <IconButton label={t.collection.more} size="lg" onClick={() => setMoreOpen(true)}>
            <DotsThreeIcon size={26} weight="bold" />
          </IconButton>
        )}
      </div>

      {tracks.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3 md:px-6">
          <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full bg-surface-2 px-3.5 ring-1 ring-line focus-within:ring-fg-3 sm:max-w-xs">
            <MagnifyingGlassIcon size={16} className="shrink-0 text-fg-3" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && query && (e.stopPropagation(), setQuery(""))}
              placeholder={t.collection.find}
              aria-label={t.collection.findIn(name)}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-3 [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button type="button" onClick={() => setQuery("")} aria-label={t.collection.clearFind} className="-mr-1 text-fg-3 hover:text-fg">
                <XCircleIcon size={18} weight="fill" />
              </button>
            )}
          </label>
          <label className="ml-auto flex h-10 items-center gap-1.5 rounded-full px-3 text-sm text-fg-2 hover:bg-surface-2 hover:text-fg">
            <SortAscendingIcon size={17} className="shrink-0" />
            <span className="sr-only">{t.collection.sortBy}</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label={t.collection.sortBy}
              className="cursor-pointer appearance-none bg-transparent pr-1 font-medium text-fg outline-none"
            >
              {SORTS[kind].map((k) => (
                <option key={k} value={k}>
                  {k === "custom" ? t.collection.ownOrder[kind] : t.collection.sorts[k]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="px-2 md:px-3">
        {tracks.length > 0 && shown.length === 0 ? (
          <EmptyState icon={<MagnifyingGlassIcon size={28} />} title={t.collection.noMatch(query.trim())} body={t.collection.noMatchBody} />
        ) : tracks.length > 0 ? (
          <TrackList
            tracks={shown}
            playlistId={playlist?.id}
            showAlbum
            onMove={canReorder ? (from, to) => void moveInPlaylist(playlist!.id, from, to) : undefined}
          />
        ) : (
          <EmptyState
            icon={<MagnifyingGlassIcon size={28} />}
            title={kind === "history" ? t.collection.emptyHistory : t.collection.empty}
            body={
              kind === "favorites"
                ? t.collection.emptyFavoritesBody
                : kind === "history"
                  ? t.collection.emptyHistoryBody
                  : t.collection.emptyPlaylistBody
            }
            action={
              <Link to={paths.search} className="mt-2 h-11 rounded-full bg-accent px-6 text-sm leading-[44px] font-semibold text-accent-ink">
                {t.common.searchMusic}
              </Link>
            }
          />
        )}
      </div>

      {playlist && (
        <>
          <Modal open={moreOpen} onClose={() => setMoreOpen(false)} title={playlist.name}>
            <div className="flex flex-col">
              <button
                type="button"
                onClick={() => {
                  setMoreOpen(false);
                  setRenaming(true);
                }}
                className="flex items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-surface-3"
              >
                <PencilSimpleIcon size={18} className="text-fg-2" /> {t.collection.rename}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMoreOpen(false);
                  setConfirmDelete(true);
                }}
                className="flex items-center gap-3 rounded-xl px-3 py-3 text-left text-danger hover:bg-surface-3"
              >
                <TrashIcon size={18} /> {t.collection.deletePlaylist}
              </button>
            </div>
          </Modal>

          <NamePlaylistDialog
            open={renaming}
            initial={playlist.name}
            title={t.collection.renameTitle}
            action={t.collection.save}
            onClose={() => setRenaming(false)}
            onSubmit={(n) => {
              void lib.renamePlaylist(playlist.id, n);
              setRenaming(false);
            }}
          />

          <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title={t.collection.deleteTitle}>
            <p className="text-sm text-fg-2">
              {t.collection.deleteBody(playlist.name, playlist.tracks.length)}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmDelete(false)} className="h-11 rounded-full px-5 text-sm font-medium text-fg-2 hover:text-fg">
                {t.common.cancel}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmDelete(false);
                  void lib.deletePlaylist(playlist.id);
                  navigate(paths.library);
                }}
                className="h-11 rounded-full bg-danger px-6 text-sm font-semibold text-white"
              >
                {t.collection.delete}
              </button>
            </div>
          </Modal>
        </>
      )}
    </div>
  );
}
