import { constants, fstatSync, lstatSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { addAbortSignal, Readable } from "node:stream";
import { createHash } from "node:crypto";
import path from "node:path";
import { ControlError } from "../lib/control/errors";
import type { BridgeConfig } from "./config";

// Only this local adapter sees paths; the HTTP API receives bytes and a basename.
export async function localUpload(localPath: string, config: BridgeConfig, signal: AbortSignal) {
  if (!path.isAbsolute(localPath) || localPath.includes("\0") || localPath.split(path.sep).includes("..")) {
    throw new ControlError("validation_failed");
  }
  let handle;
  try {
    const allowed = (filename: string) => config.media.localRoots.some((root) => {
      const relative = path.relative(root, filename);
      return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    const canonical = realpathSync(localPath);
    if (!allowed(canonical)) throw new ControlError("forbidden");
    const before = lstatSync(canonical, { bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(config.media.maxBytes)) throw new ControlError("validation_failed");
    handle = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = handle;
    const identity = (stat: typeof before) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    const expected = identity(before);
    const assertCurrent = () => {
      signal.throwIfAborted();
      // O_NOFOLLOW protects only the final component. Re-resolve both paths and
      // bind the opened inode to the pre-open snapshot before any bytes leave.
      const selected = realpathSync(localPath), resolved = realpathSync(canonical);
      if (!allowed(selected) || !allowed(resolved) || selected !== canonical || resolved !== canonical) throw new ControlError("forbidden");
      const current = lstatSync(canonical, { bigint: true }), actual = fstatSync(opened.fd, { bigint: true });
      if (!actual.isFile() || identity(actual) !== expected || identity(current) !== expected) throw new ControlError("validation_failed");
    };
    assertCurrent();
    const size = Number(before.size);
    const readChunk = async (position: number) => {
      assertCurrent();
      const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, size - position));
      const result = await opened.read(bytes, 0, bytes.length, position);
      assertCurrent();
      if (!result.bytesRead) throw new ControlError("validation_failed");
      return bytes.subarray(0, result.bytesRead);
    };
    // Filesystems can retain identical timestamps across same-size rewrites.
    // Hash one bounded preflight pass; withhold the transfer's final chunk if
    // its digest differs, so the backend cannot accept a mixed/changed file.
    const selectedHash = createHash("sha256"); let inspected = 0;
    while (inspected < size) { const chunk = await readChunk(inspected); selectedHash.update(chunk); inspected += chunk.length; }
    const expectedDigest = selectedHash.digest("hex");
    async function* chunks() {
      let position = 0; const transferredHash = createHash("sha256");
      while (position < size) {
        const bytes = await readChunk(position); position += bytes.length; transferredHash.update(bytes);
        if (position === size && transferredHash.digest("hex") !== expectedDigest) throw new ControlError("validation_failed");
        yield bytes;
      }
      assertCurrent();
    }
    const stream = addAbortSignal(signal, Readable.from(chunks(), { objectMode: false, highWaterMark: 64 * 1024 }));
    return { handle: opened, size: Number(before.size), filename: path.basename(canonical), stream, assertCurrent };
  } catch (error) {
    await handle?.close();
    if (error instanceof ControlError) throw error;
    throw new ControlError("validation_failed");
  }
}
