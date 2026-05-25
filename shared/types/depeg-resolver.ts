import { z } from "zod";
import { MethodologyEnvelopeSchema } from "./methodology-envelope";

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
export type DdrAgeStatus = (typeof DDR_AGE_STATUS_VALUES)[number];

export const DdrDurationSchema = z.object({
  /** True when Stage 2 is not shown (terminal verdict or insufficient support). */
  suppressed: z.boolean(),
  suppressedReason: z.string().nullable().optional().default(null),
  /** Human stratum label actually used, e.g. "below · severe · USD". */
  stratum: z.string().nullable().optional().default(null),
  /** Median time-to-repeg of comparable recovered incidents, seconds. */
  medianSec: z.number().nullable().optional().default(null),
  /** Interquartile band [p25, p75], seconds. */
  iqrSec: z.tuple([z.number(), z.number()]).nullable().optional().default(null),
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
  supplyChange7dPct: z.number().nullable().optional().default(null),
  supplyChange30dPct: z.number().nullable().optional().default(null),
  /** Abnormal mint expansion into the break (the USR tell); null when supply coverage is missing. */
  mintSurge: z.boolean().nullable().optional().default(null),
});
export type DdrRelatedContext = z.infer<typeof DdrRelatedContextSchema>;

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
  direction: z.enum(["above", "below"]),
  peakDeviationBps: z.number(),
  currentDeviationBps: z.number().nullable().optional().default(null),
  resolution: DdrResolutionSchema,
  duration: DdrDurationSchema,
  relatedContext: DdrRelatedContextSchema,
});
export type DdrRow = z.infer<typeof DdrRowSchema>;

// --- Response envelope -----------------------------------------------------

export const DDR_PUBLIC_WARNING =
  "Probabilistic estimate from Pharos historical data. Not investment advice or a credit rating.";

export const DdrLineageSchema = z.object({
  trainingWindow: z.object({ start: z.number(), end: z.number() }),
  eventCount: z.number().int().nonnegative(),
  incidentCount: z.number().int().nonnegative(),
  coinCount: z.number().int().nonnegative(),
  quarantinedCoins: z.number().int().nonnegative(),
});
export type DdrLineage = z.infer<typeof DdrLineageSchema>;

export const DdrMetaSchema = z.object({
  dataAsOf: z.number(),
  modelAsOf: z.number(),
  computedAt: z.number(),
  expiresAt: z.number(),
  degraded: z.boolean(),
  degradedReason: z.string().nullable().optional().default(null),
  publicWarning: z.string(),
  resolutionRubricVersion: z.string(),
  durationModelVersion: z.string(),
  incidentGroupingVersion: z.string(),
  supportRulesVersion: z.string(),
  lineage: DdrLineageSchema.nullable().optional().default(null),
});
export type DdrMeta = z.infer<typeof DdrMetaSchema>;

export const DdrResponseSchema = z.object({
  _meta: DdrMetaSchema,
  rows: z.array(DdrRowSchema),
  methodology: MethodologyEnvelopeSchema,
});
export type DdrResponse = z.infer<typeof DdrResponseSchema>;
