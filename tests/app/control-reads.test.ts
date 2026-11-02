import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configFields } from "@/lib/config-spec";
import { controlInstanceId } from "@/lib/control/auth";
import { controlTools } from "@/lib/control/contracts";
import { useDataRoot, createDataRoot } from "./support/sandbox";

const origin = "http://127.0.0.1:2004";
const token = "a".repeat(64);
const hash = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
let root: string;
let instanceId: string;
function credentials(directory = root) {
  const rootBinding = hash(realpathSync(directory));
  const backendId = randomUUID();
  const credential = { version: 1, rootBinding, backendId, instanceId: controlInstanceId(rootBinding, backendId), token, origin };
  writeFileSync(path.join(directory, ".poster-control.json"), JSON.stringify(credential), { mode: 0o600 });
  return credential;
}
function config(value: unknown) { writeFileSync(path.join(root, "poster.config.local.json"), JSON.stringify(value)); }
function request(route: string, headers: Record<string, string> = {}, endpoint = origin) {
  return new Request(`${endpoint}/api/mcp/v1/${route}`, { headers: { authorization: `Bearer ${token}`, "x-crossposter-instance": instanceId, ...headers } });
}
const profiles = { bluesky: [
  { id: "first", label: "First account", values: { BLUESKY_IDENTIFIER: "first.example", BLUESKY_APP_PASSWORD: "first-token-fixture" } },
  { id: "second", label: "Second account", values: { BLUESKY_IDENTIFIER: "second.example", BLUESKY_APP_PASSWORD: "second-token-fixture" } }
] };
const target = { id: "legacy-id", platform: "bluesky", profileId: "first", profileLabel: "First account" };
function post(id: string) { return { id, createdAt: "2026-11-01T12:00:00Z", title: "Fixture", text: "Post text", platforms: ["bluesky"],
  targets: [target], results: [{ platform: "bluesky", targetId: target.id, profileId: "first", ok: true, message: "private provider text", url: "https://fixture.example/post?token=private" }] }; }
function schedule(id: string) { return { id, createdAt: "2026-11-01T12:00:00Z", updatedAt: "2026-11-01T12:00:00Z",
  scheduledFor: "2020-01-01T00:00:00Z", text: "Due fixture", targets: [target], platforms: ["bluesky"], status: "scheduled", attempts: 0 }; }
async function get(route: string, headers: Record<string, string> = {}) {
  const routes = {
    status: () => import("@/app/api/mcp/v1/status/route"), targets: () => import("@/app/api/mcp/v1/targets/route"),
    draft: () => import("@/app/api/mcp/v1/draft/route"), posts: () => import("@/app/api/mcp/v1/posts/route"),
    scheduled: () => import("@/app/api/mcp/v1/scheduled/route")
  };
  return (await routes[route.split("?")[0] as keyof typeof routes]()).GET(request(route, headers));
}
beforeEach(() => { root = useDataRoot(); instanceId = credentials().instanceId; });

