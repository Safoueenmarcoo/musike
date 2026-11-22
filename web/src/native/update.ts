import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { Updater } from "../lib/apiTypes";

/** Updates on the phone: MusikeUpdatePlugin.java downloads the APK and opens Android's installer. */
interface UpdatePlugin {
  install(options: { url: string; version: string; size: number; sha256?: string }): Promise<{ status: "started" | "permission" }>;
  addListener(event: "progress", fn: (e: { received: number; total: number }) => void): Promise<PluginListenerHandle>;
}

const Update = registerPlugin<UpdatePlugin>("MusikeUpdate");

export const updater: Updater | null =
  Capacitor.getPlatform() === "android"
    ? {
        platform: "android",
        file: /-Android\.apk$/,
        async install(file, progress) {
          const handle = await Update.addListener("progress", (e) => progress(e.total > 0 ? e.received / e.total : 0));
          try {
            const { status } = await Update.install(file);
            return status;
          } finally {
            void handle.remove();
          }
        },
      }
    : null;
