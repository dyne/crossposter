import type { Platform, ProviderContext, PublishResult } from "@/lib/types";

/** One target/profile publish attempt. The service owns result annotations and history. */
export type Provider = (context: ProviderContext) => Promise<PublishResult>;

export type ProviderRegistry = Record<Platform, Provider>;
