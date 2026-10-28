import { expect, it, vi } from "vitest";
import {
  addMonths, calendarDaysForMonth, dateFromKey, dateKey, datetimeLocalToIso,
  datetimeLocalValue, formatDateTime, formatMonth, formatSelectedDate,
  groupPostsByDate, isQueuePost, scheduledDateKey, sortScheduledPosts, startOfMonth
} from "@/lib/scheduled/calendar";
import { apiError, formatBytes, statusLabel } from "@/lib/scheduled/presentation";
import { calendarNow, calendarPosts } from "./support/scheduled-fixture";

it("runs with an explicit supported process timezone", () => {
  expect(["UTC", "Europe/Berlin"]).toContain(process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone);
});

it.each([
  ["2026-12-31", 1, "2027-01-01"], ["2027-01-31", -1, "2026-12-01"],
  ["2024-02-29", 12, "2025-02-01"], ["2026-03-31", -1, "2026-02-01"]
])("navigates from %s by %s months without carrying its day", (key, amount, expected) => {
  const input = dateFromKey(key);
  expect(dateKey(addMonths(input, amount))).toBe(expected);
  expect(dateKey(startOfMonth(input))).toBe(`${key.slice(0, 7)}-01`);
  expect(dateKey(input)).toBe(key);
});

it.each([
  ["2024-02-01", "2024-01-28", "2024-03-09"],
  ["2026-03-01", "2026-03-01", "2026-04-11"],
  ["2026-10-01", "2026-09-27", "2026-11-07"],
  ["2027-01-01", "2026-12-27", "2027-02-06"]
])("builds six Sunday-first weeks for %s across DST and year boundaries", (month, first, last) => {
  const days = calendarDaysForMonth(dateFromKey(month), month, new Map(), dateFromKey(month));
  expect(days).toHaveLength(42); expect(days[0].key).toBe(first); expect(days[41].key).toBe(last);
  expect(new Set(days.map((day) => day.key)).size).toBe(42);
  expect(days.every((day) => day.date.getHours() === 0)).toBe(true);
  expect(days.filter((day) => day.isSelected).map((day) => day.key)).toEqual([month]);
  expect(days.filter((day) => day.isToday).map((day) => day.key)).toEqual([month]);
  expect(days.filter((day) => day.isCurrentMonth)).toHaveLength(month === "2024-02-01" ? 29 : 31);
});

it.each([
  ["2024-02-29T23:30:00.000Z", "2024-03-01T00:30", "2024-02-29T23:30"],
  ["2026-03-29T00:30:00.000Z", "2026-03-29T01:30", "2026-03-29T00:30"],
  ["2026-03-29T01:30:00.000Z", "2026-03-29T03:30", "2026-03-29T01:30"],
  ["2026-10-25T00:30:00.000Z", "2026-10-25T02:30", "2026-10-25T00:30"],
  ["2026-10-25T01:30:00.000Z", "2026-10-25T02:30", "2026-10-25T01:30"],
  ["2026-12-31T23:30:00.000Z", "2027-01-01T00:30", "2026-12-31T23:30"]
])("formats local editing/grouping for %s", (instant, berlin, utc) => {
  const expected = Intl.DateTimeFormat().resolvedOptions().timeZone === "Europe/Berlin" ? berlin : utc;
  expect(datetimeLocalValue(instant)).toBe(expected);
  expect(scheduledDateKey(instant)).toBe(expected.slice(0, 10));
});

it("preserves JavaScript's spring-gap normalization and earlier autumn-overlap occurrence", () => {
  const berlin = Intl.DateTimeFormat().resolvedOptions().timeZone === "Europe/Berlin";
  expect(datetimeLocalToIso("2026-03-29T02:30")).toBe(berlin ? "2026-03-29T01:30:00.000Z" : "2026-03-29T02:30:00.000Z");
  expect(datetimeLocalToIso("2026-10-25T02:30")).toBe(berlin ? "2026-10-25T00:30:00.000Z" : "2026-10-25T02:30:00.000Z");
});

it("preserves invalid-time guards and legacy date-key normalization", () => {
  expect(scheduledDateKey("invalid")).toBe(""); expect(datetimeLocalValue("invalid")).toBe("");
  expect(datetimeLocalToIso("")).toBe(""); expect(formatDateTime("invalid")).toBe("Invalid time");
  expect(dateKey(new Date("invalid"))).toBe("NaN-NaN-NaN");
  expect(dateKey(dateFromKey("2026-02-31"))).toBe("2026-03-03");
  expect(() => formatSelectedDate("invalid")).toThrow(RangeError);
});

it("keeps English locale labels independent of local day math", () => {
  expect(formatMonth(dateFromKey("2024-02-01"))).toBe("February 2024");
  expect(formatSelectedDate("2024-02-29")).toBe("Thursday, February 29, 2024");
});

it("orders status before time, groups valid local days and leaves the API array unchanged", () => {
  const posts = calendarPosts(); const ids = posts.map((post) => post.id);
  const sorted = sortScheduledPosts(posts.filter(isQueuePost));
  const grouped = groupPostsByDate(sorted);
  expect(grouped.get("2026-10-28")?.map((post) => post.id)).toEqual(["publishing", "due", "later", "failed/id"]);
  expect(grouped.has("")).toBe(false); expect(posts.map((post) => post.id)).toEqual(ids);
  const tied = [{ ...posts[1], id: "first" }, { ...posts[1], id: "second" }];
  expect(sortScheduledPosts(tied).map((post) => post.id)).toEqual(["first", "second"]);
});

it("preserves status/error/size presentation without merging composer validation rules", () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(calendarNow));
  const posts = calendarPosts();
  expect(statusLabel(posts[3])).toBe("due now"); expect(statusLabel(posts[1])).toBe("scheduled");
  expect(statusLabel(posts[0])).toBe("failed"); expect(statusLabel(posts[6])).toBe("scheduled");
  expect(apiError("Fixture rejected")).toBe("Fixture rejected");
  expect(apiError({ formErrors: ["One", "Two"] })).toBe("One Two");
  expect(apiError({ fieldErrors: { scheduledFor: ["Not surfaced"] } })).toBe("Could not update the scheduler.");
  expect([1023, 1024, 10240, 1048576].map(formatBytes)).toEqual(["1023 B", "1.0 KB", "10 KB", "1.0 MB"]);
});
