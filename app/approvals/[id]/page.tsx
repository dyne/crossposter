import type { Metadata } from "next";
import { ApprovalPage } from "@/components/approvals/approval-page";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Review action · Crossposter", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default async function OwnerApproval({ params }: { params: Promise<{ id: string }> }) {
  return <ApprovalPage actionId={(await params).id} />;
}
