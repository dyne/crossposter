import "server-only";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod-control";
import { actionSchema, digestSchema, idSchema, timestampSchema } from "./contracts";
import { payloadDigest } from "./canonical";
import { ControlError } from "./errors";
import type { BackendOwner } from "./backend-ownership";
import { replaceDurableJson, type DurableFileIO } from "../storage/durable-json";
import { maxJsonStorageBytes, serializeStoredJson } from "../storage/json-limits";

const recordSchema = z.strictObject({
  requestKey: z.string().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/),
  inputDigest: digestSchema,
  action: actionSchema,
  ownerDecision: z.strictObject({ actionId: idSchema, payloadDigest: digestSchema,
    preparationRevision: digestSchema, expiresAt: timestampSchema,
    decision: z.enum(["approve", "reject"]), decidedAt: timestampSchema }).optional(),
  // Backend-private publication configuration/session bindings, or the retained
  // queue snapshot for cancellation. Never returned by routes.
  accountBindings: z.record(z.string(), digestSchema),
  scheduleBinding: digestSchema.optional(),
  queueIntent: z.strictObject({ beforeDigest: digestSchema.nullable(), createdAt: timestampSchema,
    updatedAt: timestampSchema, attempts: z.number().int().nonnegative(), publishedPostId: idSchema.optional(), supersedes: idSchema.optional() }).optional()
});
const journalSchema = z.strictObject({ version: z.literal(1), records: z.array(recordSchema) });
export type ActionRecord = z.infer<typeof recordSchema>;
export type StoredAction = ActionRecord["action"];
export const actionJournalFilename = ".poster-actions.json";
const anchorFilename = ".poster-actions.anchor.json";
// Accepted schedules retain their authorization when due. Their later dispatch
// updates this same record; final outcomes cannot return to an executable state.
const transitions: Partial<Record<StoredAction["state"], readonly StoredAction["state"][]>> = {
  prepared: ["approved", "rejected", "expired", "conflicting"],
  approved: ["executing", "expired", "conflicting"],
  executing: ["executing", "scheduled", "rescheduled", "canceled", "expired", "conflicting", "succeeded", "partial", "failed", "uncertain"],
  scheduled: ["executing", "canceled", "conflicting"],
  rescheduled: ["executing", "canceled", "conflicting"]
};

export function actionRevision(action: Omit<StoredAction, "revision"> | StoredAction): string {
  const value: Partial<StoredAction> = { ...action };
  delete value.revision;
  return payloadDigest(value);
}

function parseJournal(value: unknown) {
  const parsed = journalSchema.safeParse(value);
  if (!parsed.success) throw new ControlError("storage_corrupt");
  const records = parsed.data.records;
  if (new Set(records.map((record) => record.requestKey)).size !== records.length
    || new Set(records.map((record) => record.action.id)).size !== records.length) throw new ControlError("storage_corrupt");
  for (const { action, accountBindings, ownerDecision } of records) {
    if (payloadDigest(action.payload) !== action.payloadDigest || actionRevision(action) !== action.revision
      || action.approvalUrl !== `/approvals/${action.id}`
      || action.outcomes.length !== action.payload.targets.length
      || new Set(action.payload.targets.map((target) => target.id)).size !== action.payload.targets.length
      || Object.keys(accountBindings).length !== action.payload.targets.length
      || action.payload.targets.some((target, index) => payloadDigest(action.outcomes[index].target)
        !== payloadDigest({ id: target.id, platform: target.platform, profileId: target.profileId, label: target.label })
        || !Object.hasOwn(accountBindings, target.id))) throw new ControlError("storage_corrupt");
    if (ownerDecision && (ownerDecision.actionId !== action.id || ownerDecision.payloadDigest !== action.payloadDigest
      || ownerDecision.expiresAt !== action.expiresAt || Date.parse(ownerDecision.decidedAt) < Date.parse(action.createdAt)
      || Date.parse(ownerDecision.decidedAt) >= Date.parse(action.expiresAt) || action.state === "prepared"
      || (ownerDecision.decision === "reject" && action.state !== "rejected")
      || (ownerDecision.decision === "approve" && action.state === "rejected"))) throw new ControlError("storage_corrupt");
    if (!["prepared", "expired", "conflicting"].includes(action.state) && !ownerDecision) throw new ControlError("storage_corrupt");
  }
  if (records.some((record) => record.queueIntent && (record.action.payload.mode === "publish" || !record.ownerDecision
    || !["executing", "scheduled", "rescheduled", "canceled", "expired", "conflicting", "succeeded", "partial", "failed", "uncertain"].includes(record.action.state)))) throw new ControlError("storage_corrupt");
  return parsed.data;
}

