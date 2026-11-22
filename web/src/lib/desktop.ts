/** Bridge exposed by the Electron preload script when Musike runs as the desktop app. */
interface DesktopBridge {
  platform: string;
  setTheme: (theme: "dark" | "light") => void;
  /** Missing in desktop builds older than 1.2. */
  setLanguage?: (lang: string) => void;
  /** From 1.9 on. */
  installUpdate?: (file: { url: string; version: string; size: number; sha256?: string }) => Promise<void>;
  onUpdateProgress?: (fn: (fraction: number) => void) => () => void;
}

export const desktop = (window as Window & { musikeDesktop?: DesktopBridge }).musikeDesktop;

if (desktop) {
  document.documentElement.dataset.desktop = "true";
  // Match the native window buttons to the theme picked before this script ran.
  desktop.setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
}
