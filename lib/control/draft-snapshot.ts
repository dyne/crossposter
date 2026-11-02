import type { ControlMedia } from "./contracts";
import { payloadDigest } from "./canonical";
import { ControlError } from "./errors";
import { projectControlConfig, projectControlDraft } from "./read-projections";
import type { ControlReadConfig } from "./read-storage";

export type DraftReadDependencies = {
  readConfig: () => ControlReadConfig;
  readMedia: (id: string) => Promise<ControlMedia>;
  // Draft adapters bind both existing files and explicit missing-file states.
  // Publication preparation continues to use the strict media probe.
  mediaRevision: (id: string) => string;
  environmentValue: (field: string) => string | undefined;
};

export async function readControlDraftSnapshot(deps: DraftReadDependencies) {
  const config = deps.readConfig();
  const dto = projectControlConfig(config, deps.environmentValue);
  const configRevision = payloadDigest(config);
  const targetRevision = payloadDigest(dto.targets);
  const id = config.draft.media?.id;
  const mediaRevision = id ? deps.mediaRevision(id) : null;
  let media: ControlMedia | null = null;
  if (id) {
    try { media = await deps.readMedia(id); }
    catch (error) {
      if (!(error instanceof ControlError) || error.code !== "media_missing") throw error;
    }
  }
  const assertUnchanged = () => {
    const current = deps.readConfig();
    if (payloadDigest(current) !== configRevision
      || payloadDigest(projectControlConfig(current, deps.environmentValue).targets) !== targetRevision
      || (id && deps.mediaRevision(id) !== mediaRevision)) throw new ControlError("revision_conflict");
  };
  assertUnchanged();
  return { config, dto, media, assertUnchanged,
    draft: projectControlDraft(config, dto, media?.digest ?? null,
      { allowMissingTargets: true, ...(id && !media ? { missingMediaRevision: mediaRevision! } : {}) }) };
}
