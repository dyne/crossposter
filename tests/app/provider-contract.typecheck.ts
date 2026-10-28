import type { Provider, ProviderRegistry } from "@/lib/providers";
import { providers } from "@/lib/providers";

// Compiled by npm run typecheck; these invalid registrations must remain errors.
export function checkProviderRegistration() {
  const { nostr, ...incomplete } = providers;
  void nostr;
  // @ts-expect-error Every platform, including Nostr, needs a provider.
  void (incomplete satisfies ProviderRegistry);
  // @ts-expect-error Unsupported provider IDs must not enter the registry.
  void ({ ...providers, unsupported: providers.nostr } satisfies ProviderRegistry);
  const invalidProvider = async () => ({ ok: true });
  // @ts-expect-error Provider outcomes must include the platform and message.
  void (invalidProvider satisfies Provider);
}
