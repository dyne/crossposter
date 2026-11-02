#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const usage = "Usage: node scripts/setup-control.mjs --data-root <existing-directory> --origin http://127.0.0.1:2004";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log(usage);
} else {
  let descriptor;
  try {
    if (args.length !== 4 || args[0] !== "--data-root" || args[2] !== "--origin") throw new Error();
    const root = realpathSync(args[1]);
    if (!statSync(root).isDirectory()) throw new Error();
    const url = new URL(args[3]);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
      || url.origin !== args[3] || url.username || url.password) throw new Error();
    const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
    const rootBinding = hash(root);
    const backendId = randomUUID();
    const credential = { version: 1, rootBinding, backendId,
      instanceId: hash(`crossposter-control-v1\n${rootBinding}\n${backendId}`),
      token: randomBytes(32).toString("hex"), origin: url.origin };
    // Exclusive creation refuses every existing file, dangling symlink included.
    // A failed/partial setup is left for explicit owner inspection, never replaced.
    descriptor = openSync(path.join(root, ".poster-control.json"), "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(credential, null, 2)}\n`);
    fsyncSync(descriptor);
    console.log("Control credential created in .poster-control.json. Keep that file private.");
  } catch {
    console.error(`Control setup refused. Use an existing data directory, an explicit loopback origin, and no existing credential file.\n${usage}`);
    process.exitCode = 1;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
