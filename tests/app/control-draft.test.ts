import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { useDataRoot as selectDataRoot } from "./support/sandbox";
import { imageFile } from "./support/fixtures";
import type { DraftDependencies } from "@/lib/control/draft-service";
import { releaseBackendOwners } from "@/lib/control/backend-ownership";

afterEach(() => releaseBackendOwners());
const content = { title: "", text: "", linkUrl: "", mediaId: null as string | null };
async function fixture() {
  const root = selectDataRoot();
  const { controlInstanceId } = await import("@/lib/control/auth");
  const rootBinding = `sha256:${createHash("sha256").update(fs.realpathSync(root)).digest("hex")}`;
  const backendId = randomUUID(); const token = "ab".repeat(32); const origin = "http://127.0.0.1:2004";
  const credential = { version: 1, rootBinding, backendId, token, origin, instanceId: controlInstanceId(rootBinding, backendId) };
  fs.writeFileSync(path.join(root, ".poster-control.json"), JSON.stringify(credential), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "poster.config.local.json"), JSON.stringify({ profiles: { bluesky: [
    { id: "main", label: "Main", values: { BLUESKY_IDENTIFIER: "fixture.example", BLUESKY_APP_PASSWORD: "fixture-password" } }
  ] } }));
  const routes = await import("@/app/api/mcp/v1/draft/route");
  const ui = await import("@/app/api/draft/route");
  const local = await import("@/lib/local-config");
  const storage = await import("@/lib/control/read-storage");
  const { replaceComposerDraft } = await import("@/lib/draft-store");
  const { assertBackendMutation } = await import("@/lib/control/backend-mutation");
  const deps: DraftDependencies = { readConfig: () => storage.readControlConfig(root), replaceDraft: replaceComposerDraft,
    readMedia: (id) => storage.readControlMedia(root, id), mediaRevision: (id) => storage.controlMediaRevision(root, id, true),
    assertMutation: () => { assertBackendMutation(root); }, environmentValue: (name) => process.env[name] };
  const request = (method: string, body?: unknown, headers: Record<string, string> = {}) => new Request(`${origin}/api/mcp/v1/draft`, {
    method, headers: { authorization: `Bearer ${token}`, "x-crossposter-instance": credential.instanceId, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const get = async () => (await (await routes.GET(request("GET"))).json()).data;
  const save = async (expectedRevision: string, value = content, targetIds: string[] = []) => routes.PUT(request("PUT", { expectedRevision, content: value, targetIds }));
  const uiSave = (expectedRevision: string, draft: unknown) => ui.PUT(new Request(`${origin}/api/draft`, { method: "PUT", body: JSON.stringify({ expectedRevision, draft }) }));
  const { createControlDraftService } = await import("@/lib/control/draft-service");
  return { root, request, routes, ui, local, get, save, uiSave, deps, service: createControlDraftService(deps) };
}

describe("shared singleton draft control", () => {
  it.each(["media", "profile", "both"].flatMap((removed) => ["clear", "replace"].map((mode) => ({ removed, mode }))))(
    "recovers a retained draft after removed $removed with $mode using a fresh revision", async ({ removed, mode }) => {
      const f = await fixture(); const { saveUploadedMedia } = await import("@/lib/media-store");
      const oldMedia = await saveUploadedMedia(imageFile(), "http://localhost");
      const nextMedia = await saveUploadedMedia(imageFile(), "http://localhost");
      const config = f.local.readLocalConfig();
      f.local.writeLocalConfig({ ...config, profiles: { bluesky: [...config.profiles.bluesky!,
        { id: "replacement", label: "Replacement", values: { BLUESKY_IDENTIFIER: "replacement.example", BLUESKY_APP_PASSWORD: "replacement-fixture-password" } }] } });
      const saved = await (await f.save((await f.get()).revision, { ...content, text: "Retained", mediaId: oldMedia.id }, ["bluesky:main"])).json();
      if (removed !== "profile") { fs.unlinkSync(oldMedia.path); fs.unlinkSync(`${oldMedia.path}.json`); }
      if (removed !== "media") {
        const current = f.local.readLocalConfig();
        f.local.writeLocalConfig({ ...current, profiles: { bluesky: current.profiles.bluesky!.filter((profile) => profile.id !== "main") } });
      }
      const response = await f.routes.GET(f.request("GET")); expect(response.status).toBe(200);
      const recovery = await response.json();
      expect(recovery.data).toMatchObject({ content: { text: "Retained", mediaId: oldMedia.id }, targetIds: ["bluesky:main"] });
      expect(recovery.data.revision).not.toBe(saved.data.revision);
      expect(JSON.stringify(recovery)).not.toContain(f.root);
      expect(recovery.data).not.toHaveProperty("mediaDigest");
      expect((await f.routes.DELETE(f.request("DELETE", { expectedRevision: saved.data.revision }))).status).toBe(409);
      if (removed !== "profile") expect((await f.save(recovery.data.revision, { ...content, mediaId: oldMedia.id }, [])).status).toBe(404);
      if (removed !== "media") expect((await f.save(recovery.data.revision, content, ["bluesky:main"])).status).toBe(404);
      const result = mode === "clear"
        ? await f.routes.DELETE(f.request("DELETE", { expectedRevision: recovery.data.revision }))
        : await f.save(recovery.data.revision, { ...content, text: "Recovered", mediaId: nextMedia.id }, ["bluesky:replacement"]);
      expect(result.status).toBe(200);
      const data = (await result.json()).data;
      expect(data.content).toEqual(mode === "clear" ? content : { ...content, text: "Recovered", mediaId: nextMedia.id });
      expect(data.targetIds).toEqual(mode === "clear" ? [] : ["bluesky:replacement"]);
    }
  );

  it.each(["media", "partial-media", "profile"])("conflicts when unavailable incumbent %s is restored after reading its recovery token", async (changed) => {
    const f = await fixture(); const { saveUploadedMedia } = await import("@/lib/media-store");
    const old = await saveUploadedMedia(imageFile(), "http://localhost");
    const mediaBytes = fs.readFileSync(old.path); const metadata = fs.readFileSync(`${old.path}.json`);
    await f.save((await f.get()).revision, { ...content, text: "Retained", mediaId: old.id }, ["bluesky:main"]);
    const config = f.local.readLocalConfig();
    if (changed === "profile") f.local.writeLocalConfig({ ...config, profiles: {} });
    else { fs.unlinkSync(old.path); fs.unlinkSync(`${old.path}.json`); }
    const recovery = await f.get(); const before = fs.readFileSync(f.local.localConfigPath);
    if (changed === "profile") f.local.writeLocalConfig(config);
    else { fs.writeFileSync(old.path, mediaBytes); if (changed === "media") fs.writeFileSync(`${old.path}.json`, metadata); }
    expect((await f.routes.DELETE(f.request("DELETE", { expectedRevision: recovery.revision }))).status).toBe(409);
    expect(f.local.readLocalConfig().draft.text).toBe("Retained");
    if (changed !== "profile") expect(fs.readFileSync(f.local.localConfigPath)).toEqual(before);
  });

  it("accepts only one concurrent recovery clear/replacement and keeps strict publication preparation", async () => {
    const f = await fixture(); const { saveUploadedMedia } = await import("@/lib/media-store");
    const old = await saveUploadedMedia(imageFile(), "http://localhost");
    await f.save((await f.get()).revision, { ...content, text: "Retained", mediaId: old.id }, ["bluesky:main"]);
    fs.unlinkSync(old.path);
    const recovery = await f.get();
    const { POST } = await import("@/app/api/mcp/v1/actions/route");
    const prepared = await POST(new Request("http://127.0.0.1:2004/api/mcp/v1/actions", {
      method: "POST", headers: f.request("GET").headers, body: JSON.stringify({ mode: "publish", requestKey: "unavailable-draft", content: recovery.content, targetIds: recovery.targetIds })
    }));
    expect(prepared.status).toBe(404); expect((await prepared.json()).error.code).toBe("media_missing");
    const replies = await Promise.all([f.routes.DELETE(f.request("DELETE", { expectedRevision: recovery.revision })),
      f.save(recovery.revision, { ...content, text: "New draft" }, ["bluesky:main"])]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
  });

  it("refuses recovery if a missing incumbent resource changes while replacement media IO is held", async () => {
    const f = await fixture(); const { saveUploadedMedia } = await import("@/lib/media-store");
    const old = await saveUploadedMedia(imageFile(), "http://localhost");
    const next = await saveUploadedMedia(imageFile(), "http://localhost");
    const bytes = fs.readFileSync(old.path);
    await f.save((await f.get()).revision, { ...content, text: "Retained", mediaId: old.id }, []);
    fs.unlinkSync(old.path); const recovery = await f.get();
    let entered = false; let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    const read = f.deps.readMedia;
    f.deps.readMedia = async (id) => { if (id === next.id) { entered = true; await held; } return read(id); };
    const operation = f.service.mutate("save_draft", { expectedRevision: recovery.revision, content: { ...content, mediaId: next.id }, targetIds: [] });
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      fs.writeFileSync(old.path, bytes); release();
      await expect(operation).rejects.toMatchObject({ code: "revision_conflict" });
      expect(f.local.readLocalConfig().draft.text).toBe("Retained");
    } finally { release(); await Promise.allSettled([operation]); }
  });

  it("does not return a torn recovery read when the retained draft changes during media IO", async () => {
    const f = await fixture(); const { saveUploadedMedia } = await import("@/lib/media-store");
    const old = await saveUploadedMedia(imageFile(), "http://localhost");
    await f.save((await f.get()).revision, { ...content, text: "Retained", mediaId: old.id }, []);
    let entered = false; let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    const read = f.deps.readMedia; f.deps.readMedia = async (id) => { entered = true; await held; return read(id); };
    const { readControlDraftSnapshot } = await import("@/lib/control/draft-snapshot");
    const operation = readControlDraftSnapshot(f.deps);
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      const browser = await f.ui.GET().json(); await f.uiSave(browser.revision, { text: "New browser edit" }); release();
      await expect(operation).rejects.toMatchObject({ code: "revision_conflict" });
    } finally { release(); await Promise.allSettled([operation]); }
  });

  it("round-trips empty and title-only drafts and clears with fresh monotonic server revisions", async () => {
    const f = await fixture(); const initial = await f.get();
    const empty = await (await f.save(initial.revision)).json(); expect(empty.ok).toBe(true);
    expect(empty.data.content).toEqual(content); expect(empty.data.revision).not.toBe(initial.revision);
    const title = await (await f.save(empty.data.revision, { ...content, title: "Title only" }, ["bluesky:main"])).json();
    expect(title.data).toMatchObject({ content: { title: "Title only", text: "" }, targetIds: ["bluesky:main"] });
    expect((await f.ui.GET().json()).draft).toMatchObject({ title: "Title only", targets: [{ id: "bluesky:main", profileId: "main" }] });
    expect((await f.routes.DELETE(f.request("DELETE", { expectedRevision: empty.data.revision }))).status).toBe(409);
    const cleared = await (await f.routes.DELETE(f.request("DELETE", { expectedRevision: title.data.revision }))).json();
    expect(cleared.data.content).toEqual(content); expect(cleared.data.targetIds).toEqual([]);
    expect((await f.get()).revision).toBe(cleared.data.revision);
  });

  it("accepts exactly one concurrent save or clear from a shared revision", async () => {
    const f = await fixture(); const { revision } = await f.get();
    const replies = await Promise.all([f.save(revision, { ...content, text: "Winner" }), f.routes.DELETE(f.request("DELETE", { expectedRevision: revision }))]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
  });

  it("makes stale dashboard and control saves/clears observable in both directions", async () => {
    const f = await fixture(); const control = await f.get(); const browser = await f.ui.GET().json();
    expect((await f.save(control.revision, { ...content, text: "MCP wins" })).status).toBe(200);
    expect((await f.uiSave(browser.revision, { text: "Stale UI" })).status).toBe(409);
    expect((await f.ui.DELETE(new Request("http://localhost/api/draft?scope=draft", { method: "DELETE", headers: { "if-match": browser.revision } }))).status).toBe(409);
    const freshControl = await f.get(); const freshBrowser = await f.ui.GET().json();
    expect((await f.uiSave(freshBrowser.revision, { title: "UI wins", text: "" })).status).toBe(200);
    expect((await f.save(freshControl.revision)).status).toBe(409);
    expect((await f.routes.DELETE(f.request("DELETE", { expectedRevision: freshControl.revision }))).status).toBe(409);
    expect((await f.get()).content.title).toBe("UI wins");
    expect((await f.ui.PUT(new Request("http://localhost/api/draft", { method: "PUT", body: JSON.stringify({ draft: { text: "Unversioned" } }) }))).status).toBe(409);
  });

  it("derives attachment metadata from stored ID, reloads it and ignores forged metadata", async () => {
    const f = await fixture(); const { saveUploadedMedia } = await import("@/lib/media-store");
    const media = await saveUploadedMedia(imageFile(), "http://localhost");
    const saved = await (await f.save((await f.get()).revision, { ...content, mediaId: media.id })).json();
    expect(saved.data.content.mediaId).toBe(media.id);
    expect(f.local.readLocalConfig().draft.media).toEqual({ id: media.id, filename: media.filename, contentType: "image/png", size: media.size, kind: "image", url: `/api/media/${media.id}` });
    const browser = await f.ui.GET().json();
    expect((await f.uiSave(browser.revision, { text: "Edit", media: { id: media.id, filename: "fake", contentType: "video/mp4", size: 1, kind: "video", path: "/private", url: "/private" } })).status).toBe(200);
    expect(f.local.readLocalConfig().draft.media).toMatchObject({ filename: "fixture.png", size: media.size, kind: "image" });
    expect((await f.get()).content).toMatchObject({ text: "Edit", mediaId: media.id });
    const current = await f.get();
    expect((await f.save(current.revision, { ...content, text: "Control edit", mediaId: media.id })).status).toBe(200);
    expect((await f.routes.DELETE(f.request("DELETE", { expectedRevision: (await f.get()).revision }))).status).toBe(200);
  });

  it("checks draft/owner/media again after held media IO before a write", async () => {
    const f = await fixture(); const { saveUploadedMedia } = await import("@/lib/media-store");
    const media = await saveUploadedMedia(imageFile(), "http://localhost"); const initial = await f.get();
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    const realRead = f.deps.readMedia;
    f.deps.readMedia = async (id) => { entered(); await held; return realRead(id); };
    const operation = f.service.mutate("save_draft", { expectedRevision: initial.revision, content: { ...content, mediaId: media.id }, targetIds: [] });
    try {
      await started; const browser = await f.ui.GET().json(); await f.uiSave(browser.revision, { text: "New UI edit" });
      release(); await expect(operation).rejects.toMatchObject({ code: "revision_conflict" });
      expect(f.local.readLocalConfig().draft.text).toBe("New UI edit");
    } finally { release(); await Promise.allSettled([operation]); }
  });

  it.each(["owner", "media"])("refuses changed %s after media IO and preserves prior draft", async (changed) => {
    const f = await fixture(); const { saveUploadedMedia } = await import("@/lib/media-store");
    const media = await saveUploadedMedia(imageFile(), "http://localhost"); const { revision } = await f.get();
    const before = fs.readFileSync(f.local.localConfigPath, "utf8"); const read = f.deps.readMedia;
    f.deps.readMedia = async (id) => {
      const result = await read(id);
      if (changed === "owner") fs.unlinkSync(path.join(f.root, ".poster-owner.json"));
      else fs.writeFileSync(media.path, "changed bytes");
      return result;
    };
    await expect(f.service.mutate("save_draft", { expectedRevision: revision, content: { ...content, mediaId: media.id }, targetIds: [] }))
      .rejects.toMatchObject({ code: changed === "owner" ? "ownership_conflict" : "revision_conflict" });
    expect(fs.readFileSync(f.local.localConfigPath, "utf8")).toBe(before);
    if (changed === "owner") expect(() => releaseBackendOwners()).toThrow("Another backend owns this data root.");
  });

  it("reports durable write failure with unchanged readable draft, and fails closed for corrupt storage", async () => {
    const f = await fixture(); const { revision } = await f.get(); const before = fs.readFileSync(f.local.localConfigPath, "utf8");
    const original = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === f.local.localConfigPath) throw new Error("injected write failure");
      return original(from, to);
    });
    const response = await f.save(revision, { ...content, text: "Cannot persist" });
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
    expect(fs.readFileSync(f.local.localConfigPath, "utf8")).toBe(before);
    fs.writeFileSync(f.local.localConfigPath, "{broken");
    expect((await f.save(revision)).status).toBe(500); expect(fs.readFileSync(f.local.localConfigPath, "utf8")).toBe("{broken");
  });

  it("rejects invalid authority, targets, payloads, media and storage failures without publication", async () => {
    const f = await fixture(); const { revision } = await f.get(); const before = fs.readFileSync(f.local.localConfigPath, "utf8");
    expect((await f.routes.PUT(f.request("PUT", { expectedRevision: revision, content, targetIds: [] }, { authorization: "Bearer wrong" }))).status).toBe(401);
    expect((await f.save(revision, content, ["bluesky:missing"])).status).toBe(404);
    expect((await f.save(revision, { ...content, mediaId: "missing.png" })).status).toBe(404);
    expect((await f.routes.PUT(f.request("PUT", { expectedRevision: revision, content: { ...content, path: "/private" }, targetIds: [] }))).status).toBe(400);
    expect(fs.readFileSync(f.local.localConfigPath, "utf8")).toBe(before);
    f.deps.replaceDraft = () => { throw new Error("fixture storage failure"); };
    await expect(f.service.mutate("clear_draft", { expectedRevision: revision })).rejects.toThrow("fixture storage failure");
    expect(fs.readFileSync(f.local.localConfigPath, "utf8")).toBe(before);
    const { providers } = await import("@/lib/providers"); for (const provider of Object.values(providers)) expect(provider).not.toHaveBeenCalled();
  });
});