function readPrivateJson(filename: string, maxBytes: number): unknown {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > maxBytes
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new ControlError("storage_corrupt");
  try {
    const source = readFileSync(filename, "utf8");
    if (Buffer.byteLength(source, "utf8") > maxBytes) throw new ControlError("storage_corrupt");
    return JSON.parse(source);
  } catch (error) {
    if (error instanceof ControlError) throw error;
    if (error instanceof SyntaxError) throw new ControlError("storage_corrupt");
    // Disappearance after the successful stat is a failed read, not an empty store.
    throw new ControlError("storage_unavailable");
  }
}
function hasAnchor(root: string, maxBytes: number): boolean {
  try {
    const marker = z.strictObject({ version: z.literal(1) }).safeParse(readPrivateJson(path.join(root, anchorFilename), maxBytes));
    if (!marker.success) throw new ControlError("storage_corrupt");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error instanceof ControlError ? error : new ControlError("storage_unavailable");
  }
}

export function readActionJournal(root: string, maxBytes = maxJsonStorageBytes) {
  const anchored = hasAnchor(root, maxBytes);
  try {
    const journal = parseJournal(readPrivateJson(path.join(root, actionJournalFilename), maxBytes));
    if (journal.records.length && !anchored) throw new ControlError("storage_corrupt");
    return journal;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      if (anchored) throw new ControlError("storage_corrupt");
      return { version: 1 as const, records: [] as ActionRecord[] };
    }
    throw error instanceof ControlError ? error : new ControlError("storage_unavailable");
  }
}

export function createActionStore(root: string, owner: BackendOwner, io?: DurableFileIO, maxBytes = maxJsonStorageBytes) {
  return {
    read: () => readActionJournal(root, maxBytes).records,
    // Synchronous read/check/replace is serialized by the sole backend. No await
    // may separate the check from replacement; callers recheck after async IO.
    save(record: ActionRecord, expectedRevision: string | null): ActionRecord {
      owner.assert();
      if (realpathSync(root) !== owner.root) throw new ControlError("ownership_conflict");
      const journal = readActionJournal(root, maxBytes);
      const existing = journal.records.find((item) => item.requestKey === record.requestKey || item.action.id === record.action.id);
      if (existing) {
        if (existing.requestKey !== record.requestKey || existing.inputDigest !== record.inputDigest) throw new ControlError("idempotency_conflict");
        if (expectedRevision === null) return existing;
        if (existing.action.revision !== expectedRevision) throw new ControlError("revision_conflict");
        if (existing.ownerDecision ? payloadDigest(existing.ownerDecision) !== payloadDigest(record.ownerDecision ?? null)
          : record.ownerDecision && (existing.action.state !== "prepared"
            || record.ownerDecision.preparationRevision !== existing.action.revision
            || record.action.state !== (record.ownerDecision.decision === "approve" ? "approved" : "rejected"))) throw new ControlError("action_conflict");
        if (existing.queueIntent ? payloadDigest(existing.queueIntent) !== payloadDigest(record.queueIntent ?? null)
          : record.queueIntent && (existing.action.state !== "approved" || record.action.state !== "executing")) throw new ControlError("action_conflict");
        if (existing.scheduleBinding !== record.scheduleBinding) throw new ControlError("action_conflict");
        if (existing.action.id !== record.action.id || !transitions[existing.action.state]?.includes(record.action.state)
          || payloadDigest(existing.action.payload) !== payloadDigest(record.action.payload)
          || payloadDigest(existing.accountBindings) !== payloadDigest(record.accountBindings)
          || existing.action.createdAt !== record.action.createdAt || existing.action.expiresAt !== record.action.expiresAt
          || existing.action.approvalUrl !== record.action.approvalUrl || existing.action.timezone !== record.action.timezone
          || existing.action.scheduledLocal !== record.action.scheduledLocal
          || (existing.action.scheduleId !== null && existing.action.scheduleId !== record.action.scheduleId)
          || (existing.action.postId !== null && existing.action.postId !== record.action.postId)
          || payloadDigest(existing.action.warnings) !== payloadDigest(record.action.warnings)) throw new ControlError("action_conflict");
      } else if (expectedRevision !== null || record.action.state !== "prepared") throw new ControlError("action_conflict");
      const next = parseJournal({ version: 1, records: existing
        ? journal.records.map((item) => item === existing ? record : item) : [...journal.records, record] });
      owner.assert();
      try {
        // Preflight the whole next journal before first-initialization effects,
        // including the exact UTF-8 encoding/newline used by atomic replacement.
        serializeStoredJson(next, maxBytes);
        if (!hasAnchor(root, maxBytes)) {
          // The durable marker precedes the first retained action. Afterward a
          // missing journal fails closed, including after a clean backend restart.
          replaceDurableJson(path.join(root, actionJournalFilename), journal, io, maxBytes);
          replaceDurableJson(path.join(root, anchorFilename), { version: 1 }, io, maxBytes);
        }
        replaceDurableJson(path.join(root, actionJournalFilename), next, io, maxBytes);
      }
      catch { throw new ControlError("storage_unavailable"); }
      return next.records.find((item) => item.action.id === record.action.id)!;
    }
  };
}