describe("typed control read authentication", () => {
  it.each(["", "Bearer wrong", `Basic ${token}`])("rejects invalid machine authority without leaking it", async (authorization) => {
    config({ values: { POSTER_ADMIN_PASSWORD: "approval-secret-canary" } });
    const response = await get("status", { authorization });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });
  it("requires the expected backend instance and refuses a credential copied to another root", async () => {
    expect((await get("status", { "x-crossposter-instance": "wrong" })).status).toBe(409);
    expect((await get("status", { "x-crossposter-instance": "" })).status).toBe(409);
    const second = createDataRoot();
    writeFileSync(path.join(second, ".poster-control.json"), readFileSync(path.join(root, ".poster-control.json")), { mode: 0o600 });
    vi.stubEnv("CROSSPOSTER_DATA_DIR", second);
    expect(await (await get("status")).json()).toMatchObject({ ok: false, error: { code: "instance_mismatch" } });
  });
  it.each([
    { host: "evil.example" }, { origin: "https://evil.example" }, { origin: "null" },
    { forwarded: "host=evil.example" }, { "x-forwarded-host": "evil.example" },
    { "x-forwarded-proto": "https" }, { "x-forwarded-port": "1234" },
    { "x-forwarded-for": "10.0.0.5" }, { "x-forwarded-for": "127.0.0.1, 10.0.0.5" }
  ] as Array<Record<string, string>>)("rejects hostile host/origin/proxy metadata %j", async (headers) => {
    const response = await get("status", headers);
    expect(response.status).toBe(403); expect(response.headers.has("location")).toBe(false);
  });
  it("accepts absent Origin and matching Next direct-loopback headers, with no redirects", async () => {
    const headers = { host: "127.0.0.1:2004", "x-forwarded-host": "127.0.0.1:2004", "x-forwarded-proto": "http",
      "x-forwarded-port": "2004", "x-forwarded-for": "::ffff:127.0.0.1" };
    expect((await get("status", headers)).status).toBe(200);
    expect((await get("status", { ...headers, origin })).status).toBe(200);
    const { GET } = await import("@/app/api/mcp/v1/status/route");
    expect((await GET(request("status", {}, "http://evil.example:2004"))).status).toBe(403);
    expect((await GET(request("status", headers, "http://localhost:2004"))).status).toBe(200);
    expect((await GET(request("status", {}, "http://localhost:2004"))).status).toBe(403);
    expect((await GET(request("status", headers, "http://localhost:2005"))).status).toBe(403);
    expect((await GET(request("status", headers, "http://evil.example:2004"))).status).toBe(403);
  });
  it("never bootstraps credentials from a read, and rejects unsafe/symlink credentials", async () => {
    const empty = createDataRoot(); vi.stubEnv("CROSSPOSTER_DATA_DIR", empty);
    expect((await get("status")).status).toBe(401);
    expect(() => lstatSync(path.join(empty, ".poster-control.json"))).toThrow();
    const file = path.join(root, ".poster-control.json");
    vi.stubEnv("CROSSPOSTER_DATA_DIR", root); chmodSync(file, 0o644);
    expect((await get("status")).status).toBe(401);
    chmodSync(file, 0o600); symlinkSync(file, path.join(empty, ".poster-control.json")); vi.stubEnv("CROSSPOSTER_DATA_DIR", empty);
    expect((await get("status")).status).toBe(401);
  });
  it("accepts a canonical-root alias without changing identity and reports configured scheduler state without starting it", async () => {
    const parent = createDataRoot(); const alias = path.join(parent, "alias"); symlinkSync(root, alias, "dir");
    vi.stubEnv("CROSSPOSTER_DATA_DIR", alias); vi.stubEnv("POSTER_DISABLE_SCHEDULER", "false");
    const interval = vi.spyOn(globalThis, "setInterval");
    const data = (await (await get("status")).json()).data;
    expect(data.instanceId).toBe(instanceId); expect(data.scheduler).toBe("enabled"); expect(interval).not.toHaveBeenCalled();
  });
});

