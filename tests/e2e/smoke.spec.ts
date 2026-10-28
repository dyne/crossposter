import { test, expect } from "./fixtures";

test("composer edits save to fixtures and theme survives a reload", async ({ page, fixtureState }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Compose", exact: true })).toBeVisible();
  await expect(page.getByText("Profile: Fixture Bluesky")).toBeVisible();
  await expect(page.getByRole("checkbox")).toBeChecked();
  await page.getByPlaceholder("Write the post once.").fill("Fixture browser draft");
  await expect.poll(() => fixtureState.draft.text).toBe("Fixture browser draft");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.getByPlaceholder("Write the post once.")).toHaveValue("Fixture browser draft");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("publish sends the selected fixture target and displays an uncertain result", async ({ page, fixtureState }) => {
  await page.goto("/");
  await expect(page.getByText("Profile: Fixture Bluesky")).toBeVisible();
  await expect(page.getByRole("checkbox")).toBeChecked();
  await page.getByPlaceholder("Write the post once.").fill("Fixture publish only");
  await page.getByRole("button", { name: "Publish draft", exact: true }).click();
  const results = page.getByLabel("Latest publish result");
  await expect(results).toContainText("Fixture outcome unknown; check profile before retrying.");
  await expect(results.locator(".badge")).toHaveText("check");
  expect(fixtureState.publishRequests).toEqual([expect.objectContaining({ text: "Fixture publish only", targets: [expect.objectContaining({ platform: "bluesky", profileId: "fixture" })] })]);
});

test("schedule opens its controls and the scheduler loads an isolated empty queue", async ({ page, fixtureState }) => {
  await page.goto("/");
  await expect(page.getByText("Profile: Fixture Bluesky")).toBeVisible();
  await expect(page.getByRole("checkbox")).toBeChecked();
  await page.getByPlaceholder("Write the post once.").fill("Fixture scheduled draft");
  await page.getByRole("button", { name: "Schedule draft", exact: true }).click();
  await page.getByRole("button", { name: "30 min", exact: true }).click();
  await page.getByRole("button", { name: "Confirm schedule", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Scheduled for" })).toBeVisible();
  expect(fixtureState.scheduledPosts).toHaveLength(1);
  expect(fixtureState.scheduledPosts[0].text).toBe("Fixture scheduled draft");
  fixtureState.scheduledPosts = [];
  await page.getByRole("link", { name: "Scheduler", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scheduler", exact: true })).toBeVisible();
  await expect(page.getByText("No scheduled posts", { exact: true })).toBeVisible();
});
