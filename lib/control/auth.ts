import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
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

export function authenticateControl(request: Request, root: string) {
  let setup: ReturnType<typeof readControlCredential>;
  try { setup = readControlCredential(root); } catch (error) {
    if (error instanceof ControlError && error.code === "instance_mismatch") throw error;
    throw new ControlError("unauthorized");
  }
  const { canonicalRoot, credential } = setup;
  const url = new URL(request.url);
  const expectedOrigin = new URL(credential.origin);
  const forwarded = (name: string, expected: string) => request.headers.has(name) && request.headers.get(name) !== expected;
  const peer = request.headers.get("x-forwarded-for");
  // NextURL rewrites loopback IP literals to localhost. Accept that internal
  // representation only with the original exact host and direct-loopback peer.
  const nextLoopbackUrl = url.hostname === "localhost" && url.protocol === expectedOrigin.protocol && url.port === expectedOrigin.port
    && request.headers.get("host") === expectedOrigin.host && request.headers.get("x-forwarded-host") === expectedOrigin.host
    && peer !== null && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer);
  if ((url.origin !== credential.origin && !nextLoopbackUrl) || !url.pathname.startsWith("/api/mcp/v1/")
    || (request.headers.has("host") && request.headers.get("host") !== expectedOrigin.host)
    || (request.headers.has("origin") && request.headers.get("origin") !== credential.origin)
    // Next supplies these on direct requests; reject proxy hops/substitution.
    || request.headers.has("forwarded") || forwarded("x-forwarded-host", expectedOrigin.host)
    || forwarded("x-forwarded-proto", "http") || forwarded("x-forwarded-port", expectedOrigin.port || "80")
    || (peer !== null && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer))) {
    throw new ControlError("forbidden");
  }
  const expected = Buffer.from(`Bearer ${credential.token}`, "utf8");
  const actual = Buffer.from(request.headers.get("authorization") ?? "", "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ControlError("unauthorized");
  if (request.headers.get("x-crossposter-instance") !== credential.instanceId) throw new ControlError("instance_mismatch");
  return { canonicalRoot, instanceId: credential.instanceId };
}
