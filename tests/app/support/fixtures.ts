import type { ComposeDraft, PublishPayload, ScheduledPost } from "@/lib/types";
import type { LocalConfigFile } from "@/lib/local-config";
import { vi } from "vitest";

export async function saveConfig(overrides: Partial<LocalConfigFile>) {
  const config = await import("@/lib/local-config");
  return config.writeLocalConfig({ ...config.readLocalConfig(), ...overrides });
}

export async function successfulProviders() {
  const { providers } = await import("@/lib/providers");
  for (const provider of Object.values(providers)) {
    vi.mocked(provider).mockImplementation(async (context) => ({
      platform: context.platforms[0], ok: true, message: "Fixture published"
    }));
  }
  return providers;
}

export function publishPayload(overrides: Partial<PublishPayload> = {}): PublishPayload {
  return { text: "A fixture post", platforms: ["bluesky"], ...overrides };
}

export function composeDraft(overrides: Partial<ComposeDraft> = {}): ComposeDraft {
  return { title: "", text: "A fixture draft", linkUrl: "", platforms: ["bluesky"], targets: [], ...overrides };
}

export function scheduledPost(overrides: Partial<ScheduledPost> = {}): ScheduledPost {
  return {
    id: "fixture-schedule",
    createdAt: "2026-01-15T12:00:00.000Z",
    updatedAt: "2026-01-15T12:00:00.000Z",
    scheduledFor: "2026-01-16T12:00:00.000Z",
    text: "A fixture scheduled post",
    platforms: ["bluesky"],
    status: "scheduled",
    attempts: 0,
    ...overrides
  };
}

export function imageFile(): File {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
  return new File([png], "fixture.png", { type: "image/png" });
}

export function jsonRequest(body: unknown, pathname = "/api/publish"): Request {
  return new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}
