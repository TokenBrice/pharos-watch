import { z } from "zod";
import { MethodologyEnvelopeSchema } from "./methodology-envelope";
import { DepegDirectionSchema } from "./market";
import { SafetyScorePublicationIdentitySchema } from "./safety-score-publication";

/**
 * Depeg Duration Resolver (DDR) shared contract.
 *
 * Two-stage readout for an active confirmed depeg event:
 *  - Stage 1 "Resolution Outlook": mechanistic tiered verdict (will it repeg or is it terminal?)
 *    plus the kill-signal / recovery-anchor factors that drove it.
 *  - Stage 2 "Expected Duration": empirical stratified landmark estimate (when, if recoverable),
 *    with per-horizon resolution likelihood and data-sufficiency states.
 *
 * Methodology + limitations: docs/depeg-resolver.md. Verdicts are calibrated domain reads,
 * not fitted probabilities and not a credit rating.
 */

// Public Zod schemas keep exported companion aliases as the contract type surface.

// --- Stage 1: resolution tiers ---------------------------------------------

export const DDR_RESOLUTION_TIER_VALUES = [
  "recovery_likely",
  "at_risk",
  "recovery_unlikely",
  "insufficient_signal",
] as const;
export type DdrResolutionTier = (typeof DDR_RESOLUTION_TIER_VALUES)[number];

/** Kill signals push toward terminal; recovery anchors push toward repeg. */
export const DDR_FACTOR_KIND_VALUES = ["kill", "anchor"] as const;
export type DdrFactorKind = (typeof DDR_FACTOR_KIND_VALUES)[number];

/** kill → elevated|severe ; anchor → weak|strong. */
export const DDR_FACTOR_SEVERITY_VALUES = ["elevated", "severe", "weak", "strong"] as const;
export type DdrFactorSeverity = (typeof DDR_FACTOR_SEVERITY_VALUES)[number];

/** Stable codes so the frontend can map icons/copy. K = kill signal, R = recovery anchor. */
export const DDR_KILL_CODE_VALUES = [
  "K1_supply_weaponization",
  "K2_backing_impairment",
  "K3_freeze_seizure",
  "K4_reflexive_spiral",
  "K5_exit_collapse",
  "K6_wind_down",
] as const;
export const DDR_ANCHOR_CODE_VALUES = [
  "R1_noninflatable_supply",
  "R2_hard_collateral_redemption",
  "R3_no_supply_anomaly",
  "R4_no_freeze_point",
  "R5_proven_meanreversion",
] as const;
export const DDR_FACTOR_CODE_VALUES = [...DDR_KILL_CODE_VALUES, ...DDR_ANCHOR_CODE_VALUES] as const;
export type DdrFactorCode = (typeof DDR_FACTOR_CODE_VALUES)[number];

export const DdrFactorSchema = z.object({
  code: z.enum(DDR_FACTOR_CODE_VALUES),
  kind: z.enum(DDR_FACTOR_KIND_VALUES),
  severity: z.enum(DDR_FACTOR_SEVERITY_VALUES),
  /** Short human reason, e.g. "Concentrated minter expanded supply +38% into the break". */
  label: z.string(),
});
export type DdrFactor = z.infer<typeof DdrFactorSchema>;

export const DdrResolutionSchema = z.object({
  tier: z.enum(DDR_RESOLUTION_TIER_VALUES),
  factors: z.array(DdrFactorSchema),
  /** Populated only for insufficient_signal: which inputs were missing. */
  insufficientReasons: z.array(z.string()).optional(),
});
export type DdrResolution = z.infer<typeof DdrResolutionSchema>;

// --- Stage 2: duration -----------------------------------------------------

export const DDR_HORIZON_VALUES = ["6h", "24h", "7d", "30d"] as const;
export type DdrHorizon = (typeof DDR_HORIZON_VALUES)[number];

export const DDR_CELL_STATE_VALUES = [
  "benchmarked",
  "thin_support",
  "no_comparable_closures",
  "chronic_tail",
  "unsupported",
  "data_issue",
] as const;
export type DdrCellState = (typeof DDR_CELL_STATE_VALUES)[number];

