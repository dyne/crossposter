import { controlCommit } from "@/lib/control/execution-http";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ actionId: string }> }) {
  return controlCommit(request, (await context.params).actionId);
}
