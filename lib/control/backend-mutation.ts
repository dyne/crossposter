import "server-only";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { readControlCredential } from "./auth";
import { backendOwner, rememberControlRoot, wasControlEnabled } from "./backend-ownership";
import { readControlConfig } from "./read-storage";
import { readActionJournal } from "./action-store";
import { ControlError } from "./errors";
import { dataRoot } from "@/lib/runtime-paths";

export function controlEnabled(root: string): boolean {
  try { lstatSync(path.join(root, ".poster-control.json")); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      let remembered = wasControlEnabled(root);
      try { remembered ||= wasControlEnabled(realpathSync(root)); } catch { /* legacy writes retain their missing-root error */ }
      if (remembered) throw new ControlError("ownership_conflict");
      // Removing setup cannot let a fresh process bypass an incumbent claim or
      // the retained action store. Opt-out requires an offline owner operation.
      for (const name of [".poster-owner.json", ".poster-owner-recovery", ".poster-actions.json", ".poster-actions.anchor.json"]) {
        try { lstatSync(path.join(root, name)); throw new ControlError("ownership_conflict"); }
        catch (present) {
          if (present instanceof ControlError) throw present;
          if (!(present instanceof Error && "code" in present && present.code === "ENOENT")) throw new ControlError("storage_unavailable");
        }
      }
      return false;
    }
    throw new ControlError(wasControlEnabled(root) ? "ownership_conflict" : "storage_unavailable");
  }
}

// Opt-in is tested with lstat, not exists: a broken symlink, invalid credential
// or unreadable setup must never turn a control-enabled backend into legacy mode.
export function assertBackendMutation(root: string) {
  if (!controlEnabled(root)) return null;
  const { canonicalRoot } = readControlCredential(root);
  rememberControlRoot(root);
  rememberControlRoot(canonicalRoot);
  const owner = backendOwner(canonicalRoot);
  readControlConfig(canonicalRoot);
  readActionJournal(canonicalRoot);
  owner.assert();
  return owner;
}

export function assertCurrentBackendMutation() { return assertBackendMutation(dataRoot()); }
