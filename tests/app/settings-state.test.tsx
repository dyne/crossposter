// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { settingsFixture } from "./support/settings-fixture";
import type { ConfigResponse } from "@/lib/settings/contracts";

let config: ConfigResponse;
let fail = false;
beforeEach(() => {
  config = settingsFixture(); fail = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== "/api/config") throw new Error(`Unexpected ${url}`);
    if (init?.method === "PUT") {
      if (fail) return new Response(JSON.stringify({ error: "Fixture refused" }), { status: 500 });
      config = { ...config, ...JSON.parse(String(init.body)) };
    }
    return new Response(JSON.stringify(config));
  }));
});
afterEach(cleanup);

it("tracks saved/dirty values and active selection separately from unsaved profile edits", async () => {
  const { useSettingsConfig } = await import("@/components/settings/use-settings-config");
  const { result } = renderHook(useSettingsConfig);
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.isDirty).toBe(false);
  act(() => result.current.addProfile("bluesky"));
  const second = result.current.profiles.bluesky![1];
  expect(result.current.activeProfiles.bluesky).toBe(second.id);
  act(() => result.current.updateProfile("bluesky", second.id, { ...second, label: "Unsaved second profile" }));
  act(() => result.current.selectProfile("bluesky", "fixture"));
  expect(result.current.profiles.bluesky![1].label).toBe("Unsaved second profile");
  expect(result.current.isDirty).toBe(true);
  expect(result.current.savedConfiguration.profiles.bluesky).toHaveLength(1);
  await act(async () => { expect(await result.current.saveConfig()).toBe(true); });
  expect(result.current.isDirty).toBe(false);
  expect(config.activeProfiles.bluesky).toBe("fixture");
  expect(config.profiles.bluesky![1].label).toBe("Unsaved second profile");
  act(() => result.current.setValues((values) => ({ ...values, POSTER_LOCAL_PORT: "4100" })));
  fail = true;
  await act(async () => { expect(await result.current.saveConfig()).toBe(false); });
  expect(result.current.isDirty).toBe(true);
  expect(result.current.values.POSTER_LOCAL_PORT).toBe("4100");
  expect(result.current.savedConfiguration.values.POSTER_LOCAL_PORT).toBe("2004");
});

it("uses provider defaults, retains active selection when deleting another profile, and clears it on last deletion", async () => {
  const { useSettingsConfig } = await import("@/components/settings/use-settings-config");
  const { result } = renderHook(useSettingsConfig);
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  act(() => result.current.addProfile("instagram"));
  const instagram = result.current.profiles.instagram![0];
  expect(instagram.values.INSTAGRAM_BROWSER_HEADLESS).toBe("true");
  act(() => result.current.deleteProfile("instagram", instagram.id));
  act(() => result.current.deleteProfile("instagram", instagram.id));
  expect(result.current.profiles.instagram).toEqual([]);
  expect(result.current.activeProfiles.instagram).toBe("");
  act(() => result.current.addProfile("bluesky"));
  const second = result.current.profiles.bluesky![1];
  act(() => result.current.deleteProfile("bluesky", "fixture"));
  act(() => result.current.deleteProfile("bluesky", "fixture"));
  expect(result.current.activeProfiles.bluesky).toBe(second.id);
});
