import { describe, expect, it, vi } from "vitest";
import { saveConfig } from "./support/fixtures";

describe("public configuration lookup", () => {
  it("uses defaults when local configuration and environment are absent", async () => {
    const { getConfigValue } = await import("@/lib/local-config");
    expect(getConfigValue("POSTER_LOCAL_PORT")).toBe("2004");
    expect(getConfigValue("X_PREMIUM_LONG_POSTS")).toBe("false");
    expect(getConfigValue("BLUESKY_IDENTIFIER")).toBeUndefined();
  });

  it("uses the environment before defaults and local values before environment", async () => {
    vi.stubEnv("POSTER_LOCAL_PORT", "3456");
    const { getConfigValue } = await import("@/lib/local-config");
    expect(getConfigValue("POSTER_LOCAL_PORT")).toBe("3456");
    await saveConfig({ values: { POSTER_LOCAL_PORT: " 4567 " } });
    expect(getConfigValue("POSTER_LOCAL_PORT")).toBe("4567");
    await saveConfig({ values: { POSTER_LOCAL_PORT: "" } });
    expect(getConfigValue("POSTER_LOCAL_PORT")).toBe("3456");
  });

  it("uses active profile values before local values and allows explicit profile override", async () => {
    vi.stubEnv("BLUESKY_IDENTIFIER", "environment.example");
    await saveConfig({
      values: { BLUESKY_IDENTIFIER: "local.example" },
      profiles: { bluesky: [
        { id: "one", label: "One", values: { BLUESKY_IDENTIFIER: "one.example" } },
        { id: "two", label: "Two", values: { BLUESKY_IDENTIFIER: "two.example" } }
      ] },
      activeProfiles: { bluesky: "one" }
    });
    const { getConfigValue } = await import("@/lib/local-config");
    expect(getConfigValue("BLUESKY_IDENTIFIER")).toBe("one.example");
    expect(getConfigValue("BLUESKY_IDENTIFIER", "two")).toBe("two.example");
  });

  it("implicit empty profiles fall back while explicit empty profiles exclude local/env credentials", async () => {
    vi.stubEnv("BLUESKY_APP_PASSWORD", "fixture-environment-token");
    await saveConfig({
      values: { BLUESKY_IDENTIFIER: "local.example" },
      profiles: { bluesky: [{ id: "empty", label: "Empty", values: {} }] },
      activeProfiles: { bluesky: "empty" }
    });
    const { getConfigValue } = await import("@/lib/local-config");
    expect(getConfigValue("BLUESKY_IDENTIFIER")).toBe("local.example");
    expect(getConfigValue("BLUESKY_APP_PASSWORD")).toBe("fixture-environment-token");
    expect(getConfigValue("BLUESKY_IDENTIFIER", "empty")).toBeUndefined();
    expect(getConfigValue("BLUESKY_APP_PASSWORD", "empty")).toBeUndefined();
    expect(getConfigValue("BLUESKY_APP_PASSWORD", "missing")).toBeUndefined();
  });

  it("explicit missing profile settings retain field defaults", async () => {
    vi.stubEnv("X_PREMIUM_LONG_POSTS", "true");
    await saveConfig({ values: { X_PREMIUM_LONG_POSTS: "true" }, profiles: { x: [{ id: "empty", label: "Empty", values: {} }] } });
    const { getConfigValue } = await import("@/lib/local-config");
    expect(getConfigValue("X_PREMIUM_LONG_POSTS")).toBe("true");
    expect(getConfigValue("X_PREMIUM_LONG_POSTS", "empty")).toBe("false");
    expect(getConfigValue("X_PREMIUM_LONG_POSTS", "missing")).toBe("false");
  });

  it("only validates explicitly selected profiles and reports missing/invalid credentials", async () => {
    await saveConfig({ profiles: { bluesky: [{ id: "bad", label: "Bad", values: { BLUESKY_IDENTIFIER: "@invalid" } }] } });
    const { getProfileConfigIssues } = await import("@/lib/local-config");
    expect(getProfileConfigIssues("bluesky")).toEqual([]);
    expect(getProfileConfigIssues("bluesky", "missing")).toEqual([{ field: "profile", label: "Profile", message: "Selected profile no longer exists", kind: "missing" }]);
    expect(getProfileConfigIssues("bluesky", "bad")).toEqual([
      { field: "BLUESKY_IDENTIFIER", label: "Bluesky handle", message: "Invalid Bluesky handle: should not include @", kind: "invalid" },
      { field: "BLUESKY_APP_PASSWORD", label: "Bluesky app password", message: "Missing Bluesky app password", kind: "missing" }
    ]);
  });
});
