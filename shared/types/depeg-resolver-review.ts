import { z } from "zod";
import {
  DDR_CELL_STATE_VALUES,
  DDR_HORIZON_VALUES,
  DDR_RESOLUTION_TIER_VALUES,
  DdrFactorSchema,
  DdrHorizonCellSchema,
} from "./depeg-resolver";
import { MethodologyEnvelopeSchema } from "./methodology-envelope";

/**
 * Depeg Duration Resolver Reviewer (DDRR) shared contract.
 *
 * DDRR compares a stored DDR assessment against later canonical event state.
 * It does not replay current DDR code over old events.
 */

export const DDRR_REVIEWER_VERSION = "ddr-reviewer-v1";
export const DDRR_PUBLIC_WARNING =
  "Reviews compare prior DDR readouts with later Pharos event data. Pending rows are not scored.";

export const DDRR_CHECKPOINT_VALUES = ["first", "age_1h", "age_6h", "age_24h", "age_7d", "latest"] as const;
export type DdrrCheckpoint = (typeof DDRR_CHECKPOINT_VALUES)[number];

export const DDRR_ACTUAL_OUTCOME_VALUES = [
  "recovered",
  "orphan_closed",
  "terminal_observed",
  "still_open",
  "source_event_missing",
  "data_issue",
] as const;
export type DdrrActualOutcome = (typeof DDRR_ACTUAL_OUTCOME_VALUES)[number];

export const DDRR_VERDICT_REVIEW_VALUES = [
  "correct_recoverable",
  "correct_terminal",
  "false_terminal",
  "false_recoverable",
  "risk_noted_terminal",
  "unscored_insufficient_signal",
  "pending",
  "data_issue",
] as const;
export type DdrrVerdictReview = (typeof DDRR_VERDICT_REVIEW_VALUES)[number];

export const DDRR_DURATION_REVIEW_VALUES = [
  "inside_band",
  "faster_than_band",
  "slower_than_band",
  "median_late_by",
  "median_early_by",
  "median_exact",
  "duration_unscored",
  "data_issue",
] as const;
export type DdrrDurationReview = (typeof DDRR_DURATION_REVIEW_VALUES)[number];

export const DDRR_MEDIAN_REVIEW_VALUES = ["median_late_by", "median_early_by", "median_exact"] as const;
export type DdrrMedianReview = (typeof DDRR_MEDIAN_REVIEW_VALUES)[number];

export const DDRR_HORIZON_REVIEW_VALUES = ["hit", "miss", "pending", "unscored"] as const;
export type DdrrHorizonReviewResult = (typeof DDRR_HORIZON_REVIEW_VALUES)[number];

export const DdrrIqrRemainingSecSchema = z.tuple([z.number().nonnegative(), z.number().nonnegative()]);
export type DdrrIqrRemainingSec = z.infer<typeof DdrrIqrRemainingSecSchema>;

export const DdrrAssessmentSchema = z.object({
  eventId: z.number().int().nonnegative(),
  stablecoinId: z.string(),
  symbol: z.string(),
  name: z.string(),
  pegCurrency: z.string(),
  governance: z.string(),
  direction: z.enum(["above", "below"]),
  startedAt: z.number().int().nonnegative(),
  assessedAt: z.number().int().nonnegative(),
  eventAgeSec: z.number().int().nonnegative(),
  checkpoint: z.enum(DDRR_CHECKPOINT_VALUES),
  methodologyVersion: z.string(),
  resolutionTier: z.enum(DDR_RESOLUTION_TIER_VALUES),
  durationSuppressed: z.boolean(),
  durationSuppressedReason: z.string().nullable(),
  predictedRemainingSec: z.number().int().nonnegative().nullable(),
  iqrRemainingSec: DdrrIqrRemainingSecSchema.nullable(),
  horizonCells: z.array(DdrHorizonCellSchema),
  stratum: z.string().nullable(),
  factors: z.array(DdrFactorSchema),
});
export type DdrrAssessment = z.infer<typeof DdrrAssessmentSchema>;

export const DdrrActualEventSchema = z.object({
  eventId: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().nullable(),
  recoveryPrice: z.number().positive().nullable(),
  stablecoinStatus: z.string().nullable().optional().default(null),
  terminalObserved: z.boolean().nullable().optional().default(null),
});
export type DdrrActualEvent = z.infer<typeof DdrrActualEventSchema>;

export const DdrrHorizonReviewSchema = z.object({
  horizon: z.enum(DDR_HORIZON_VALUES),
  horizonSec: z.number().int().positive(),
  result: z.enum(DDRR_HORIZON_REVIEW_VALUES),
  horizonElapsed: z.boolean(),
  resolvedWithinHorizon: z.boolean(),
  sourceCellState: z.enum(DDR_CELL_STATE_VALUES),
  probability: z.number().min(0).max(1).nullable(),
  probabilityDisplay: z.string().nullable(),
  probabilityInterval: z.object({ lower: z.number(), upper: z.number() }).nullable(),
});
export type DdrrHorizonReview = z.infer<typeof DdrrHorizonReviewSchema>;

