import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isPlaceholderValue } from "@/lib/config-validation";
import { assertLocalControlRequest, readControlCredential } from "./auth";
import { ControlError } from "./errors";
import { projectControlConfig } from "./read-projections";
import { readControlConfig } from "./read-storage";

const cookieName = "crossposter-owner";
const lifetimeMs = 15 * 60_000;
type Session = { root: string; instanceId: string; credentialTag: string; csrf: string; expires: number };
type Attempts = { failures: number; until: number };
type Authority = { key: Buffer; sessions: Map<string, Session>; attempts: Map<string, Attempts> };
const authorityKey = Symbol.for("crossposter.owner-approval.v1");
const state = globalThis as typeof globalThis & { [authorityKey]?: Authority };
// Shared across Next route bundles, but never persisted or derived from the
// machine credential. Restart signs the owner out without losing decisions.
function authority(): Authority {
  return state[authorityKey] ??= { key: randomBytes(32), sessions: new Map(), attempts: new Map() };
}
function equal(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function ownerApprovalConfigured(root: string): boolean {
  return ownerSetup(root).password !== null;
}
function ownerSetup(root: string) {
  const setup = readControlCredential(root);
  const password = projectControlConfig(readControlConfig(setup.canonicalRoot), (name) => process.env[name]).baseValue("POSTER_ADMIN_PASSWORD");
  return { ...setup, password: !password || password.length > 1024 || /[\0\r\n]/.test(password)
    || isPlaceholderValue(password) || equal(password, setup.credential.token) ? null : password };
}
export function checkOwnerRequest(request: Request, root: string, mutation: boolean) {
  const setup = ownerSetup(root);
  assertLocalControlRequest(request, setup.credential, "/api/approvals/", mutation);
  if (request.headers.get("host") !== new URL(setup.credential.origin).host
    || request.headers.has("authorization") || request.headers.has("x-crossposter-instance")
    || (request.headers.has("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin")
    || new URL(request.url).searchParams.size) throw new ControlError("forbidden");
  if (mutation && request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new ControlError("validation_failed");
  return setup;
}
function tag(password: string) { return createHmac("sha256", authority().key).update(password).digest("hex"); }
function prune(now: number) {
  for (const [id, session] of authority().sessions) if (session.expires <= now) authority().sessions.delete(id);
  for (const [root, attempt] of authority().attempts) if (attempt.until <= now) authority().attempts.delete(root);
}
function sessionId(request: Request) {
  const values = (request.headers.get("cookie") ?? "").split(";").map((value) => value.trim()).filter((value) => value.startsWith(`${cookieName}=`));
  if (values.length !== 1) throw new ControlError("approval_required");
  const id = values[0].slice(cookieName.length + 1);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new ControlError("approval_required");
  return id;
}
export function authenticateOwner(request: Request, root: string, mutation = false, now = Date.now()) {
  const setup = checkOwnerRequest(request, root, mutation);
  if (setup.password === null) throw new ControlError("approval_setup_required");
  prune(now);
  const session = authority().sessions.get(sessionId(request));
  if (!session || session.root !== setup.canonicalRoot || session.instanceId !== setup.credential.instanceId
    || !equal(session.credentialTag, tag(setup.password))) throw new ControlError("approval_required");
  if (mutation && !equal(session.csrf, request.headers.get("x-crossposter-csrf") ?? "")) throw new ControlError("forbidden");
  return { csrf: session.csrf, expiresAt: new Date(session.expires).toISOString() };
}
export function loginOwner(request: Request, root: string, password: string, now = Date.now()) {
  const setup = checkOwnerRequest(request, root, true);
  if (setup.password === null) throw new ControlError("approval_setup_required");
  prune(now);
  const attempts = authority().attempts.get(setup.canonicalRoot) ?? { failures: 0, until: now + lifetimeMs };
  if (attempts.failures >= 5) throw new ControlError("approval_required");
  if (!equal(password, setup.password)) {
    attempts.failures++; authority().attempts.set(setup.canonicalRoot, attempts);
    throw new ControlError("approval_required");
  }
  authority().attempts.delete(setup.canonicalRoot);
  // Bound retained sessions even when a local browser repeatedly signs in.
  while (authority().sessions.size >= 128) authority().sessions.delete(authority().sessions.keys().next().value!);
  // Rotate this browser's previous session, without trusting a supplied ID.
  try { authority().sessions.delete(sessionId(request)); } catch { /* no prior browser session */ }
  const id = randomBytes(32).toString("hex"); const csrf = randomBytes(32).toString("hex"); const expires = now + lifetimeMs;
  authority().sessions.set(id, { root: setup.canonicalRoot, instanceId: setup.credential.instanceId, credentialTag: tag(setup.password), csrf, expires });
  return { csrf, expiresAt: new Date(expires).toISOString(), cookie: `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/api/approvals; Max-Age=${lifetimeMs / 1000}` };
}
export function logoutOwner(request: Request, root: string) {
  authenticateOwner(request, root, true);
  authority().sessions.delete(sessionId(request));
  return `${cookieName}=; HttpOnly; SameSite=Strict; Path=/api/approvals; Max-Age=0`;
}
