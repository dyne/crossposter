import { controlRead } from "@/lib/control/http";
import { controlDraft } from "@/lib/control/draft-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return controlRead(request, "get_draft"); }
export function PUT(request: Request) { return controlDraft(request, "save_draft"); }
export function DELETE(request: Request) { return controlDraft(request, "clear_draft"); }
