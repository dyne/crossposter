import "server-only";
import { timingSafeEqual } from "node:crypto";
import { readControlCredential } from "./credential";
import { ControlError } from "./errors";
export { controlInstanceId, isControlOrigin, readControlCredential } from "./credential";

export function assertLocalControlRequest(request: Request, credential: ReturnType<typeof readControlCredential>["credential"],
  pathPrefix: string, requireOrigin = false) {
  const url = new URL(request.url);
  const expectedOrigin = new URL(credential.origin);
  const forwarded = (name: string, expected: string) => request.headers.has(name) && request.headers.get(name) !== expected;
  const peer = request.headers.get("x-forwarded-for");
  // NextURL rewrites loopback IP literals to localhost. Accept that internal
  // representation only with the original exact host and direct-loopback peer.
  const nextLoopbackUrl = url.hostname === "localhost" && url.protocol === expectedOrigin.protocol && url.port === expectedOrigin.port
    && request.headers.get("host") === expectedOrigin.host && request.headers.get("x-forwarded-host") === expectedOrigin.host
    && peer !== null && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer);
  if ((url.origin !== credential.origin && !nextLoopbackUrl) || !url.pathname.startsWith(pathPrefix)
    || (request.headers.has("host") && request.headers.get("host") !== expectedOrigin.host)
    || (request.headers.has("origin") && request.headers.get("origin") !== credential.origin)
    // Next supplies these on direct requests; reject proxy hops/substitution.
    || request.headers.has("forwarded") || forwarded("x-forwarded-host", expectedOrigin.host)
    || forwarded("x-forwarded-proto", "http") || forwarded("x-forwarded-port", expectedOrigin.port || "80")
    || (peer !== null && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer))) {
    throw new ControlError("forbidden");
  }
  if (requireOrigin && request.headers.get("origin") !== credential.origin) throw new ControlError("forbidden");
}

export function authenticateControl(request: Request, root: string) {
  let setup: ReturnType<typeof readControlCredential>;
  try { setup = readControlCredential(root); } catch (error) {
    if (error instanceof ControlError && error.code === "instance_mismatch") throw error;
    throw new ControlError("unauthorized");
  }
  const { canonicalRoot, credential } = setup;
  assertLocalControlRequest(request, credential, "/api/mcp/v1/");
  const expected = Buffer.from(`Bearer ${credential.token}`, "utf8");
  const actual = Buffer.from(request.headers.get("authorization") ?? "", "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ControlError("unauthorized");
  if (request.headers.get("x-crossposter-instance") !== credential.instanceId) throw new ControlError("instance_mismatch");
  return { canonicalRoot, instanceId: credential.instanceId };
}
