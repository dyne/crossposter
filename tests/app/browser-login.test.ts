import { expect, it, vi } from "vitest";
import { saveConfig } from "./support/fixtures";
import { validateConfigField } from "@/lib/config-validation";
import { configFields } from "@/lib/config-spec";

it.each(["x", "instagram"] as const)("passes %s profile browser and headless login settings without password arguments", async (platform) => {
  const prefix = platform.toUpperCase();
  await saveConfig({ profiles: { [platform]: [{ id: "fixture", label: "Fixture", values: {
    [`${prefix}_BROWSER_LOGIN_HEADLESS`]: "true",
    [`${prefix}_BROWSER_LOGIN_USERNAME`]: "fixture-user",
    [`${prefix}_BROWSER_LOGIN_PASSWORD`]: "fixture-password",
    [`${prefix}_BROWSER_CHANNEL`]: "chromium",
    [`${prefix}_BROWSER_LOCALE`]: "it-IT",
    [`${prefix}_BROWSER_VIEWPORT`]: "1440x900"
  } }] } });
  const { execFile } = await import("node:child_process");
  vi.mocked(execFile).mockImplementationOnce((...args) => {
    const callback = args.at(-1);
    if (typeof callback !== "function") throw new Error("No callback");
    queueMicrotask(() => callback(null, '{"ok":true,"message":"Fixture saved"}', ""));
    return {} as ReturnType<typeof execFile>;
  });
  const run = platform === "x" ? (await import("@/lib/x-browser")).loginXBrowser
    : (await import("@/lib/instagram-browser")).loginInstagramBrowser;
  await expect(run("fixture")).resolves.toMatchObject({ ok: true });
  const call = vi.mocked(execFile).mock.calls[0];
  expect(call[1]).toEqual(expect.arrayContaining(["--headless", "true"]));
  expect(JSON.stringify(call[1])).not.toContain("fixture-password");
  expect(call[2]).toMatchObject({ env: {
    [`${prefix}_BROWSER_LOGIN_USERNAME`]: "fixture-user", [`${prefix}_BROWSER_LOGIN_PASSWORD`]: "fixture-password",
    [`${prefix}_BROWSER_CHANNEL`]: "chromium", [`${prefix}_BROWSER_LOCALE`]: "it-IT", [`${prefix}_BROWSER_VIEWPORT`]: "1440x900"
  } });
});

it.each(["X", "INSTAGRAM"])("validates optional %s browser preferences and masks login passwords", (prefix) => {
  for (const [suffix, invalid] of [["LOGIN_HEADLESS", "maybe"], ["CHANNEL", "unknown"], ["LOCALE", "bad locale"], ["VIEWPORT", "0x900"]]) {
    const field = configFields.find((f) => f.name === `${prefix}_BROWSER_${suffix}`)!;
    expect(validateConfigField(field, invalid, false)).not.toBeNull();
    expect(validateConfigField(field, "", false)).toBeNull();
  }
  expect(configFields.find((f) => f.name === `${prefix}_BROWSER_LOGIN_PASSWORD`)?.secret).toBe(true);
});

it.each(["x", "instagram"] as const)("defaults %s login to visible without inheriting another account's credentials", async (platform) => {
  const prefix = platform.toUpperCase();
  vi.stubEnv(`${prefix}_BROWSER_LOGIN_HEADLESS`, "true");
  vi.stubEnv(`${prefix}_BROWSER_LOGIN_PASSWORD`, "other-account-password");
  await saveConfig({ profiles: { [platform]: [{ id: "fixture", label: "Fixture", values: {} }] } });
  const { execFile } = await import("node:child_process");
  vi.mocked(execFile).mockImplementationOnce((...args) => {
    const callback = args.at(-1);
    if (typeof callback !== "function") throw new Error("No callback");
    queueMicrotask(() => callback(null, '{"ok":true}', ""));
    return {} as ReturnType<typeof execFile>;
  });
  const run = platform === "x" ? (await import("@/lib/x-browser")).loginXBrowser
    : (await import("@/lib/instagram-browser")).loginInstagramBrowser;
  await run("fixture");
  const call = vi.mocked(execFile).mock.calls[0];
  expect(call[1]).toEqual(expect.arrayContaining(["--headless", "false"]));
  expect(call[2]).toMatchObject({ env: { [`${prefix}_BROWSER_LOGIN_PASSWORD`]: "" } });
});
