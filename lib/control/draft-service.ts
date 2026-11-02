import type { ComposeDraft } from "@/lib/types";
import { normalizeComposeDraft } from "@/lib/storage/content-codec";
import { composerDraftRevision } from "@/lib/storage/draft-service";
import { controlTools } from "./contracts";
import { ControlError } from "./errors";
import { projectControlConfig, projectControlDraft } from "./read-projections";
import { readControlDraftSnapshot, type DraftReadDependencies } from "./draft-snapshot";

export type DraftDependencies = DraftReadDependencies & {
  replaceDraft: (draft: ComposeDraft, expectedStorageRevision: string) => void;
  assertMutation: () => void;
};

export function createControlDraftService(deps: DraftDependencies) {
  return {
    async mutate(name: "save_draft" | "clear_draft", input: unknown) {
      const parsed = name === "save_draft" ? controlTools.save_draft.inputSchema.safeParse(input)
        : controlTools.clear_draft.inputSchema.safeParse(input);
      if (!parsed.success) throw new ControlError("validation_failed");
      deps.assertMutation();
      const snapshot = await readControlDraftSnapshot(deps);
      const { config, dto } = snapshot;
      const incoming = name === "save_draft" ? controlTools.save_draft.inputSchema.parse(input) : null;
      const selected = incoming?.targetIds.map((id) => {
        const target = dto.targets.find((item) => item.id === id);
        if (!target) throw new ControlError("target_missing");
        return { id: target.id, platform: target.platform,
          ...(target.profileId ? { profileId: target.profileId } : {}), profileLabel: target.label };
      }) ?? [];
      const id = incoming?.content.mediaId;
      const version = id ? deps.mediaRevision(id) : null;
      // A new attachment remains strict, including reusing an unavailable old
      // ID. Clear or replacement can drop an unavailable incumbent attachment.
      const attached = id ? id === snapshot.media?.id ? snapshot.media : await deps.readMedia(id) : null;

      // Media hashing yields. A dashboard save, another control writer, changed
      // target/config, lost ownership or changed media must win before effects.
      deps.assertMutation();
      snapshot.assertUnchanged();
      if ((id && deps.mediaRevision(id) !== version) || snapshot.draft.revision !== parsed.data.expectedRevision) throw new ControlError("revision_conflict");
      const draft = normalizeComposeDraft(incoming ? {
        ...incoming.content, platforms: [...new Set(selected.map((target) => target.platform))], targets: selected,
        ...(attached ? { media: { id: attached.id, filename: attached.filename, contentType: attached.contentType,
          size: attached.size, kind: attached.kind, url: attached.url } } : {})
      } : {});
      deps.replaceDraft(draft, composerDraftRevision(config.draft));
      const saved = deps.readConfig();
      return projectControlDraft(saved, projectControlConfig(saved, deps.environmentValue), attached?.digest ?? null);
    }
  };
}
