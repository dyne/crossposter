// Browser-safe identity and labels. Provider implementations stay in lib/providers.
export const platformIds = [
  "x",
  "linkedin",
  "bluesky",
  "mastodon",
  "instagram",
  "youtube",
  "dribbble",
  "pinterest",
  "devto",
  "hackernews",
  "nostr"
] as const;

export type Platform = (typeof platformIds)[number];

export const platformLabels = {
  x: "X / Twitter",
  linkedin: "LinkedIn",
  bluesky: "Bluesky",
  mastodon: "Mastodon",
  instagram: "Instagram",
  youtube: "YouTube",
  dribbble: "Dribbble",
  pinterest: "Pinterest",
  devto: "Dev.to",
  hackernews: "Hacker News",
  nostr: "Nostr"
} satisfies Record<Platform, string>;

export function isPlatform(value: unknown): value is Platform {
  return platformIds.some((platform) => platform === value);
}
