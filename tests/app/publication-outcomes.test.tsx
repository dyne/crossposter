// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PublishResults } from "@/components/composer/publish-results";
import { PublishedHistory } from "@/components/composer/published-history";
import { ScheduledItem } from "@/components/scheduled/scheduled-item";
import { publicationRows, type PublicationView } from "@/lib/publication-outcomes";
import { scheduledPost } from "./support/fixtures";

afterEach(cleanup);
const longError = `Account response could not be read. ${"Retain this diagnostic before checking the remote account. ".repeat(12)}`;
const results = [
  { platform: "bluesky" as const, targetId: "bluesky:north", profileLabel: "North team", ok: true, message: "Accepted without a returned URL" },
  { platform: "bluesky" as const, targetId: "bluesky:south", profileLabel: "South team", ok: false, message: longError },
  { platform: "bluesky" as const, targetId: "bluesky:east", profileLabel: "East team", ok: false, uncertain: true, message: "Response lost after possible acceptance" }
];

it("shows explicit live outcomes and duplicate-provider accounts without needing URLs, hover or color", () => {
  render(<PublishResults results={results} />);
  for (const status of ["Published", "Failed", "Outcome unknown"]) expect(screen.getByText(status)).toBeVisible();
  for (const account of ["North team", "South team", "East team"]) expect(screen.getByText(`Bluesky · ${account}`)).toBeVisible();
  expect(screen.getByText("Accepted without a returned URL")).toBeVisible(); expect(screen.queryByRole("link")).toBeNull();
  const details = screen.getByText("Details for Bluesky · South team"); expect(details.closest("details")).not.toHaveAttribute("open");
  fireEvent.click(details); expect(details.closest("details")).toHaveAttribute("open"); expect(screen.getByText(longError.trim())).toBeVisible();
  expect(screen.getByText(/Inspect the remote account/)).toBeVisible(); expect(screen.queryByRole("button")).toBeNull();
});

it("uses authoritative not-dispatched evidence in history without changing the original record", () => {
  const post: PublicationView = { id: "known", createdAt: "2026-01-15T12:00:00Z", text: "Original immutable body", platforms: ["bluesky"], results: [results[1]],
    outcomes: [{ target: { id: "bluesky:south", platform: "bluesky", profileId: "south", label: "South team" }, state: "not_dispatched", message: "Stopped during validation, before provider dispatch.", url: null }] };
  const before = structuredClone(post); render(<PublishedHistory publishedPosts={[post]} />);
  expect(screen.getByText("Not sent")).toBeVisible(); expect(screen.queryByText("Failed", { exact: true })).toBeNull();
  expect(screen.getByText("Stopped during validation, before provider dispatch.")).toBeVisible(); expect(post).toEqual(before);
  expect(publicationRows(post.results, [{ id: "bluesky", platform: "bluesky" }], post.outcomes)).toHaveLength(1);
});

it("never infers not-sent from a generic failure, a missing URL, or missing results for attempted targets", () => {
  expect(publicationRows([results[1]])[0].state).toBe("Failed");
  const rows = publicationRows([results[0]], [{ id: "bluesky:north", platform: "bluesky", profileLabel: "North team" }, { id: "bluesky:west", platform: "bluesky", profileLabel: "West team" }]);
  expect(rows.map((row) => row.state)).toEqual(["Published", "Outcome unknown"]);
  expect(rows[1].label).toBe("Bluesky · West team");
});

it("explains blocked timing, frozen approval and remote inspection while keeping only explicit discard", () => {
  const onDiscard = vi.fn();
  render(<ScheduledItem post={scheduledPost({ status: "failed", attempts: 1, results, authorization: { actionId: "frozen", payloadDigest: "frozen" } })}
    editValue="2026-01-16T12:00" busy={false} onEdit={vi.fn()} onReschedule={vi.fn()} onDiscard={onDiscard} />);
  expect(screen.getByText(/requires a new reschedule preparation and owner approval/)).toBeVisible();
  expect(screen.getByText(/Inspect the remote account/)).toBeVisible();
  expect(screen.getByText(/does not remove a post from a remote account/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Save timing" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Discard" })); expect(onDiscard).toHaveBeenCalledOnce();
  expect(within(screen.getByRole("article")).getByText("Published", { exact: true })).toBeVisible();
});
