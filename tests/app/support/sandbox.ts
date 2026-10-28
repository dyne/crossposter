import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

// Setup imports this helper before installing filesystem mocks. These original
// functions own fixture creation/cleanup; application imports get guarded APIs.
const sandboxRoot = fs.mkdtempSync(path.join(tmpdir(), "crossposter-unit-"));
const blockedCalls: string[] = [];

export function denyIO(boundary: string): never {
  blockedCalls.push(boundary);
  throw new Error(`Unexpected test IO: ${boundary}; install an explicit fake`);
}

// Only guard tests should consume this list. Ordinary tests fail in teardown
// even when production code catches the error from an unexpected IO attempt.
export function takeBlockedCalls(): string[] {
  return blockedCalls.splice(0);
}

export function assertNoBlockedCalls(): void {
  if (blockedCalls.length) {
    throw new Error(`Unexpected test IO was caught by application code: ${takeBlockedCalls().join(", ")}`);
  }
}

export function assertFixturePath(value: unknown): void {
  const filename = value instanceof URL
    ? fileURLToPath(value)
    : Buffer.isBuffer(value) ? value.toString() : value;
  if (typeof filename !== "string") {
    denyIO("filesystem outside sandbox");
  }
  const relative = path.relative(sandboxRoot, path.resolve(filename));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    denyIO("filesystem outside sandbox");
  }
}

export function createDataRoot(): string {
  return fs.mkdtempSync(path.join(sandboxRoot, "data-"));
}

export function setDataRoot(root = createDataRoot()): string {
  assertFixturePath(root);
  vi.stubEnv("CROSSPOSTER_DATA_DIR", root);
  vi.stubEnv("CROSSPOSTER_APP_ROOT", root);
  return root;
}

export function useDataRoot(root = createDataRoot()): string {
  setDataRoot(root);
  vi.resetModules();
  return root;
}

export function cleanDataRoots(): void {
  for (const entry of fs.readdirSync(sandboxRoot)) {
    fs.rmSync(path.join(sandboxRoot, entry), { recursive: true, force: true });
  }
}

export function disposeSandbox(): void {
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
}

export function freezeClock(now = "2026-01-15T12:00:00.000Z"): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
}
