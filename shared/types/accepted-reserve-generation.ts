import { z } from "zod";
import { LiveReserveSnapshotMetadataSchema } from "./live-reserves";
import { LIVE_RESERVE_EVIDENCE_CLASS_VALUES, LIVE_RESERVE_SOURCE_MODEL_VALUES, LIVE_RESERVE_WARNING_EFFECT_VALUES } from "./live-reserve-core";

export const AcceptedReserveSnapshotSchema = z.object({
  stablecoinId: z.string().min(1),
  fetchedAt: z.number().int().positive(),
  attemptId: z.string().min(1).nullable(),
  source: z.string(),
  metadata: LiveReserveSnapshotMetadataSchema,
  warnings: z.array(z.object({ code: z.string(), message: z.string(), severity: z.enum(["info", "warning"]), effect: z.enum(LIVE_RESERVE_WARNING_EFFECT_VALUES) }).strict()),
  warningCount: z.number().int().nonnegative(),
  adapterSourceModel: z.enum(LIVE_RESERVE_SOURCE_MODEL_VALUES),
  adapterEvidenceClass: z.enum(LIVE_RESERVE_EVIDENCE_CLASS_VALUES),
  configFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sliceCount: z.number().int().nonnegative(),
  lastSuccessAt: z.number().int().positive().nullable(),
  lastSuccessAttemptId: z.string().min(1).nullable(),
}).strict();
export type AcceptedReserveSnapshot = z.output<typeof AcceptedReserveSnapshotSchema>;

export const AcceptedReserveGenerationSchema = z.object({
  schemaVersion: z.literal(2),
  generationId: z.string().min(1),
  root: z.object({ scheduleKey: z.literal("fourHourlyReserveSync"), slotStartedAt: z.number().int().positive(), queueHash: z.string().min(1) }).strict(),
  sealedBy: z.object({ attemptNo: z.number().int().positive(), executionGeneration: z.number().int().positive(), invocationId: z.string().min(1) }).strict(),
  producerCompletedAtSec: z.number().int().positive(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  members: z.array(z.object({
    stablecoinId: z.string().min(1),
    snapshot: AcceptedReserveSnapshotSchema.nullable(),
    latestAttempt: z.object({ attemptId: z.string().nullable(), attemptedAt: z.number().int().nullable(), status: z.enum(["ok", "degraded", "error", "skipped"]).nullable() }).strict(),
  }).strict()),
}).strict().superRefine((value, ctx) => {
  if (value.generationId !== `reserve:${value.root.slotStartedAt}:${value.root.queueHash}`) ctx.addIssue({ code: "custom", message: "Reserve root identity mismatch" });
  if (new Set(value.members.map((member) => member.stablecoinId)).size !== value.members.length || value.members.some((member) => member.snapshot && member.snapshot.stablecoinId !== member.stablecoinId)) ctx.addIssue({ code: "custom", message: "Reserve member identity mismatch" });
});
export type AcceptedReserveGeneration = z.output<typeof AcceptedReserveGenerationSchema>;

export { RedemptionReserveRunMetadataSchema } from "./reserve-input";
export type { ConsumedReserveInput } from "./reserve-input";
