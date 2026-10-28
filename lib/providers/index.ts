import { publishBluesky } from "@/lib/providers/bluesky";
import { publishDevto } from "@/lib/providers/devto";
import { publishDribbble } from "@/lib/providers/dribbble";
import { publishHackerNews } from "@/lib/providers/hackernews";
import { publishLinkedIn } from "@/lib/providers/linkedin";
import { publishMastodon } from "@/lib/providers/mastodon";
import { publishInstagram } from "@/lib/providers/instagram";
import { publishNostr } from "@/lib/providers/nostr";
import { publishPinterest } from "@/lib/providers/pinterest";
import { publishX } from "@/lib/providers/x";
import { publishYouTube } from "@/lib/providers/youtube";
import type { ProviderRegistry } from "@/lib/publishing/provider";

export type { Provider, ProviderRegistry } from "@/lib/publishing/provider";

export const providers = {
  x: publishX,
  linkedin: publishLinkedIn,
  bluesky: publishBluesky,
  mastodon: publishMastodon,
  instagram: publishInstagram,
  youtube: publishYouTube,
  dribbble: publishDribbble,
  pinterest: publishPinterest,
  devto: publishDevto,
  hackernews: publishHackerNews,
  nostr: publishNostr
} satisfies ProviderRegistry;
