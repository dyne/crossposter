import type { ScheduledPost } from "@/lib/types";

export const calendarNow = "2026-10-28T12:00:00.000Z";
export function calendarPosts(): ScheduledPost[] {
  const base = { createdAt: calendarNow, updatedAt: calendarNow, platforms: ["bluesky"] as ScheduledPost["platforms"], attempts: 0 };
  return [
    { ...base, id: "failed/id", title: "Check uncertain result", text: "Check the profile before retrying this fixture.", scheduledFor: "2026-10-28T08:00:00.000Z", status: "failed", lastError: "Fixture verification needed", results: [{ platform: "bluesky", ok: false, uncertain: true, message: "Fixture outcome unknown", profileLabel: "Fixture profile" }] },
    { ...base, id: "later", title: "Later scheduled fixture", text: "A queued fixture.", scheduledFor: "2026-10-28T16:00:00.000Z", status: "scheduled" },
    { ...base, id: "publishing", title: "Publishing fixture", text: "An in-flight fixture.", scheduledFor: "2026-10-28T09:00:00.000Z", status: "publishing" },
    { ...base, id: "due", title: "Due fixture", text: "A due fixture.", scheduledFor: "2026-10-28T10:00:00.000Z", status: "scheduled" },
    { ...base, id: "published", title: "Hidden published fixture", text: "Already published.", scheduledFor: "2026-10-28T10:00:00.000Z", status: "published" },
    { ...base, id: "canceled", title: "Hidden canceled fixture", text: "Canceled.", scheduledFor: "2026-10-28T10:00:00.000Z", status: "canceled" },
    { ...base, id: "invalid", title: "Hidden invalid time", text: "Invalid time remains counted but ungrouped.", scheduledFor: "invalid", status: "scheduled" }
  ];
}
