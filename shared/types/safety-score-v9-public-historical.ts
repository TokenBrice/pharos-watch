import { z } from "zod";
import { issue, ScoreSchema } from "./safety-schema-primitives";
import { V9WrapperFactDispositionSchema, V9WrapperFormSchema, V9WrapperLocalFactKeySchema, V9_WRAPPER_LOCAL_FACT_KEYS } from "./safety-score-v9-wrapper";
import { V9WrapperRiskAssessmentSchema } from "./safety-score-v9-fact-primitives";
import { causeGapRefs, V9EvidenceCauseSchema, V9ScoringDispositionSchema } from "./safety-score-v9-public-causes";
import { isUniqueSorted, numbersAgree, SafetyScoreV9CapSchema, SCORE_TOLERANCE } from "./safety-score-v9-public-facts";

/** Archive-only vocabulary: never admitted by live producers or consumers. */
export const SafetyScoreV9HistoricalCapSchema = SafetyScoreV9CapSchema.extend({
  source: z.enum(["active-depeg", "structural", "parent", "evidence", "track-record", "bounded-compensability"]),
});

/** The recorded nine-factor contract, not a second runtime scoring policy. */
export const SafetyScoreV9HistoricalWrapperParentLimitSchema = z.object({
  schemaVersion: z.literal(1),
  parentScore: ScoreSchema,
  form: V9WrapperFormSchema,
  treatment: z.enum(["local-facts", "fallback-discount", "documented-risk-transfer"]),
  localRiskDiscount: z.number().finite().min(0).max(100),
  fallbackDiscount: z.number().finite().min(0).max(100),
  appliedDiscount: z.number().finite().min(0).max(100),
  gradeFloor: ScoreSchema.optional(),
  riskTransfer: z.object({
    disposition: V9WrapperFactDispositionSchema,
    mechanism: z.enum(["none", "first-loss-capital", "insurance", "overcollateralization", "other", "unknown"]),
    requestedCredit: z.number().finite().min(0).max(100),
    appliedCredit: z.number().finite().min(0).max(100),
  }).strict(),
  limit: ScoreSchema,
  factsComplete: z.boolean(),
  missingFacts: z.array(z.object({
    factClass: z.union([V9WrapperLocalFactKeySchema, z.enum(["riskTransfer", "wrapperForm"])]),
    disposition: V9WrapperFactDispositionSchema.exclude(["reviewed", "not-applicable"]),
    cause: V9EvidenceCauseSchema.nullable().optional(),
    causeGapRefs: causeGapRefs().optional(),
    scoringDisposition: V9ScoringDispositionSchema.optional(),
  }).strict()),
  adjustments: z.array(z.object({
    factKey: V9WrapperLocalFactKeySchema,
    disposition: V9WrapperFactDispositionSchema,
    assessment: V9WrapperRiskAssessmentSchema.nullable(),
    maximumDiscountPoints: z.number().finite().positive().max(100),
    discountPoints: z.number().finite().min(0).max(100),
    cause: V9EvidenceCauseSchema.nullable().optional(),
    causeGapRefs: causeGapRefs().optional(),
    scoringDisposition: V9ScoringDispositionSchema.optional(),
  }).strict()),
}).strict().superRefine((limit, ctx) => {
  if (!isUniqueSorted(limit.missingFacts.map(fact => `${fact.factClass}:${fact.disposition}`))) {
    issue(ctx, ["missingFacts"], "V9 wrapper missing facts must be unique and sorted");
  }
  if (JSON.stringify(limit.adjustments.map(adjustment => adjustment.factKey)) !== JSON.stringify(V9_WRAPPER_LOCAL_FACT_KEYS)) {
    issue(ctx, ["adjustments"], "V9 wrapper adjustments must cover every local fact in canonical order");
  }
  if (!numbersAgree(limit.localRiskDiscount, limit.adjustments.reduce((sum, adjustment) => sum + adjustment.discountPoints, 0))) {
    issue(ctx, ["localRiskDiscount"], "V9 wrapper local-risk discount must reconcile its fact adjustments");
  }
  if (limit.factsComplete !== (limit.missingFacts.length === 0)) {
    issue(ctx, ["factsComplete"], "V9 wrapper completeness must exactly match its missing facts");
  }
  const requestedDiscount = limit.factsComplete ? limit.localRiskDiscount : Math.max(limit.localRiskDiscount, limit.fallbackDiscount);
  if (limit.gradeFloor !== undefined && (
    limit.parentScore < limit.gradeFloor || limit.parentScore - requestedDiscount >= limit.gradeFloor ||
    limit.adjustments.some(adjustment => adjustment.discountPoints > 0 &&
      (adjustment.assessment === "high" || adjustment.assessment === "critical" || adjustment.scoringDisposition === "measured-adverse"))
  )) {
    issue(ctx, ["gradeFloor"], "V9 wrapper grade protection requires a crossing from a non-danger parent without severe or measured-adverse local findings");
  }
  const expectedDiscount = limit.gradeFloor === undefined ? requestedDiscount : limit.parentScore - limit.gradeFloor;
  if (!numbersAgree(limit.appliedDiscount, expectedDiscount)) {
    issue(ctx, ["appliedDiscount"], "V9 wrapper discount must use the conservative local maximum, limited only by an admitted mild-risk grade floor");
  }
  if (limit.riskTransfer.appliedCredit > limit.riskTransfer.requestedCredit + SCORE_TOLERANCE) {
    issue(ctx, ["riskTransfer", "appliedCredit"], "V9 wrapper cannot apply more risk-transfer credit than documented");
  }
  if (!numbersAgree(limit.limit, Math.max(0, limit.parentScore - limit.appliedDiscount) + limit.riskTransfer.appliedCredit)) {
    issue(ctx, ["limit"], "V9 wrapper limit must apply parent risk, local discount, and documented credit exactly once");
  }
  if ((limit.treatment === "fallback-discount") !== (!limit.factsComplete && limit.fallbackDiscount > 0) ||
      (limit.treatment === "documented-risk-transfer") !== (limit.riskTransfer.appliedCredit > 0)) {
    issue(ctx, ["treatment"], "V9 wrapper treatment must match applied fallback eligibility and risk-transfer credit");
  }
});
