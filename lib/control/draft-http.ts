import "server-only";
import { dataRoot } from "@/lib/runtime-paths";
import { replaceComposerDraft } from "@/lib/draft-store";
import { authenticateControl } from "./auth";
import { assertBackendMutation } from "./backend-mutation";
import { createControlDraftService } from "./draft-service";
import { ControlError } from "./errors";
import { controlFailure, controlSuccess, readControlJson } from "./http";
import { readControlConfig, readControlMedia, controlMediaRevision } from "./read-storage";

export async function controlDraft(request: Request, name: "save_draft" | "clear_draft") {
  try {
    const { canonicalRoot: root } = authenticateControl(request, dataRoot());
    if (new URL(request.url).searchParams.size) throw new ControlError("validation_failed");
    const service = createControlDraftService({
      readConfig: () => readControlConfig(root), replaceDraft: replaceComposerDraft,
      readMedia: (id) => readControlMedia(root, id), mediaRevision: (id) => controlMediaRevision(root, id, true),
      assertMutation: () => { if (!assertBackendMutation(root)) throw new ControlError("ownership_conflict"); },
      environmentValue: (name) => process.env[name]
    });
    return controlSuccess(name, await service.mutate(name, await readControlJson(request)));
  } catch (error) { return controlFailure(error); }
}
