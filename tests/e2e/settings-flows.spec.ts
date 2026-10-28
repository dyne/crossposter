import { test, expect } from "./settings-fixtures";

test("settings profiles save, reload and remain selectable on the dashboard", async ({ page, settingsState }) => {
  await page.goto("/settings/socials");
  const bluesky = page.locator(".info-panel").filter({ has: page.getByText("Fixture Bluesky", { exact: true }) });
  await expect(bluesky).toBeVisible();
  await bluesky.getByRole("button", { name: "Add profile" }).click();
  const added = bluesky.locator(".config-group").last();
  await added.getByRole("textbox").first().fill("Second fixture profile");
  await added.getByPlaceholder("BLUESKY_IDENTIFIER").fill("second.example");
  await added.getByPlaceholder("BLUESKY_APP_PASSWORD").fill("fixture-second-token");
  await page.getByRole("button", { name: "Save config" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved locally.");
  expect(settingsState.config.profiles.bluesky).toHaveLength(2);
  expect(settingsState.config.activeProfiles.bluesky).toBe(settingsState.config.profiles.bluesky[1].id);
  await page.reload();
  await expect(page.getByText("Second fixture profile", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("BLUESKY_APP_PASSWORD").last()).toHaveAttribute("type", "password");
  await expect(page.getByPlaceholder("BLUESKY_IDENTIFIER").last()).toHaveValue("second.example");
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  const first = page.locator(".channel").filter({ hasText: "Profile: Fixture Bluesky" });
  const second = page.locator(".channel").filter({ hasText: "Profile: Second fixture profile" });
  await expect(first).toBeVisible(); await expect(second).toBeVisible();
  await page.getByRole("button", { name: "None", exact: true }).click();
  await first.click(); await expect(first.getByRole("checkbox")).toBeChecked();
  await expect(second.getByRole("checkbox")).not.toBeChecked();
  await second.click(); await first.click();
  await expect(second.getByRole("checkbox")).toBeChecked();
  await expect(first.getByRole("checkbox")).not.toBeChecked();
});

test("local settings save the port and network host across reload", async ({ page, settingsState }) => {
  await page.goto("/settings");
  await expect(page.getByPlaceholder("POSTER_LOCAL_PORT")).toHaveValue("2004");
  await page.getByPlaceholder("POSTER_LOCAL_PORT").fill("4100");
  await page.getByPlaceholder("100.x.x.x or macbook.tailnet.ts.net").fill("fixture.tailnet.ts.net");
  await page.getByRole("button", { name: "Save config" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved locally.");
  expect(settingsState.config.values.POSTER_LOCAL_PORT).toBe("4100");
  await page.reload();
  await expect(page.getByPlaceholder("POSTER_LOCAL_PORT")).toHaveValue("4100");
  await expect(page.getByRole("link", { name: "http://fixture.tailnet.ts.net:4100" })).toBeVisible();
});
