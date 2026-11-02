import assert from "node:assert/strict";
import { fstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import filesystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { localUpload } from "../../dist/mcp/mcp/upload.js";
import { within } from "./support.mjs";

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "crossposter-mcp-files-"));
  const media = path.join(directory, "media ü"), outside = path.join(directory, "private"); mkdirSync(media); mkdirSync(outside);
  const config = { media: { localRoots: [media], maxBytes: 1024 * 1024, timeoutMs: 1000 } };
  return { directory, media, outside, config, close: () => rmSync(directory, { recursive: true, force: true }) };
}
const signal = () => AbortSignal.timeout(2000);

test("local streaming handles Unicode/space paths in bounded chunks and rejects escapes/devices/missing/directory/oversize inputs", async () => {
  const f = fixture(); let upload;
  try {
    const bytes = Buffer.alloc(256 * 1024 + 7, 3), selected = path.join(f.media, "selected image ü.png"); writeFileSync(selected, bytes);
    upload = await localUpload(selected, f.config, signal()); const chunks = [];
    for await (const chunk of upload.stream) { assert.ok(chunk.length <= 64 * 1024); chunks.push(chunk); }
    assert.equal(Buffer.concat(chunks).equals(bytes), true); upload.assertCurrent(); await upload.handle.close(); upload = undefined;
    const privateFile = path.join(f.outside, "poster.config.local.json"); writeFileSync(privateFile, "private-fixture-canary");
    symlinkSync(privateFile, path.join(f.media, "escape.png")); symlinkSync(f.outside, path.join(f.media, "ancestor"), "dir"); symlinkSync("/dev/null", path.join(f.media, "device.png"));
    for (const selectedPath of [privateFile, path.join(f.media, "escape.png"), path.join(f.media, "ancestor/poster.config.local.json"),
      `${f.media}/../private/poster.config.local.json`, path.join(f.media, "missing.png"), f.media, "/dev/null", path.join(f.media, "device.png"), "relative.png"]) {
      await assert.rejects(localUpload(selectedPath, f.config, signal()), undefined, "invalid local selection must not open a transferable stream");
    }
    await assert.rejects(localUpload(selected, { media: { ...f.config.media, maxBytes: 2 } }, signal()));
    await assert.rejects(localUpload(selected, { media: { ...f.config.media, localRoots: [] } }, signal()));
    await assert.rejects(localUpload("/dev/null", { media: { ...f.config.media, localRoots: ["/dev"] } }, signal()), (error) => error.code === "validation_failed");
  } finally { upload?.stream.destroy(); await upload?.handle.close(); f.close(); }
});

test("ancestor replacement between realpath authorization and awaited open is refused before a single byte is read", async (t) => {
  const f = fixture(); const selectedDirectory = path.join(f.media, "album"); mkdirSync(selectedDirectory);
  const selected = path.join(selectedDirectory, "image.png"); writeFileSync(selected, "selected bytes"); writeFileSync(path.join(f.outside, "image.png"), "outside private bytes");
  const original = fs.open; let opened, reads = 0;
  t.mock.method(fs, "open", async (...args) => {
    renameSync(selectedDirectory, `${selectedDirectory}-retained`); symlinkSync(f.outside, selectedDirectory, "dir");
    opened = await original(...args);
    assert.equal(fstatSync(opened.fd).ino === statSync(path.join(f.outside, "image.png")).ino, true, "the injected race actually opened the outside inode");
    const read = opened.read.bind(opened);
    opened.read = (...values) => { reads++; return read(...values); }; return opened;
  });
  try {
    await assert.rejects(localUpload(selected, f.config, signal()), (error) => ["forbidden", "validation_failed"].includes(error.code));
    assert.equal(reads, 0); assert.equal(opened.fd, -1, "rejected file descriptor is closed");
  } finally { t.mock.restoreAll(); f.close(); }
});

test("changed inode or bytes and injected read errors stop streaming and close the selected descriptor", async (t) => {
  const f = fixture(); const selected = path.join(f.media, "image.png"); const original = fs.open;
  try {
    for (const mode of ["write", "replace", "failure"]) {
      writeFileSync(selected, Buffer.alloc(64 * 1024, 4)); let opened, chunks = 0, upload;
      const initial = statSync(selected, { bigint: true });
      const freezeTimes = (stat) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { mtimeNs: initial.mtimeNs, ctimeNs: initial.ctimeNs });
      const lstat = filesystem.lstatSync, fstat = filesystem.fstatSync;
      // Force the same-size timestamp collision observed on the host filesystem;
      // inode/size checks remain real. Byte comparison must detect the rewrite.
      if (mode === "write") {
        t.mock.method(filesystem, "lstatSync", (...values) => freezeTimes(lstat(...values)));
        t.mock.method(filesystem, "fstatSync", (...values) => freezeTimes(fstat(...values)));
        syncBuiltinESMExports();
      }
      const mock = t.mock.method(fs, "open", async (...args) => {
        opened = await original(...args); const read = opened.read.bind(opened);
        opened.read = async (...values) => {
          if (mode === "failure") throw new Error("Injected read failure");
          const result = await read(...values);
          if (mode === "replace") { renameSync(selected, `${selected}.old`); writeFileSync(selected, Buffer.alloc(64 * 1024, 5)); }
          else writeFileSync(selected, Buffer.alloc(64 * 1024, 5));
          return result;
        }; return opened;
      });
      try { await assert.rejects(async () => { upload = await localUpload(selected, f.config, signal()); for await (const chunk of upload.stream) chunks += chunk.length; }); assert.equal(chunks, 0); }
      finally { upload?.stream.destroy(); await upload?.handle.close(); mock.mock.restore(); t.mock.restoreAll(); syncBuiltinESMExports(); }
      assert.equal(opened.fd, -1);
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
});

test("cancellation while a preflight or transfer read is held emits no bytes and releases the descriptor", async (t) => {
  const f = fixture(); const selected = path.join(f.media, "image.png"); writeFileSync(selected, Buffer.alloc(64 * 1024));
  const original = fs.open;
  try {
    for (const holdAt of [1, 2]) {
      const controller = new AbortController(); let release, entered, upload, opened, calls = 0, bytes = 0;
      const held = new Promise((resolve) => { release = resolve; }), started = new Promise((resolve) => { entered = resolve; });
      t.mock.method(fs, "open", async (...args) => {
        opened = await original(...args); const read = opened.read.bind(opened);
        opened.read = async (...values) => { if (++calls === holdAt) { entered(); await held; } return read(...values); }; return opened;
      });
      const running = (async () => {
        upload = await localUpload(selected, f.config, controller.signal);
        for await (const chunk of upload.stream) bytes += chunk.length;
        return true;
      })().catch(() => false);
      try { await within(started); controller.abort(); release(); assert.equal(await within(running), false); assert.equal(bytes, 0); }
      finally { release(); await within(running); upload?.stream.destroy(); await upload?.handle.close(); t.mock.restoreAll(); }
      assert.equal(opened.fd, -1);
    }
  } finally { t.mock.restoreAll(); f.close(); }
});
