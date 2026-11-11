import { NextResponse } from "next/server";
import { z } from "zod";
import { getScheduledPosts, removeScheduledPost, updateScheduledPost } from "@/lib/local-config";
import { requestOrigin } from "@/lib/request-origin";
import { ensureSchedulerStarted } from "@/lib/scheduler";
import { findScheduledPost, scheduledQueue } from "@/lib/scheduling/queries";
import { scheduledClaimRevision } from "@/lib/scheduling/policy";
import { rescheduleBinding } from "@/lib/control/reschedule-policy";
import { readActionJournal } from "@/lib/control/action-store";
import { dataRoot } from "@/lib/runtime-paths";

export const runtime = "nodejs";

const patchSchema = z.object({
  scheduledFor: z.string().min(1).max(80)
});

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const current = findScheduledPost(getScheduledPosts(), id);

  if (!current) {
    return NextResponse.json({ error: "Scheduled post was not found" }, { status: 404 });
  }

  const evidence = rescheduleBinding(current, readActionJournal(dataRoot()).records);
  if (!evidence) {
    return NextResponse.json(
      { error: "This scheduled post can no longer be rescheduled." },
      { status: 400 }
    );
  }
  // An old approval freezes its original timing. A safe new time still needs
  // a fresh control preparation and independent owner approval.
  if (current.authorization) {
    return NextResponse.json(
      { error: "Prepare a new reschedule and obtain owner approval to change this approved schedule." },
      { status: 400 }
    );
  }

  const parsed = patchSchema.safeParse(await request.json());

  if (!parsed.success || !Number.isFinite(Date.parse(parsed.data.scheduledFor))) {
    return NextResponse.json({ error: "Choose a valid scheduled time." }, { status: 400 });
  }

  const scheduledAt = Date.parse(parsed.data.scheduledFor);

  if (scheduledAt < Date.now() - 60_000) {
    return NextResponse.json({ error: "Choose a scheduled time in the future." }, { status: 400 });
  }

  const conflict = Symbol("changed schedule");
  let updated;
  try {
    updated = updateScheduledPost(id, (post) => {
      if (scheduledClaimRevision(post) !== scheduledClaimRevision(current)
        || rescheduleBinding(post, readActionJournal(dataRoot()).records) !== evidence) throw conflict;
      return { ...post, scheduledFor: new Date(scheduledAt).toISOString(), updatedAt: new Date().toISOString(), status: "scheduled" };
    });
  } catch (error) {
    if (error !== conflict) throw error;
    return NextResponse.json({ error: "This scheduled post can no longer be rescheduled." }, { status: 400 });
  }
  if (!updated) return NextResponse.json({ error: "Scheduled post was not found" }, { status: 404 });

  ensureSchedulerStarted(new URL("/api/scheduled/tick", requestOrigin(request)).toString());

  return NextResponse.json({
    scheduledPost: updated,
    scheduledPosts: scheduledQueue(getScheduledPosts())
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const current = findScheduledPost(getScheduledPosts(), id);

  if (!current) {
    return NextResponse.json({ error: "Scheduled post was not found" }, { status: 404 });
  }

  if (current.status === "publishing" || current.status === "published") {
    return NextResponse.json(
      { error: "This scheduled post can no longer be discarded." },
      { status: 400 }
    );
  }

  return NextResponse.json({
    scheduledPost: current,
    scheduledPosts: scheduledQueue(removeScheduledPost(id))
  });
}
