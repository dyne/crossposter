import type { PublishResult, ScheduledPost } from "@/lib/types";

export function resultStatusClass(result: PublishResult): "ok" | "unknown" | "err" {
  return result.ok ? "ok" : result.uncertain ? "unknown" : "err";
}

export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function statusLabel(post: ScheduledPost): string {
  if (post.status === "scheduled") {
    return Date.parse(post.scheduledFor) <= Date.now() ? "due now" : "scheduled";
  }

  return post.status;
}

export function apiError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    const record = error as { formErrors?: string[] };

    if (record.formErrors?.length) {
      return record.formErrors.join(" ");
    }
  }

  return "Could not update the scheduler.";
}
