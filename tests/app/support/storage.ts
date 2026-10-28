import path from "node:path";
import { Readable } from "node:stream";
import type { ConfigStorage } from "@/lib/storage/json-storage";
import { mediaFilePath } from "@/lib/storage/media-storage";
import type { MediaStorage } from "@/lib/storage/media-storage";
import type { StoredMedia } from "@/lib/storage/media-types";

// Serialize even in memory: callers must not accidentally rely on shared objects.
export function memoryConfigStorage(root: string) {
  let raw: string | undefined;
  const storage: ConfigStorage = {
    path: path.join(root, "poster.config.local.json"),
    exists: () => raw !== undefined,
    read: () => JSON.parse(raw!),
    write: (value) => { raw = `${JSON.stringify(value, null, 2)}\n`; }
  };
  return { storage, readRaw: () => raw, writeRaw: (value: string) => { raw = value; } };
}

export function memoryMediaStorage(root: string) {
  const directory = path.join(root, ".poster-uploads");
  const files = new Map<string, Buffer>();
  let prepared = false;
  const filename = (id: string) => mediaFilePath(directory, id);
  const missing = () => Object.assign(new Error("ENOENT: fixture file missing"), { code: "ENOENT" });
  const read = (name: string) => {
    const value = files.get(name);
    if (!value) throw missing();
    return Buffer.from(value);
  };
  const storage: MediaStorage = {
    prepare: async () => { prepared = true; },
    writeFile: async (id, stream) => {
      if (!prepared) throw missing();
      const destination = filename(id);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      files.set(destination, Buffer.concat(chunks));
      return destination;
    },
    readFile: async (id) => read(filename(id)),
    writeMetadata: async (id, metadata) => {
      if (!prepared) throw missing();
      files.set(`${filename(id)}.json`, Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`));
    },
    read: async (id) => {
      const metadata = JSON.parse(read(`${filename(id)}.json`).toString()) as StoredMedia;
      const storedPath = filename(metadata.id);
      return { metadata, path: storedPath, size: read(storedPath).length };
    },
    openFile: (name) => Readable.from((async function* () { yield read(name); })()),
    delete: async (id) => {
      let deleted = false;
      try { deleted = files.delete(filename(id)); } catch {}
      try { deleted = files.delete(`${filename(id)}.json`) || deleted; } catch {}
      return deleted;
    },
    deleteAll: async () => { const count = files.size; files.clear(); return count; },
    stats: async () => ({ path: directory, files: files.size, bytes: [...files.values()].reduce((sum, file) => sum + file.length, 0) })
  };
  return {
    storage,
    readRaw: async (name: string) => read(name).toString(),
    writeRaw: async (name: string, value: string) => { files.set(name, Buffer.from(value)); },
    removeRaw: async (name: string) => { if (!files.delete(name)) throw missing(); }
  };
}
