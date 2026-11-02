import { ownerSession } from "@/lib/control/approval-http";

export const runtime = "nodejs";
export async function GET(request: Request) { return ownerSession(request, "read"); }
export async function POST(request: Request) { return ownerSession(request, "login"); }
export async function DELETE(request: Request) { return ownerSession(request, "logout"); }
