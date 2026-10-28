export type ProgressPlacement = "top" | "bottom";

export { formatLimitBytes as formatBytes } from "@/lib/platform-limits";

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }

  if (!error || typeof error !== "object") {
    return false;
  }

  return "name" in error && (error as { name?: unknown }).name === "AbortError";
}

export function formatDateTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Saved locally";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

export function datetimeLocalValue(date = new Date(Date.now() + 30 * 60 * 1000)): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);

  return local.toISOString().slice(0, 16);
}

export function datetimeLocalToIso(value: string): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function datetimeDatePart(value: string): string {
  return value.split("T")[0] || "";
}

export function datetimeTimePart(value: string): string {
  return value.split("T")[1] || "";
}

export function mergeDateTimeParts(current: string, part: "date" | "time", value: string): string {
  const date = part === "date" ? value : datetimeDatePart(current) || datetimeDatePart(datetimeLocalValue());
  const time = part === "time" ? value : datetimeTimePart(current) || datetimeTimePart(datetimeLocalValue());

  return `${date}T${time}`;
}

export function tomorrowMorning(): Date {
  const date = new Date();

  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);

  return date;
}

export function futureScheduleValue(value: string): string {
  const iso = datetimeLocalToIso(value);

  return iso && Date.parse(iso) >= Date.now() - 60_000 ? value : datetimeLocalValue();
}
