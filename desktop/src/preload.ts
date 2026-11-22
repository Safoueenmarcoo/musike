import { contextBridge, ipcRenderer } from "electron";

// The only bridge between the web app and the desktop shell.
contextBridge.exposeInMainWorld("musikeDesktop", {
  platform: process.platform,
  setTheme: (theme: "dark" | "light") => ipcRenderer.send("musike:theme", theme),
  setLanguage: (lang: string) => ipcRenderer.send("musike:lang", lang),
  retry: () => ipcRenderer.send("musike:retry"),
  installUpdate: (request: { url: string; version: string; size: number; sha256?: string }) => ipcRenderer.invoke("musike:update", request),
  onUpdateProgress: (fn: (fraction: number) => void) => {
    const listener = (_event: unknown, fraction: number) => fn(fraction);
    ipcRenderer.on("musike:update-progress", listener);
    return () => void ipcRenderer.removeListener("musike:update-progress", listener);
  },
});
