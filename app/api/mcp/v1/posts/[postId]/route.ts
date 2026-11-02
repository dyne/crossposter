import { controlRead } from "@/lib/control/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ postId: string }> }) {
  return controlRead(request, "get_post", await context.params);
}
