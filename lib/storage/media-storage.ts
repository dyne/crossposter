import "server-only";
import { createReadStream, createWriteStream } from "node:fs";
import type { ReadStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MediaStorageStats, StoredMedia } from "./media-types";

export type MediaStorage<Stream extends Readable = Readable> = {
  prepare: () => Promise<void>;
  writeFile: (id: string, stream: Readable) => Promise<string>;
  readFile: (id: string) => Promise<Buffer>;
  writeMetadata: (id: string, metadata: StoredMedia) => Promise<void>;
  read: (id: string) => Promise<{ metadata: StoredMedia; path: string; size: number }>;
  openFile: (filename: string) => Stream;
  delete: (id: string) => Promise<boolean>;
  deleteAll: () => Promise<number>;
  stats: () => Promise<MediaStorageStats>;
};

const mediaIdPattern = /^[a-f0-9-]{36}(?:\.[a-z0-9]{1,12})?$/i;

export function mediaFilePath(directory: string, id: string): string {
  if (!mediaIdPattern.test(id)) {
    throw new Error("Invalid media id");
  }

  return path.join(directory, id);
}

export function createMediaStorage(dataRoot: string): MediaStorage<ReadStream> {
  const directory = path.join(dataRoot, ".poster-uploads");
  const mediaPath = (id: string) => mediaFilePath(directory, id);
  const metadataPath = (id: string) => `${mediaPath(id)}.json`;

  async function walk(current: string): Promise<{ files: number; bytes: number }> {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    const stats = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(current, entry.name);

        if (entry.isDirectory()) {
          return walk(entryPath);
        }

        if (!entry.isFile()) {
          return { files: 0, bytes: 0 };
        }

        const fileStat = await stat(entryPath).catch(() => null);
        return { files: fileStat ? 1 : 0, bytes: fileStat?.size || 0 };
      })
    );

    return stats.reduce(
      (total, item) => ({ files: total.files + item.files, bytes: total.bytes + item.bytes }),
      { files: 0, bytes: 0 }
    );
  }

  return {
    prepare: async () => { await mkdir(directory, { recursive: true }); },
    writeFile: async (id, stream) => {
      const destination = mediaPath(id);
      await pipeline(stream, createWriteStream(destination));
      return destination;
    },
    readFile: (id) => readFile(mediaPath(id)),
    writeMetadata: (id, metadata) => writeFile(metadataPath(id), `${JSON.stringify(metadata, null, 2)}\n`),
    read: async (id) => {
      const metadata = JSON.parse(await readFile(metadataPath(id), "utf8")) as StoredMedia;
      const storedPath = mediaPath(metadata.id);
      const fileStat = await stat(storedPath);
      return { metadata, path: storedPath, size: fileStat.size };
    },
    openFile: (filename) => createReadStream(filename),
    delete: async (id) => {
      let deleted = false;
      try {
        await unlink(mediaPath(id));
        deleted = true;
      } catch {}
      try {
        await unlink(metadataPath(id));
        deleted = true;
      } catch {}
      return deleted;
    },
    deleteAll: async () => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      await Promise.all(entries.map((entry) => rm(path.join(directory, entry.name), { force: true, recursive: true })));
      return entries.length;
    },
    stats: async () => ({ path: directory, ...(await walk(directory)) })
  };
}
