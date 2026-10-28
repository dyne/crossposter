import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPublishRequestSchema,
  createScheduleRequestSchema,
  requestValidationMessage
} from "@/lib/publishing/contracts";
import { jsonRequest, saveConfig, successfulProviders } from "./support/fixtures";
import { freezeClock } from "./support/sandbox";
import { linkError } from "./support/request-cases";

const future = "2026-01-16T12:00:00.000Z";
const textError = "Write post text, or add a title for title-only channels.";
const freeLimitError = "X / Twitter · Free fixture post is 281/280 characters. Shorten the post or deselect X / Twitter · Free fixture.";
const premium = { id: "premium-target", platform: "x", profileId: "premium", profileLabel: "Premium fixture" };
const free = { id: "free-target", platform: "x", profileId: "free", profileLabel: "Free fixture" };

type ParityCase = { name: string; body: Record<string, unknown>; error?: string; text?: string; linkUrl?: string };
const parityCases: ParityCase[] = [
  { name: "whitespace is normalized at persistence", body: { title: " \t ", text: " Fixture text \n ", linkUrl: " \n " }, text: "Fixture text" },
  { name: "empty text is rejected", body: { text: " \n " }, error: textError },
  { name: "an empty URL stays absent", body: { linkUrl: "" } },
  { name: "a bare domain gets HTTPS", body: { linkUrl: " fixture.example/path " }, linkUrl: "https://fixture.example/path" },
  { name: "invalid URLs beat title and text errors", body: { linkUrl: "not a url", title: "a".repeat(301), text: "a".repeat(301) }, error: linkError },
  { name: "URL usernames are rejected", body: { linkUrl: "https://fixture-user@fixture.example" }, error: linkError },
  { name: "URL passwords are rejected", body: { linkUrl: "https://:fixture-secret@fixture.example" }, error: linkError },
  { name: "empty targets use duplicate platform defaults", body: { platforms: ["bluesky", "bluesky"], targets: [] } },
  { name: "targets override title-requiring platforms", body: { platforms: ["hackernews"], targets: [{ id: "blue", platform: "bluesky" }] } },
  { name: "premium first permits duplicate X targets", body: { text: "a".repeat(281), targets: [premium, free] } },
  { name: "free first rejects duplicate X targets", body: { text: "a".repeat(281), targets: [free, premium] }, error: freeLimitError },
  { name: "title-only Hacker News defaults missing text", body: { title: "Fixture title", text: undefined, platforms: ["hackernews"] }, text: "" },
  { name: "title-only Dribbble retains route acceptance", body: { title: "Fixture title", text: "", platforms: ["dribbble"] }, text: "" },
  { name: "title-only Pinterest retains route acceptance", body: { title: "Fixture title", text: "", platforms: ["pinterest"] }, text: "" },
  { name: "title-required errors retain their order", body: { title: " \n ", text: "", platforms: ["dribbble", "youtube", "hackernews"] }, error: `Hacker News requires a title. YouTube requires a title. Dribbble requires a title. ${textError}` },
  { name: "Unicode graphemes at the limit are accepted", body: { text: "e\u0301".repeat(300) } },
  { name: "Unicode graphemes over the limit are rejected", body: { text: "e\u0301".repeat(301) }, error: "Bluesky post is 301/300 characters. Shorten the post or deselect Bluesky." },
  { name: "UTF-8 overflow retains the generic text error before byte error", body: { platforms: ["devto"], text: "é".repeat(409_601) }, error: "String must contain at most 100000 character(s) Dev.to article body is over 800 KB. Shorten the post before publishing." }
];

beforeEach(async () => {
  freezeClock();
  await successfulProviders();
});

