import "server-only";
import { randomUUID } from "node:crypto";
import {
  appendPublishedPost,
  getConfigValue,
  getProfileConfigIssues
} from "@/lib/local-config";
import { getUploadedMedia } from "@/lib/media-store";
import { providers } from "@/lib/providers";
import { createPublishService } from "@/lib/publishing/service";
import { assertBackendMutation } from "@/lib/control/backend-mutation";
import { dataRoot } from "@/lib/runtime-paths";

export type { PublishRunInput, PublishRunResult } from "@/lib/publishing/service";

export const runPublish = createPublishService({
  assertCanPublish: () => { assertBackendMutation(dataRoot()); },
  providers,
  getConfigValue,
  getProfileConfigIssues,
  getUploadedMedia,
  appendPublishedPost,
  now: () => new Date(),
  createId: randomUUID
});
