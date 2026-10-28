import "server-only";
import { randomUUID } from "node:crypto";
import { dataRoot } from "@/lib/runtime-paths";
import { createLocalConfigStore } from "@/lib/storage/config-store";
import { createJsonConfigStorage } from "@/lib/storage/json-storage";

export type { LocalConfigFile, LocalConfigValues } from "@/lib/storage/config-codec";
export type { ProviderProfile } from "@/lib/types";
export { emptyComposeDraft } from "@/lib/storage/content-codec";
export { isPlaceholderValue } from "@/lib/config-validation";

const storage = createJsonConfigStorage(dataRoot());
export const localConfigPath = storage.path;
export const {
  readLocalConfig,
  writeLocalConfig,
  appendPublishedPost,
  getScheduledPosts,
  upsertScheduledPost,
  updateScheduledPost,
  removeScheduledPost,
  getConfigValue,
  getProfileConfigIssues
} = createLocalConfigStore(
  storage,
  { createId: randomUUID, now: () => new Date().toISOString() },
  (name) => process.env[name]
);