describe("publish and schedule request parity", () => {
  it.each(parityCases)("$name", async ({ body, error, text, linkUrl }) => {
    await saveConfig({ profiles: { x: [
      { id: "premium", label: "Premium fixture", values: { X_PREMIUM_LONG_POSTS: "true" } },
      { id: "free", label: "Free fixture", values: { X_PREMIUM_LONG_POSTS: "false" } }
    ] } });
    const publish = await import("@/app/api/publish/route");
    const schedule = await import("@/app/api/scheduled/route");
    for (const [variant, handler] of [["publish", publish.POST], ["schedule", schedule.POST]] as const) {
      const payload = { text: "Fixture text", platforms: ["bluesky"], scheduledFor: future, ...body };
      const response = await handler(jsonRequest(payload));
      expect(response.status, variant).toBe(error ? 400 : 200);
      const result = await response.json();
      if (error) {
        expect(result, variant).toEqual({ error });
      } else {
        const post = variant === "publish" ? result.publishedPost : result.scheduledPost;
        expect(post.text, variant).toBe(text ?? payload.text);
        expect(post.linkUrl, variant).toBe(linkUrl);
        if (Array.isArray(body.platforms) && body.platforms.length === 2) {
          expect(post.targets).toEqual([{ id: "bluesky", platform: "bluesky" }, { id: "bluesky", platform: "bluesky" }]);
          expect(post.platforms).toEqual(variant === "publish" ? ["bluesky"] : ["bluesky", "bluesky"]);
        }
      }
    }
  });

  it.each([
    { scheduledFor: "2026-01-15T11:58:59.999Z", error: "Choose a scheduled time in the future." },
    { scheduledFor: "2026-01-15T11:59:00.000Z" },
    { scheduledFor: "not-a-date", error: "Choose a valid scheduled time." }
  ])("keeps scheduling time rules separate for $scheduledFor", async ({ scheduledFor, error }) => {
    const publish = await import("@/app/api/publish/route");
    const schedule = await import("@/app/api/scheduled/route");
    const payload = { text: "Fixture text", platforms: ["bluesky"], scheduledFor };
    expect((await publish.POST(jsonRequest(payload))).status).toBe(200);
    const response = await schedule.POST(jsonRequest(payload));
    expect(response.status).toBe(error ? 400 : 200);
    if (error) expect(await response.json()).toEqual({ error });
  });
});

describe("composed request variants", () => {
  it("keeps publish-only fields and strips them when scheduling", () => {
    const lookup = vi.fn(() => undefined);
    const payload = { text: "Fixture", platforms: ["bluesky"], scheduledFor: future, adminPassword: "fixture", mediaUrl: " fixture.example/image.png " };
    expect(createPublishRequestSchema(lookup).parse(payload)).toEqual({
      text: "Fixture", platforms: ["bluesky"], adminPassword: "fixture", mediaUrl: "https://fixture.example/image.png"
    });
    expect(createScheduleRequestSchema(lookup).parse(payload)).toEqual({ text: "Fixture", platforms: ["bluesky"], scheduledFor: future });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    { field: "adminPassword", value: 123, error: "Publish request is invalid. Check the highlighted fields and try again." },
    { field: "mediaUrl", value: "ftp://fixture.example", error: "Media URL is invalid. Upload a local file instead." }
  ])("validates $field only for publishing", ({ field, value, error }) => {
    const payload = { text: "Fixture", platforms: ["bluesky"], scheduledFor: future, [field]: value };
    const parsed = createPublishRequestSchema(() => undefined).safeParse(payload);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(requestValidationMessage(parsed.error, "publish")).toBe(error);
    expect(createScheduleRequestSchema(() => undefined).safeParse(payload).success).toBe(true);
  });

  it.each([createPublishRequestSchema, createScheduleRequestSchema])("looks up each X target's current profile configuration at parse time", (createSchema) => {
    const lookup = vi.fn(() => "false");
    const schema = createSchema(lookup);
    const payload = { text: "a".repeat(281), scheduledFor: future, targets: [premium, free, { id: "blue", platform: "bluesky" }] };
    expect(lookup).not.toHaveBeenCalled();
    expect(schema.safeParse(payload).success).toBe(false);
    lookup.mockImplementation(() => "true");
    expect(schema.safeParse(payload).success).toBe(true);
    expect(lookup.mock.calls).toEqual([
      ["X_PREMIUM_LONG_POSTS", "premium"], ["X_PREMIUM_LONG_POSTS", "free"],
      ["X_PREMIUM_LONG_POSTS", "premium"], ["X_PREMIUM_LONG_POSTS", "free"]
    ]);
  });
});
