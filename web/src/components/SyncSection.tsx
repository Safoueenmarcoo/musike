import { ArrowsClockwiseIcon, ArrowSquareOutIcon, CloudCheckIcon, CloudSlashIcon, DesktopIcon, DeviceMobileIcon, GithubLogoIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { cn } from "../lib/format";
import { useRemote } from "../stores/remote";
import { useSync } from "../stores/sync";

/** The other linked devices remote playback can see right now, and how. */
function Devices() {
  const snap = useRemote((s) => s.snap);
  const t = useT();
  if (!snap?.enabled || !snap.self) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <p className="text-xs font-medium text-fg-3">{t.remote.devices}</p>
      <p className="text-xs text-fg-2">{t.remote.thisDevice(snap.self.name)}</p>
      {snap.peers.length ? (
        <ul className="flex flex-col gap-1.5">
          {snap.peers.map((p) => {
            const Icon = p.kind === "android" ? DeviceMobileIcon : DesktopIcon;
            return (
              <li key={p.id} className="flex items-center gap-2 text-sm">
                <Icon size={17} className="shrink-0 text-fg-2" />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="shrink-0 text-xs text-fg-3">{p.via === "lan" ? t.remote.viaWifi : t.remote.viaInternet}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-fg-3">{t.remote.none}</p>
      )}
      {snap.relay === "limited" && <p className="text-xs text-danger">{t.remote.limited}</p>}
    </div>
  );
}

/** A GitHub page that creates a classic token with only the "gist" permission, already named. */
const NEW_TOKEN = "https://github.com/settings/tokens/new?scopes=gist&description=Musike%20sync";

/** Settings: link this device to GitHub so the library is the same on all of them. */
export function SyncSection() {
  const { status, busy, load, connect, syncNow, disconnect } = useSync();
  const [token, setToken] = useState("");
  const [confirming, setConfirming] = useState(false);
  const t = useT();

  useEffect(() => {
    void load();
  }, [load]);

  const action = "flex h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition-[transform,background-color] active:scale-[0.98] disabled:opacity-50";
  const ago = (at: number) => {
    const min = Math.floor((Date.now() - at) / 60_000);
    return min < 1 ? t.sync.justNow : t.sync.minutesAgo(min);
  };

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-medium text-fg-3">{t.sync.title}</h3>
      <p className="text-sm text-fg-2">{t.sync.body}</p>

      {status?.connected ? (
        <div className="flex flex-col gap-3 rounded-[16px] bg-surface-1 p-4 ring-1 ring-line">
          <div className="flex items-start gap-3">
            {status.error ? (
              <CloudSlashIcon size={22} className="mt-0.5 shrink-0 text-danger" />
            ) : (
              <CloudCheckIcon size={22} className="mt-0.5 shrink-0 text-accent-text" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t.sync.linked(status.login ?? "")}</p>
              <p className={cn("text-xs", status.error ? "text-danger" : "text-fg-2")}>
                {status.error ?? (status.syncing ? t.sync.syncing : status.lastSync ? t.sync.last(ago(status.lastSync)) : t.sync.waiting)}
              </p>
            </div>
            {status.gistUrl && (
              <a href={status.gistUrl} target="_blank" rel="noreferrer" title={t.sync.openGist} aria-label={t.sync.openGist} className="grid size-8 place-items-center rounded-full text-fg-2 hover:bg-surface-3 hover:text-fg">
                <ArrowSquareOutIcon size={17} />
              </a>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={!!busy} onClick={() => void syncNow()} className={`${action} bg-surface-2 ring-1 ring-line hover:bg-surface-3`}>
              <ArrowsClockwiseIcon size={18} className={busy === "sync" || status.syncing ? "animate-spin" : ""} /> {t.sync.now}
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => {
                if (!confirming) return setConfirming(true);
                setConfirming(false);
                void disconnect();
              }}
              className={cn(action, confirming ? "bg-danger font-semibold text-white" : "bg-surface-2 ring-1 ring-line hover:bg-surface-3")}
            >
              {confirming ? t.sync.unlinkConfirm : t.sync.unlink}
            </button>
          </div>
          {confirming && <p className="text-sm text-fg-2">{t.sync.unlinkBody}</p>}
          <Devices />
        </div>
      ) : (
        <form
          className="flex flex-col gap-3 rounded-[16px] bg-surface-1 p-4 ring-1 ring-line"
          onSubmit={(e) => {
            e.preventDefault();
            void connect(token).then((ok) => ok && setToken(""));
          }}
        >
          <ol className="list-decimal space-y-1 pl-5 text-sm text-fg-2">
            <li>
              {t.sync.step1}{" "}
              <a href={NEW_TOKEN} target="_blank" rel="noreferrer" className="font-medium text-accent-text underline-offset-2 hover:underline">
                {t.sync.step1Link}
              </a>
            </li>
            <li>{t.sync.step2}</li>
            <li>{t.sync.step3}</li>
          </ol>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ghp_…"
            aria-label={t.sync.tokenLabel}
            className="h-11 rounded-[12px] bg-surface-2 px-3.5 font-mono text-sm ring-1 ring-line outline-none placeholder:text-fg-3 focus:ring-accent"
          />
          <button type="submit" disabled={!token.trim() || !!busy} className={`${action} bg-accent font-semibold text-accent-ink`}>
            <GithubLogoIcon size={18} weight="fill" /> {busy === "connect" ? t.sync.linking : t.sync.link}
          </button>
        </form>
      )}
    </section>
  );
}
