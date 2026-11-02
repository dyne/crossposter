import type { Readable } from "node:stream";
import { controlTools, type ControlToolName } from "../lib/control/contracts";
import { ControlError, publicError } from "../lib/control/errors";
import { readControlCredential } from "../lib/control/credential";
import type { BridgeConfig } from "./config";
import { localUpload } from "./upload";

// Leave framing margin below the official stdio client's default 10MiB buffer.
// An oversized page is an explicit transport error; never truncate its records.
const responseByteLimit = 8 * 1024 * 1024;
const segment = (value: unknown) => {
  if (typeof value !== "string" || value === "." || value === "..") throw new ControlError("validation_failed");
  return encodeURIComponent(value);
};
type RequestBody = string | Readable;

export function backendClient(config: BridgeConfig, backendVersion: string, lifetime?: AbortSignal) {
  async function request(name: ControlToolName, route: string, signal: AbortSignal,
    body?: RequestBody, extraHeaders: Record<string, string> = {}) {
    // Re-read only the dedicated credential, never application/provider settings.
    const { credential } = readControlCredential(config.canonicalRoot);
    if (credential.origin !== config.origin || credential.instanceId !== config.credential.instanceId) throw new ControlError("instance_mismatch");
    if (credential.token !== config.credential.token) throw new ControlError("unauthorized");
    const response = await fetch(`${config.origin}/api/mcp/v1${route}`, {
      method: controlTools[name].method, headers: { authorization: `Bearer ${credential.token}`,
        "x-crossposter-instance": credential.instanceId, ...extraHeaders },
      redirect: "error", signal, ...(body === undefined ? {} : { body: body as BodyInit, duplex: "half" })
    });
    const declaredSize = response.headers.get("content-length");
    if (!response.headers.get("content-type")?.startsWith("application/json") || !response.body
      || (declaredSize !== null && (!/^[0-9]+$/.test(declaredSize) || Number(declaredSize) > responseByteLimit))) {
      await response.body?.cancel(); throw new ControlError("backend_unavailable");
    }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > responseByteLimit) { await reader.cancel(); throw new ControlError("backend_unavailable"); }
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const parsed = controlTools[name].outputSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
    if (!parsed.success || response.ok !== parsed.data.ok) throw new ControlError("backend_unavailable");
    if (!parsed.data.ok) return { ok: false as const, error: publicError(new ControlError(parsed.data.error.code, parsed.data.error.actionId)) };
    if (name === "get_status") {
      const status = controlTools.get_status.dataSchema.parse(parsed.data.data);
      if (status.instanceId !== config.credential.instanceId || status.backendVersion !== backendVersion) throw new ControlError("instance_mismatch");
    }
    return parsed.data;
  }

  async function invoke(name: ControlToolName, input: Record<string, unknown>, cancellation?: AbortSignal) {
    const timeout = AbortSignal.timeout(name === "upload_media" ? config.media.timeoutMs : 30_000);
    const signal = AbortSignal.any([timeout, ...(cancellation ? [cancellation] : []), ...(lifetime ? [lifetime] : [])]);
    try {
      if (name === "get_status") return await request(name, "/status", signal);
      const status = await request("get_status", "/status", signal);
      if (!status.ok) return status;
      // Explicit mapping is the complete HTTP allowlist; no path/method proxy.
      switch (name) {
        case "list_targets": case "list_posts": case "list_scheduled_posts": {
          const query = new URLSearchParams({ limit: String(input.limit) });
          if (input.cursor !== undefined) query.set("cursor", String(input.cursor));
          return await request(name, `${controlTools[name].route}?${query}`, signal);
        }
        case "get_draft": return await request(name, "/draft", signal);
        case "save_draft": case "clear_draft":
          return await request(name, "/draft", signal, JSON.stringify(input), { "content-type": "application/json" });
        case "get_media": return await request(name, `/media/${segment(input.mediaId)}`, signal);
        case "get_action": return await request(name, `/actions/${segment(input.actionId)}`, signal);
        case "get_post": return await request(name, `/posts/${segment(input.postId)}`, signal);
        case "prepare_action": return await request(name, "/actions", signal, JSON.stringify(input), { "content-type": "application/json" });
        case "commit_action": return await request(name, `/actions/${segment(input.actionId)}/commit`, signal,
          JSON.stringify({ expectedDigest: input.expectedDigest }), { "content-type": "application/json" });
        case "upload_media": {
          const upload = await localUpload(String(input.localPath), config, signal);
          try {
            const result = await request(name, "/media", signal, upload.stream, { "content-type": "application/octet-stream",
              "x-crossposter-filename": encodeURIComponent(upload.filename), "x-crossposter-media-size": String(upload.size), "content-length": String(upload.size) });
            upload.assertCurrent(); return result;
          } finally { upload.stream.destroy(); await upload.handle.close(); }
        }
      }
    } catch (error) {
      const knownId = (name === "get_action" || name === "commit_action") && typeof input.actionId === "string" ? input.actionId : undefined;
      const failure = error instanceof ControlError ? new ControlError(error.code, error.actionId ?? knownId) : new ControlError("backend_unavailable", knownId);
      return { ok: false as const, error: publicError(failure) };
    }
  }
  return { invoke };
}
