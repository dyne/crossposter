// Shared backend/Node bridge credential boundary. Never import provider state.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod-control";
import { digestSchema } from "./contracts";
import { ControlError } from "./errors";

const credentialSchema = z.strictObject({
  version: z.literal(1), rootBinding: digestSchema,
  backendId: z.uuid(), instanceId: digestSchema,
  token: z.string().regex(/^[a-f0-9]{64}$/), origin: z.string()
});
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export function controlInstanceId(rootBinding: string, backendId: string) {
  return hash(`crossposter-control-v1\n${rootBinding}\n${backendId}`);
}
export function isControlOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)
      && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}
export function readControlCredential(root: string) {
  let canonicalRoot: string;
  let credential: z.infer<typeof credentialSchema>;
  try {
    canonicalRoot = realpathSync(root);
    const filename = path.join(canonicalRoot, ".poster-control.json");
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 16384
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new ControlError("storage_corrupt");
    credential = credentialSchema.parse(JSON.parse(readFileSync(filename, "utf8")));
    if (!isControlOrigin(credential.origin)) throw new ControlError("storage_corrupt");
  } catch (error) {
    if (error instanceof ControlError) throw error;
    if (error instanceof Error && (error instanceof SyntaxError || error.name === "ZodError")) throw new ControlError("storage_corrupt");
    throw new ControlError("storage_unavailable");
  }
  if (credential.rootBinding !== hash(canonicalRoot)
    || credential.instanceId !== controlInstanceId(credential.rootBinding, credential.backendId)) {
    throw new ControlError("instance_mismatch");
  }
  return { canonicalRoot, credential };
}
