import type { Platform } from "@/lib/types";
import { platformLabels } from "@/lib/platform-catalog";
import type { SettingsView } from "./contracts";

export type SetupGuide = {
  title: string;
  intro: string;
  links: Array<{
    label: string;
    href: string;
  }>;
  steps: string[];
};

export const platforms: Array<{ id: Platform; label: string }> = [
  { id: "x", label: platformLabels.x },
  { id: "linkedin", label: platformLabels.linkedin },
  { id: "bluesky", label: platformLabels.bluesky },
  { id: "mastodon", label: platformLabels.mastodon },
  { id: "instagram", label: platformLabels.instagram },
  { id: "youtube", label: platformLabels.youtube },
  { id: "devto", label: platformLabels.devto },
  { id: "pinterest", label: platformLabels.pinterest },
  { id: "hackernews", label: platformLabels.hackernews },
  { id: "nostr", label: platformLabels.nostr },
  { id: "dribbble", label: platformLabels.dribbble }
];

export const settingsViews: Array<{ id: SettingsView; label: string; href: string }> = [
  { id: "settings", label: "Settings", href: "/settings" },
  { id: "storage", label: "Storage", href: "/settings/storage" },
  { id: "socials", label: "Socials", href: "/settings/socials" }
];

export const setupGuides: Partial<Record<Platform, SetupGuide>> = {
  bluesky: {
    title: "Bluesky setup",
    intro: "Use your Bluesky handle plus an app password. Do not use your main account password.",
    links: [
      { label: "Open app passwords", href: "https://bsky.app/settings/app-passwords" }
    ],
    steps: [
      "Open Bluesky App Passwords and create a new app password.",
      "Add a Bluesky profile here.",
      "Set Bluesky handle to your handle without @, for example apoorvdarshan.com.",
      "Paste the generated app password into Bluesky app password.",
      "Save config, then select Bluesky on the Dashboard."
    ]
  },
  mastodon: {
    title: "Mastodon setup",
    intro: "Create an application on your Mastodon instance and copy an access token.",
    links: [
      { label: "mastodon.social apps", href: "https://mastodon.social/settings/applications" },
      { label: "OAuth scopes", href: "https://docs.joinmastodon.org/api/oauth-scopes/" },
      { label: "Status API", href: "https://docs.joinmastodon.org/methods/statuses/" }
    ],
    steps: [
      "Open your instance settings, usually https://your-instance/settings/applications.",
      "Create a new application with write:statuses and write:media scopes, or the broad write scope.",
      "Copy the access token.",
      "Add a Mastodon profile here.",
      "Set Mastodon instance to the full URL, for example https://mastodon.social.",
      "Paste the access token, save config, then select Mastodon on the Dashboard."
    ]
  },
  devto: {
    title: "Dev.to setup",
    intro: "Dev.to publishes markdown articles through an API key from your account settings.",
    links: [
      { label: "Open Dev.to extensions", href: "https://dev.to/settings/extensions" }
    ],
    steps: [
      "Open Dev.to account settings, then Extensions.",
      "Generate or copy an API key.",
      "Add a Dev.to profile here.",
      "Paste the key into Dev.to API key.",
      "Save config. On the Dashboard, fill Title and Post before publishing."
    ]
  },
  linkedin: {
    title: "LinkedIn profile and Page setup",
    intro:
      "Use Connect LinkedIn to save a token locally. Personal posts use a person URN; Page posts use an organization URN.",
    links: [
      { label: "LinkedIn apps", href: "https://www.linkedin.com/developers/apps" },
      { label: "Create a LinkedIn Page", href: "https://www.linkedin.com/help/linkedin/answer/a545752" },
      {
        label: "App Page verification",
        href: "https://www.linkedin.com/help/billing/answer/a1665329"
      },
      {
        label: "OAuth flow",
        href: "https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow"
      },
      {
        label: "OpenID profile",
        href: "https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2"
      },
      {
        label: "Posts API",
        href: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api"
      }
    ],
    steps: [
      "Open LinkedIn Developers, then create a new app if you do not already have one.",
      "During app creation, add the app name, logo, privacy policy URL if LinkedIn asks, and the LinkedIn Page LinkedIn uses to verify app ownership.",
      "If you do not have a Page yet, create one from LinkedIn's For Business menu, then use that Page for app verification.",
      "Enable Share on LinkedIn for w_member_social personal posting.",
      "For company Page posting, your app also needs LinkedIn access that grants w_organization_social.",
      "If Community Management API access is disabled, create a new LinkedIn app for Page posting instead of using the app that already has Share or OpenID products.",
      "Use the same LinkedIn Page or company page for the new app, and do not add Share on LinkedIn or OpenID before requesting Community Management API.",
      "In the new app's Products tab, request Community Management API Development Tier, select the Page management use case, fill the access form, and wait for LinkedIn approval.",
      "Only submit legal organization details you can verify. If you do not have a registered organization, keep LinkedIn on personal posting.",
      "Enable Sign In with LinkedIn using OpenID Connect so Crossposter can auto-fill urn:li:person:... for personal posting.",
      "In the LinkedIn Auth tab, add http://localhost:2004/api/auth/linkedin/callback as an authorized redirect URL.",
      "Paste the app's client ID and client secret into this LinkedIn profile. They stay in poster.config.local.json.",
      "For personal posting, use scopes openid profile w_member_social, then click Connect LinkedIn.",
      "For Page posting, use scopes openid profile w_member_social w_organization_social, then click Connect LinkedIn as a Page admin or content admin.",
      "After approval, Crossposter fills the access token and a personal author URN automatically.",
      "For Page posting, replace LinkedIn author URN with urn:li:organization:YOUR_PAGE_ORG_ID and save config."
    ]
  },
  x: {
    title: "X / Twitter setup",
    intro:
      "Local posting through a dedicated, isolated browser, the same way Instagram works. You log in once in a separate window; posts are then typed and sent through X's own composer, headlessly. It never touches your personal Chrome profile.",
    links: [
      { label: "X automation rules", href: "https://help.x.com/articles/76915-automation-rules-and-best-practices" }
    ],
    steps: [
      "Install the browser engine in Terminal with crossposter install-instagram-browser-deps, or ./scripts/install-instagram-browser-deps.sh when working from the Git repo (the X method reuses the same engine).",
      "Add one X / Twitter profile here for each X account.",
      "Set X browser profile folder to a unique folder per account, for example .x-browser/apoorvdarshan.",
      "Click Log in to X. A real browser window opens once. Sign in (including any 2FA), then it saves the session and closes.",
      "Keep X browser headless on so future posts run invisibly. Set it to false only to watch the browser if a post fails.",
      "Turn on X Premium media limits only for Premium accounts. It raises the text limit from 280 to 25,000 characters and video size from 512 MB to 16 GB.",
      "Save config, then select X / Twitter on the Dashboard.",
      "Crossposter publishes user-triggered posts only. X may still challenge, limit, or lock accounts for automated-looking behavior, so keep posting occasional and human-paced.",
      "Local images, GIFs, and MP4 video are attached in the composer."
    ]
  },
  instagram: {
    title: "Instagram setup",
    intro:
      "Unofficial local posting through a dedicated, isolated browser with a one-time login per account, in its own profile folder separate from your own Chrome profile. It reuses your real signed-in session, so there is no stored password. It prefers your installed Google Chrome and falls back to bundled Chromium.",
    links: [
      { label: "Playwright", href: "https://playwright.dev/python/" },
      { label: "Instagram terms", href: "https://help.instagram.com/581066165581870" }
    ],
    steps: [
      "Install the browser engine in Terminal with crossposter install-instagram-browser-deps, or ./scripts/install-instagram-browser-deps.sh when working from the Git repo.",
      "Add one Instagram profile here for each Instagram account.",
      "Set Instagram browser profile folder to a unique folder per account, for example .instagram-browser/apoorvdarshan.",
      "Click Log in to Instagram. A real browser window opens once. Sign in (including any 2FA), then it saves the session and closes.",
      "Keep Instagram browser headless on so future posts run invisibly. Set it to false only to watch the browser if a post fails.",
      "Use the Dashboard Post field as the caption and attach one local JPG, PNG, WebP, MP4, or MOV file before publishing.",
      "Video (MP4/MOV) uploads require Google Chrome installed; bundled Chromium can read images but not H.264 video. Image posts work either way.",
      "Avoid parallel or high-volume posting. Instagram may challenge, rate limit, or restrict accounts for suspicious automation."
    ]
  },
  youtube: {
    title: "YouTube setup",
    intro:
      "Unofficial local uploading through YouTube.js and InnerTube. Crossposter can read cookies from your signed-in Chrome profile at publish time.",
    links: [
      { label: "YouTube.js", href: "https://github.com/LuanRT/YouTube.js" },
      { label: "YouTube upload formats", href: "https://support.google.com/youtube/answer/55744" },
      { label: "YouTube upload limits", href: "https://support.google.com/youtube/answer/71673" },
      { label: "YouTube terms", href: "https://www.youtube.com/t/terms" }
    ],
    steps: [
      "Log in to YouTube and YouTube Studio in Chrome.",
      "Add a YouTube profile here.",
      "Leave YouTube cookie source as chrome to read fresh browser cookies each publish.",
      "Set YouTube Chrome profile if you do not use Chrome's Default profile.",
      "Optionally click Import Chrome cookies to save a fallback cookie in poster.config.local.json.",
      "YouTube privacy defaults to PUBLIC. Change it to UNLISTED or PRIVATE only when needed.",
      "On the Dashboard, add a Title, Post text for the description, and attach a local video.",
      "Avoid high-volume uploads. YouTube may challenge, throttle, or restrict accounts for suspicious automation."
    ]
  },
  dribbble: {
    title: "Dribbble setup",
    intro:
      "Official shot uploads through the Dribbble API. Connect Dribbble saves an upload token locally.",
    links: [
      { label: "Dribbble OAuth", href: "https://developer.dribbble.com/v2/oauth/" },
      { label: "Create shot API", href: "https://developer.dribbble.com/v2/shots/" }
    ],
    steps: [
      "Create or open a Dribbble API application.",
      "Set the application's callback URL to http://localhost:2004/settings/socials/dribbble/callback.",
      "Add a Dribbble profile here. The client ID and client secret fields are right below Profile name — paste them there.",
      "Leave Dribbble OAuth scopes as public upload, then click Connect Dribbble.",
      "Optionally add comma-separated tags. Dribbble accepts up to 12 tags.",
      "Optionally set a team ID or enable Low Profile.",
      "On the Dashboard, add a Title, optional Post text for the shot description, and attach a JPG, PNG, or GIF.",
      "Dribbble API shot images must be exactly 400x300 or 800x600 and no larger than 8 MB.",
      "Dribbble creates shots asynchronously, so the returned shot may take a moment to appear."
    ]
  },
  pinterest: {
    title: "Pinterest setup",
    intro:
      "Unofficial local posting through py3-pinterest. Crossposter saves one browser-cookie session folder per Pinterest profile.",
    links: [
      { label: "py3-pinterest", href: "https://github.com/bstoilov/py3-pinterest" },
      { label: "Pinterest developer guidelines", href: "https://policy.pinterest.com/en/developer-guidelines" },
      { label: "Pinterest Pin specs", href: "https://help.pinterest.com/en/article/review-pin-specs" }
    ],
    steps: [
      "Install py3-pinterest in Terminal with crossposter install-pinterest-deps, or ./scripts/install-pinterest-deps.sh when working from the Git repo.",
      "Add a Pinterest profile here.",
      "Set Pinterest email, password, and username for that account. They stay in poster.config.local.json.",
      "Set Pinterest board ID to the numeric board you want to publish into.",
      "Set Pinterest session folder to a unique folder for each account, for example .pinterest-sessions/apoorvdarshan.",
      "If Pinterest blocks headless login, set Pinterest headless login to false so py3-pinterest can show Chrome.",
      "On the Dashboard, attach one local image or MP4/MOV video. Title becomes the Pin title, Post becomes the description, and Link becomes the Pin destination URL.",
      "Avoid parallel or high-volume posting. Pinterest may challenge, rate limit, or restrict accounts for suspicious automation."
    ]
  },
  nostr: {
    title: "Nostr setup",
    intro:
      "Nostr posts are signed locally with your private key and sent directly to the relays you configure.",
    links: [
      { label: "Nostr protocol", href: "https://github.com/nostr-protocol/nips/blob/master/01.md" },
      { label: "NIP-19 keys", href: "https://github.com/nostr-protocol/nips/blob/master/19.md" }
    ],
    steps: [
      "Create or choose a Nostr account in your preferred Nostr client.",
      "For safer local automation, create a dedicated Nostr key instead of using your main identity key.",
      "Export or copy the account private key as nsec... or 64-character hex.",
      "Add a Nostr profile here.",
      "Paste the private key into Nostr private key.",
      "Paste one or more relay URLs into Nostr relays, separated by commas or new lines.",
      "Use the same relays you already publish to from your Nostr client.",
      "Save config, then select Nostr on the Dashboard.",
      "Crossposter publishes kind-1 text notes. Local file upload is ignored; paste public media links into the post text when needed."
    ]
  },
  hackernews: {
    title: "Hacker News setup",
    intro:
      "Unofficial personal automation. Hacker News has no official submit API, so Crossposter logs in with your local credentials and submits through HN's normal form flow.",
    links: [
      { label: "HN submit", href: "https://news.ycombinator.com/submit" },
      { label: "HN guidelines", href: "https://news.ycombinator.com/newsguidelines.html" },
      { label: "Official read-only API", href: "https://github.com/HackerNews/API" },
      { label: "Unofficial flow reference", href: "https://github.com/lukakerr/hkn" }
    ],
    steps: [
      "Only use this for your own Hacker News account and your own submissions.",
      "Add a Hacker News profile here.",
      "Paste your Hacker News username and password. They stay in poster.config.local.json.",
      "If HN blocks password login validation, log in through Chrome and click Import Chrome cookie.",
      "Save config, then select Hacker News on the Dashboard.",
      "Add a Title. Hacker News requires it.",
      "Optionally put a URL in the Dashboard Link field.",
      "Optionally write text/body in the Dashboard Post field.",
      "Leave Link empty when you want a discussion/text post.",
      "Local media upload is ignored.",
      "If Hacker News requires CAPTCHA or browser validation, Crossposter will fail with a message and you must submit manually."
    ]
  }
};
