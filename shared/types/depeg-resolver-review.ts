import { z } from "zod";
import { DepegDirectionSchema } from "./market";
import {
  DDR_ASSESSMENT_CHECKPOINT_VALUES,
  DDR_CELL_STATE_VALUES,
  DDR_HORIZON_VALUES,
  DDR_RESOLUTION_TIER_VALUES,
  DdrOfficialLockOutcomeSchema,
  DdrFactorSchema,
  DdrHorizonCellSchema,
  DdrPredictionErratumSchema,
} from "./depeg-resolver";
import { MethodologyEnvelopeSchema } from "./methodology-envelope";

/**
 * Depeg Duration Resolver Reviewer (DDRR) shared contract.
 *
 * DDRR reviews the frozen public_prediction lock outcome that entered a
 * first-publication manifest. It does not replay current DDR code over old
 * incidents, and it keeps no-prediction coverage separate from accuracy.
 */

// Public Zod schemas keep exported companion aliases as the contract type surface.

export const DDRR_REVIEWER_VERSION = "ddr-reviewer-v4";
export const DDRR_SNAPSHOT_CACHE_GENERATION = 4;
export const DDRR_PUBLIC_WARNING =
  "Reviews compare frozen DDR predictions Pharos published with later Pharos event data. Coverage rows are not scored as predictions.";

// DDRR and DDR checkpoints are semantically distinct domains (review vs.
// assessment) but currently share the same 7-member tuple.
export const DDRR_CHECKPOINT_VALUES = DDR_ASSESSMENT_CHECKPOINT_VALUES;

export const DDRR_SOURCE_EVENT_STATE_VALUES = [
  "active",
  "recovered",
  "terminal",
  "orphan_closed",
  "data_issue",
  "missing",
  "invalidated",
] as const;
export type DdrrSourceEventState = (typeof DDRR_SOURCE_EVENT_STATE_VALUES)[number];

