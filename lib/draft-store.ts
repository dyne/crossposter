import "server-only";
import { readLocalConfig, writeLocalConfig } from "./local-config";
import { createDraftService } from "./storage/draft-service";

export const { replace: replaceComposerDraft } = createDraftService({
  readConfig: readLocalConfig, writeConfig: writeLocalConfig, now: () => new Date()
});
