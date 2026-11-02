import "server-only";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ControlError } from "./errors";
import { flushDirectory } from "../storage/durable-json";

type Claim = { version: 1; root: string; pid: number; token: string };
export type BackendOwner = { root: string; assert: () => void; release: () => void };
export const ownerFilename = ".poster-owner.json";
const recoveryName = ".poster-owner-recovery";
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
    throw new ControlError("storage_unavailable");
  }
}

function readClaim(filename: string) {
  try {
    const before = fs.lstatSync(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 16384 || (before.mode & 0o077)
      || (typeof process.getuid === "function" && before.uid !== process.getuid())) throw new ControlError("ownership_conflict");
    const claim = JSON.parse(fs.readFileSync(filename, "utf8")) as Claim;
    const after = fs.lstatSync(filename);
    if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs
      || claim.version !== 1 || typeof claim.root !== "string" || !Number.isSafeInteger(claim.pid) || claim.pid <= 0
      || typeof claim.token !== "string" || !/^[a-f0-9-]{36}$/.test(claim.token)
      || Object.keys(claim).sort().join() !== "pid,root,token,version") throw new ControlError("ownership_conflict");
    return { claim, stat: after };
  } catch (error) {
    if (error instanceof ControlError || missing(error)) throw error;
    throw new ControlError("ownership_conflict");
  }
}

// link creates the complete, fsynced claim exclusively: no half-written owner
// record is visible to another process. A recovery gate serializes stale removal.
export function acquireBackendOwner(dataRoot: string, alive = processAlive): BackendOwner {
  let root: string;
  try { root = fs.realpathSync(dataRoot); } catch { throw new ControlError("storage_unavailable"); }
  const filename = path.join(root, ownerFilename);
  const recovery = path.join(root, recoveryName);
  const claim: Claim = { version: 1, root, pid: process.pid, token: randomUUID() };
  const temporary = path.join(root, `.poster-owner-${claim.token}.tmp`);
  let gate = false;
  let linked = false;
  let descriptor: number | undefined;
  try {
    try { fs.lstatSync(recovery); throw new ControlError("ownership_conflict"); }
    catch (error) { if (!missing(error)) throw error; }
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(claim), "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    try { fs.linkSync(temporary, filename); linked = true; }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const prior = readClaim(filename);
      if (prior.claim.root !== root || alive(prior.claim.pid)) throw new ControlError("ownership_conflict");
      try { fs.mkdirSync(recovery, { mode: 0o700 }); gate = true; }
      catch { throw new ControlError("ownership_conflict"); }
      const current = readClaim(filename);
      if (current.stat.ino !== prior.stat.ino || current.stat.dev !== prior.stat.dev
        || current.claim.token !== prior.claim.token || alive(current.claim.pid)) throw new ControlError("ownership_conflict");
      fs.unlinkSync(filename);
      fs.linkSync(temporary, filename); linked = true;
    }
    flushDirectory(root);
    const owned = readClaim(filename);
    let released = false;
    let lost = false;
    const assert = () => {
      if (released || lost) throw new ControlError("ownership_conflict");
      try {
        const current = readClaim(filename);
        if (current.claim.token !== claim.token || current.claim.pid !== process.pid || current.claim.root !== root
          || current.stat.ino !== owned.stat.ino || current.stat.dev !== owned.stat.dev) throw new ControlError("ownership_conflict");
      } catch { lost = true; throw new ControlError("ownership_conflict"); }
    };
    return { root, assert, release: () => {
      if (released) return;
      assert();
      fs.unlinkSync(filename);
      released = true;
      flushDirectory(root);
    } };
  } catch (error) {
    // A partially acquired claim stays conservative on any durability failure.
    // It cannot authorize a mutation and becomes recoverable after process exit.
    throw error instanceof ControlError ? error : new ControlError(linked ? "storage_unavailable" : "ownership_conflict");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (!missing(error)) throw new ControlError("storage_unavailable"); }
    if (gate) { fs.rmdirSync(recovery); flushDirectory(root); }
  }
}

type OwnerState = { owners: Map<string, BackendOwner>; enabled: Set<string>; lost: Set<string> };
const stateKey = Symbol.for("crossposter.backend-ownership.v1");
const globals = globalThis as typeof globalThis & { [stateKey]?: OwnerState };
const state = globals[stateKey] ??= { owners: new Map(), enabled: new Set(), lost: new Set() };

// Shared across Next route bundles and hot reloads, but the authority is always
// the on-disk claim. Missing/replaced claims never silently reacquire ownership.
export function backendOwner(root: string): BackendOwner {
  const canonical = fs.realpathSync(root);
  if (state.lost.has(canonical)) throw new ControlError("ownership_conflict");
  let owner = state.owners.get(canonical);
  if (!owner) {
    owner = acquireBackendOwner(canonical);
    state.owners.set(canonical, owner);
  }
  try { owner.assert(); } catch (error) { state.lost.add(canonical); throw error; }
  return owner;
}
export function rememberControlRoot(root: string): void { state.enabled.add(path.resolve(root)); }
export function wasControlEnabled(root: string): boolean { return state.enabled.has(path.resolve(root)); }
export function releaseBackendOwners(): void {
  let failure: unknown;
  for (const [root, owner] of state.owners) {
    try { owner.release(); } catch (error) { state.lost.add(root); failure ??= error; }
    finally { state.owners.delete(root); }
  }
  if (failure) throw failure;
}
if (!globals[stateKey]?.enabled.has("exit-handler")) {
  state.enabled.add("exit-handler");
  process.once("exit", () => { for (const owner of state.owners.values()) { try { owner.release(); } catch { /* lost claims are never removed */ } } });
}
