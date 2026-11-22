import { ArrowCircleUpIcon, ArrowSquareOutIcon, CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { updater } from "../lib/api";
import { cn } from "../lib/format";
import { RELEASES_PAGE, useUpdates } from "../stores/updates";

/** Settings: this build's version, and the newer one on GitHub when there is one. Only where the app can update itself. */
export function UpdateSection() {
  const { status, latest, progress, error, check, install } = useUpdates();
  const t = useT();
  if (!updater) return null;

  const busy = status === "checking" || status === "downloading" || (status === "installing" && updater.platform === "windows");
  const canInstall = !!latest && (status === "available" || status === "permission" || status === "error" || (status === "installing" && updater.platform === "android"));
  const line =
    status === "checking"
      ? t.updates.checking
      : status === "current"
        ? t.updates.current
        : status === "available" && latest
          ? t.updates.available(latest.version)
          : status === "downloading"
            ? t.updates.downloading(Math.round(progress * 100))
            : status === "installing"
              ? updater.platform === "windows"
                ? t.updates.installingWindows
                : t.updates.installingAndroid
              : status === "permission"
                ? t.updates.permission
                : status === "error"
                  ? error ?? t.updates.failed
                  : null;
  const Icon = status === "error" ? WarningCircleIcon : latest ? ArrowCircleUpIcon : CheckCircleIcon;
  const action = "flex h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition-[transform,background-color] active:scale-[0.98] disabled:opacity-50";

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-medium text-fg-3">{t.updates.title}</h3>
      <div className="flex flex-col gap-3 rounded-[16px] bg-surface-1 p-4 ring-1 ring-line">
        <div className="flex items-start gap-3">
          <Icon size={22} className={cn("mt-0.5 shrink-0", status === "error" ? "text-danger" : "text-accent-text")} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t.updates.version(__APP_VERSION__)}</p>
            {line && (
              <p role="status" className={cn("text-xs", status === "error" ? "text-danger" : "text-fg-2")}>
                {line}
              </p>
            )}
          </div>
          {latest && (
            <a href={RELEASES_PAGE} target="_blank" rel="noreferrer" title={t.updates.notes} aria-label={t.updates.notes} className="grid size-8 place-items-center rounded-full text-fg-2 hover:bg-surface-3 hover:text-fg">
              <ArrowSquareOutIcon size={17} />
            </a>
          )}
        </div>
        {status === "downloading" && (
          <div className="h-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        {canInstall && latest ? (
          <button type="button" onClick={() => void install()} className={cn(action, "bg-accent font-semibold text-accent-ink")}>
            {t.updates.updateTo(latest.version)}
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => void check()} className={cn(action, "bg-surface-2 ring-1 ring-line hover:bg-surface-3")}>
            {t.updates.check}
          </button>
        )}
      </div>
    </section>
  );
}
