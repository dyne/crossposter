import type {
  ComposeDraft, Platform, ProviderProfile, PublishedMedia, PublishedPost,
  PublishResult, PublishTarget, ScheduledPost
} from "@/lib/types";

export type PublishResponse = { results?: PublishResult[]; publishedPost?: PublishedPost; error?: unknown };
export type ConfigProfilesResponse = { profiles: Partial<Record<Platform, ProviderProfile[]>> };
export type DraftResponse = { draft?: ComposeDraft; publishedPosts?: PublishedPost[] };
export type UploadedMedia = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  kind: "image" | "video" | "audio" | "file";
  url: string;
};
export type MediaUploadResponse = { media?: UploadedMedia; error?: unknown };
export type ScheduledResponse = { scheduledPost?: ScheduledPost; error?: unknown };
export type PublishInput = {
  title?: string;
  text: string;
  linkUrl?: string;
  mediaId?: string;
  platforms: Platform[];
  targets: PublishTarget[];
};
export type ScheduleInput = PublishInput & { scheduledFor: string };
type ApiFieldError = { formErrors?: string[]; fieldErrors?: Record<string, string[]> };

function putDraft(draft: ComposeDraft) {
  return fetch("/api/draft", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ draft })
  });
}

async function postJson<T>(url: string, input: PublishInput | ScheduleInput, signal: AbortSignal) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal
  });
  return { ok: response.ok, body: await response.json() as T };
}

// Browser-only transport seam. Status handling remains operation-specific:
// legacy draft/config reads parse JSON regardless of HTTP status, and draft
// writes ignore response bodies. Publishing/scheduling inspect status below.
export const composeClient = {
  async readConfig(): Promise<ConfigProfilesResponse> {
    return (await fetch("/api/config", { cache: "no-store" })).json();
  },
  async readDraft(signal?: AbortSignal): Promise<DraftResponse> {
    return (await fetch("/api/draft", { cache: "no-store", signal })).json();
  },
  saveDraft: putDraft,
  clearHistory: () => fetch("/api/draft?scope=history", { method: "DELETE" }),
  publish: (input: PublishInput, signal: AbortSignal) => postJson<PublishResponse>("/api/publish", input, signal),
  schedule: (input: ScheduleInput, signal: AbortSignal) => postJson<ScheduledResponse>("/api/scheduled", input, signal),
  async upload(file: File, signal: AbortSignal): Promise<UploadedMedia> {
    const formData = new FormData();
    formData.set("file", file);
    const response = await fetch("/api/media", { method: "POST", body: formData, signal });
    const body = await response.json() as MediaUploadResponse;
    if (!response.ok || !body.media) {
      throw new Error(typeof body.error === "string" ? body.error : "Media upload failed");
    }
    return body.media;
  },
  compressVideo: (formData: FormData, signal?: AbortSignal) => fetch("/api/media/compress-video", { method: "POST", body: formData, signal })
};

export async function fileFromDraftMedia(media: PublishedMedia, signal?: AbortSignal): Promise<File | null> {
  if (!media?.url) return null;
  let target = media.url;
  try {
    const parsed = new URL(media.url, window.location.origin);
    target = `${parsed.pathname}${parsed.search}`;
  } catch { /* Keep the original URL, as for legacy drafts. */ }
  try {
    const response = await fetch(target, { cache: "no-store", signal });
    if (!response.ok) return null;
    const blob = await response.blob();
    return new File([blob], media.filename || "draft-media", { type: media.contentType || blob.type || "application/octet-stream" });
  } catch { return null; }
}

export function formatApiError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const fieldError = error as ApiFieldError;
    if (fieldError.fieldErrors?.linkUrl?.length) return "Link is invalid. Use a URL like https://example.com, or leave Link empty.";
    if (fieldError.fieldErrors?.title?.length) return fieldError.fieldErrors.title.join(" ");
    if (fieldError.fieldErrors?.text?.length) return fieldError.fieldErrors.text.join(" ");
    if (fieldError.fieldErrors?.mediaUrl?.length) return "Media URL is invalid. Upload a local file instead.";
    if (fieldError.formErrors?.length) return fieldError.formErrors.join(" ");
  }
  return "Publish request is invalid. Check the fields and try again.";
}