export const DdrHorizonCellSchema = z.object({
  horizon: z.enum(DDR_HORIZON_VALUES),
  state: z.enum(DDR_CELL_STATE_VALUES),
  /** 0..1 weighted resolution probability within the horizon, or null when not displayable. */
  probability: z.number().min(0).max(1).nullable(),
  /** Public interval text derived from the Wilson bounds, e.g. "35-55%". */
  probabilityDisplay: z.string().nullable(),
  probabilityInterval: z.object({ lower: z.number(), upper: z.number() }).nullable(),
  // transparency counts
  rawAtRisk: z.number().int().nonnegative(),
  uniqueCoins: z.number().int().nonnegative(),
  intervalClosures: z.number().int().nonnegative(),
  intervalNonClosures: z.number().int().nonnegative(),
});
export type DdrHorizonCell = z.infer<typeof DdrHorizonCellSchema>;

export const DDR_AGE_STATUS_VALUES = ["ordinary", "extended", "chronic_tail", "data_issue"] as const;

export const DDR_DURATION_BAND_META = {
  label: "typical_range",
  lowerPercentile: 15,
  upperPercentile: 85,
} as const;

export const DdrDurationBandMetaSchema = z.object({
  label: z.literal(DDR_DURATION_BAND_META.label),
  lowerPercentile: z.literal(DDR_DURATION_BAND_META.lowerPercentile),
  upperPercentile: z.literal(DDR_DURATION_BAND_META.upperPercentile),
});

export const DdrDurationSchema = z.object({
  /** True when Stage 2 is not shown (terminal verdict or insufficient support). */
  suppressed: z.boolean(),
  suppressedReason: z.string().nullable().optional().default(null),
  /** Human stratum label actually used, e.g. "below · severe · USD". */
  stratum: z.string().nullable().optional().default(null),
  /** Median time-to-repeg of comparable recovered incidents, seconds. */
  medianSec: z.number().nullable().optional().default(null),
  /** Typical range [p15, p85], seconds. The legacy field name remains for API compatibility. */
  iqrSec: z.tuple([z.number().nonnegative(), z.number().nonnegative()]).nullable().optional().default(null),
  ageStatus: z.enum(DDR_AGE_STATUS_VALUES).nullable().optional().default(null),
  horizons: z.array(DdrHorizonCellSchema),
});
export type DdrDuration = z.infer<typeof DdrDurationSchema>;

// --- Row + related context -------------------------------------------------

export const DdrRelatedContextSchema = z.object({
  dewsBand: z.string().nullable().optional().default(null),
  dewsScore: z.number().nullable().optional().default(null),
  liquidityScore: z.number().nullable().optional().default(null),
  safetyGrade: z.string().nullable().optional().default(null),
  safetyScore: z.number().nullable().optional().default(null),
  safetyContext: z.object({
    status: z.enum(["v9-identified", "identity-missing", "identity-mismatch", "unsupported-model", "cache-unavailable"]),
    reason: z.string().nullable(),
    identity: SafetyScorePublicationIdentitySchema.nullable(),
  }).optional(),
  supplyChange7dPct: z.number().nullable().optional().default(null),
  supplyChange30dPct: z.number().nullable().optional().default(null),
  /** Abnormal mint expansion into the break (the USR tell); null when supply coverage is missing. */
  mintSurge: z.boolean().nullable().optional().default(null),
});

const DdrSealedRelatedContextSchema = DdrRelatedContextSchema.extend({
  safetyContext: z.object({
    status: z.union([
      DdrRelatedContextSchema.shape.safetyContext.unwrap().shape.status,
      z.string().regex(/^[a-z0-9]+-identified$/),
    ]),
    reason: z.string().nullable(),
    identity: SafetyScorePublicationIdentitySchema.nullable(),
  }).optional(),
});

export const DdrRowSchema = z.object({
  stablecoinId: z.string(),
  symbol: z.string(),
  name: z.string(),
  pegCurrency: z.string(),
  governance: z.string(),
  /** active | frozen — frozen with an open event is itself terminal context. */
  status: z.string().nullable().optional().default(null),
  eventId: z.number(),
  startedAt: z.number(),
  ageSec: z.number().int().nonnegative(),
  direction: DepegDirectionSchema,
  peakDeviationBps: z.number(),
  currentDeviationBps: z.number().nullable().optional().default(null),
  resolution: DdrResolutionSchema,
  duration: DdrDurationSchema,
  relatedContext: DdrRelatedContextSchema,
});
export type DdrRow = z.infer<typeof DdrRowSchema>;

// --- Response envelope -----------------------------------------------------

