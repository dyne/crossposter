import { createPublishRequestSchema, type ConfigValueLookup } from "@/lib/publishing/contracts";
import type { PublishTarget } from "@/lib/types";
import type { ControlContent } from "./contracts";

// Structural tool validation cannot determine platform rules from opaque IDs.
// Apply the established rules separately to every server-resolved account, so
// the incumbent first-platform limit shortcut cannot skip a second profile.
export function validateResolvedContent(
  content: ControlContent, targets: PublishTarget[], getConfigValue: ConfigValueLookup
): { valid: boolean } {
  if (!targets.length) return { valid: false };
  const schema = createPublishRequestSchema(getConfigValue);
  return { valid: targets.every((target) => schema.safeParse({
    title: content.title, text: content.text, linkUrl: content.linkUrl,
    ...(content.mediaId ? { mediaId: content.mediaId } : {}), targets: [target]
  }).success) };
}
