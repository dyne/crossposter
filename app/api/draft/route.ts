import { NextResponse } from "next/server";
import { emptyComposeDraft, readLocalConfig, writeLocalConfig } from "@/lib/local-config";
import type { ComposeDraft } from "@/lib/types";
import { replaceComposerDraft } from "@/lib/draft-store";
import { composerDraftRevision } from "@/lib/storage/draft-service";
import { getUploadedMedia } from "@/lib/media-store";
import { controlEnabled } from "@/lib/control/backend-mutation";
import { dataRoot } from "@/lib/runtime-paths";
import { ControlError } from "@/lib/control/errors";
import { readControlMedia, controlMediaRevision } from "@/lib/control/read-storage";
import { dashboardOutcomeRecords, publicationOutcomeView } from "@/lib/control/outcome-projection";

export const runtime = "nodejs";

export function GET() {
  const localConfig = readLocalConfig();
  const records = dashboardOutcomeRecords();

  return NextResponse.json({
    draft: localConfig.draft,
    revision: composerDraftRevision(localConfig.draft),
    publishedPosts: localConfig.publishedPosts.map((post) => publicationOutcomeView(post, records))
  });
}

export async function PUT(request: Request) {
  const body = (await request.json()) as { draft?: Partial<ComposeDraft>; expectedRevision?: string };
  const localConfig = readLocalConfig();
  const initialRevision = composerDraftRevision(localConfig.draft);
  const controlled = controlEnabled(dataRoot());
  if ((controlled && body.expectedRevision === undefined)
    || (body.expectedRevision !== undefined && typeof body.expectedRevision !== "string")) {
    return NextResponse.json({ error: "Reload the draft before saving.", code: "revision_conflict" }, { status: 409 });
  }
  try {
    // Only an ID selects stored media. Caller paths/type/size/URL never become
    // authoritative metadata.
    const id = body.draft?.media?.id;
    const version = controlled && id ? controlMediaRevision(dataRoot(), id) : null;
    const media = id ? controlled ? await readControlMedia(dataRoot(), id) : await getUploadedMedia(id, request.url) : null;
    if (version && controlMediaRevision(dataRoot(), id!) !== version) throw new ControlError("revision_conflict");
    const saved = replaceComposerDraft({ ...emptyComposeDraft, ...body.draft,
      media: media ? { id: media.id, filename: media.filename, contentType: media.contentType,
        size: media.size, kind: media.kind, url: `/api/media/${media.id}` } : undefined
    }, body.expectedRevision ?? initialRevision);
    return NextResponse.json({ draft: saved.draft, publishedPosts: saved.publishedPosts, revision: composerDraftRevision(saved.draft) });
  } catch (error) {
    if (error instanceof ControlError && error.code === "revision_conflict") {
      return NextResponse.json({ error: "Draft changed elsewhere. Reload before saving; your edits remain in this browser.", code: "revision_conflict" }, { status: 409 });
    }
    throw error;
  }
}

export function DELETE(request: Request) {
  const scope = new URL(request.url).searchParams.get("scope");
  if (scope === "draft") {
    const expected = request.headers.get("if-match");
    if (controlEnabled(dataRoot()) && !expected) return NextResponse.json({ error: "Reload the draft before clearing.", code: "revision_conflict" }, { status: 409 });
    try {
      const saved = replaceComposerDraft(emptyComposeDraft, expected ?? undefined);
      return NextResponse.json({ draft: saved.draft, publishedPosts: saved.publishedPosts, revision: composerDraftRevision(saved.draft) });
    } catch (error) {
      if (error instanceof ControlError && error.code === "revision_conflict") return NextResponse.json({ error: "Draft changed elsewhere. Reload before clearing.", code: "revision_conflict" }, { status: 409 });
      throw error;
    }
  }
  const localConfig = readLocalConfig();
  const saved = writeLocalConfig({
    ...localConfig,
    ...(scope === "history" ? { publishedPosts: [] } : {}),
  });

  return NextResponse.json({
    draft: saved.draft,
    revision: composerDraftRevision(saved.draft),
    publishedPosts: saved.publishedPosts
  });
}