export const DDR_PUBLIC_WARNING =
  "Forecast from Pharos historical data. Not investment advice or a credit rating.";

export const DDR_ASSESSMENT_CHECKPOINT_VALUES = [
  "first",
  "age_1h",
  "age_6h",
  "age_24h",
  "age_7d",
  "latest",
  "public_prediction",
] as const;
export type DdrAssessmentCheckpoint = (typeof DDR_ASSESSMENT_CHECKPOINT_VALUES)[number];

export const DDR_PUBLIC_PREDICTION_STATE_VALUES = [
  "pending_lock",
  "lock_deferred",
  "publication_retry_pending",
  "frozen",
  "no_call",
  "invalidated",
] as const;
export type DdrPublicPredictionState = (typeof DDR_PUBLIC_PREDICTION_STATE_VALUES)[number];

export const DDR_LOCK_TIMING_VALUES = ["on_time", "late_confirmation", "late_freeze", "deferred"] as const;
export type DdrLockTiming = (typeof DDR_LOCK_TIMING_VALUES)[number];

export const DDR_LOCK_TRIGGER_VALUES = ["scheduled_24h", "forecast_readiness", "readiness_backstop"] as const;
export type DdrLockTrigger = (typeof DDR_LOCK_TRIGGER_VALUES)[number];

export const DDR_FORECAST_READINESS_COMPONENT_VALUES = [
  "input_coverage",
  "resolution_signal",
  "duration_support",
  "observation_maturity",
] as const;
export type DdrForecastReadinessComponentKey = (typeof DDR_FORECAST_READINESS_COMPONENT_VALUES)[number];

export const DdrForecastReadinessComponentSchema = z.object({
  key: z.enum(DDR_FORECAST_READINESS_COMPONENT_VALUES),
  label: z.string(),
  score: z.number().min(0).max(1),
  weight: z.number().positive(),
  reason: z.string(),
});
export type DdrForecastReadinessComponent = z.infer<typeof DdrForecastReadinessComponentSchema>;

export const DdrForecastReadinessSchema = z.object({
  version: z.string(),
  score: z.number().min(0).max(1),
  threshold: z.number().min(0).max(1),
  strictEarlyLockReady: z.boolean(),
  reasons: z.array(z.string()),
  components: z.array(DdrForecastReadinessComponentSchema),
});
export type DdrForecastReadiness = z.infer<typeof DdrForecastReadinessSchema>;

export const DdrForecastReadinessBackstopSchema = z.object({
  version: z.string(),
  delaySec: z.number().int().nonnegative(),
  backstopAt: z.number().int().nonnegative().nullable().optional().default(null),
  reached: z.boolean().optional().default(false),
});
export type DdrForecastReadinessBackstop = z.infer<typeof DdrForecastReadinessBackstopSchema>;

export const DDR_ERRATUM_REASON_VALUES = [
  "false_positive",
  "disputed",
  "no_data",
  "event_identity_error",
  "input_corruption",
  "lifecycle_status_error",
  "implementation_bug",
  "hash_mismatch",
] as const;

export const DdrLineageSchema = z.object({
  trainingWindow: z.object({ start: z.number(), end: z.number() }),
  eventCount: z.number().int().nonnegative(),
  incidentCount: z.number().int().nonnegative(),
  coinCount: z.number().int().nonnegative(),
  quarantinedCoins: z.number().int().nonnegative(),
});
export type DdrLineage = z.infer<typeof DdrLineageSchema>;

export const DdrPredictionErratumSchema = z.object({
  id: z.number().int().positive(),
  state: z.literal("invalidated"),
  publicPredictionId: z.number().int().positive(),
  incidentKey: z.string(),
  eventId: z.number().int().positive(),
  assessmentId: z.number().int().positive(),
  reason: z.enum(DDR_ERRATUM_REASON_VALUES),
  createdAt: z.number().int().positive(),
  operatorNote: z.string(),
  rowHashBefore: z.string().nullable(),
  replacementAssessmentId: z.number().int().positive().nullable(),
  replacementRowHash: z.string().nullable(),
  createdBy: z.string(),
});
export type DdrPredictionErratum = z.infer<typeof DdrPredictionErratumSchema>;