export const DdrrRowSchema = z.object({
  eventId: z.number().int().nonnegative(),
  stablecoinId: z.string(),
  symbol: z.string(),
  name: z.string(),
  pegCurrency: z.string(),
  governance: z.string(),
  direction: z.enum(["above", "below"]),
  startedAt: z.number().int().nonnegative(),
  assessedAt: z.number().int().nonnegative(),
  eventAgeSec: z.number().int().nonnegative(),
  checkpoint: z.enum(DDRR_CHECKPOINT_VALUES),
  methodologyVersion: z.string(),
  resolutionTier: z.enum(DDR_RESOLUTION_TIER_VALUES),
  durationSuppressed: z.boolean(),
  durationSuppressedReason: z.string().nullable(),
  predictedRemainingSec: z.number().int().nonnegative().nullable(),
  iqrRemainingSec: DdrrIqrRemainingSecSchema.nullable(),
  actualOutcome: z.enum(DDRR_ACTUAL_OUTCOME_VALUES),
  actualEndedAt: z.number().int().nonnegative().nullable(),
  actualRemainingSec: z.number().int().nonnegative().nullable(),
  verdictReview: z.enum(DDRR_VERDICT_REVIEW_VALUES),
  durationReview: z.enum(DDRR_DURATION_REVIEW_VALUES),
  medianReview: z.enum(DDRR_MEDIAN_REVIEW_VALUES).nullable(),
  signedErrorSec: z.number().nullable(),
  absoluteErrorSec: z.number().nonnegative().nullable(),
  withinIqr: z.boolean().nullable(),
  horizonReviews: z.array(DdrrHorizonReviewSchema),
  stratum: z.string().nullable(),
  factors: z.array(DdrFactorSchema),
  sourceEventState: z.enum(DDRR_ACTUAL_OUTCOME_VALUES),
});
export type DdrrRow = z.infer<typeof DdrrRowSchema>;

export const DdrrHorizonHitRateSchema = z.object({
  horizon: z.enum(DDR_HORIZON_VALUES),
  scored: z.number().int().nonnegative(),
  hits: z.number().int().nonnegative(),
  misses: z.number().int().nonnegative(),
  hitRate: z.number().min(0).max(1).nullable(),
});
export type DdrrHorizonHitRate = z.infer<typeof DdrrHorizonHitRateSchema>;

export const DdrrHeadlineStatsSchema = z.object({
  recoveryLikelihoodCorrectCount: z.number().int().nonnegative(),
  recoveryLikelihoodScoredCount: z.number().int().nonnegative(),
  recoveryLikelihoodAccuracyPct: z.number().min(0).max(1).nullable(),
  durationScoredCount: z.number().int().nonnegative(),
  averageSignedDurationErrorSec: z.number().nullable(),
  averageAbsoluteDurationErrorSec: z.number().nullable(),
});
export type DdrrHeadlineStats = z.infer<typeof DdrrHeadlineStatsSchema>;

export const DdrrSummarySchema = DdrrHeadlineStatsSchema.extend({
  correctRecoverable: z.number().int().nonnegative(),
  correctTerminal: z.number().int().nonnegative(),
  falseTerminal: z.number().int().nonnegative(),
  falseRecoverable: z.number().int().nonnegative(),
  riskNotedTerminal: z.number().int().nonnegative(),
  unscoredInsufficientSignal: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  dataIssue: z.number().int().nonnegative(),
  verdictScoredCount: z.number().int().nonnegative(),
  durationUnscoredCount: z.number().int().nonnegative(),
  withinIqrCount: z.number().int().nonnegative(),
  iqrScoredCount: z.number().int().nonnegative(),
  withinIqrPct: z.number().min(0).max(1).nullable(),
  medianAbsoluteErrorSec: z.number().nullable(),
  horizonHitRates: z.array(DdrrHorizonHitRateSchema),
});
export type DdrrSummary = z.infer<typeof DdrrSummarySchema>;

export const DdrrMetaSchema = z.object({
  computedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  degraded: z.boolean(),
  degradedReason: z.string().nullable(),
  reviewerVersion: z.string(),
  publicWarning: z.string(),
  assessedEventCount: z.number().int().nonnegative(),
  reviewedEventCount: z.number().int().nonnegative(),
  pendingEventCount: z.number().int().nonnegative(),
  durationScoredCount: z.number().int().nonnegative(),
  verdictScoredCount: z.number().int().nonnegative(),
  assessmentRowLimit: z.number().int().nonnegative(),
  assessmentRowsTruncated: z.boolean(),
  publicRowLimit: z.number().int().nonnegative(),
  publicRowsTruncated: z.boolean(),
  methodologyVersions: z.array(z.string()),
});
export type DdrrMeta = z.infer<typeof DdrrMetaSchema>;

export const DdrrResponseSchema = z.object({
  _meta: DdrrMetaSchema,
  summary: DdrrSummarySchema,
  rows: z.array(DdrrRowSchema),
  methodology: MethodologyEnvelopeSchema,
});
export type DdrrResponse = z.infer<typeof DdrrResponseSchema>;
