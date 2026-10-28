import { describe, expect, it, vi } from "vitest";
import { formatLimitBytes, postLimitIssues, postLimitIssuesForTargets, textBytes, textLength, titleLimitIssues, xMediaSizeLimit } from "@/lib/platform-limits";

describe("public publishing limits", () => {
  it("counts graphemes independently of UTF-8 bytes", () => {
    expect(textLength("👨‍👩‍👧‍👦e\u0301")).toBe(2);
    expect(textBytes("é")).toBe(2);
    expect(postLimitIssues(["bluesky"], "👨‍👩‍👧‍👦".repeat(300))).toEqual([]);
    expect(postLimitIssues(["bluesky"], "é".repeat(301))[0].message).toBe("Bluesky post is 301/300 characters. Shorten the post or deselect Bluesky.");
  });

  it.each([
    { platform: "x" as const, limit: 280 },
    { platform: "bluesky" as const, limit: 300 },
    { platform: "mastodon" as const, limit: 500 },
    { platform: "pinterest" as const, limit: 800 }
  ])("accepts exactly $limit characters on $platform and rejects one more", ({ platform, limit }) => {
    expect(postLimitIssues([platform], ` ${"a".repeat(limit)} `)).toEqual([]);
    expect(postLimitIssues([platform], "a".repeat(limit + 1))).toHaveLength(1);
  });

  it("supports X premium and uses the first target's limit for a repeated platform", () => {
    const text = "a".repeat(281);
    expect(postLimitIssuesForTargets([{ platform: "x", xPremium: true }, { platform: "x", xPremium: false }], text)).toEqual([]);
    expect(postLimitIssuesForTargets([{ platform: "x", xPremium: false, profileLabel: "Free fixture" }, { platform: "x", xPremium: true }], text)[0].message).toBe("X / Twitter · Free fixture post is 281/280 characters. Shorten the post or deselect X / Twitter · Free fixture.");
    expect(postLimitIssuesForTargets([{ platform: "x", xPremium: true }], "a".repeat(25_000))).toEqual([]);
    expect(postLimitIssuesForTargets([{ platform: "x", xPremium: true }], "a".repeat(25_001))).toHaveLength(1);
  });

  it("applies the Dev.to body bound to bytes rather than characters", () => {
    expect(postLimitIssues(["devto"], "é".repeat(409_600))).toEqual([]);
    expect(postLimitIssues(["devto"], "é".repeat(409_601))).toEqual([{ id: "devto-body-limit", field: "text", message: "Dev.to article body is over 800 KB. Shorten the post before publishing." }]);
  });

  it("ignores whitespace in Dev.to titles and deduplicates platform issues", () => {
    expect(titleLimitIssues(["devto"], " a ".repeat(128))).toEqual([]);
    expect(titleLimitIssues(["devto", "devto"], " a ".repeat(129))).toEqual([{ id: "devto-title-limit", field: "title", message: "Dev.to title is 129/128 characters. Shorten the title or deselect Dev.to." }]);
  });

  it("falls back to Unicode code points when the browser lacks grapheme segmentation", () => {
    vi.stubGlobal("Intl", Object.create(Intl, { Segmenter: { value: undefined } }));
    expect(textLength("😀é")).toBe(2);
    expect(textLength("e\u0301")).toBe(2);
  });

  it.each([
    [512, "512 B"], [1024, "1.0 KB"], [10 * 1024, "10 KB"],
    [1024 ** 2, "1.0 MB"], [16 * 1024 ** 3, "16 GB"]
  ] as const)("formats the displayed upload bound %s as %s", (bytes, label) => {
    expect(formatLimitBytes(bytes)).toBe(label);
  });

  it("distinguishes photo, GIF and account-specific video upload bounds", () => {
    expect(xMediaSizeLimit("image", "image/png", false)).toEqual({ bytes: 5 * 1024 ** 2, label: "X photo" });
    expect(xMediaSizeLimit("image", "image/gif", false)).toEqual({ bytes: 15 * 1024 ** 2, label: "X GIF" });
    expect(xMediaSizeLimit("video", "video/mp4", false)).toEqual({ bytes: 512 * 1024 ** 2, label: "X video" });
    expect(xMediaSizeLimit("video", "video/mp4", true)).toEqual({ bytes: 16 * 1024 ** 3, label: "X Premium video" });
    expect(xMediaSizeLimit("audio", "audio/mpeg", true)).toBeUndefined();
  });
});
