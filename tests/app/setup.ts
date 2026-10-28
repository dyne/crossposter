import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { afterAll, afterEach, beforeEach, vi } from "vitest";
import { configFields } from "@/lib/config-spec";
import type { Platform, ProviderContext, PublishResult } from "@/lib/types";
import {
  assertFixturePath,
  assertNoBlockedCalls,
  cleanDataRoots,
  denyIO,
  disposeSandbox,
  setDataRoot
} from "./support/sandbox";

function blocked(boundary: string) {
  return vi.fn(function () { return denyIO(boundary); });
}

function guardFilesystem<T extends object>(original: T, names: string[]): T {
  const guarded = { ...original };
  for (const name of names) {
    const operation = Reflect.get(original, name);
    if (typeof operation !== "function") throw new Error(`Missing filesystem API: ${name}`);
    Reflect.set(guarded, name, (...args: unknown[]) => {
      assertFixturePath(args[0]);
      return Reflect.apply(operation, original, args);
    });
  }
  return guarded;
}

const guardedFs = guardFilesystem(fs, [
  "existsSync", "readFileSync", "writeFileSync", "mkdirSync", "readdirSync",
  "rmSync", "unlinkSync", "statSync", "accessSync", "createReadStream", "createWriteStream"
]);
const guardedPromises = guardFilesystem(fsPromises, [
  "access", "mkdir", "readFile", "readdir", "rm", "stat", "unlink", "writeFile", "open"
]);

// doMock is deliberate: the setup's native imports above must precede mocks.
// Vitest runs this file before importing each test/application module.
vi.doMock("node:fs", () => ({ ...guardedFs, promises: guardedPromises, default: { ...guardedFs, promises: guardedPromises } }));
vi.doMock("node:fs/promises", () => ({ ...guardedPromises, default: guardedPromises }));
vi.doMock("node:child_process", () => {
  const operations = Object.fromEntries(
    ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]
      .map((name) => [name, blocked(`process.${name}`)])
  );
  return { ...operations, default: operations };
});

async function blockNetworkModule(module: string, names: string[]) {
  const original = await vi.importActual<Record<string, unknown>>(module);
  const operations = Object.fromEntries(names.map((name) => [name, blocked(`${module}.${name}`)]));
  return { ...original, ...operations, default: { ...original, ...operations } };
}

vi.doMock("node:http", () => blockNetworkModule("node:http", ["request", "get"]));
vi.doMock("node:https", () => blockNetworkModule("node:https", ["request", "get"]));
vi.doMock("node:net", () => blockNetworkModule("node:net", ["connect", "createConnection", "Socket"]));
vi.doMock("node:tls", () => blockNetworkModule("node:tls", ["connect", "TLSSocket"]));

const platforms: Platform[] = [
  "x", "linkedin", "bluesky", "mastodon", "instagram", "youtube",
  "dribbble", "pinterest", "devto", "hackernews", "nostr"
];
const providerFakes = Object.fromEntries(platforms.map((platform) => [
  platform,
  vi.fn<(context: ProviderContext) => Promise<PublishResult>>(
    async () => denyIO(`provider.${platform}`)
  )
]));
vi.doMock("@/lib/providers", () => ({ providers: providerFakes }));

function isolateEnvironment() {
  // No provider/account settings are inherited from the developer or CI host.
  const configNames = new Set(configFields.map((field) => field.name));
  for (const name of Object.keys(process.env)) {
    if (/^(CROSSPOSTER_|POSTER_|X_|INSTAGRAM_|PINTEREST_|HACKERNEWS_|YOUTUBE_)/.test(name)) {
      configNames.add(name);
    }
  }
  for (const name of configNames) vi.stubEnv(name, undefined);
  setDataRoot();
  vi.stubEnv("POSTER_DISABLE_SCHEDULER", "true");
  vi.stubGlobal("fetch", blocked("fetch"));
  vi.stubGlobal("WebSocket", blocked("WebSocket"));
}

// Also protect static imports during collection. Tests should dynamically import
// modules after useDataRoot() whenever they capture paths or environment values.
isolateEnvironment();
beforeEach(() => {
  vi.resetAllMocks();
  isolateEnvironment();
});
afterEach(() => {
  try {
    assertNoBlockedCalls();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    cleanDataRoots();
  }
});
afterAll(disposeSandbox);
