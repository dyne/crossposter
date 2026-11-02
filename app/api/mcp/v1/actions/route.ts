import { controlAction } from "@/lib/control/action-http";

export const runtime = "nodejs";
export async function POST(request: Request) { return controlAction(request, "prepare_action"); }
