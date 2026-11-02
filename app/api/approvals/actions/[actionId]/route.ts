import { ownerAction } from "@/lib/control/approval-http";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ actionId: string }> }) {
  return ownerAction(request, (await context.params).actionId, "read");
}
export async function POST(request: Request, context: { params: Promise<{ actionId: string }> }) {
  return ownerAction(request, (await context.params).actionId, "decide");
}
