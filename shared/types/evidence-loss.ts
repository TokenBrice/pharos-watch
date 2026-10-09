import { z } from "zod";
import { CanonicalKeySchema, CanonicalTextSchema, UnixSecondsSchema } from "@shared/types/safety-schema-primitives";

/** Evidence classification, independent of cron terminal status and Safety causes. */
export const EvidenceLossDispositionSchema = z.enum(["operational", "evidential", "semantic", "unknown"]);
export type EvidenceLossDisposition = z.output<typeof EvidenceLossDispositionSchema>;

export const OperationalEvidenceLossReasonSchema = z.enum([
  "transport", "timeout", "budget-deferred", "rate-limited", "provider-outage", "credential-missing",
]);

/** Bounded producer vocabulary keeps cron summaries bounded without truncating identities. */
export const EvidenceLossReasonSchema = CanonicalKeySchema.refine((reason) => reason.length <= 96, {
  message: "Evidence loss reasons must be at most 96 characters",
});
const EvidenceLossScopeSchema = z.object({
  assetId: CanonicalTextSchema,
  kind: z.enum(["route", "datum", "source-leg", "asset"]),
  key: CanonicalTextSchema,
}).strict();

/** Every entry is a required leg, including fallback/storage-readback legs when applicable. */
export const EvidenceLossLegSchema = z.object({
  key: CanonicalTextSchema,
  sourceId: CanonicalTextSchema,
  disposition: EvidenceLossDispositionSchema,
  reason: EvidenceLossReasonSchema,
  // An immutable producer packet/reference, not an exception message or cron status.
  proof: CanonicalTextSchema.nullable(),
}).strict().superRefine((leg, ctx) => {
  if (leg.disposition === "operational" && !OperationalEvidenceLossReasonSchema.safeParse(leg.reason).success) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: "Operational loss requires an operational machine reason" });
  }
});
export type EvidenceLossLeg = z.output<typeof EvidenceLossLegSchema>;

const PriorEvidenceSchema = z.object({
  ref: CanonicalTextSchema,
  observedAtSec: UnixSecondsSchema,
  expiresAtSec: UnixSecondsSchema,
}).strict().refine((prior) => prior.expiresAtSec > prior.observedAtSec, {
  path: ["expiresAtSec"], message: "Original evidence expiry must follow its observation",
});

export const EvidenceLossOutcomeSchema = z.object({
  scope: EvidenceLossScopeSchema,
  disposition: EvidenceLossDispositionSchema,
  reason: EvidenceLossReasonSchema,
  attemptId: CanonicalTextSchema.nullable(),
  runId: CanonicalTextSchema.nullable(),
  generationId: CanonicalTextSchema.nullable(),
  sourceId: CanonicalTextSchema.nullable(),
  observedAtSec: UnixSecondsSchema.nullable(),
  legs: z.array(EvidenceLossLegSchema),
  proof: CanonicalTextSchema.nullable(),
  priorEvidence: PriorEvidenceSchema.nullable(),
  // Pre-contract rows must be explicitly unknown; missing provenance is never backfilled.
  legacy: z.boolean(),
}).strict().superRefine((outcome, ctx) => {
  if (outcome.legacy) {
    if (outcome.disposition !== "unknown") {
      ctx.addIssue({ code: "custom", path: ["disposition"], message: "Legacy loss has unknown disposition" });
    }
  } else {
    for (const field of ["attemptId", "sourceId", "observedAtSec"] as const) {
      if (outcome[field] === null) ctx.addIssue({ code: "custom", path: [field], message: "Non-legacy loss requires observed attempt identity" });
    }
    if (outcome.runId === null && outcome.generationId === null) {
      ctx.addIssue({ code: "custom", path: ["runId"], message: "Non-legacy loss requires a run or generation identity" });
    }
  }
  if (outcome.disposition === "operational") {
    if (!OperationalEvidenceLossReasonSchema.safeParse(outcome.reason).success) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Operational loss requires an operational machine reason" });
    }
    if (outcome.proof === null || outcome.legs.length === 0 || outcome.legs.some((leg) => leg.disposition !== "operational" || leg.proof === null)) {
      ctx.addIssue({ code: "custom", path: ["disposition"], message: "Operational loss requires proof and complete operational required legs" });
    }
  }
});
export type EvidenceLossOutcome = z.output<typeof EvidenceLossOutcomeSchema>;
