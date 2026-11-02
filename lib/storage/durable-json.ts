import "server-only";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { maxJsonStorageBytes, serializeStoredJson } from "./json-limits";

export type DurableFileIO = Pick<typeof fs, "openSync" | "writeFileSync" | "fsyncSync" | "closeSync" | "renameSync" | "unlinkSync">;

export function flushDirectory(directory: string, io: DurableFileIO = fs): void {
  const descriptor = io.openSync(directory, "r");
  try { io.fsyncSync(descriptor); } finally { io.closeSync(descriptor); }
}

// A failure after rename can mean the new bytes are visible but their directory
// entry is not durable. Report the failure; a retry must read, never assume rollback.
export function replaceDurableJson(filename: string, value: unknown, io: DurableFileIO = fs, maxBytes = maxJsonStorageBytes): void {
  const serialized = serializeStoredJson(value, maxBytes);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = io.openSync(temporary, "wx", 0o600);
    io.writeFileSync(descriptor, serialized, "utf8");
    io.fsyncSync(descriptor);
    io.closeSync(descriptor);
    descriptor = undefined;
    io.renameSync(temporary, filename);
    flushDirectory(path.dirname(filename), io);
  } finally {
    if (descriptor !== undefined) io.closeSync(descriptor);
    try { io.unlinkSync(temporary); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}
