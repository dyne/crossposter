import type { z } from "zod";
import type { createPublishRequestSchema, createScheduleRequestSchema } from "@/lib/publishing/contracts";

type PublishRequest = z.output<ReturnType<typeof createPublishRequestSchema>>;
type ScheduleRequest = z.output<ReturnType<typeof createScheduleRequestSchema>>;

// Keep composed outputs precise: shared validation must retain each route's fields.
export function checkRequestVariantTypes(publish: PublishRequest, schedule: ScheduleRequest) {
  const adminPassword: string | undefined = publish.adminPassword;
  const mediaUrl: string | undefined = publish.mediaUrl;
  const scheduledFor: string = schedule.scheduledFor;
  void [adminPassword, mediaUrl, scheduledFor];
  // @ts-expect-error Immediate requests strip the scheduling field.
  void publish.scheduledFor;
  // @ts-expect-error Scheduling requests strip the password field.
  void schedule.adminPassword;
  // @ts-expect-error Scheduling requests strip the public media URL field.
  void schedule.mediaUrl;
}
