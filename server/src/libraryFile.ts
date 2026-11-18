import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { LibraryStorage } from "./library.js";

/** The library as data/library.json, replaced atomically (write a temp file, then rename over). */
export function fileStorage(dir = config.dataDir): LibraryStorage {
  const file = path.join(dir, "library.json");
  return {
    read: async () => (existsSync(file) ? readFile(file, "utf8") : null),
    write: async (json) => {
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, json, "utf8");
      await rename(tmp, file);
    },
  };
}

/** Small named files in the data folder (sync's token and its last merged library), each replaced atomically. */
export function fileStore(dir = config.dataDir) {
  const at = (name: string) => path.join(dir, path.basename(name));
  return {
    read: async (name: string) => (existsSync(at(name)) ? readFile(at(name), "utf8") : null),
    write: async (name: string, text: string) => {
      await mkdir(dir, { recursive: true });
      const tmp = `${at(name)}.tmp`;
      await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, at(name));
    },
    remove: async (name: string) => {
      await rm(at(name), { force: true });
    },
  };
}
