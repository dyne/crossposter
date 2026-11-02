import { getConfigValue } from "@/lib/local-config";
import { publicationConfig } from "@/lib/publishing/config-context";

export function requireEnv(name: string, profileId?: string): string {
  const value = optionalEnv(name, profileId);

  if (!value) {
    throw new Error(`Missing ${name}`);
  }

  return value;
}

export function optionalEnv(name: string, profileId?: string): string | undefined {
  const exact = publicationConfig();
  return exact ? exact[name] || undefined : getConfigValue(name, profileId);
}
