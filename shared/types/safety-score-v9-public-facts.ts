import { z } from "zod";
import {
  V9CapSourceSchema,
  V9EvidenceLevelSchema,
  V9ReasonCodeSchema,
  type V9ReasonCode,
} from "./safety-score-v9";
import { compareText } from "./safety-score-v9-fact-primitives";
import { V9_ACCESS_POSTURE_FIELDS, V9_PUBLIC_EVIDENCE_RESPONSIBILITIES } from "./safety-score-v9-vocabulary";
import { V9AccessFreezeExposureSchema, V9AccessGovernanceSchema, V9AccessPostureFieldSchema } from "./safety-score-v9-vocabulary";
import { V9AccessPrimaryExitSchema, V9AccessTransferSchema } from "./safety-score-v9-vocabulary";

import { V9_GRADE_THRESHOLDS } from "./safety-score-v9-grade";
import { V9AccessLookthroughSummarySchema } from "./safety-score-v9-access-lookthrough";
import { causeGapRefs, V9EvidenceCauseSchema, V9PillarCauseShape, V9ScoringDispositionSchema } from "./safety-score-v9-public-causes";
import methodologyPolicy from "../data/safety-score-v9/methodology-policy-candidate-v1.json";

// Canonical ordering is a determinism-digest input; it has one definition.
import { BaseInputGenerationIdSchema, ScoreSchema, Sha256Schema } from "./safety-schema-primitives";
export { BaseInputGenerationIdSchema, ScoreSchema, Sha256Schema };
export const V9PolicyVersionSchema = z.string().regex(/^\d+\.\d+$/);
export const RESPONSIBILITIES = V9_PUBLIC_EVIDENCE_RESPONSIBILITIES;
export const SCORE_TOLERANCE = 0.0002;
export const EXIT_SCORE_TOLERANCE = 0.03;
export const PUBLIC_SCORE_ROUNDING_HEADROOM = 0.5;
export const V9_NEUTRAL_CONTROL_SCORE = 95;
// Validation-only mirrors of policy-owned values: these check published output rather than
// computing it, so they are deliberately NOT admitted to the policy digest — that would rotate it
// without changing any score. They should still be derived, because a validator that re-encodes a
// threshold can reject a correct publication once the policy moves.
const cMinusThreshold = V9_GRADE_THRESHOLDS.find(
  (threshold) => threshold.grade === "C-",
);
if (cMinusThreshold === undefined) {
  throw new Error("Safety Score v9 grade thresholds must include C-");
}
export const C_MINUS_MIN_SCORE = cMinusThreshold.min;
// Validation projects the policy authority without parsing a second policy envelope.
export const DANGER_PEG_MULTIPLIER_FLOOR =
  methodologyPolicy.semantic.formula.danger.adverseAttributionPegMultiplierFloor;
// C/U treatment is numeric unless the registered reason is diagnostic; the
// minimum-track-record exception remains a ceiling. Read the registry authority,
// not the retired evidence-cap classification, without importing shared/lib.
const V9_BOUNDED_ATTRIBUTION_REASON_CODES = methodologyPolicy.reasonRegistry
  .filter((reason) => reason.defaultTreatment !== "diagnostic" || reason.ceilingRule?.source === "minimum-track-record")
  .map((reason) => V9ReasonCodeSchema.parse(reason.code));
export const V9_BOUNDED_ATTRIBUTION_REASON_CODE_SET =
  new Set<V9ReasonCode>(V9_BOUNDED_ATTRIBUTION_REASON_CODES);


export function isUniqueSorted(values: readonly string[]): boolean {
  return (
    new Set(values).size === values.length && values.every((value, index) => index === 0 || values[index - 1]! < value)
  );
}

export function numbersAgree(left: number | null, right: number | null): boolean {
  return left === null || right === null ? left === right : Math.abs(left - right) <= SCORE_TOLERANCE;
}

export function roundAttributionValue(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(Number((value * factor).toPrecision(15))) / factor;
}

