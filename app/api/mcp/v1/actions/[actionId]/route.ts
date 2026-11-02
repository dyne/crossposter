import { controlAction } from "@/lib/control/action-http";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ actionId: string }> }) {
  return controlAction(request, "get_action", await context.params);
}
