import "server-only";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ConfigStorage = {
  path: string;
  exists: () => boolean;
  read: () => unknown;
  write: (value: unknown) => void;
};

// Keep reads/writes synchronous: config updates are a single-process read/modify/write.
export function createJsonConfigStorage(dataRoot: string): ConfigStorage {
  const filename = path.join(dataRoot, "poster.config.local.json");

  return {
    path: filename,
    exists: () => existsSync(filename),
    read: () => JSON.parse(readFileSync(filename, "utf8")) as unknown,
    write: (value) => writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`)
  };
}
