import { controlRead } from "@/lib/control/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return controlRead(request, "get_draft"); }
