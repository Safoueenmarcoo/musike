import { WifiSlashIcon } from "@phosphor-icons/react";
import { Link, useLocation } from "react-router";
import { useOnline } from "../hooks/useOnline";
import { useT } from "../i18n";
import { capabilities } from "../lib/api";
import { cn } from "../lib/format";
import { paths } from "../lib/routes";

/** Shown while the device has no connection: what still works (downloaded songs) and the way to them. */
export function OfflineNotice({ className }: { className?: string }) {
  const online = useOnline();
  const { pathname } = useLocation();
  const t = useT();
  if (online || !capabilities.downloads) return null;
  return (
    <div role="status" className={cn("items-center gap-3 rounded-[14px] bg-surface-3 py-2 pr-2 pl-3.5 text-sm", className)}>
      <WifiSlashIcon size={18} className="shrink-0 text-fg-2" />
      <span className="min-w-0 flex-1">{t.downloads.offline}</span>
      {pathname !== paths.downloads && (
        <Link
          to={paths.downloads}
          className="flex h-8 shrink-0 items-center rounded-full bg-accent px-3.5 text-[13px] font-semibold text-accent-ink transition-transform active:scale-95"
        >
          {t.downloads.offlineOpen}
        </Link>
      )}
    </div>
  );
}