const SafetyScoreV9PublicReasonSchema = z
  .object({
    code: V9ReasonCodeSchema,
    message: z.string().min(1),
    path: z.string().min(1).nullable(),
    cause: V9EvidenceCauseSchema.nullable().optional(),
    causeGapRefs: causeGapRefs().optional(),
    scoringDisposition: V9ScoringDispositionSchema.optional(),
  })
  .strict();
export type SafetyScoreV9PublicReason = z.infer<typeof SafetyScoreV9PublicReasonSchema>;

export const SafetyScoreV9PublicReasonListSchema = z
  .array(SafetyScoreV9PublicReasonSchema)
  .superRefine((reasons, ctx) => {
    const identities = new Set<string>();
    reasons.forEach((reason, index) => {
      const identity = `${reason.code}\u0000${reason.path ?? ""}`;
      if (identities.has(identity)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: "V9 public reasons must have unique code/path identities",
        });
      }
      identities.add(identity);
    });
  });

export const SafetyScoreV9NrReasonSchema = z
  .object({
    code: V9ReasonCodeSchema,
    message: z.string().min(1),
    field: z.string().min(1).nullable(),
    origin: z.enum(["asset", "upstream"]),
    causes: z.array(V9EvidenceCauseSchema.extract(["C", "U", "D"])).optional(),
    causeGapRefs: causeGapRefs().optional(),
  })
  .strict();
export type SafetyScoreV9NrReason = z.infer<typeof SafetyScoreV9NrReasonSchema>;

const SafetyScoreV9FreshnessVerdictSchema = z.enum(["current", "stale", "unknown"]);
export const SafetyScoreV9FreshnessAssessmentSchema = z.object({
  verdict: SafetyScoreV9FreshnessVerdictSchema,
  assessedAtSec: z.number().int().nonnegative(),
  observedAtSec: z.number().int().nonnegative().nullable(),
  sourceGenerationId: z.string().min(1).nullable(),
  maxAgeSec: z.number().int().nonnegative().nullable(),
  reason: z.enum(["pillar-clock-unavailable", "source-unavailable", "source-generation-unavailable", "future-source-time"]).nullable(),
}).strict().superRefine((assessment, ctx) => {
  const { verdict, assessedAtSec, observedAtSec, sourceGenerationId, maxAgeSec, reason } = assessment;
  if (verdict === "unknown") {
    if (reason === null) ctx.addIssue({ code: "custom", path: ["reason"], message: "Unknown freshness requires a reason" });
    if (reason === "pillar-clock-unavailable" && (observedAtSec !== null || sourceGenerationId !== null || maxAgeSec !== null) ||
        reason === "source-unavailable" && (observedAtSec !== null || maxAgeSec === null) ||
        reason === "source-generation-unavailable" && (sourceGenerationId !== null || observedAtSec === null || maxAgeSec === null) ||
        reason === "future-source-time" && maxAgeSec === null) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Unknown freshness reason must match its unavailable operands" });
    }
    if (reason === "future-source-time" && (observedAtSec === null || observedAtSec <= assessedAtSec)) {
      ctx.addIssue({ code: "custom", path: ["observedAtSec"], message: "Future-source diagnosis requires a future observation" });
    }
    if (observedAtSec !== null && observedAtSec > assessedAtSec && reason !== "future-source-time") {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Future observations require their explicit diagnosis" });
    }
    return;
  }
  if (reason !== null || observedAtSec === null || sourceGenerationId === null || maxAgeSec === null ||
      observedAtSec > assessedAtSec || (assessedAtSec - observedAtSec <= maxAgeSec) !== (verdict === "current")) {
    ctx.addIssue({ code: "custom", message: "Freshness verdict must reproduce from its original clock, generation and inclusive age budget" });
  }
});
export type SafetyScoreV9FreshnessAssessment = z.infer<typeof SafetyScoreV9FreshnessAssessmentSchema>;
export type SafetyScoreV9EvidenceFreshness = SafetyScoreV9FreshnessAssessment["verdict"];

