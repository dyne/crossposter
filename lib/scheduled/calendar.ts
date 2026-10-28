import type { ScheduledPost } from "@/lib/types";

export function isQueuePost(post: ScheduledPost): boolean {
  return post.status === "scheduled" || post.status === "publishing" || post.status === "failed";
}

export const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addMonths(date: Date, value: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + value, 1);
}

export function dateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${date.getFullYear()}-${month}-${day}`;
}

export function dateFromKey(value: string): Date {
  const [year = "0", month = "1", day = "1"] = value.split("-");

  return new Date(Number(year), Number(month) - 1, Number(day));
}

export function scheduledDateKey(value: string): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? "" : dateKey(date);
}

export function formatMonth(value: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric"
  }).format(value);
}

export function formatSelectedDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  }).format(dateFromKey(value));
}

export function formatDateTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Invalid time";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

export function datetimeLocalValue(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);

  return local.toISOString().slice(0, 16);
}

export function datetimeLocalToIso(value: string): string {
  // Preserve Date's local-time normalization, including DST gaps and overlaps.
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function sortScheduledPosts(posts: ScheduledPost[]) {
  return [...posts].sort((a, b) => {
    const statusRank = (post: ScheduledPost) =>
      post.status === "scheduled" || post.status === "publishing"
        ? 0
        : post.status === "failed"
          ? 1
          : 2;

    return statusRank(a) - statusRank(b) || Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor);
  });
}

export function groupPostsByDate(sortedPosts: ScheduledPost[]) {
  const grouped = new Map<string, ScheduledPost[]>();

  for (const post of sortedPosts) {
    const key = scheduledDateKey(post.scheduledFor);

    if (!key) {
      continue;
    }

    grouped.set(key, [...(grouped.get(key) || []), post]);
  }

  return grouped;
}

export function calendarDaysForMonth(
  visibleMonth: Date,
  selectedDateKey: string,
  postsByDate: Map<string, ScheduledPost[]>,
  today: Date
) {
  const first = startOfMonth(visibleMonth);
  const start = new Date(first);

  start.setDate(first.getDate() - first.getDay());

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);

    date.setDate(start.getDate() + index);

    const key = dateKey(date);
    const dayPosts = postsByDate.get(key) || [];

    return {
      date,
      key,
      posts: dayPosts,
      isCurrentMonth: date.getMonth() === visibleMonth.getMonth(),
      isSelected: key === selectedDateKey,
      isToday: key === dateKey(today)
    };
  });
}
