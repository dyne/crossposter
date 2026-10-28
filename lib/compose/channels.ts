import { platformLabels } from "@/lib/platform-catalog";
import { validatePlatformConfig, type ConfigIssue } from "@/lib/config-validation";
import type { Platform, ProviderProfile, PublishTarget } from "@/lib/types";

export const channels: Array<{
  id: Platform;
  label: string;
  note: string;
  uses: string[];
  target: string;
  media: string;
}> = [
  {
    id: "x",
    label: platformLabels.x,
    note: "Local browser post",
    uses: ["Post", "Media"],
    target: "Uses the active X / Twitter browser profile from Settings.",
    media: "Photos up to 5 MB, GIF up to 15 MB, video up to 512 MB or 16 GB with Premium."
  },
  {
    id: "linkedin",
    label: platformLabels.linkedin,
    note: "Profile or page post",
    uses: ["Post", "Media"],
    target: "Uses the active LinkedIn profile or Page from Settings.",
    media: "Local images and MP4 video are supported."
  },
  {
    id: "bluesky",
    label: platformLabels.bluesky,
    note: "Text and images",
    uses: ["Post", "Media"],
    target: "Uses the active Bluesky profile from Settings.",
    media: "Local image only: JPEG, PNG, WebP, GIF up to 1 MB."
  },
  {
    id: "mastodon",
    label: platformLabels.mastodon,
    note: "Text and media",
    uses: ["Post", "Media"],
    target: "Uses the active Mastodon profile from Settings.",
    media: "Local image, video, audio, or file upload is supported."
  },
  {
    id: "instagram",
    label: platformLabels.instagram,
    note: "Browser session media post",
    uses: ["Post", "Media"],
    target: "Posts through this profile's signed-in Instagram browser session.",
    media: "Requires a local JPG, PNG, WebP image up to 8 MB, or MP4/MOV video up to 300 MB. Photos post as 1:1 square and videos as 9:16 reels — use those ratios so nothing is cropped."
  },
  {
    id: "youtube",
    label: platformLabels.youtube,
    note: "InnerTube video upload",
    uses: ["Title", "Post", "Media"],
    target: "Uses the active YouTube.js cookie profile from Settings.",
    media: "Title becomes the video title. Post becomes the description. Requires a local video up to 256 GB or 12 hours."
  },
  {
    id: "devto",
    label: platformLabels.devto,
    note: "Markdown article",
    uses: ["Title", "Post"],
    target: "Uses the active Dev.to profile from Settings.",
    media: "Local media is ignored; publish without cover image."
  },
  {
    id: "pinterest",
    label: platformLabels.pinterest,
    note: "Unofficial Pin upload",
    uses: ["Title", "Link", "Post", "Media"],
    target: "Uses the active Pinterest py3-pinterest profile from Settings.",
    media: "Title becomes the Pin title. Post becomes the description. Link becomes the destination URL. Requires a local image or MP4/MOV video."
  },
  {
    id: "hackernews",
    label: platformLabels.hackernews,
    note: "Submit link or text",
    uses: ["Title", "Link", "Post"],
    target: "Uses the active Hacker News profile from Settings.",
    media: "Unofficial personal automation; local media is ignored; the Link field becomes the submitted URL."
  },
  {
    id: "nostr",
    label: platformLabels.nostr,
    note: "Text note",
    uses: ["Post"],
    target: "Uses the active Nostr profile from Settings.",
    media: "Local media is ignored; paste public media links into the post text."
  },
  {
    id: "dribbble",
    label: platformLabels.dribbble,
    note: "Shot upload",
    uses: ["Title", "Post", "Media"],
    target: "Uses the active Dribbble OAuth token profile from Settings.",
    media: "Title becomes the shot title. Post becomes the description. Requires a JPG, PNG, or GIF exactly 400x300 or 800x600."
  }
];

export type ChannelDefinition = (typeof channels)[number];

export type ChannelTarget = ChannelDefinition & {
  targetId: string;
  profileId: string;
  profileLabel: string;
  profileValues: Record<string, string>;
  ready: boolean;
  issues: ConfigIssue[];
};

const envLabels: Record<string, string> = {
  BLUESKY_IDENTIFIER: "Bluesky handle",
  BLUESKY_APP_PASSWORD: "app password",
  MASTODON_INSTANCE: "instance",
  MASTODON_ACCESS_TOKEN: "access token",
  DEVTO_API_KEY: "API key",
  INSTAGRAM_BROWSER_PROFILE_DIR: "browser profile folder",
  INSTAGRAM_BROWSER_HEADLESS: "headless",
  INSTAGRAM_BROWSER_TIMEOUT_MS: "browser timeout",
  INSTAGRAM_PYTHON_COMMAND: "Python command",
  YOUTUBE_COOKIE_SOURCE: "cookie source",
  YOUTUBE_CHROME_PROFILE: "Chrome profile",
  YOUTUBE_COOKIE: "cookie",
  YOUTUBE_PRIVACY: "privacy",
  YOUTUBE_TIMEOUT_MS: "timeout",
  DRIBBBLE_ACCESS_TOKEN: "access token",
  DRIBBBLE_TAGS: "tags",
  DRIBBBLE_TEAM_ID: "team ID",
  DRIBBBLE_LOW_PROFILE: "Low Profile",
  PINTEREST_EMAIL: "email",
  PINTEREST_PASSWORD: "password",
  PINTEREST_USERNAME: "username",
  PINTEREST_BOARD_ID: "board ID",
  PINTEREST_CRED_ROOT: "session folder",
  LINKEDIN_ACCESS_TOKEN: "access token",
  LINKEDIN_AUTHOR_URN: "author URN",
  NOSTR_PRIVATE_KEY: "private key",
  NOSTR_RELAYS: "relays",
  HACKERNEWS_USERNAME: "username",
  HACKERNEWS_PASSWORD: "password",
  X_BROWSER_PROFILE_DIR: "browser profile folder",
  X_BROWSER_HEADLESS: "headless toggle",
  X_BROWSER_TIMEOUT_MS: "timeout",
  X_PYTHON_COMMAND: "Python command",
  X_PREMIUM_LONG_POSTS: "Premium media toggle"
};

export function formatConfigIssues(issues: ConfigIssue[]): string {
  const labels = issues.map((issue) => issue.message || envLabels[issue.field] || issue.field);

  return `${labels.slice(0, 2).join(", ")}${labels.length > 2 ? "..." : ""}`;
}

export function publishTargetFromCard(target: ChannelTarget): PublishTarget {
  return {
    id: target.targetId,
    platform: target.id,
    profileId: target.profileId,
    profileLabel: target.profileLabel
  };
}



export function channelTargets(profiles: Partial<Record<Platform, ProviderProfile[]>>): ChannelTarget[] {
  return channels.flatMap((channel) => (profiles[channel.id] || []).map((profile) => {
    const issues = validatePlatformConfig(channel.id, profile.values);
    return {
      ...channel, targetId: `${channel.id}:${profile.id}`,
      profileId: profile.id, profileLabel: profile.label, profileValues: profile.values,
      ready: issues.length === 0, issues
    };
  }));
}
