import "server-only";
import { createReadStream, createWriteStream, lstatSync } from "node:fs";
import type { ReadStream } from "node:fs";
import { link, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MediaStorageStats, StoredMedia } from "./media-types";
import { assertBackendMutation } from "@/lib/control/backend-mutation";
import { mediaFilePath } from "./media-path";
export { mediaFilePath } from "./media-path";

export type StreamUpload = {
  path: string;
  write: (stream: Readable) => Promise<void>;
  commit: (metadata: StoredMedia) => Promise<void>;
  discard: () => Promise<void>;
};

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
  beginStreamUpload?: (id: string) => Promise<StreamUpload>;
};

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
    beginStreamUpload: async (id) => {
      assertBackendMutation(dataRoot);
      await mkdir(directory, { recursive: true });
      const directoryStat = lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Invalid media directory");
      const destination = mediaPath(id);
      const staging = path.join(directory, `.incoming-${id}`);
      assertBackendMutation(dataRoot);
      await mkdir(staging, { mode: 0o700 });
      const bytes = path.join(staging, "bytes"); const metadata = path.join(staging, "metadata.json");
      let ownBytes = false; let ownMetadata = false;
      return {
        path: destination,
        write: async (stream) => {
          assertBackendMutation(dataRoot);
          await pipeline(stream, createWriteStream(bytes, { flags: "wx", mode: 0o600 }));
        },
        commit: async (value) => {
          assertBackendMutation(dataRoot);
          await writeFile(metadata, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
          assertBackendMutation(dataRoot);
          await link(bytes, destination); ownBytes = true;
          assertBackendMutation(dataRoot);
          await link(metadata, metadataPath(id)); ownMetadata = true;
          assertBackendMutation(dataRoot);
          await rm(staging, { recursive: true, force: true });
        },
        discard: async () => {
          assertBackendMutation(dataRoot);
          if (ownMetadata) await unlink(metadataPath(id));
          assertBackendMutation(dataRoot);
          if (ownBytes) await unlink(destination);
          assertBackendMutation(dataRoot);
          await rm(staging, { recursive: true, force: true });
        }
      };
    },
    prepare: async () => { assertBackendMutation(dataRoot); await mkdir(directory, { recursive: true }); },
    writeFile: async (id, stream) => {
      assertBackendMutation(dataRoot);
      const destination = mediaPath(id);
      await pipeline(stream, createWriteStream(destination));
      return destination;
    },
    readFile: (id) => readFile(mediaPath(id)),
    writeMetadata: (id, metadata) => {
      assertBackendMutation(dataRoot);
      return writeFile(metadataPath(id), `${JSON.stringify(metadata, null, 2)}\n`);
    },
    read: async (id) => {
      const metadata = JSON.parse(await readFile(metadataPath(id), "utf8")) as StoredMedia;
      const storedPath = mediaPath(metadata.id);
      const fileStat = await stat(storedPath);
      return { metadata, path: storedPath, size: fileStat.size };
    },
    openFile: (filename) => createReadStream(filename),
    delete: async (id) => {
      assertBackendMutation(dataRoot);
      let deleted = false;
      try {
        await unlink(mediaPath(id));
        deleted = true;
      } catch {}
      assertBackendMutation(dataRoot);
      try {
        await unlink(metadataPath(id));
        deleted = true;
      } catch {}
      return deleted;
    },
    deleteAll: async () => {
      assertBackendMutation(dataRoot);
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      assertBackendMutation(dataRoot);
      await Promise.all(entries.map((entry) => rm(path.join(directory, entry.name), { force: true, recursive: true })));
      return entries.length;
    },
    stats: async () => ({ path: directory, ...(await walk(directory)) })
  };
}
