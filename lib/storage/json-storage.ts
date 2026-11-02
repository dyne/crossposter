import "server-only";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertBackendMutation, controlEnabled } from "@/lib/control/backend-mutation";
import { replaceDurableJson } from "./durable-json";
import { maxJsonStorageBytes } from "./json-limits";
import { readControlConfig } from "@/lib/control/read-storage";
import { ControlError } from "@/lib/control/errors";

export type ConfigStorage = {
  path: string;
  exists: () => boolean;
  read: () => unknown;
  write: (value: unknown) => void;
  strictRead?: () => boolean;
};

// Keep reads/writes synchronous: config updates are a single-process read/modify/write.
export function createJsonConfigStorage(dataRoot: string, maxBytes = maxJsonStorageBytes): ConfigStorage {
  const filename = path.join(dataRoot, "poster.config.local.json");

  return {
    path: filename,
    strictRead: () => controlEnabled(dataRoot),
    exists: () => { assertBackendMutation(dataRoot); return existsSync(filename); },
    read: () => {
      const owner = assertBackendMutation(dataRoot);
      if (owner && maxBytes !== maxJsonStorageBytes) readControlConfig(dataRoot, maxBytes);
      return JSON.parse(readFileSync(filename, "utf8")) as unknown;
    },
    write: (value) => {
      if (assertBackendMutation(dataRoot)) {
        try { replaceDurableJson(filename, value, undefined, maxBytes); }
        catch { throw new ControlError("storage_unavailable"); }
      }
      else writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
    }
  };
}
