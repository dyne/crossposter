import { controlUploadMedia } from "@/lib/control/media-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;
export function POST(request: Request) { return controlUploadMedia(request); }
