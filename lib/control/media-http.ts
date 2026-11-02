import "server-only";
import { dataRoot } from "@/lib/runtime-paths";
import { createMediaStore, MediaUploadError } from "@/lib/storage/media-service";
import { createMediaStorage } from "@/lib/storage/media-storage";
import { authenticateControl } from "./auth";
import { assertBackendMutation } from "./backend-mutation";
import { ControlError } from "./errors";
import { controlFailure, controlSuccess } from "./http";
import { controlMediaSettings } from "./media-settings";
import { projectControlConfig, projectControlMedia } from "./read-projections";
import { readControlConfig, readControlMedia } from "./read-storage";

export async function controlUploadMedia(request: Request) {
  try {
    const { canonicalRoot: root } = authenticateControl(request, dataRoot());
    if (new URL(request.url).searchParams.size || !request.body) throw new ControlError("validation_failed");
    let settings: ReturnType<typeof controlMediaSettings>;
    try { settings = controlMediaSettings((name) => process.env[name]); }
    catch { throw new ControlError("storage_corrupt"); }
    const rawSize = request.headers.get("x-crossposter-media-size") ?? "";
    let filename: string;
    try { filename = decodeURIComponent(request.headers.get("x-crossposter-filename") ?? ""); }
    catch { throw new ControlError("validation_failed"); }
    const size = Number(rawSize);
    if (!/^[1-9][0-9]*$/.test(rawSize) || !Number.isSafeInteger(size) || size > settings.maxBytes
      || !filename.trim() || filename.length > 240 || /[/\\\x00-\x1f\x7f]/.test(filename)
      || (request.headers.has("content-length") && request.headers.get("content-length") !== rawSize)) throw new ControlError("validation_failed");
    if (!assertBackendMutation(root)) throw new ControlError("ownership_conflict");
    const store = createMediaStore(createMediaStorage(root));
    let saved: Awaited<ReturnType<typeof store.saveStreamedMedia>>;
    try { saved = await store.saveStreamedMedia({ filename, size, contentType: request.headers.get("content-type") ?? "",
      stream: request.body, maxBytes: settings.maxBytes, timeoutMs: settings.timeoutMs, signal: request.signal }, request.url); }
    catch (error) {
      if (error instanceof ControlError) throw error;
      throw new ControlError(error instanceof MediaUploadError ? "validation_failed" : "storage_unavailable");
    }
    // Verify actual stored bytes through the same strict lookup preparation uses.
    try {
      const media = await readControlMedia(root, saved.id);
      if (!assertBackendMutation(root)) throw new ControlError("ownership_conflict");
      return controlSuccess("upload_media", projectControlMedia(media, projectControlConfig(readControlConfig(root), (field) => process.env[field])));
    } catch (error) { await store.deleteUploadedMedia(saved.id).catch(() => undefined); throw error; }
  } catch (error) { return controlFailure(error); }
}
