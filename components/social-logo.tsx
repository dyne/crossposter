import {
  siBluesky,
  siDevdotto,
  siDribbble,
  siInstagram,
  siMastodon,
  siPinterest,
  siX,
  siYoutube,
  siYcombinator,
  type SimpleIcon
} from "simple-icons";
import type { CSSProperties } from "react";
import type { Platform } from "@/lib/types";
import { platformLabels } from "@/lib/platform-catalog";

const socialIcons: Partial<Record<Platform, SimpleIcon>> = {
  x: siX,
  bluesky: siBluesky,
  mastodon: siMastodon,
  instagram: siInstagram,
  youtube: siYoutube,
  dribbble: siDribbble,
  pinterest: siPinterest,
  devto: siDevdotto,
  hackernews: siYcombinator
};

const brandColors = {
  x: "#4b5563",
  linkedin: "#0a66c2",
  bluesky: `#${siBluesky.hex}`,
  mastodon: `#${siMastodon.hex}`,
  instagram: `#${siInstagram.hex}`,
  youtube: `#${siYoutube.hex}`,
  dribbble: `#${siDribbble.hex}`,
  pinterest: `#${siPinterest.hex}`,
  devto: `#${siDevdotto.hex}`,
  hackernews: `#${siYcombinator.hex}`,
  nostr: "#8f3ffc"
} satisfies Record<Platform, string>;

type SocialLogoProps = {
  platform: Platform;
  size?: "sm" | "md";
};

export function SocialLogo({ platform, size = "md" }: SocialLogoProps) {
  const icon = socialIcons[platform];
  const name = platformLabels[platform];

  return (
    <span
      aria-label={`${name} logo`}
      className={`social-logo social-logo-${size}`}
      role="img"
      style={{ "--brand": brandColors[platform] } as CSSProperties}
      title={name}
    >
      {icon ? (
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d={icon.path} />
        </svg>
      ) : platform === "nostr" ? (
        <span className="nostr-mark" aria-hidden="true" />
      ) : (
        <span className="linkedin-mark" aria-hidden="true">
          in
        </span>
      )}
    </span>
  );
}
