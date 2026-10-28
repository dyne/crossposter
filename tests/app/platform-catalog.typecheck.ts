import { platformLabels } from "@/lib/platform-catalog";
import type { Platform } from "@/lib/types";

// Compiled by `npm run typecheck`; a missing or newly accepted key must fail.
export function checkExhaustivePlatformMaps() {
  const { nostr, ...missingPlatform } = platformLabels;
  void nostr;
  // @ts-expect-error An exhaustive map must include Nostr.
  void (missingPlatform satisfies Record<Platform, string>);
  // @ts-expect-error Unsupported platform keys must be rejected.
  void ({ ...platformLabels, unsupported: "Unsupported" } satisfies Record<Platform, string>);
}
