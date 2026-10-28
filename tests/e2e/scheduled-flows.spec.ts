import { test, expect } from "./scheduled-fixtures";
import { calendarNow } from "../app/support/scheduled-fixture";

for (const timezoneId of ["Europe/Berlin", "UTC"]) {
  test.describe(`scheduler browser-local ${timezoneId}`, () => {
    test.use({ timezoneId, locale: "en-US" });
    test.beforeEach(async ({ page, scheduleState }) => {
      expect(scheduleState.writes).toEqual([]);
      await page.clock.setFixedTime(new Date(calendarNow));
    });

    test("navigates month/year boundaries and out-of-month days without changing selection until clicked", async ({ page, scheduleState }) => {
      await page.goto("/scheduled");
      await expect(page.locator(".scheduled-card")).toHaveCount(4);
      await page.getByRole("button", { name: "Next month" }).click();
      await expect(page.getByText("November 2026", { exact: true })).toBeVisible();
      await expect(page.locator(".scheduler-date-heading")).toContainText("Wednesday, October 28, 2026");
      await page.getByRole("button", { name: "12/1/2026: 0 posts" }).click();
      await expect(page.getByText("December 2026", { exact: true })).toBeVisible();
      await expect(page.getByText("No posts on this date", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Next month" }).click();
      await expect(page.getByText("January 2027", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Previous month" }).click();
      await expect(page.getByText("December 2026", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Today", exact: true }).click();
      await expect(page.getByText("October 2026", { exact: true })).toBeVisible();
      await expect(page.locator(".scheduled-card")).toHaveCount(4);
      expect(scheduleState.writes).toEqual([]);
    });

    test("shows failed and uncertain results, local times, due status and queue ordering", async ({ page, scheduleState }) => {
      await page.goto("/scheduled");
      const failed = page.locator("article").filter({ hasText: "Check uncertain result" });
      await expect(failed.locator(".scheduler-status")).toHaveText("failed");
      await expect(failed.locator(".scheduled-results strong")).toHaveText("Result: 0/1 ok · 1 check");
      await expect(failed.locator(".history-platform.unknown")).toHaveText("Bluesky · Fixture profile");
      await expect(failed.locator("time")).toHaveText(timezoneId === "Europe/Berlin" ? "Oct 28, 2026, 9:00 AM" : "Oct 28, 2026, 8:00 AM");
      await expect(page.locator(".scheduled-card h3")).toHaveText(["Publishing fixture", "Due fixture", "Later scheduled fixture", "Check uncertain result"]);
      await expect(page.locator("article").filter({ hasText: "Due fixture" }).locator(".scheduler-status")).toHaveText("due now");
      await expect(page.locator("article").filter({ hasText: "Publishing fixture" }).getByRole("button")).toHaveCount(0);
      await expect(page.getByLabel("Scheduler counts")).toHaveText("3 scheduled1 publishing1 failed");
      expect(scheduleState.writes).toEqual([]);
    });

    test("reschedules with UTC wire time, moves grouping and keeps the selected date", async ({ page, scheduleState }) => {
      await page.goto("/scheduled");
      const failed = page.locator("article").filter({ hasText: "Check uncertain result" });
      await failed.getByLabel("Edit timing").fill("2026-11-01T18:45");
      await failed.getByRole("button", { name: "Save timing" }).click();
      await expect(page.getByRole("status")).toHaveText("Schedule timing updated.");
      expect(scheduleState.writes).toEqual([{ method: "PATCH", path: "/api/scheduled/failed%2Fid", body: { scheduledFor: timezoneId === "Europe/Berlin" ? "2026-11-01T17:45:00.000Z" : "2026-11-01T18:45:00.000Z" } }]);
      await expect(page.locator(".scheduler-date-heading")).toContainText("Wednesday, October 28, 2026");
      await expect(page.locator(".scheduled-card")).toHaveCount(3);
      await page.getByRole("button", { name: "11/1/2026: 1 post" }).click();
      await expect(page.getByText("November 2026", { exact: true })).toBeVisible();
      await expect(failed.getByLabel("Edit timing")).toHaveValue("2026-11-01T18:45");
      await expect(failed.locator(".scheduler-status")).toHaveText("scheduled");
    });

    test("discards a failed uncertain item only through the explicit DELETE action", async ({ page, scheduleState }) => {
      await page.goto("/scheduled");
      await page.locator("article").filter({ hasText: "Check uncertain result" }).getByRole("button", { name: "Discard" }).click();
      await expect(page.getByRole("status")).toHaveText("Scheduled post discarded.");
      await expect(page.locator(".scheduled-card")).toHaveCount(3);
      expect(scheduleState.writes).toEqual([{ method: "DELETE", path: "/api/scheduled/failed%2Fid", body: null }]);
      await expect(page.getByLabel("Scheduler counts")).toHaveText("3 scheduled1 publishing0 failed");
    });

    for (const action of ["Save timing", "Discard"]) {
      test(`retains edits/item and releases busy buttons on ${action} HTTP failure`, async ({ page, scheduleState }) => {
        await page.goto("/scheduled"); scheduleState.error = "Fixture mutation refused";
        const failed = page.locator("article").filter({ hasText: "Check uncertain result" });
        await failed.getByLabel("Edit timing").fill("2026-10-28T18:45");
        await failed.getByRole("button", { name: action }).click();
        await expect(page.getByRole("status")).toHaveText("Fixture mutation refused");
        await expect(failed.getByLabel("Edit timing")).toHaveValue("2026-10-28T18:45");
        await expect(failed.getByRole("button", { name: action })).toBeEnabled();
        await expect(page.locator(".scheduled-card")).toHaveCount(4);
        expect(scheduleState.writes).toHaveLength(1);
      });
    }

    test("shows initial fetch failure and recovers through explicit Refresh", async ({ page, scheduleState }) => {
      scheduleState.loadError = "Fixture queue unavailable";
      await page.goto("/scheduled");
      await expect(page.getByRole("status")).toHaveText("Fixture queue unavailable");
      await expect(page.getByText("No scheduled posts", { exact: true })).toBeVisible();
      scheduleState.loadError = "";
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("Scheduler refreshed.");
      await expect(page.locator(".scheduled-card")).toHaveCount(4);
      expect(scheduleState.writes).toEqual([]);
    });

    for (const method of ["GET", "PATCH", "DELETE"] as const) {
      test(`shows ${method} transport errors without losing the queue or locking actions`, async ({ page, scheduleState }) => {
        await page.goto("/scheduled");
        const failed = page.locator("article").filter({ hasText: "Check uncertain result" });
        await expect(failed).toBeVisible(); scheduleState.transportError = method;
        if (method === "GET") await page.getByRole("button", { name: "Refresh", exact: true }).click();
        else await failed.getByRole("button", { name: method === "PATCH" ? "Save timing" : "Discard" }).click();
        await expect(page.getByRole("status")).toHaveText("Failed to fetch");
        await expect(page.locator(".scheduled-card")).toHaveCount(4);
        await expect(failed.getByRole("button", { name: "Discard" })).toBeEnabled();
        expect(scheduleState.writes).toHaveLength(method === "GET" ? 0 : 1);
      });
    }
  });
}