describe("safe read projections", () => {
  it("reads every contract without dispatching due schedules, starting timers or writing data", async () => {
    config({ profiles, draft: { title: "", text: "Draft", targets: [target] }, publishedPosts: [post("post-1")], scheduledPosts: [schedule("due")] });
    const file = path.join(root, "poster.config.local.json"); const before = readFileSync(file, "utf8");
    const timer = vi.spyOn(globalThis, "setInterval"); const { providers } = await import("@/lib/providers");
    for (const [route, tool] of [["status", "get_status"], ["targets", "list_targets"], ["draft", "get_draft"], ["posts", "list_posts"], ["scheduled", "list_scheduled_posts"]] as const) {
      const response = await get(route); expect(response.status, route).toBe(200);
      expect(controlTools[tool].outputSchema.safeParse(await response.json()).success, route).toBe(true);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const { GET } = await import("@/app/api/mcp/v1/posts/[postId]/route");
    const response = await GET(request("posts/post-1"), { params: Promise.resolve({ postId: "post-1" }) });
    expect(controlTools.get_post.outputSchema.safeParse(await response.json()).success).toBe(true);
    expect(timer).not.toHaveBeenCalled(); for (const provider of Object.values(providers)) expect(provider).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toBe(before);
  });
  it("keeps every config/profile value out of targets, errors, result text and stored paths", async () => {
    const values = Object.fromEntries(configFields.map((field, index) => [field.name, `CANARY_PRIVATE_${index}_VALUE`]));
    const item = post("post-1"); item.results[0].message = values.NOSTR_PRIVATE_KEY; item.results[0].url = `https://fixture.example/${values.POSTER_ADMIN_PASSWORD}`;
    config({ values, profiles: { bluesky: [{ id: "first", label: "Public label", values }] }, publishedPosts: [item], scheduledPosts: [schedule("due")] });
    for (const route of ["status", "targets", "draft", "posts", "scheduled"]) {
      const response = await get(route); expect(response.status).toBe(200); const text = await response.text();
      for (const canary of Object.values(values)) expect(text).not.toContain(canary);
      expect(text).not.toContain(root); expect(text).not.toContain(token);
    }
  });
  it("resolves two same-platform profiles independently and never follows active-profile fallback", async () => {
    config({ profiles, activeProfiles: { bluesky: "second" }, values: { BLUESKY_IDENTIFIER: "base.example", BLUESKY_APP_PASSWORD: "base-token-fixture" },
      draft: { title: "", text: "", targets: [target] } });
    const response = await get("targets"); const data = (await response.json()).data;
    expect(data.items.map((item: { id: string }) => item.id)).toEqual(["bluesky:base", "bluesky:first", "bluesky:second"]);
    expect(data.items.every((item: { readinessBasis: string }) => item.readinessBasis === "configuration_only")).toBe(true);
    expect(data.items[0].capabilities).toEqual({ text: true, title: false, singleMedia: true });
    expect((await (await get("draft")).json()).data.targetIds).toEqual(["bluesky:first"]);
    config({ profiles: { bluesky: [profiles.bluesky[1]] }, draft: { targets: [target] } });
    expect(await (await get("draft")).json()).toMatchObject({ error: { code: "target_missing" } });
  });
  it("retains partial and uncertain outcomes with redacted messages and safe URLs", async () => {
    const first = post("partial"); const second = { id: "second-target", platform: "bluesky", profileId: "second", profileLabel: "Second account" };
    first.targets.push(second); first.results.push({ platform: "bluesky", targetId: second.id, profileId: second.profileId, ok: false, message: "private failure", url: "" });
    const uncertain = { ...first, id: "uncertain", results: [first.results[0], { ...first.results[1], uncertain: true }] };
    config({ publishedPosts: [first, uncertain] });
    const data = (await (await get("posts")).json()).data;
    expect(data.items.map((item: { state: string }) => item.state)).toEqual(["partial", "uncertain"]);
    expect(data.items[0].outcomes[0].url).toBe("https://fixture.example/post");
    expect(JSON.stringify(data)).not.toContain("private");
  });
  it("keeps a selected target without a retained result explicitly uncertain", async () => {
    const item = post("incomplete");
    item.targets.push({ id: "second-target", platform: "bluesky", profileId: "second", profileLabel: "Second account" });
    config({ publishedPosts: [item] });
    const data = (await (await get("posts")).json()).data.items[0];
    expect(data.state).toBe("uncertain");
    expect(data.outcomes.map((outcome: { state: string }) => outcome.state)).toEqual(["succeeded", "uncertain"]);
    expect(data.outcomes[1].target.id).toBe("bluesky:second");
    expect(data.outcomes[1].message).toContain("No retained result");
  });
  it("rejects duplicate results for one selected target instead of double-counting success", async () => {
    const item = post("duplicate"); item.results.push({ ...item.results[0] }); config({ publishedPosts: [item] });
    expect(await (await get("posts")).json()).toMatchObject({ ok: false, error: { code: "storage_corrupt" } });
  });
  it("rejects a result whose target ID contradicts its platform identity", async () => {
    const item = post("mismatched"); item.results[0].platform = "youtube"; config({ publishedPosts: [item] });
    expect(await (await get("posts")).json()).toMatchObject({ ok: false, error: { code: "storage_corrupt" } });
  });
  it("does not infer that missing legacy queue results prove a target was never dispatched", async () => {
    config({ scheduledPosts: [schedule("queued"), { ...schedule("interrupted"), status: "publishing" }] });
    const items = (await (await get("scheduled")).json()).data.items;
    expect(items).toHaveLength(2);
    for (const item of items) expect(item.outcomes.map((outcome: { state: string }) => outcome.state)).toEqual(["uncertain"]);
  });
  it.each([
    { platform: "youtube", url: "https://www.youtube.com/watch?v=VIDEO123" },
    { platform: "hackernews", url: "https://news.ycombinator.com/item?id=123456" },
    { platform: "hackernews", url: "https://news.ycombinator.com/item?id=123456#comments" }
  ])("preserves native $platform identity parameters exactly", async ({ platform, url }) => {
    config({ publishedPosts: [{ ...post("native"), platforms: [platform], targets: [{ id: platform, platform }],
      results: [{ platform, targetId: platform, ok: true, message: "fixture", url }] }] });
    const data = (await (await get("posts")).json()).data.items[0];
    expect(data.outcomes[0].url).toBe(url);
  });
  it.each([
    { url: "https://www.youtube.com/watch?v=VIDEO123&access_token=fixture-token", expected: "https://www.youtube.com/watch?v=VIDEO123" },
    { url: "https://news.ycombinator.com/item?id=123456&password=fixture-password", expected: "https://news.ycombinator.com/item?id=123456" },
    { url: "https://www.youtube.com/watch?v=VIDEO123#access_token=fixture-token", expected: "https://www.youtube.com/watch?v=VIDEO123" },
    { url: "https://user:fixture-password@news.ycombinator.com/item?id=123456", expected: null }
  ])("removes URL credentials while retaining usable native identity: $url", async ({ url, expected }) => {
    const item = post("native"); item.results[0].url = url; config({ publishedPosts: [item] });
    expect((await (await get("posts")).json()).data.items[0].outcomes[0].url).toBe(expected);
  });
  it("does not treat configured public provider identities as secret native-link substrings", async () => {
    const mastodonUrl = "https://mastodon.example/@publicuser/123456";
    const blueskyUrl = "https://bsky.app/profile/public.example/post/abc123";
    config({ values: { MASTODON_INSTANCE: "https://mastodon.example", BLUESKY_IDENTIFIER: "public.example" },
      publishedPosts: [
        { ...post("mastodon"), platforms: ["mastodon"], targets: [{ id: "mastodon", platform: "mastodon" }],
          results: [{ platform: "mastodon", targetId: "mastodon", ok: true, message: "fixture", url: mastodonUrl }] },
        { ...post("bluesky"), targets: [target], results: [{ ...post("bluesky").results[0], url: blueskyUrl }] }
      ] });
    const items = (await (await get("posts")).json()).data.items;
    expect(items.map((item: { outcomes: Array<{ url: string }> }) => item.outcomes[0].url)).toEqual([blueskyUrl, mastodonUrl]);
  });
  it("protects short secret/session values in labels, result URLs, media names and errors", async () => {
    const short = "s7"; const privateDirectory = "d9";
    const item = post("short-secret"); item.results[0].url = "https://fixture.example/%73%37";
    const id = `${randomUUID()}.png`; const directory = path.join(root, ".poster-uploads"); mkdirSync(directory);
    writeFileSync(path.join(directory, id), "fixture");
    writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ id, filename: `${short}.png`, contentType: "image/png", size: 7, kind: "image" }));
    config({ values: { POSTER_ADMIN_PASSWORD: short, X_BROWSER_PROFILE_DIR: privateDirectory },
      profiles: { bluesky: [{ ...profiles.bluesky[0], label: `${short} account`, values: { ...profiles.bluesky[0].values, BLUESKY_APP_PASSWORD: "p8" } }] }, publishedPosts: [item] });
    expect((await (await get("targets")).json()).data.items.find((value: { id: string }) => value.id === "bluesky:first").label).toBe("Account");
    expect((await (await get("posts")).json()).data.items[0].outcomes[0].url).toBeNull();
    item.results[0].url = `https://fixture.example/${privateDirectory}/session`; config({ values: { X_BROWSER_PROFILE_DIR: privateDirectory }, publishedPosts: [item] });
    expect((await (await get("posts")).json()).data.items[0].outcomes[0].url).toBeNull();
    config({ values: { POSTER_ADMIN_PASSWORD: short } });
    const { GET } = await import("@/app/api/mcp/v1/media/[mediaId]/route");
    expect((await (await GET(request(`media/${id}`), { params: Promise.resolve({ mediaId: id }) })).json()).data.filename).toBe("upload");
    writeFileSync(path.join(root, "poster.config.local.json"), `${short}{`);
    const error = await (await get("posts")).text(); expect(error).not.toContain(short); expect(error).not.toContain(privateDirectory);
  });
  it.each(["profile", "environment", "legacy-flat"])("protects a short %s secret while preserving authored content", async (source) => {
    const short = "q6"; const item = post("short-source"); item.results[0].url = `https://fixture.example/${short}`;
    item.text = `Author intentionally wrote ${short}.`; item.title = `Authored ${short}`;
    const profile = { ...profiles.bluesky[0], label: `${short} account`, values: { ...profiles.bluesky[0].values,
      ...(source === "profile" ? { BLUESKY_APP_PASSWORD: short } : {}) } };
    if (source === "environment") vi.stubEnv("BLUESKY_APP_PASSWORD", short);
    config({ ...(source === "legacy-flat" ? { BLUESKY_APP_PASSWORD: short } : {}), profiles: { bluesky: [profile] }, publishedPosts: [item] });
    const data = (await (await get("posts")).json()).data.items[0];
    expect(data.outcomes[0].url).toBeNull(); expect(data.content.text).toBe(item.text); expect(data.content.title).toBe(item.title);
    expect((await (await get("targets")).json()).data.items.find((value: { id: string }) => value.id === "bluesky:first").label).toBe("Account");
  });
  it("paginates equal-time posts deterministically without duplicates and detects snapshot changes", async () => {
    config({ publishedPosts: [post("c"), post("a"), post("b")] });
    const first = (await (await get("posts?limit=1")).json()).data;
    const second = (await (await get(`posts?limit=1&cursor=${first.nextCursor}`)).json()).data;
    const third = (await (await get(`posts?limit=1&cursor=${second.nextCursor}`)).json()).data;
    expect([first.items[0].id, second.items[0].id, third.items[0].id]).toEqual(["a", "b", "c"]); expect(third.nextCursor).toBeNull();
    expect((await get(`scheduled?cursor=${first.nextCursor}`)).status).toBe(400);
    config({ publishedPosts: [post("a"), post("b"), post("new")] });
    expect(await (await get(`posts?cursor=${first.nextCursor}`)).json()).toMatchObject({ error: { code: "cursor_stale" } });
  });
  it.each(["posts?limit=0", "posts?limit=101", "posts?limit=1.2", "posts?limit=1&limit=2", "posts?cursor=bad", "status?url=https://evil.example", "targets?platform=bluesky"])("rejects invalid or proxy-like arguments %s", async (route) => {
    expect((await get(route)).status).toBe(400);
  });
  it.each(["{", "[]", '{"publishedPosts":[{}]}', '{"scheduledPosts":null}', '{"draft":{"text":123}}', '{"profiles":{"bluesky":[{"id":"x"}]}}', '{"BLUESKY_IDENTIFIER":123}'])("reports corrupt state explicitly instead of an empty success: %s", async (body) => {
    writeFileSync(path.join(root, "poster.config.local.json"), body);
    const response = await get("posts"); expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "storage_corrupt" } });
  });
  it("reports absent posts explicitly and treats genuinely absent config as empty", async () => {
    expect((await (await get("posts")).json()).data.items).toEqual([]);
    const { GET } = await import("@/app/api/mcp/v1/posts/[postId]/route");
    expect(await (await GET(request("posts/missing"), { params: Promise.resolve({ postId: "missing" }) })).json()).toMatchObject({ error: { code: "post_missing" } });
  });
  it("keeps target and schedule cursors bounded, instance-bound and revision-sensitive", async () => {
    config({ profiles, scheduledPosts: [schedule("a"), schedule("b")] });
    const targets = (await (await get("targets?limit=1")).json()).data;
    const more = (await (await get(`targets?limit=1&cursor=${targets.nextCursor}`)).json()).data;
    expect([targets.items[0].id, more.items[0].id]).toEqual(["bluesky:first", "bluesky:second"]);
    const first = (await (await get("scheduled?limit=1")).json()).data;
    const second = (await (await get(`scheduled?limit=1&cursor=${first.nextCursor}`)).json()).data;
    expect([first.items[0].id, second.items[0].id]).toEqual(["a", "b"]);
    config({ profiles, scheduledPosts: [{ ...schedule("a"), attempts: 1 }, schedule("b")] });
    expect(await (await get(`scheduled?cursor=${first.nextCursor}`)).json()).toMatchObject({ error: { code: "cursor_stale" } });
    const decoded = JSON.parse(Buffer.from(targets.nextCursor, "base64url").toString()); decoded.instanceId = `sha256:${"b".repeat(64)}`;
    const wrong = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    expect(await (await get(`targets?cursor=${wrong}`)).json()).toMatchObject({ error: { code: "cursor_invalid" } });
  });
  it("reports unreadable storage without exposing filesystem or provider exception text", async () => {
    config({}); const original = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((filename: unknown, ...args: unknown[]) => {
      if (filename === path.join(root, "poster.config.local.json")) throw Object.assign(new Error("/private/COOKIE_PATH secret-canary"), { code: "EACCES" });
      return Reflect.apply(original, fs, [filename, ...args]);
    }) as typeof fs.readFileSync);
    const response = await get("posts"); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: { code: "storage_unavailable", message: "Local storage is unavailable.", retryable: true } });
  });
  it("keeps legacy platform-only retained history readable and preserves authored links", async () => {
    const item = { ...post("legacy"), targets: undefined, linkUrl: "https://fixture.example/article?edition=2#section",
      results: [{ platform: "bluesky", targetId: "bluesky", ok: true, message: "old fixture" }] };
    config({ publishedPosts: [item] });
    const data = (await (await get("posts")).json()).data.items[0];
    expect(data.targets[0].id).toBe("bluesky:base"); expect(data.content.linkUrl).toBe(item.linkUrl);
  });
  it("returns safe media metadata and a streamed byte digest, ignoring stored path/url authority", async () => {
    const id = `${randomUUID()}.png`; const directory = path.join(root, ".poster-uploads"); mkdirSync(directory);
    const bytes = Buffer.from("synthetic fixture bytes"); writeFileSync(path.join(directory, id), bytes);
    const metadata = { id, filename: "/private/session-canary/fixture.png", contentType: "image/png", kind: "image", size: bytes.length,
      path: "/private/CANARY_COOKIE_PATH", url: "https://evil.example/CANARY_COOKIE" };
    writeFileSync(path.join(directory, `${id}.json`), JSON.stringify(metadata));
    const { GET } = await import("@/app/api/mcp/v1/media/[mediaId]/route");
    const response = await GET(request(`media/${id}`), { params: Promise.resolve({ mediaId: id }) });
    expect(response.status).toBe(200); const result = await response.json();
    expect(controlTools.get_media.outputSchema.safeParse(result).success).toBe(true);
    expect(result.data).toEqual({ id, filename: "fixture.png", contentType: "image/png", kind: "image", size: bytes.length, digest: hash(bytes), url: `/api/media/${id}` });
    metadata.id = `${randomUUID()}.png`; writeFileSync(path.join(directory, `${id}.json`), JSON.stringify(metadata));
    expect(await (await GET(request(`media/${id}`), { params: Promise.resolve({ mediaId: id }) })).json()).toMatchObject({ error: { code: "storage_corrupt" } });
    const absent = `${randomUUID()}.png`;
    expect(await (await GET(request(`media/${absent}`), { params: Promise.resolve({ mediaId: absent }) })).json()).toMatchObject({ error: { code: "media_missing" } });
  });
  it.each(["malformed", "wrong-size", "digest-mismatch", "symlink"])("rejects corrupt media %s without revealing paths", async (variant) => {
    const id = `${randomUUID()}.png`; const directory = path.join(root, ".poster-uploads"); mkdirSync(directory);
    const filename = path.join(directory, id); const bytes = Buffer.from("fixture");
    if (variant === "symlink") { const privateFile = path.join(root, "private-canary"); writeFileSync(privateFile, bytes); symlinkSync(privateFile, filename); }
    else writeFileSync(filename, bytes);
    const metadata = { id, filename: "fixture.png", contentType: "image/png", kind: "image", size: variant === "wrong-size" ? 99 : bytes.length,
      ...(variant === "digest-mismatch" ? { digest: `sha256:${"0".repeat(64)}` } : {}) };
    writeFileSync(`${filename}.json`, variant === "malformed" ? "private-canary{" : JSON.stringify(metadata));
    const { GET } = await import("@/app/api/mcp/v1/media/[mediaId]/route");
    const response = await GET(request(`media/${id}`), { params: Promise.resolve({ mediaId: id }) });
    expect(await response.json()).toEqual({ ok: false, error: { code: "storage_corrupt", message: "Local storage contains invalid data.", retryable: false } });
  });
});
