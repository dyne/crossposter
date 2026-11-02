import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkBoundaries, readProductionSources } from "./import-boundaries.mjs";

test("current browser and core boundaries have no runtime server/adapter dependencies", () => {
  const files = readProductionSources(fileURLToPath(new URL("../../", import.meta.url)));
  assert.ok(files.size > 100, "must inspect the production tree");
  assert.deepEqual(checkBoundaries(files), []);
});

test("rejects a client dependency reaching Node through a re-export and dynamic import", () => {
  const files = new Map([
    ["app/page.tsx", '// client entry\n"use client"; import { load } from "@/lib/bridge";'],
    ["lib/bridge.ts", 'export { load } from "./nested";'],
    ["lib/nested.ts", 'export const load = () => import("node:fs");']
  ]);
  assert.match(checkBoundaries(files).join("\n"), /app\/page.tsx.*@\/lib\/bridge.*\.\/nested.*node:fs/);
});

test("rejects server modules and computed or unresolved imports from browser-safe libraries", () => {
  for (const dependency of ['"@/lib/local-config"', '"@/lib/guarded"', '"./missing"', "moduleName"]) {
    const files = new Map([
      ["lib/compose/client.ts", `export const load = () => import(${dependency});`],
      ["lib/local-config.ts", "export const value = 1;"],
      ["lib/guarded.ts", 'import "server-only";']
    ]);
    assert.ok(checkBoundaries(files).length > 0, dependency);
  }
});

test("permits erased types while rejecting runtime provider and storage coupling in core services", () => {
  const files = new Map([
    ["lib/publishing/service.ts", 'import "server-only"; import type { Provider } from "@/lib/providers";'],
    ["lib/providers/index.ts", 'import "node:child_process";'],
    ["lib/storage/config-codec.ts", 'export type { Provider } from "@/lib/providers";'],
    ["lib/compose/client.ts", 'import { type Provider } from "@/lib/providers";']
  ]);
  assert.deepEqual(checkBoundaries(files), []);
  files.set("lib/publishing/service.ts", 'import { provider } from "@/lib/providers";');
  assert.match(checkBoundaries(files).join("\n"), /publishing\/service.*providers/);
  files.set("lib/storage/config-codec.ts", 'const fs = require("fs");');
  assert.match(checkBoundaries(files).join("\n"), /config-codec.*fs/);
});

test("resolves present static CSS modules without allowing missing styles or hidden Node imports", () => {
  const files = new Map([
    ["components/approval.tsx", '"use client"; import styles from "./approval.module.css"; import { value } from "./helper";'],
    ["components/approval.module.css", ".page { color: green; }"],
    ["components/helper.ts", "export const value = 1;"]
  ]);
  assert.deepEqual(checkBoundaries(files), []);
  files.delete("components/approval.module.css");
  assert.match(checkBoundaries(files).join("\n"), /unresolved.*approval.module.css/);
  files.set("components/approval.module.css", ".page { color: green; }");
  files.set("components/helper.ts", 'import "node:fs";');
  assert.match(checkBoundaries(files).join("\n"), /forbidden.*helper.*node:fs/);
});

test("Node bridge can share credentials/contracts but cannot import backend ownership, server-only, Next or providers", () => {
  const files = new Map([
    ["mcp/server.ts", 'import { read } from "../lib/control/credential"; import "node:fs";'],
    ["lib/control/credential.ts", 'import "node:crypto"; export const read = () => {};']
  ]);
  assert.deepEqual(checkBoundaries(files), []);
  for (const dependency of ['"server-only"', '"next/server"', '"../lib/providers/index"', '"../lib/control/backend-ownership"']) {
    files.set("mcp/server.ts", `import ${dependency};`);
    files.set("lib/providers/index.ts", "export const provider = 1;");
    files.set("lib/control/backend-ownership.ts", 'import "server-only";');
    assert.ok(checkBoundaries(files).length > 0, dependency);
  }
});