export const DdrPredictionMetaSchema = z.object({
  state: z.enum(DDR_PUBLIC_PREDICTION_STATE_VALUES),
  publicPredictionId: z.number().int().positive().nullable(),
  incidentKey: z.string(),
  predictionPolicyVersion: z.string(),
  predictionMethodologyVersion: z.string().nullable(),
  predictionMethodologyVersionLabel: z.string().nullable(),
  resolutionRubricVersion: z.string().nullable(),
  durationModelVersion: z.string().nullable(),
  incidentGroupingVersion: z.string().nullable(),
  supportRulesVersion: z.string().nullable(),
  eligibleAt: z.number().int().nonnegative(),
  policyDelaySec: z.number().int().nonnegative().optional().default(24 * 3600),
  lockedAt: z.number().int().nonnegative().nullable(),
  publishedAt: z.number().int().nonnegative().nullable(),
  publicationSnapshotToken: z.string().nullable(),
  snapshotGeneration: z.number().int().positive().nullable(),
  eventAgeAtLockSec: z.number().int().nonnegative().nullable(),
  lockTiming: z.enum(DDR_LOCK_TIMING_VALUES).nullable(),
  lockTrigger: z.enum(DDR_LOCK_TRIGGER_VALUES).optional().default("scheduled_24h"),
  readiness: DdrForecastReadinessSchema.nullable().optional().default(null),
  backstop: DdrForecastReadinessBackstopSchema.nullable().optional().default(null),
  source: z.enum(["public_prediction", "pending", "erratum"]),
  deferralReason: z.string().nullable(),
  deferralCount: z.number().int().nonnegative().nullable(),
  rowHash: z.string().nullable(),
  lineage: DdrLineageSchema.nullable(),
  modelAsOf: z.number().int().nonnegative().nullable(),
  latestErratum: DdrPredictionErratumSchema.nullable(),
  errataCount: z.number().int().nonnegative(),
  errataHistory: z.array(DdrPredictionErratumSchema),
});
export type DdrPredictionMeta = z.infer<typeof DdrPredictionMetaSchema>;

export const DdrAnchoredHorizonCellSchema = DdrHorizonCellSchema.extend({
  horizonEndAt: z.number().int().nonnegative(),
  anchoredLabel: z.string(),
});

export const DdrFrozenDurationSchema = DdrDurationSchema.extend({
  remainingAsOf: z.number().int().nonnegative(),
  medianResolveAt: z.number().int().nonnegative().nullable(),
  iqrResolveAt: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).nullable(),
  horizons: z.array(DdrAnchoredHorizonCellSchema),
});

export const DdrV2BaseRowSchema = z.object({
  stablecoinId: z.string(),
  symbol: z.string(),
  name: z.string(),
  pegCurrency: z.string(),
  governance: z.string(),
  status: z.string().nullable(),
  eventId: z.number().int().positive(),
  incidentKey: z.string(),
  startedAt: z.number().int().nonnegative(),
  direction: DepegDirectionSchema,
});

export const DdrV2LiveOverlaySchema = z.object({
  currentEventId: z.number().int().positive().nullable(),
  ageSec: z.number().int().nonnegative(),
  peakDeviationBps: z.number(),
  currentDeviationBps: z.number().nullable(),
  eventState: z.enum(["active", "closed_pending_review", "source_event_missing", "event_invalidated"]),
  updatedAt: z.number().int().nonnegative(),
  stale: z.boolean(),
  degradedReason: z.string().nullable(),
});
export type DdrV2LiveOverlay = z.infer<typeof DdrV2LiveOverlaySchema>;

export const DdrV2FrozenPayloadSchema = z.object({
  resolution: DdrResolutionSchema,
  duration: DdrFrozenDurationSchema,
  relatedContext: DdrSealedRelatedContextSchema,
  sourceRow: DdrRowSchema.extend({
    relatedContext: DdrSealedRelatedContextSchema,
  }),
});

export const DdrV2NoCallPayloadSchema = z.object({
  lockedAt: z.number().int().nonnegative(),
  eventAgeAtLockSec: z.number().int().nonnegative(),
  missingReasons: z.array(z.string()),
  relatedContext: DdrSealedRelatedContextSchema,
});

export const DdrOfficialLockOutcomeSchema = z.union([DdrV2FrozenPayloadSchema, DdrV2NoCallPayloadSchema]);
export type DdrOfficialLockOutcome = z.infer<typeof DdrOfficialLockOutcomeSchema>;

export const DdrV2PendingRowSchema = DdrV2BaseRowSchema.extend({
  kind: z.literal("pending"),
  prediction: DdrPredictionMetaSchema.extend({
    state: z.enum(["pending_lock", "lock_deferred", "publication_retry_pending"]),
  }),
  frozen: z.null(),
});

