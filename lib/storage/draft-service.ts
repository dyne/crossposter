import type { ComposeDraft } from "@/lib/types";
import type { LocalConfigFile } from "./config-codec";
import { normalizeComposeDraft } from "./content-codec";
import { payloadDigest } from "@/lib/control/canonical";
import { ControlError } from "@/lib/control/errors";

// Dashboard concurrency token. Control's public revision additionally binds
// resolved targets and actual media bytes; both adapters replace this same draft.
export function composerDraftRevision(draft: Omit<Partial<ComposeDraft>, "media"> & { media?: { id: string } }): string {
  const value = normalizeComposeDraft(draft);
  return payloadDigest({ title: value.title, text: value.text, linkUrl: value.linkUrl,
    platforms: value.platforms, targets: value.targets ?? [], mediaId: draft.media?.id ?? null,
    updatedAt: value.updatedAt ?? null });
}

export function createDraftService(deps: {
  readConfig: () => LocalConfigFile;
  writeConfig: (config: LocalConfigFile) => LocalConfigFile;
  now: () => Date;
}) {
  return {
    replace(draft: Partial<ComposeDraft>, expectedRevision?: string) {
      // No await between this revision check and the incumbent synchronous
      // storage write. Read again here to preserve unrelated history/queue edits.
      const config = deps.readConfig();
      if (expectedRevision !== undefined && composerDraftRevision(config.draft) !== expectedRevision) {
        throw new ControlError("revision_conflict");
      }
      const previous = Date.parse(config.draft.updatedAt ?? "");
      const updatedAt = new Date(Math.max(deps.now().getTime(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
      return deps.writeConfig({ ...config, draft: normalizeComposeDraft({ ...draft, updatedAt }) });
    }
  };
}
