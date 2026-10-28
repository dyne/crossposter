// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { calendarNow, calendarPosts } from "./support/scheduled-fixture";
import type { ScheduledPost } from "@/lib/types";

let posts: ScheduledPost[];
let failure: "http" | "transport" | "non-error" | "json" | "";
const writes: Array<{ url: string; method: string; body: unknown }> = [];
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
beforeEach(() => {
  posts = calendarPosts(); failure = ""; writes.length = 0;
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(calendarNow));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.startsWith("/api/scheduled")) throw new Error(`Unexpected calendar request ${url}`);
    if (init?.method) writes.push({ url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : null });
    if (failure === "transport") throw new Error("Fixture disconnected");
    if (failure === "non-error") throw "Fixture thrown value";
    if (failure === "json") return new Response("invalid JSON");
    if (failure === "http") return json({ error: { formErrors: ["Fixture denied", "Try later"], fieldErrors: { scheduledFor: ["Ignored field message"] } } }, 400);
    return json({ scheduledPosts: posts });
  }));
});
afterEach(cleanup);
async function mount() {
  const { default: Page } = await import("@/app/scheduled/page");
  render(<Page />);
  await waitFor(() => expect(screen.queryByText("Loading scheduled posts")).not.toBeInTheDocument());
  // Select the fixed fixture date independently of the host's current day.
  const month = screen.getByText("Month").parentElement!;
  while (!within(month).queryByText("October 2026")) {
    const heading = within(month).getByText(/\w+ \d{4}/).textContent!;
    fireEvent.click(screen.getByRole("button", { name: new Date(heading).getTime() > new Date("October 2026").getTime() ? "Previous month" : "Next month" }));
  }
  fireEvent.click(screen.getByRole("button", { name: /^10\/28\/2026:/ }));
}
function card(title: string) { return screen.getByText(title, { exact: true }).closest("article")!; }

it("preserves queue filtering, status-before-time ordering, invalid-date counts and uncertain presentation", async () => {
  await mount();
  expect(screen.getByLabelText("Scheduler counts")).toHaveTextContent("3 scheduled1 publishing1 failed");
  expect(Array.from(document.querySelectorAll(".scheduled-card h3")).map((e) => e.textContent)).toEqual(["Publishing fixture", "Due fixture", "Later scheduled fixture", "Check uncertain result"]);
  expect(within(card("Check uncertain result")).getByText("Result: 0/1 ok · 1 check")).toBeVisible();
  expect(within(card("Publishing fixture")).queryByRole("button", { name: "Discard" })).toBeNull();
  expect(screen.queryByText("Hidden invalid time")).toBeNull();
});

it("keeps month navigation independent of selected date and returns Today to the browser-local date", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Next month" }));
  expect(screen.getByText("November 2026")).toBeVisible();
  expect(screen.getByText("Wednesday, October 28, 2026")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /^12\/1\/2026:/ }));
  expect(screen.getByText("December 2026")).toBeVisible();
  expect(screen.getAllByText("Tuesday, December 1, 2026")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Today" }));
  expect(document.querySelector(".scheduler-date-heading")).toHaveTextContent(new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date()));
});

it.each([
  ["2024-02-29T23:30:00.000Z", "2024-03-01", "2024-02-29"],
  ["2026-12-31T23:30:00.000Z", "2027-01-01", "2026-12-31"],
  ["2026-03-29T01:30:00.000Z", "2026-03-29", "2026-03-29"],
  ["2026-10-25T01:30:00.000Z", "2026-10-25", "2026-10-25"]
])("groups %s on its browser-local day and submits the original instant", async (instant, berlin, utc) => {
  const key = Intl.DateTimeFormat().resolvedOptions().timeZone === "Europe/Berlin" ? berlin : utc;
  posts = [{ ...posts[0], scheduledFor: instant }];
  const { default: Page } = await import("@/app/scheduled/page");
  render(<Page />);
  await waitFor(() => expect(screen.queryByText("Loading scheduled posts")).toBeNull());
  const [year, month, day] = key.split("-").map(Number);
  const targetMonth = new Date(year, month - 1, 1);
  const monthHeading = screen.getByText("Month").parentElement!;
  while (!within(monthHeading).queryByText(new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(targetMonth))) {
    const heading = within(monthHeading).getByText(/\w+ \d{4}/).textContent!;
    fireEvent.click(screen.getByRole("button", { name: new Date(heading).getTime() > targetMonth.getTime() ? "Previous month" : "Next month" }));
  }
  fireEvent.click(screen.getByRole("button", { name: `${month}/${day}/${year}: 1 post` }));
  const item = card("Check uncertain result");
  expect(within(item).getByText(new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(instant)))).toBeVisible();
  fireEvent.click(within(item).getByRole("button", { name: "Save timing" }));
  await screen.findByText("Schedule timing updated.");
  // Ambiguous autumn input uses JS's earlier occurrence, even if the original was later.
  const expected = instant === "2026-10-25T01:30:00.000Z" && Intl.DateTimeFormat().resolvedOptions().timeZone === "Europe/Berlin" ? "2026-10-25T00:30:00.000Z" : instant;
  expect(writes[0]).toEqual({ url: "/api/scheduled/failed%2Fid", method: "PATCH", body: { scheduledFor: expected } });
});