export const DdrV2PredictionRowSchema = DdrV2BaseRowSchema.extend({
  kind: z.literal("prediction"),
  prediction: DdrPredictionMetaSchema.extend({ state: z.literal("frozen") }),
  frozen: DdrV2FrozenPayloadSchema,
});
export type DdrV2PredictionRow = z.infer<typeof DdrV2PredictionRowSchema>;

export const DdrV2NoCallRowSchema = DdrV2BaseRowSchema.extend({
  kind: z.literal("no_call"),
  prediction: DdrPredictionMetaSchema.extend({ state: z.literal("no_call") }),
  noCall: DdrV2NoCallPayloadSchema,
  frozen: z.null(),
});

export const DdrV2InvalidatedPredictionRowSchema = DdrV2BaseRowSchema.extend({
  kind: z.literal("invalidated_prediction"),
  prediction: DdrPredictionMetaSchema.extend({ state: z.literal("invalidated") }),
  originalKind: z.enum(["prediction", "no_call"]),
  originalOutcome: DdrOfficialLockOutcomeSchema,
  frozen: DdrV2FrozenPayloadSchema.nullable(),
  noCall: DdrV2NoCallPayloadSchema.nullable(),
});

export const DdrV2RowSchema = z.discriminatedUnion("kind", [
  DdrV2PendingRowSchema,
  DdrV2PredictionRowSchema,
  DdrV2NoCallRowSchema,
  DdrV2InvalidatedPredictionRowSchema,
]);
export type DdrV2Row = z.infer<typeof DdrV2RowSchema>;

export const DdrV2ResponseRowSchema = z.discriminatedUnion("kind", [
  DdrV2PendingRowSchema.extend({ live: DdrV2LiveOverlaySchema }),
  DdrV2PredictionRowSchema.extend({ live: DdrV2LiveOverlaySchema }),
  DdrV2NoCallRowSchema.extend({ live: DdrV2LiveOverlaySchema }),
  DdrV2InvalidatedPredictionRowSchema.extend({ live: DdrV2LiveOverlaySchema }),
]);
export type DdrV2ResponseRow = z.infer<typeof DdrV2ResponseRowSchema>;

export const DdrReadOverlaySchema = z.object({
  degradedLockDeferralIncidentKeys: z.array(z.string()).optional().default([]),
  closedPendingReviewIncidentKeys: z.array(z.string()).optional().default([]),
  suppressedIncidentKeys: z.array(z.string()).optional().default([]),
});
export type DdrReadOverlay = z.infer<typeof DdrReadOverlaySchema>;

export const DDR_EMPTY_READ_OVERLAY: DdrReadOverlay = {
  degradedLockDeferralIncidentKeys: [],
  closedPendingReviewIncidentKeys: [],
  suppressedIncidentKeys: [],
};

export const DdrMetaSchema = z.object({
  schemaVersion: z.literal(2),
  dataAsOf: z.number(),
  modelAsOf: z.number(),
  computedAt: z.number(),
  expiresAt: z.number(),
  snapshotToken: z.string().nullable(),
  snapshotGeneration: z.number().int().positive().nullable(),
  publicPredictionIds: z.array(z.number().int().positive()),
  publicPredictionRowHashes: z.record(z.string(), z.string()),
  basePayloadHash: z.string().nullable(),
  readOverlay: DdrReadOverlaySchema.optional().default(DDR_EMPTY_READ_OVERLAY),
  degraded: z.boolean(),
  degradedReason: z.string().nullable().optional().default(null),
  publicWarning: z.string(),
  resolutionRubricVersion: z.string(),
  durationModelVersion: z.string(),
  /** Semantics of legacy `iqrSec` duration fields for this response. */
  durationBand: DdrDurationBandMetaSchema.optional(),
  incidentGroupingVersion: z.string(),
  supportRulesVersion: z.string(),
  lineage: DdrLineageSchema.nullable().optional().default(null),
});
export type DdrMeta = z.infer<typeof DdrMetaSchema>;

export const DdrResponseSchema = z.object({
  _meta: DdrMetaSchema,
  rows: z.array(DdrV2ResponseRowSchema),
  methodology: MethodologyEnvelopeSchema,
});
export type DdrResponse = z.infer<typeof DdrResponseSchema>;