export const DDRR_ACTUAL_OUTCOME_VALUES = [
  "recovered",
  "terminal",
  "orphan_closed",
  "still_open",
  "source_missing",
  "data_issue",
  "invalidated",
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

export const DDRR_SCORED_VERDICTS: ReadonlySet<DdrrVerdictReview> = new Set([
  "correct_recoverable",
  "correct_terminal",
  "false_terminal",
  "false_recoverable",
  "risk_noted_terminal",
]);

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

export const DDRR_COVERAGE_PREDICTION_STATE_VALUES = [
  "pending_lock",
  "lock_deferred",
  "data_quality_gap",
  "orphan_closed",
  "publication_retry_pending",
  "resolved_before_prediction",
  "terminal_before_prediction",
  "missed_lock_recovered",
  "missed_lock_terminal",
  "publication_failed",
] as const;
export type DdrrCoveragePredictionState = (typeof DDRR_COVERAGE_PREDICTION_STATE_VALUES)[number];

export const DDRR_COVERAGE_CAUSE_VALUES = [
  "active_pending_lock",
  "active_lock_deferred",
  "pre_lock_recovered",
  "pre_lock_terminal",
  "late_confirmation",
  "system_deferral",
  "source_event_repair",
  "data_quality_gap",
  "orphan_closed",
  "terminal_time_unknown",
  "publication_retry_pending",
  "publication_failed",
  "confirmation_time_unknown",
  "cron_gap",
  "lock_missed",
] as const;
export type DdrrCoverageCause = (typeof DDRR_COVERAGE_CAUSE_VALUES)[number];

export const DDRR_OUTCOME_QUALITY_STATE_VALUES = ["classified", "orphan_closed", "data_quality_gap"] as const;
export type DdrrOutcomeQualityState = (typeof DDRR_OUTCOME_QUALITY_STATE_VALUES)[number];

export const DDRR_TERMINAL_EVIDENCE_PRECISION_VALUES = ["day", "month", "unknown"] as const;
export type DdrrTerminalEvidencePrecision = (typeof DDRR_TERMINAL_EVIDENCE_PRECISION_VALUES)[number];

export const DdrrIqrRemainingSecSchema = z.tuple([z.number().nonnegative(), z.number().nonnegative()]);

export const DdrrTerminalEvidenceIntervalSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export type DdrrTerminalEvidenceInterval = z.infer<typeof DdrrTerminalEvidenceIntervalSchema>;

export const DdrrLineageSchema = z.object({
  autoRepaired: z.literal(true).optional(),
  repairSources: z.array(z.string()).min(1).optional(),
  parentIncidentKey: z.string().optional(),
});
export type DdrrLineage = z.infer<typeof DdrrLineageSchema>;

export const DdrrAssessmentSchema = z.object({
  eventId: z.number().int().nonnegative(),
  currentEventId: z.number().int().nonnegative().nullable().optional().default(null),
  incidentKey: z.string().optional(),
  publicPredictionId: z.number().int().nonnegative().optional(),
  assessmentId: z.number().int().nonnegative().optional(),
  stablecoinId: z.string(),
  symbol: z.string(),
  name: z.string(),
  pegCurrency: z.string(),
  governance: z.string(),
  direction: DepegDirectionSchema,
  startedAt: z.number().int().nonnegative(),
  eligibleAt: z.number().int().nonnegative().optional(),
  lockedAt: z.number().int().nonnegative().optional(),
  publishedAt: z.number().int().nonnegative().optional(),
  publicationSnapshotToken: z.string().optional(),
  assessedAt: z.number().int().nonnegative(),
  eventAgeSec: z.number().int().nonnegative(),
  checkpoint: z.enum(DDRR_CHECKPOINT_VALUES),
  methodologyVersion: z.string(),
  predictionMethodologyVersion: z.string().optional(),
  predictionPolicyVersion: z.string().optional(),
  resolutionTier: z.enum(DDR_RESOLUTION_TIER_VALUES),
  durationSuppressed: z.boolean(),
  durationSuppressedReason: z.string().nullable(),
  predictedRemainingSec: z.number().int().nonnegative().nullable(),
  iqrRemainingSec: DdrrIqrRemainingSecSchema.nullable(),
  horizonCells: z.array(DdrHorizonCellSchema),
  stratum: z.string().nullable(),
  factors: z.array(DdrFactorSchema),
  lineage: DdrrLineageSchema.optional(),
});
export type DdrrAssessment = z.infer<typeof DdrrAssessmentSchema>;

export const DdrrActualEventSchema = z.object({
  eventId: z.number().int().nonnegative(),
  currentEventId: z.number().int().nonnegative().nullable().optional().default(null),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().nullable(),
  recoveryPrice: z.number().positive().nullable(),
  stablecoinStatus: z.string().nullable().optional().default(null),
  terminalObserved: z.boolean().nullable().optional().default(null),
  terminalEvidenceAt: z.number().int().nonnegative().nullable().optional().default(null),
  terminalEvidenceInterval: DdrrTerminalEvidenceIntervalSchema.nullable().optional().default(null),
  terminalEvidencePrecision: z.enum(DDRR_TERMINAL_EVIDENCE_PRECISION_VALUES).nullable().optional().default(null),
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

export const DdrrV2BaseRowSchema = z.object({
  eventId: z.number().int().nonnegative(),
  currentEventId: z.number().int().nonnegative().nullable(),
  incidentKey: z.string(),
  stablecoinId: z.string(),
  symbol: z.string(),
  name: z.string(),
  pegCurrency: z.string(),
  governance: z.string(),
  direction: DepegDirectionSchema,
  startedAt: z.number().int().nonnegative(),
  eligibleAt: z.number().int().nonnegative(),
  sourceEventState: z.enum(DDRR_SOURCE_EVENT_STATE_VALUES),
  terminalEvidenceAt: z.number().int().nonnegative().nullable(),
  terminalEvidenceInterval: DdrrTerminalEvidenceIntervalSchema.nullable(),
  terminalEvidencePrecision: z.enum(DDRR_TERMINAL_EVIDENCE_PRECISION_VALUES).nullable(),
  lineage: DdrrLineageSchema.optional(),
});
export type DdrrV2BaseRow = z.infer<typeof DdrrV2BaseRowSchema>;

export const DdrrV2ActualOutcomeDetailSchema = z.object({
  kind: z.enum(DDRR_ACTUAL_OUTCOME_VALUES),
  actualEndedAt: z.number().int().nonnegative().nullable(),
  actualRemainingSec: z.number().int().nonnegative().nullable(),
  terminalEvidenceAt: z.number().int().nonnegative().nullable(),
  terminalEvidenceInterval: DdrrTerminalEvidenceIntervalSchema.nullable(),
  terminalEvidencePrecision: z.enum(DDRR_TERMINAL_EVIDENCE_PRECISION_VALUES).nullable(),
  reviewedAt: z.number().int().nonnegative(),
});
export type DdrrV2ActualOutcomeDetail = z.infer<typeof DdrrV2ActualOutcomeDetailSchema>;

export const DdrrFrozenPredictionReviewSchema = z.object({
  resolutionTier: z.enum(DDR_RESOLUTION_TIER_VALUES),
  predictedRemainingSec: z.number().int().nonnegative().nullable(),
  iqrRemainingSec: DdrrIqrRemainingSecSchema.nullable(),
  horizonCells: z.array(DdrHorizonCellSchema),
  stratum: z.string().nullable(),
  factors: z.array(DdrFactorSchema),
});

const DdrrPublicationCoreSchema = z.object({
  publicPredictionId: z.number().int().nonnegative(),
  assessmentId: z.number().int().nonnegative(),
  predictionMethodologyVersion: z.string(),
  predictionPolicyVersion: z.string(),
  lockedAt: z.number().int().nonnegative(),
});

export const DdrrV2PredictionReviewRowSchema = DdrrV2BaseRowSchema.extend({
  kind: z.literal("prediction_review"),
  ...DdrrPublicationCoreSchema.shape,
  predictionState: z.literal("frozen"),
  publishedAt: z.number().int().nonnegative(),
  publicationSnapshotToken: z.string(),
  frozen: DdrrFrozenPredictionReviewSchema,
  actual: DdrrV2ActualOutcomeDetailSchema,
  verdictReview: z.enum(DDRR_VERDICT_REVIEW_VALUES),
  durationReview: z.enum(DDRR_DURATION_REVIEW_VALUES),
  horizonReviews: z.array(DdrrHorizonReviewSchema),
  predictedRemainingSec: z.number().int().nonnegative().nullable(),
  actualRemainingSec: z.number().int().nonnegative().nullable(),
  signedDurationErrorSec: z.number().nullable(),
  absoluteDurationErrorSec: z.number().nonnegative().nullable(),
  medianReview: z.enum(DDRR_MEDIAN_REVIEW_VALUES).nullable(),
  withinIqr: z.boolean().nullable(),
});
export type DdrrV2PredictionReviewRow = z.infer<typeof DdrrV2PredictionReviewRowSchema>;

export const DdrrV2NoCallReviewRowSchema = DdrrV2BaseRowSchema.extend({
  kind: z.literal("no_call_review"),
  ...DdrrPublicationCoreSchema.shape,
  predictionState: z.literal("no_call"),
  publishedAt: z.number().int().nonnegative(),
  publicationSnapshotToken: z.string(),
  missingReasons: z.array(z.string()),
  actual: DdrrV2ActualOutcomeDetailSchema,
  verdictReview: z.literal("unscored_insufficient_signal"),
  durationReview: z.literal("duration_unscored"),
  horizonReviews: z.tuple([]),
});
export type DdrrV2NoCallReviewRow = z.infer<typeof DdrrV2NoCallReviewRowSchema>;

export const DdrrFailedPublicationSchema = z.object({
  publicPredictionId: z.number().int().nonnegative(),
  assessmentId: z.number().int().nonnegative(),
  lockedAt: z.number().int().nonnegative(),
  outcomeKind: z.enum(["prediction", "no_call"]),
  rowHash: z.string(),
  sealedPayloadRedacted: z.literal(true),
  lastAttemptedAt: z.number().int().nonnegative().nullable(),
});
export type DdrrFailedPublication = z.infer<typeof DdrrFailedPublicationSchema>;

export const DdrrV2CoverageRowSchema = DdrrV2BaseRowSchema.extend({
  kind: z.literal("coverage"),
  predictionState: z.enum(DDRR_COVERAGE_PREDICTION_STATE_VALUES),
  // Actual-outcome spelling of the base row's sourceEventState; carried
  // alongside it so consumers need no state-to-outcome mapping.
  actualOutcome: z.enum(DDRR_ACTUAL_OUTCOME_VALUES),
  actualEndedAt: z.number().int().nonnegative().nullable(),
  terminalEvidenceSourceDate: z.string().nullable(),
  coverageCause: z.enum(DDRR_COVERAGE_CAUSE_VALUES),
  operationalCoverageCause: z.enum(DDRR_COVERAGE_CAUSE_VALUES).nullable(),
  outcomeQualityState: z.enum(DDRR_OUTCOME_QUALITY_STATE_VALUES).nullable(),
  reason: z.string().nullable(),
  failedPublication: DdrrFailedPublicationSchema.nullable(),
});
export type DdrrV2CoverageRow = z.infer<typeof DdrrV2CoverageRowSchema>;

/**
 * Consumer-only compatibility for the generation-3 to generation-4 rollout.
 * Generation-3 payloads before the 2026-09-06 cutover omit `actualOutcome`;
 * the producer/write schema above remains strict for current generation-4 rows.
 */
export const DdrrV2CoverageResponseRowSchema = DdrrV2CoverageRowSchema.extend({
  actualOutcome: z.enum(DDRR_ACTUAL_OUTCOME_VALUES).optional(),
});
export type DdrrV2CoverageResponseRow = z.infer<typeof DdrrV2CoverageResponseRowSchema>;

export const DdrrV2InvalidatedPredictionRowSchema = DdrrV2BaseRowSchema.extend({
  kind: z.literal("invalidated_prediction"),
  ...DdrrPublicationCoreSchema.shape,
  predictionState: z.literal("invalidated"),
  publishedAt: z.number().int().nonnegative().nullable(),
  publicationSnapshotToken: z.string().nullable(),
  originalKind: z.enum(["prediction", "no_call"]),
  originalOutcome: DdrOfficialLockOutcomeSchema,
  latestErratum: DdrPredictionErratumSchema,
  errataCount: z.number().int().nonnegative(),
  errataHistory: z.array(DdrPredictionErratumSchema),
});
export type DdrrV2InvalidatedPredictionRow = z.infer<typeof DdrrV2InvalidatedPredictionRowSchema>;

export const DdrrRowSchema = z.discriminatedUnion("kind", [
  DdrrV2PredictionReviewRowSchema,
  DdrrV2NoCallReviewRowSchema,
  DdrrV2CoverageRowSchema,
  DdrrV2InvalidatedPredictionRowSchema,
]);
export type DdrrRow = z.infer<typeof DdrrRowSchema>;

export const DdrrResponseRowSchema = z.discriminatedUnion("kind", [
  DdrrV2PredictionReviewRowSchema,
  DdrrV2NoCallReviewRowSchema,
  DdrrV2CoverageResponseRowSchema,
  DdrrV2InvalidatedPredictionRowSchema,
]);
export type DdrrResponseRow = z.infer<typeof DdrrResponseRowSchema>;

export const DdrrHorizonHitRateSchema = z.object({
  horizon: z.enum(DDR_HORIZON_VALUES),
  scored: z.number().int().nonnegative(),
  hits: z.number().int().nonnegative(),
  misses: z.number().int().nonnegative(),
  hitRate: z.number().min(0).max(1).nullable(),
});
export type DdrrHorizonHitRate = z.infer<typeof DdrrHorizonHitRateSchema>;

export const DdrrHorizonCalibrationSchema = z.object({
  horizon: z.enum(DDR_HORIZON_VALUES),
  scored: z.number().int().nonnegative(),
  meanPredictedProbability: z.number().min(0).max(1).nullable(),
  realizedClosureShare: z.number().min(0).max(1).nullable(),
  biasPp: z.number().min(-100).max(100).nullable(),
  zScore: z.number().finite().nullable(),
});
export type DdrrHorizonCalibration = z.infer<typeof DdrrHorizonCalibrationSchema>;

export const DdrrV2SummaryMetricsSchema = z.object({
  activeEligibleIncidentCount: z.number().int().nonnegative(),
  policyUniverseIncidentCount: z.number().int().nonnegative(),
  lockedPredictionCount: z.number().int().nonnegative(),
  pendingLockCount: z.number().int().nonnegative(),
  lockDeferredCount: z.number().int().nonnegative(),
  resolvedBeforePredictionCount: z.number().int().nonnegative(),
  terminalBeforePredictionCount: z.number().int().nonnegative(),
  dataQualityGapCount: z.number().int().nonnegative(),
  orphanClosedCount: z.number().int().nonnegative(),
  missedLockRecoveredCount: z.number().int().nonnegative(),
  missedLockTerminalCount: z.number().int().nonnegative(),
  missedLockOrphanClosedCount: z.number().int().nonnegative(),
  missedLockDataQualityGapCount: z.number().int().nonnegative(),
  missedNoPredictionCount: z.number().int().nonnegative(),
  publicationFailedCount: z.number().int().nonnegative(),
  publicationRetryPendingCount: z.number().int().nonnegative(),
  missedOperationalLockCount: z.number().int().nonnegative(),
  confirmationTimeUnknownCount: z.number().int().nonnegative(),
  noCallCount: z.number().int().nonnegative(),
  invalidatedPredictionCount: z.number().int().nonnegative(),
  currentEligibleOpportunityCount: z.number().int().nonnegative(),
  finalizedOpportunityCount: z.number().int().nonnegative(),
  predictionRatePct: z.number().min(0).max(1).nullable(),
  invalidationAdjustedPredictionRatePct: z.number().min(0).max(1).nullable(),
  decisionProgressPct: z.number().min(0).max(1).nullable(),
  operationalMissRatePct: z.number().min(0).max(1).nullable(),
  noCallRatePct: z.number().min(0).max(1).nullable(),
  preLockRecoveredPct: z.number().min(0).max(1).nullable(),
  preLockTerminalPct: z.number().min(0).max(1).nullable(),
  missedLockPct: z.number().min(0).max(1).nullable(),
  stateAssignedPct: z.number().min(0).max(1).nullable(),
  finalizedCoveragePct: z.number().min(0).max(1).nullable(),
  recoveryLikelihoodCorrectCount: z.number().int().nonnegative(),
  recoveryLikelihoodScoredCount: z.number().int().nonnegative(),
  recoveryLikelihoodAccuracyPct: z.number().min(0).max(1).nullable(),
  durationScoredCount: z.number().int().nonnegative(),
  meanSignedDurationErrorSec: z.number().nullable(),
  medianSignedDurationErrorSec: z.number().nullable(),
  meanAbsoluteDurationErrorSec: z.number().nullable(),
  medianAbsoluteDurationErrorSec: z.number().nullable(),
  invalidatedPct: z.number().min(0).max(1).nullable(),
  invalidatedByReason: z.record(z.string(), z.number().int().nonnegative()),
  accuracyDenominatorLabel: z.string(),
  horizonHitRates: z.array(DdrrHorizonHitRateSchema),
  horizonCalibration: z.array(DdrrHorizonCalibrationSchema).default([]),
});
export type DdrrV2SummaryMetrics = z.infer<typeof DdrrV2SummaryMetricsSchema>;

export const DdrrV2SummarySegmentSchema = z.object({
  segmentKind: z.enum(["prediction_policy", "coverage", "all"]),
  predictionMethodologyVersion: z.string().nullable(),
  predictionPolicyVersion: z.string().nullable(),
  metrics: DdrrV2SummaryMetricsSchema,
});

/**
 * Public DDRR summary contract.
 *
 * `byPredictionPolicy` is intentionally retained as a forward-compatible
 * inspection surface while generation-2 cached payloads are valid. Removing it
 * requires a DDRR cache-generation bump plus worker-before-client sequencing.
 */
export const DdrrSummarySchema = z.object({
  headlineScope: z.enum(["current_policy", "all_ddrv2", "insufficient_data"]),
  headlineLabel: z.string(),
  headline: DdrrV2SummaryMetricsSchema,
  byPredictionPolicy: z.array(DdrrV2SummarySegmentSchema),
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
  incidentRowLimit: z.number().int().nonnegative(),
  incidentRowsTruncated: z.boolean(),
  publicRowLimit: z.number().int().nonnegative(),
  publicRowsTruncated: z.boolean(),
  methodologyVersions: z.array(z.string()),
});

export const DdrrResponseSchema = z.object({
  _meta: DdrrMetaSchema,
  summary: DdrrSummarySchema,
  rows: z.array(DdrrResponseRowSchema),
  methodology: MethodologyEnvelopeSchema,
});
export type DdrrResponse = z.infer<typeof DdrrResponseSchema>;

/** OpenAPI documents the current generation-4 producer payload, not its transition input. */
export const DdrrResponseOpenApiSchema = DdrrResponseSchema.extend({
  rows: z.array(DdrrRowSchema),
});
