import { ArrowCircleDownIcon, TrashIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Link } from "react-router";
import { useT } from "../i18n";
import { capabilities } from "../lib/api";
import { formatBytes } from "../lib/format";
import { paths } from "../lib/routes";
import { useDownloads } from "../stores/downloads";
import { useUi } from "../stores/ui";

/** Settings: how much is saved on this device, the way to the list, and a way to free the space. */
export function DownloadsSection() {
  const count = useDownloads((s) => s.items.length);
  const bytes = useDownloads((s) => s.bytes);
  const removeAll = useDownloads((s) => s.removeAll);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const [confirming, setConfirming] = useState(false);
  const t = useT();
  if (!capabilities.downloads) return null;

  const action = "flex h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition-[transform,background-color] active:scale-[0.98]";

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-medium text-fg-3">{t.downloads.title}</h3>
      <p className="text-sm text-fg-2">{t.downloads.settingsBody}</p>

      <div className="flex flex-col gap-3 rounded-[16px] bg-surface-1 p-4 ring-1 ring-line">
        <p className="font-mono text-[13px] text-fg-2 tabular-nums">
          {count ? t.downloads.summary(count, formatBytes(bytes, t.locale)) : t.downloads.settingsEmpty}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Link to={paths.downloads} onClick={() => setSettingsOpen(false)} className={`${action} bg-surface-2 ring-1 ring-line hover:bg-surface-3`}>
            <ArrowCircleDownIcon size={18} /> {t.downloads.title}
          </Link>
          <button
            type="button"
            disabled={!count}
            aria-label={confirming ? t.downloads.removeConfirm : t.downloads.removeAll}
            onClick={() => {
              if (!confirming) return setConfirming(true);
              setConfirming(false);
              void removeAll();
            }}
            className={`${action} disabled:opacity-50 ${confirming ? "bg-danger font-semibold text-white" : "bg-surface-2 ring-1 ring-line hover:bg-surface-3"}`}
          >
            <TrashIcon size={18} /> {confirming ? t.downloads.removeConfirm : t.downloads.removeAllShort}
          </button>
        </div>
        {confirming && (
          <p role="alert" className="text-sm text-danger">
            {t.downloads.removeBody(count)}
          </p>
        )}
      </div>
    </section>
  );
}
