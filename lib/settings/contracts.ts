import type { ConfigField } from "@/lib/config-spec";
import type { Platform, ProviderProfile } from "@/lib/types";

export type { ProviderProfile } from "@/lib/types";

export type SettingsConfiguration = {
  values: Record<string, string>;
  profiles: Partial<Record<Platform, ProviderProfile[]>>;
  activeProfiles: Partial<Record<Platform, string>>;
};

export type ConfigResponse = SettingsConfiguration & {
  fields: ConfigField[];
  configPath?: string;
  localUrl?: string;
};

export type StorageResponse = {
  uploads: {
    path: string;
    files: number;
    bytes: number;
  };
  config: {
    draftBytes: number;
    publishedPostsBytes: number;
    publishedPosts: number;
    scheduledPostsBytes: number;
    scheduledPosts: number;
  };
  totalBytes: number;
};

export type LocalServiceResponse = {
  supported: boolean;
  label: string;
  manager?: string;
  plistPath: string;
  installed: boolean;
  legacyServiceInstalled?: boolean;
  running: boolean;
  port: string;
  error?: string;
};

export type TailscaleResponse = {
  configuredHost: string;
  detectedIp: string;
  error: string;
  host: string;
  installed: boolean;
  port: string;
  running: boolean;
  url: string;
};

export type AppVersionResponse = {
  packageName: string;
  currentVersion: string;
  latestVersion: string;
  latestError: string;
  updateAvailable: boolean;
  autoUpdate: boolean;
  managedByHomebrew: boolean;
  installSource: string;
  appRoot: string;
  dataRoot: string;
  updateCommand: string;
  ok?: boolean;
  method?: string;
  requiresRestart?: boolean;
  message?: string;
};

export type BrowserStorageStats = {
  bytes: number;
  files: number;
  draftBytes: number;
  mediaBytes: number;
};

export type SettingsView = "settings" | "storage" | "socials";
