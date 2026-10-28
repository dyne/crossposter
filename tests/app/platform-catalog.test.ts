import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { isPlatform, platformIds, platformLabels } from "@/lib/platform-catalog";
import { platformLabel } from "@/lib/platform-limits";
import { platformSchema } from "@/lib/publishing/contracts";
import type { Platform, ProviderProfile } from "@/lib/types";
import { saveConfig } from "./support/fixtures";

const expectedPlatforms = [
  "x", "linkedin", "bluesky", "mastodon", "instagram", "youtube",
  "dribbble", "pinterest", "devto", "hackernews", "nostr"
] as const;

describe("shared platform catalog", () => {
  it("retains the eleven IDs, enum order and display labels", () => {
    expect(platformIds).toEqual(expectedPlatforms);
    expect(platformSchema.options).toEqual(expectedPlatforms);
    expect(platformLabels).toEqual({
      x: "X / Twitter", linkedin: "LinkedIn", bluesky: "Bluesky", mastodon: "Mastodon",
      instagram: "Instagram", youtube: "YouTube", dribbble: "Dribbble", pinterest: "Pinterest",
      devto: "Dev.to", hackernews: "Hacker News", nostr: "Nostr"
    });
    expectTypeOf<z.infer<typeof platformSchema>>().toEqualTypeOf<Platform>();
    for (const platform of expectedPlatforms) {
      expect(platformSchema.parse(platform)).toBe(platform);
      expect(isPlatform(platform)).toBe(true);
      expect(platformLabel(platform)).toBe(platformLabels[platform]);
    }
  });

  it.each([undefined, null, "", "X", "twitter", "unsupported", {}, ["x"], 1])(
    "rejects unsupported identity %j at untrusted edges", (value) => {
      expect(isPlatform(value)).toBe(false);
      expect(platformSchema.safeParse(value).success).toBe(false);
    }
  );

  it.each(expectedPlatforms)("preserves %s profiles and draft targets through local storage", async (platform) => {
    const profile: ProviderProfile = {
      id: `fixture-${platform}`, label: `${platformLabels[platform]} fixture`,
      values: { POSTER_LOCAL_PORT: "2004" }
    };
    const target = { id: `${platform}:${profile.id}`, platform, profileId: profile.id, profileLabel: profile.label };
    await saveConfig({
      profiles: { [platform]: [profile] },
      activeProfiles: { [platform]: profile.id },
      draft: { title: "", text: "Fixture", linkUrl: "", platforms: [platform], targets: [target] }
    });
    const { readLocalConfig } = await import("@/lib/local-config");
    const saved = readLocalConfig();
    expect(saved.profiles).toEqual({ [platform]: [profile] });
    expect(saved.activeProfiles).toEqual({ [platform]: profile.id });
    expect(saved.draft.platforms).toEqual([platform]);
    expect(saved.draft.targets).toEqual([target]);
  });
});
