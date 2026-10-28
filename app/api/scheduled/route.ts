import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createScheduleRequestSchema, defaultTargets, requestValidationMessage } from "@/lib/publishing/contracts";
import { getConfigValue, getScheduledPosts, upsertScheduledPost } from "@/lib/local-config";
import { getUploadedMedia } from "@/lib/media-store";
import { requestOrigin } from "@/lib/request-origin";
import { ensureSchedulerStarted, runScheduledTick } from "@/lib/scheduler";
import { scheduledQueue } from "@/lib/scheduling/queries";
import type { Platform, PublishedMedia, PublishTarget, ScheduledPost } from "@/lib/types";

export const runtime = "nodejs";

const requestSchema = createScheduleRequestSchema(getConfigValue);

function uniquePlatforms(targets: PublishTarget[]): Platform[] {
  return Array.from(new Set(targets.map((target) => target.platform)));
}

function mediaSummary(media: Awaited<ReturnType<typeof getUploadedMedia>>): PublishedMedia {
  return {
    id: media.id,
    filename: media.filename,
    contentType: media.contentType,
    size: media.size,
    kind: media.kind,
    url: media.url
  };
}

export async function GET(request: Request) {
  const tickUrl = new URL("/api/scheduled/tick", requestOrigin(request)).toString();

  ensureSchedulerStarted(tickUrl);
  await runScheduledTick(tickUrl);

  return NextResponse.json({
    scheduledPosts: scheduledQueue(getScheduledPosts())
  });
}

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ error: requestValidationMessage(parsed.error, "schedule") }, { status: 400 });
  }

  const scheduledAt = Date.parse(parsed.data.scheduledFor);

  if (scheduledAt < Date.now() - 60_000) {
    return NextResponse.json({ error: "Choose a scheduled time in the future." }, { status: 400 });
  }

  const targets = defaultTargets(parsed.data);
  const platforms = uniquePlatforms(targets);
  let media: PublishedMedia | undefined;

  if (parsed.data.mediaId) {
    try {
      media = mediaSummary(await getUploadedMedia(parsed.data.mediaId, requestOrigin(request)));
    } catch {
      return NextResponse.json({ error: "Uploaded media was not found" }, { status: 400 });
    }
  }

  const now = new Date().toISOString();
  const scheduledPost = upsertScheduledPost({
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    scheduledFor: new Date(scheduledAt).toISOString(),
    ...(parsed.data.title?.trim() ? { title: parsed.data.title.trim() } : {}),
    text: parsed.data.text.trim(),
    ...(parsed.data.linkUrl ? { linkUrl: parsed.data.linkUrl } : {}),
    platforms,
    targets,
    ...(media ? { media } : {}),
    status: "scheduled",
    attempts: 0
  } satisfies ScheduledPost);
  const tickUrl = new URL("/api/scheduled/tick", requestOrigin(request)).toString();

  ensureSchedulerStarted(tickUrl);

  return NextResponse.json({
    scheduledPost,
    scheduledPosts: scheduledQueue(getScheduledPosts())
  });
}
