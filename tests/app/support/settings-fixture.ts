import { configFields } from "@/lib/config-spec";

// Synthetic placeholders only. No host config, provider session or personal data.
export function settingsFixture() {
  return {
    fields: configFields,
    values: { POSTER_LOCAL_PORT: "2004", POSTER_AUTO_UPDATE: "true" },
    profiles: {
      bluesky: [{ id: "fixture", label: "Fixture Bluesky", values: {
        BLUESKY_IDENTIFIER: "fixture.example", BLUESKY_APP_PASSWORD: "fixture-only-token"
      } }]
    },
    activeProfiles: { bluesky: "fixture" },
    configPath: "/fixture/poster.config.local.json",
    localUrl: "http://localhost:2004"
  };
}

export const settingsPanels = {
  "/api/storage": { uploads: { path: "/fixture/uploads", files: 2, bytes: 1024 }, config: {
    draftBytes: 128, publishedPostsBytes: 256, publishedPosts: 1, scheduledPostsBytes: 64, scheduledPosts: 1
  }, totalBytes: 1472 },
  "/api/local-service": { supported: true, label: "Fixture service", plistPath: "/fixture/service.plist", installed: false, running: false, port: "2004" },
  "/api/network/tailscale": { configuredHost: "", detectedIp: "", error: "", host: "", installed: false, running: false, port: "2004", url: "" },
  "/api/app-version": { packageName: "crossposter", currentVersion: "1.1.16", latestVersion: "1.1.16", latestError: "", updateAvailable: false, autoUpdate: true, managedByHomebrew: false, installSource: "local", appRoot: "/fixture/app", dataRoot: "/fixture/data", updateCommand: "npx @apoorvdarshan/crossposter@latest" }
};
