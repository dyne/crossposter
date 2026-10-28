// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ScheduledItem } from "@/components/scheduled/scheduled-item";
import { ScheduledList } from "@/components/scheduled/scheduled-list";
import { calendarPosts } from "./support/scheduled-fixture";

afterEach(cleanup);
const actions = () => ({ editValue: "2026-10-28T12:00", busy: false, onEdit: vi.fn(), onReschedule: vi.fn(), onDiscard: vi.fn() });

it("retains target/profile identity, result links and ok-before-uncertain status presentation", () => {
  const post = { ...calendarPosts()[0], title: "  ", linkUrl: "https://example.test/post", targets: [{ id: "b:one", platform: "bluesky" as const, profileLabel: "Fixture one" }], results: [
    { platform: "bluesky" as const, targetId: "b:one", profileLabel: "Fixture one", ok: true, uncertain: true, message: "Fixture confirmed", url: "https://example.test/result" },
    { platform: "bluesky" as const, targetId: "b:two", ok: false, message: "Fixture failed" }
  ] };
  render(<ScheduledItem post={post} {...actions()} />);
  expect(screen.getByRole("heading", { name: "Untitled post" })).toBeVisible();
  expect(screen.getByText("Result: 1/2 ok · 1 check")).toBeVisible();
  expect(screen.getByRole("link", { name: /Bluesky · Fixture one$/ })).toHaveClass("ok");
  expect(screen.getByRole("link", { name: /Bluesky · Fixture one$/ })).toHaveAttribute("href", "https://example.test/result");
  expect(screen.getByRole("link", { name: "https://example.test/post" })).toHaveAttribute("rel", "noreferrer");
  expect(screen.getByTitle("Fixture failed")).toHaveClass("err");
});

it.each(["image", "video", "audio", "file"] as const)("preserves %s media presentation and encoded URLs", (kind) => {
  const post = { ...calendarPosts()[0], media: { id: "fixture/media", filename: "fixture.bin", contentType: "fixture/type", size: 1024, kind, url: "ignored-original-url" } };
  const { container } = render(<ScheduledItem post={post} {...actions()} />);
  expect(screen.getByText("fixture.bin · fixture/type · 1.0 KB")).toBeVisible();
  if (kind === "image") expect(screen.getByRole("img", { name: "fixture.bin" })).toHaveAttribute("src", "/api/media/fixture%2Fmedia");
  if (kind === "video") {
    expect(container.querySelector("video")).toHaveAttribute("src", "/api/media/fixture%2Fmedia");
    expect(container.querySelector("video")).toHaveAttribute("preload", "metadata");
  }
  if (kind === "audio" || kind === "file") expect(container.querySelector(".scheduled-media-fileicon svg")).toBeInTheDocument();
});

it("keeps editable input active while only mutation buttons are busy and hides actions during publishing", () => {
  const callbacks = actions(); const post = calendarPosts()[0];
  const { rerender } = render(<ScheduledItem post={post} {...callbacks} busy />);
  expect(screen.getByRole("button", { name: "Save timing" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
  expect(screen.getByLabelText("Edit timing")).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Edit timing"), { target: { value: "2026-10-29T12:00" } });
  expect(callbacks.onEdit).toHaveBeenCalledWith("2026-10-29T12:00");
  rerender(<ScheduledItem post={post} {...callbacks} />);
  fireEvent.click(screen.getByRole("button", { name: "Save timing" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(callbacks.onReschedule).toHaveBeenCalledOnce(); expect(callbacks.onDiscard).toHaveBeenCalledOnce();
  rerender(<ScheduledItem post={{ ...post, status: "publishing" }} {...callbacks} />);
  expect(screen.queryByLabelText("Edit timing")).toBeNull(); expect(screen.queryByRole("button")).toBeNull();
});

it("distinguishes an empty queue from an empty selected day and the loading state", () => {
  const props = { selectedDateKey: "2026-10-28", selectedDatePosts: [], totalPosts: 0, isLoading: false, edits: {}, busyId: "", onEdit: vi.fn(), onReschedule: vi.fn(), onDiscard: vi.fn() };
  const { rerender } = render(<ScheduledList {...props} />);
  expect(screen.getByText("No scheduled posts")).toBeVisible();
  rerender(<ScheduledList {...props} totalPosts={1} />);
  expect(screen.getByText("No posts on this date")).toBeVisible();
  expect(screen.queryByText("No scheduled posts")).toBeNull();
  rerender(<ScheduledList {...props} isLoading />);
  expect(screen.getByText("Loading scheduled posts")).toBeVisible();
  expect(screen.queryByText("No posts on this date")).toBeNull();
});