it("retains edits across refresh, including server reschedules, and sends browser-local edits as UTC", async () => {
  await mount(); const item = card("Check uncertain result");
  const input = within(item).getByLabelText("Edit timing");
  fireEvent.change(input, { target: { value: "2026-10-28T18:45" } });
  posts = posts.map((post) => ({ ...post, scheduledFor: "2026-10-28T20:00:00.000Z" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Scheduler refreshed.");
  expect(input).toHaveValue("2026-10-28T18:45");
  fireEvent.click(within(item).getByRole("button", { name: "Save timing" }));
  await screen.findByText("Schedule timing updated.");
  expect(writes[0].body).toEqual({ scheduledFor: Intl.DateTimeFormat().resolvedOptions().timeZone === "Europe/Berlin" ? "2026-10-28T17:45:00.000Z" : "2026-10-28T18:45:00.000Z" });
});

it("rejects empty timing without a request and discards by encoded ID", async () => {
  await mount(); const item = card("Check uncertain result");
  fireEvent.change(within(item).getByLabelText("Edit timing"), { target: { value: "" } });
  fireEvent.click(within(item).getByRole("button", { name: "Save timing" }));
  await screen.findByText("Choose a valid scheduled time."); expect(writes).toHaveLength(0);
  posts = posts.filter((post) => post.id !== "failed/id");
  fireEvent.click(within(item).getByRole("button", { name: "Discard" }));
  await screen.findByText("Scheduled post discarded."); expect(screen.queryByText("Check uncertain result")).toBeNull();
  expect(writes[0]).toEqual({ url: "/api/scheduled/failed%2Fid", method: "DELETE", body: null });
});

it.each(["http", "transport", "non-error"] as const)("shows initial fetch %s failure and clears loading", async (kind) => {
  failure = kind; await mount();
  expect(screen.getByRole("status")).toHaveTextContent(kind === "http" ? "Fixture denied Try later" : kind === "transport" ? "Fixture disconnected" : "Could not load scheduled posts.");
  expect(screen.getByText("No scheduled posts")).toBeVisible();
});

it.each(["Save timing", "Discard"])("keeps data/edit state on %s HTTP and transport failures and releases busy state", async (action) => {
  await mount(); const item = card("Check uncertain result");
  failure = "http"; fireEvent.click(within(item).getByRole("button", { name: action }));
  await screen.findByText("Fixture denied Try later"); expect(within(item).getByRole("button", { name: action })).toBeEnabled();
  failure = "transport"; fireEvent.click(within(item).getByRole("button", { name: action }));
  await screen.findByText("Fixture disconnected"); expect(within(item).getByRole("button", { name: action })).toBeEnabled();
  failure = "non-error"; fireEvent.click(within(item).getByRole("button", { name: action }));
  await screen.findByText(action === "Discard" ? "Could not discard post." : "Could not reschedule post.");
  expect(within(item).getByLabelText("Edit timing")).not.toHaveValue("");
});

it("refreshes every 30 seconds, preserves old rows on failure and cleans up its interval", async () => {
  const interval = vi.spyOn(window, "setInterval"); const clear = vi.spyOn(window, "clearInterval");
  await mount(); expect(interval).toHaveBeenCalledWith(expect.any(Function), 30_000);
  failure = "http";
  await act(async () => { await interval.mock.calls[0][0](); });
  await screen.findByText("Fixture denied Try later"); expect(card("Check uncertain result")).toBeInTheDocument();
  cleanup(); expect(clear).toHaveBeenCalledWith(interval.mock.results[0].value);
});
