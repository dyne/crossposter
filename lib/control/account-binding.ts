import "server-only";
import { createHash, createHmac } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { configFields } from "@/lib/config-spec";
import { validatePlatformConfig } from "@/lib/config-validation";
import { normalizeValues } from "@/lib/storage/config-codec";
import { chromeCookieDbCandidates, ensureYouTubeCookieCanUpload, normalizeYouTubeCookie } from "@/lib/youtube-browser-cookie";
import { canonicalJson } from "./canonical";
import { ControlError } from "./errors";
import { projectControlConfig } from "./read-projections";
import type { ControlReadConfig } from "./read-storage";

// Explicit base resolution never calls the legacy active-profile lookup. Later
// execution must resolve this same target ID and verify its private binding.
export function resolveControlTarget(config: ControlReadConfig, id: string, environmentValue: (name: string) => string | undefined) {
  const dto = projectControlConfig(config, environmentValue);
  const target = dto.targets.find((item) => item.id === id);
  if (!target) throw new ControlError("target_missing");
  const profile = target.profileId === null ? undefined : config.profiles[target.platform]?.find((item) => item.id === target.profileId);
  const localValues = profile ? normalizeValues(profile.values) : { ...normalizeValues(config), ...normalizeValues(config.values) };
  const values = Object.fromEntries(configFields.filter((field) => field.requiredFor?.includes(target.platform) || field.showFor?.includes(target.platform))
    .map((field) => [field.name, localValues[field.name] || (!profile ? environmentValue(field.name) : undefined) || field.defaultValue || ""]));
  return { target, values, valid: validatePlatformConfig(target.platform, values).length === 0 };
}
export type ResolvedControlTarget = ReturnType<typeof resolveControlTarget>;

// This is a conservative local session binding, not a provider login claim.
// Cookie/login/storage bytes are bound privately as well as tree identity, so
// same-size rewrites on filesystems with coarse timestamps still invalidate it.
// No session bytes, paths or credential fingerprints enter the public revision.
export function sessionIdentitySnapshot(root: string, resolved: ResolvedControlTarget): string {
  const { target, values } = resolved;
  const folders = target.platform === "x" ? [values.X_BROWSER_PROFILE_DIR]
    : target.platform === "instagram" ? [values.INSTAGRAM_BROWSER_PROFILE_DIR]
      : target.platform === "pinterest" ? [values.PINTEREST_CRED_ROOT] : [];
  let files: string[] = [];
  try {
    if (target.platform === "youtube") {
      const stored = normalizeYouTubeCookie(values.YOUTUBE_COOKIE);
      if (values.YOUTUBE_COOKIE_SOURCE.trim().toLowerCase() === "manual") {
        try { if (!stored) throw new Error(); ensureYouTubeCookieCanUpload(stored); }
        catch { throw new ControlError("validation_failed"); }
      } else {
        let candidates: ReturnType<typeof chromeCookieDbCandidates> = [];
        try { candidates = chromeCookieDbCandidates(values.YOUTUBE_CHROME_PROFILE.trim() || undefined); }
        catch { if (!stored) throw new ControlError("action_conflict"); }
        // The incumbent provider falls back to its stored cookie when Chrome
        // import is unavailable. Bind both potential sources conservatively.
        if (!candidates.length && !stored) throw new ControlError("action_conflict");
        files = candidates.flatMap(({ dbPath }) => [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]);
      }
    }
    const hash = createHash("sha256"); let entries = 0; let identityBytes = 0;
    function visit(filename: string, depth: number, optional = false) {
      if (++entries > 50_000 || depth > 20) throw new ControlError("storage_unavailable");
      let stat;
      try { stat = lstatSync(filename, { bigint: true }); }
      catch (error) {
        if (optional && error instanceof Error && "code" in error && error.code === "ENOENT") { hash.update(canonicalJson([filename, "absent"])); return; }
        throw error;
      }
      hash.update(canonicalJson([filename, String(stat.dev), String(stat.ino), String(stat.mode), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]));
      if (stat.isSymbolicLink()) {
        // Chromium's transient process/socket links are not account data. Other
        // links cannot establish a stable session tree and are refused.
        if (!path.basename(filename).startsWith("Singleton")) throw new ControlError("action_conflict");
        hash.update(readlinkSync(filename)); return;
      }
      if (stat.isDirectory()) for (const name of readdirSync(filename).sort()) visit(path.join(filename, name), depth + 1);
      else if (!stat.isFile()) throw new ControlError("action_conflict");
      else if (target.platform === "pinterest" || /(?:^|[/\\])(?:Cookies(?:-wal|-shm)?|Login Data(?:-wal|-shm)?|Preferences|Secure Preferences|Local State)$/.test(filename)
        || /[/\\](?:Local Storage|Session Storage)[/\\]/.test(filename)) {
        identityBytes += Number(stat.size);
        if (identityBytes > 64 * 1024 * 1024) throw new ControlError("storage_unavailable");
        const bytes = readFileSync(filename); const after = lstatSync(filename, { bigint: true });
        if (BigInt(bytes.length) !== stat.size || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs) throw new ControlError("action_conflict");
        hash.update(bytes);
      }
    }
    for (const folder of folders) visit(realpathSync(path.resolve(root, folder.trim())), 0);
    for (const filename of files) visit(filename, 0, filename.endsWith("-wal") || filename.endsWith("-shm"));
    return `sha256:${hash.digest("hex")}`;
  } catch (error) { throw error instanceof ControlError ? error : new ControlError("action_conflict"); }
}

export function bindControlAccount(root: string, privateKey: string, resolved: ResolvedControlTarget): string {
  return `sha256:${createHmac("sha256", privateKey).update(canonicalJson({ target: resolved.target,
    resolution: resolved.target.profileId === null ? "explicit_base" : "explicit_profile", values: resolved.values,
    session: sessionIdentitySnapshot(root, resolved) })).digest("hex")}`;
}
