import type { ControlErrorCode } from "./contracts";

const messages: Record<ControlErrorCode, string> = {
  validation_failed: "Control request is invalid.", unauthorized: "Machine authentication is required.",
  forbidden: "Control requests require the configured loopback origin.", instance_mismatch: "Backend instance does not match.",
  target_missing: "A selected target no longer exists.", media_missing: "Stored media was not found.",
  post_missing: "Retained post was not found.", action_missing: "Action was not found.", schedule_missing: "Schedule was not found.",
  revision_conflict: "The saved revision changed.", cursor_invalid: "Pagination cursor is invalid.",
  cursor_stale: "The collection changed. Restart pagination.", approval_setup_required: "Owner approval must be configured locally.",
  approval_required: "Independent owner approval is required.", approval_expired: "Owner approval expired.",
  approval_rejected: "The owner rejected this action.", idempotency_conflict: "The request key already identifies different content.",
  action_conflict: "The action preconditions changed.", backend_unavailable: "The backend is unavailable.",
  storage_unavailable: "Local storage is unavailable.", storage_corrupt: "Local storage contains invalid data.",
  ownership_conflict: "Another backend owns this data root.", internal_error: "The control operation could not be completed."
};
export class ControlError extends Error {
  constructor(readonly code: ControlErrorCode) { super(messages[code]); }
}
export function publicError(error: unknown) {
  const code = error instanceof ControlError ? error.code : "internal_error";
  return { code, message: messages[code], retryable: code === "storage_unavailable" || code === "backend_unavailable" };
}
