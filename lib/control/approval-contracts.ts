import { z } from "zod-control";
import { digestSchema, timestampSchema } from "./contracts";

// Browser-only contracts. These are deliberately absent from the MCP catalog.
export const ownerLoginSchema = z.strictObject({ password: z.string().min(1).max(1024) });
export const ownerDecisionInputSchema = z.strictObject({
  decision: z.enum(["approve", "reject"]), expectedDigest: digestSchema,
  expectedRevision: digestSchema, expiresAt: timestampSchema
});
export type OwnerDecisionInput = z.infer<typeof ownerDecisionInputSchema>;
