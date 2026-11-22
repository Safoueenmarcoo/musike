import { create } from "zustand";
import { getT } from "../i18n";
import { updater } from "../lib/api";
import type { UpdateFile } from "../lib/apiTypes";
import { toast } from "./ui";

/**
 * Updates from the app: looks at the latest release of this fork on GitHub and, when it's newer than this build
 * and has this platform's file, offers it. The Windows app installs it over itself and opens again; the Android
 * app opens the system installer, which asks first.
 */

export const REPO = "Safoueenmarcoo/musike";
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const EVERY = 6 * 60 * 60 * 1000;

export type UpdateStatus = "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "permission" | "error";

interface UpdatesState {
  status: UpdateStatus;
  latest: UpdateFile | null;
  progress: number;
  error: string | null;
  /** Checks GitHub. Quiet: no error shown, and a toast if there is something new. */
  check(quiet?: boolean): Promise<void>;
  install(): Promise<void>;
}

/** True when version `a` (1.10.0) comes after `b` (1.9.2). */
export function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

interface Release {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name: string; size: number; browser_download_url: string; digest?: string | null }[];
}

/** The update in a release, if it is newer than this build and has this platform's file. */
export function pickUpdate(release: Release, current: string, file: RegExp): UpdateFile | null {
  const version = release.tag_name?.replace(/^v/, "") ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(version) || release.draft || release.prerelease || !newer(version, current)) return null;
  const asset = release.assets?.find((a) => file.test(a.name));
  if (!asset) return null;
  const sha256 = asset.digest?.startsWith("sha256:") ? asset.digest.slice(7) : undefined;
  return { url: asset.browser_download_url, version, size: asset.size, sha256: sha256 && /^[0-9a-f]{64}$/.test(sha256) ? sha256 : undefined };
}

let announced = "";

export const useUpdates = create<UpdatesState>((set, get) => ({
  status: "idle",
  latest: null,
  progress: 0,
  error: null,

  async check(quiet = false) {
    const busy = get().status;
    if (!updater || busy === "checking" || busy === "downloading" || busy === "installing") return;
    set({ status: "checking", error: null });
    try {
      const res = await fetch(LATEST, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
      // No published release yet.
      if (res.status === 404) return set({ status: "current", latest: null });
      if (!res.ok) throw new Error(getT().updates.githubError(res.status));
      const latest = pickUpdate((await res.json()) as Release, __APP_VERSION__, updater.file);
      set({ status: latest ? "available" : "current", latest });
      if (latest && quiet && announced !== latest.version) {
        announced = latest.version;
        const t = getT().updates;
        toast(t.available(latest.version), "info", { label: t.update, run: () => void get().install() });
      }
    } catch (err) {
      set({ status: quiet ? "idle" : "error", error: quiet ? null : err instanceof Error ? err.message : String(err) });
    }
  },

  async install() {
    const { latest, status } = get();
    if (!updater || !latest || status === "downloading") return;
    set({ status: "downloading", progress: 0, error: null });
    try {
      const result = await updater.install(latest, (progress) => set({ progress: Math.min(1, Math.max(0, progress)) }));
      set({ status: result === "permission" ? "permission" : "installing", progress: 1 });
    } catch (err) {
      const message = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);
      set({ status: "error", error: message });
      toast(getT().updates.failed, "error");
    }
  },
}));

let started = false;

/** A first look a little after start, then every few hours while the app stays open. */
export function startUpdateChecks() {
  if (!updater || started) return;
  started = true;
  const run = () => {
    if (navigator.onLine) void useUpdates.getState().check(true);
  };
  setTimeout(run, 8000);
  setInterval(run, EVERY);
}