/** Pre-assessment schema-7 publications retain their bare verdict, never invented operands. */
export const SafetyScoreV9EvidenceFreshnessSchema = z.union([
  SafetyScoreV9FreshnessAssessmentSchema,
  SafetyScoreV9FreshnessVerdictSchema,
]);
export const SafetyScoreV9AggregateFreshnessSchema = z.object({
  verdict: SafetyScoreV9FreshnessAssessmentSchema.shape.verdict,
  pillarRefs: z.tuple([z.literal("backing"), z.literal("exit"), z.literal("control")]),
}).strict();
export const SafetyScoreV9EvidenceSummaryFreshnessSchema = z.union([
  SafetyScoreV9AggregateFreshnessSchema,
  SafetyScoreV9FreshnessVerdictSchema,
]);

export function safetyScoreV9FreshnessVerdict(
  freshness: z.infer<typeof SafetyScoreV9EvidenceFreshnessSchema> | z.infer<typeof SafetyScoreV9EvidenceSummaryFreshnessSchema>,
): SafetyScoreV9FreshnessAssessment["verdict"] {
  return typeof freshness === "string" ? freshness : freshness.verdict;
}

export const SafetyScoreV9PillarSchema = z
  .object({
    ...V9PillarCauseShape,
    score: ScoreSchema.nullable(),
    evidenceLevel: V9EvidenceLevelSchema,
    freshness: SafetyScoreV9EvidenceFreshnessSchema,
    components: z.array(z.string().min(1)),
    reasons: SafetyScoreV9PublicReasonListSchema,
  })
  .strict()
  .superRefine((pillar, ctx) => {
    if ((pillar.aggregationDisposition === "excluded-a-b") !== (pillar.score === null) &&
        pillar.aggregationDisposition === "excluded-a-b") {
      ctx.addIssue({ code: "custom", path: ["score"], message: "Excluded pillars must have null score" });
    }
    if (pillar.aggregationDisposition === "excluded-a-b" &&
        ((pillar.causeGapRefs?.length ?? 0) === 0 || (pillar.limitedEvidenceCauses?.length ?? 0) > 0 || pillar.supportedComponentKeys.length > 0)) {
      ctx.addIssue({ code: "custom", message: "Excluded pillars require A/B gaps, no scoreable support and no limiting C/U/D" });
    }
    if (!isUniqueSorted(pillar.components)) {
      ctx.addIssue({ code: "custom", path: ["components"], message: "V9 pillar components must be unique and sorted" });
    }
  });

export const SafetyScoreV9CapSchema = z
  .object({
    kind: z.string().min(1),
    limit: ScoreSchema,
    source: V9CapSourceSchema,
    reason: z.string().min(1),
    binding: z.boolean(),
  })
  .strict();
export type SafetyScoreV9Cap = z.infer<typeof SafetyScoreV9CapSchema>;

export const SafetyScoreV9AccessPostureSchema = z
  .object({
    transfer: V9AccessTransferSchema,
    freezeExposure: V9AccessFreezeExposureSchema,
    primaryExit: V9AccessPrimaryExitSchema,
    governance: V9AccessGovernanceSchema,
    unknownFields: z.array(V9AccessPostureFieldSchema),
    signals: z.array(z.string().min(1)),
    reasons: SafetyScoreV9PublicReasonListSchema,
    freezeLookthrough: V9AccessLookthroughSummarySchema.nullable().optional(),
  })
  .strict()
  .superRefine((posture, ctx) => {
    const expectedUnknown = V9_ACCESS_POSTURE_FIELDS
      .filter((field) => posture[field] === "unknown")
      .sort(compareText);
    if (JSON.stringify(posture.unknownFields) !== JSON.stringify(expectedUnknown)) {
      ctx.addIssue({
        code: "custom",
        path: ["unknownFields"],
        message: "V9 access unknown fields must exactly match unknown posture values",
      });
    }
    if (!isUniqueSorted(posture.signals)) {
      ctx.addIssue({ code: "custom", path: ["signals"], message: "V9 access signals must be unique and sorted" });
    }
  });
