import { z } from "zod";
import { NET_FLOW_DIRECTION_24H_VALUES, PRESSURE_SHIFT_STATE_VALUES } from "./mint-burn-signals";
import { SafetyScorePublicationIdentitySchema } from "./safety-score-publication";
import { ApiMetaEnvelopeSchema, FreshnessStatusSchema } from "@pharos/contracts/api-meta";

export {
  NET_FLOW_DIRECTION_24H_VALUES,
  PRESSURE_SHIFT_STATE_VALUES,
  type NetFlowDirection24h,
  type PressureShiftState,
} from "./mint-burn-signals";

const SignedFlowIntensitySchema = z.number().min(-100).max(100);
const PressureShiftStateSchema = z.enum(PRESSURE_SHIFT_STATE_VALUES);
const NetFlowDirection24hSchema = z.enum(NET_FLOW_DIRECTION_24H_VALUES);

/**
 * USD valuation completeness of a flow window (or one side of it).
 * - `complete`: every counted event carried a USD valuation, including an empty observed subtotal.
 *   Exact totals and genuine zero activity additionally require independent complete scan proof.
 * - `partial`: counted events without a USD valuation exist. Mint/burn volumes are known-subtotal lower
 *   bounds; the known signed net is a one-sided bound only when exactly one side is partial.
 * - `unknown`: part of the window was aggregated before valuation completeness was recorded.
 */
export const MINT_BURN_VALUATION_COMPLETENESS_VALUES = ["complete", "partial", "unknown"] as const;
export const MintBurnValuationCompletenessSchema = z.enum(MINT_BURN_VALUATION_COMPLETENESS_VALUES);
export type MintBurnValuationCompleteness = z.infer<typeof MintBurnValuationCompletenessSchema>;

/** Window valuation: `partial` wins over `unknown`, which wins over `complete`. */
export const MintBurnValuationSchema = z.object({
  completeness: MintBurnValuationCompletenessSchema,
  mintCompleteness: MintBurnValuationCompletenessSchema,
  burnCompleteness: MintBurnValuationCompletenessSchema,
  /** Counted mints without a USD valuation, in hours whose coverage was recorded (a lower bound when `mintCompleteness` is `unknown`). */
  unpricedMintEventCount: z.number().int().nonnegative(),
  /** Counted effective burns without a USD valuation, in hours whose coverage was recorded. */
  unpricedBurnEventCount: z.number().int().nonnegative(),
});
export type MintBurnValuation = z.infer<typeof MintBurnValuationSchema>;

/**
 * Proven one-sided bound on a withheld signed net (mint-burn-flow v6.25). Unpriced mints can only
 * raise the true net (`lower`: net ≥ valueUsd); unpriced burns can only lower it (`upper`: net ≤
 * valueUsd). Published only when exactly one side is partial; never the net itself.
 */
export const MintBurnSignedNetBoundSchema = z.object({
  kind: z.enum(["lower", "upper"]),
  valueUsd: z.number().finite(),
});
export type MintBurnSignedNetBound = z.infer<typeof MintBurnSignedNetBoundSchema>;

/** Market-wide FTQ dependency; coin flow totals do not consume Safety Scores. */
export const MINT_BURN_FTQ_DEPENDENCY_KEY = "flightToQuality";

export const MintBurnScanWindowSchema = z.object({
  complete: z.boolean(),
  unavailableReason: z.literal("scan-coverage-incomplete").nullable(),
  provenance: z.enum(["durable-v2", "legacy-pre-cutover"]).optional(),
});
export type MintBurnScanWindow = z.infer<typeof MintBurnScanWindowSchema>;

export const MintBurnWatermarkSchema = z.object({
  timestamp: z.number().int().nonnegative().nullable(),
  ageSec: z.number().nonnegative().nullable(),
  maxAgeSec: z.number().positive(),
  unavailableReason: z.enum(["scan-watermark-stale", "scan-watermark-unavailable"]).nullable(),
});
export type MintBurnWatermark = z.infer<typeof MintBurnWatermarkSchema>;

export const MintBurnPublicationSchema = z.object({
  evaluatedAt: z.number().int().nonnegative(),
  requiredBaselineSec: z.number().int().positive(),
  freshnessBudgetSec: z.number().positive(),
  legs: z.array(z.object({
    configKey: z.string(),
    configFingerprint: z.string(),
    stablecoinId: z.string(),
    chainId: z.string(),
    status: z.enum(["admitted", "pending-admission", "disabled"]),
    reason: z.enum(["legacy-grandfathered", "baseline-incomplete", "frontier-stale", "proof-unavailable", "valuation-incomplete", "operator-disabled", "shared-bucket-disabled", "unsupported-shared-bucket", "reactivation-pending"]).nullable(),
    admittedAt: z.number().int().nonnegative().nullable(),
    baselineFrom: z.number().int().nonnegative().nullable(),
    baselineTo: z.number().int().nonnegative().nullable(),
    coveredSeconds: z.number().nonnegative().nullable(),
    frontierAgeSec: z.number().nonnegative().nullable(),
  })),
});
export type MintBurnPublication = z.infer<typeof MintBurnPublicationSchema>;
const MintBurnGaugeSchema = z.object({
  score: SignedFlowIntensitySchema.nullable(),
  band: z.string().nullable(),
  intensitySemantics: z.literal("signed-v2"),
  /** `null` when classification is unavailable or missing valuation can alter the conclusion. */
  flightToQuality: z.boolean().nullable(),
  flightIntensity: z.number().finite().nullable(),
  /** Score is the observed admitted-member composite, not a full-roster claim. */
  scoreScope: z.literal("admitted-coins").optional(),
  scanCoverage: MintBurnScanWindowSchema.extend({
    admittedCoins: z.number().int().nonnegative().optional(),
    excludedCoins: z.number().int().nonnegative().optional(),
    excludedMcapUsd: z.number().nonnegative().nullable().optional(),
  }).optional(),
  // The retired cache label is accepted for rolling/historical payload reads.
  classificationSource: z
    .enum(["safety-score-v9-publication", "report-card-cache", "unavailable"])
    .optional(),
  safetyScoreIdentity: SafetyScorePublicationIdentitySchema.nullable().optional(),
  /** Machine-readable classification failure, independent of USD valuation gating. */
  classificationReason: z.string().nullable().optional(),
  trackedCoins: z.number().int().nonnegative(),
  /** Sum of observed tracked-chain supply; coins counted in `mcapUnavailableCoins` are excluded, not zeroed. */
  trackedMcapUsd: z.number().finite().nonnegative(),
  /**
   * Tracked coins whose supply weight was unavailable, excluded from the gauge weights and
   * `trackedMcapUsd`. Absent on payloads produced before the count existed (count unknown).
   */
  mcapUnavailableCoins: z.number().int().nonnegative().optional(),
  /**
   * Weighted coins whose valuation can alter `score`. Since mint-burn-flow v6.23 these are coins with
   * 24h activity and at least seven days of baseline history whose pressure is withheld because the 24h window is not `complete`
   * or the baseline is `partial`; `score` re-weights over the remaining coins, so any positive count
   * means it is not the full-cohort composite. Before v6.23 the count named partial inputs that
   * entered `score`. Absent on payloads produced before valuation completeness existed (unknown).
   */
  partialValuationInputs: z.number().int().nonnegative().optional(),
  /** Observed weight of the coins counted in `partialValuationInputs`. Absent before v6.23. */
  partialValuationMcapUsd: z.number().finite().nonnegative().optional(),
  /**
   * Observed weight of the coins whose pressure entered `score` (its re-weighting denominator).
   * With `partialValuationMcapUsd` it bounds the full-cohort score. Absent before v6.23.
   */
  scoredMcapUsd: z.number().finite().nonnegative().optional(),
});
export type MintBurnGauge = z.infer<typeof MintBurnGaugeSchema>;

const MintBurnScopeSchema = z.object({
  chainIds: z.array(z.string()),
  label: z.string(),
});

const MintBurnSyncSchema = z.object({
  lastSuccessfulSyncAt: z.number().nullable(),
  freshnessStatus: FreshnessStatusSchema,
  warning: z.string().nullable(),
  classificationWarning: z.string().nullable().optional(),
  criticalLaneHealthy: z.boolean(),
});

export const MintBurnCoverageStatusSchema = z.enum([
  "full",
  "partial-history",
  "lagging",
  "bootstrapping",
  "unknown",
  "disabled",
]);
export type MintBurnCoverageStatus = z.infer<typeof MintBurnCoverageStatusSchema>;


const MintBurnCoinCoverageSchema = z.object({
  startBlock: z.number(),
  lastSyncedBlock: z.number().nullable(),
  lagBlocks: z.number().nullable(),
  historyStartAt: z.number().nullable(),
  has24hWindow: z.boolean(),
  has7dWindow: z.boolean().optional(),
  has30dWindow: z.boolean(),
  has90dWindow: z.boolean(),
  isPartial: z.boolean(),
  adapterKinds: z.array(z.string()).optional(),
  startBlockSource: z.string().optional(),
  startBlockConfidence: z.enum(["high", "medium", "low"]).optional(),
  status: MintBurnCoverageStatusSchema,
  unavailableReason: z.enum(["cron-snapshot-unavailable", "scan-coverage-incomplete"]).nullable().optional(),
  provenance: z.enum(["durable-v2", "legacy-pre-cutover"]).optional(),
  windows: z.object({
    window24h: MintBurnScanWindowSchema,
    window7d: MintBurnScanWindowSchema,
    window30d: MintBurnScanWindowSchema,
    window90d: MintBurnScanWindowSchema,
  }).optional(),
});
export type MintBurnCoinCoverage = z.infer<typeof MintBurnCoinCoverageSchema>;

/**
 * Per-coin valuation completeness. `window24h` qualifies the 24h volumes, net, direction and (with
 * `baseline`) the pressure shift; the `netFlow*` entries qualify the matching window nets.
 */
const MintBurnCoinValuationSchema = z.object({
  window24h: MintBurnValuationSchema,
  baseline: MintBurnValuationCompletenessSchema,
  netFlow7d: MintBurnValuationCompletenessSchema,
  netFlow30d: MintBurnValuationCompletenessSchema,
  netFlow90d: MintBurnValuationCompletenessSchema,
  /** One-sided bound on a withheld window net; `null` when none is proven. Absent before v6.25. */
  netFlow7dBound: MintBurnSignedNetBoundSchema.nullable().optional(),
  netFlow30dBound: MintBurnSignedNetBoundSchema.nullable().optional(),
  netFlow90dBound: MintBurnSignedNetBoundSchema.nullable().optional(),
});

export const MintBurnCoinFlowSchema = z.object({
  stablecoinId: z.string(),
  symbol: z.string(),
  pressureShiftScore: SignedFlowIntensitySchema.nullable(),
  pressureShiftState: PressureShiftStateSchema,
  /** `null` when missing valuation or scan evidence leaves the direction unproven. */
  netFlowDirection24h: NetFlowDirection24hSchema.nullable(),
  /** Legacy reader safety gate: null unless the full 24h scan is proved. */
  has24hActivity: z.boolean().nullable(),
  /** Additive observation fact; false means no observed events, not proof of a quiet window. */
  observed24hActivity: z.boolean().optional(),
  baselineDailyNetUsd: z.number().nullable(),
  baselineDailyAbsUsd: z.number().nullable(),
  baselineDataDays: z.number().nullable(),
  /**
   * Observed tracked-chain supply weight the Bank Run Gauge applies to this coin (mint-burn-flow
   * v6.27). `null` when the weight is unavailable: the coin is excluded from the gauge and counted in
   * `gauge.mcapUnavailableCoins`, never weighted as zero. The coin moves `gauge.score` only when its
   * `pressureShiftScore` is non-null. Absent on payloads produced before the field existed.
   */
  gaugeWeightUsd: z.number().finite().nonnegative().nullable().optional(),
  /**
   * Signed nets are `null` when scan-window evidence is unavailable or valuation is `partial`
   * (a partial signed net is not a bound in either direction). An `unknown` valuation window
   * keeps its known-valuation net only when scan evidence admits it, labelled by `valuation`.
   */
  netFlow24hUsd: z.number().finite().nullable(),
  /** Observed gross subtotals: exact only with complete scan proof and matching `valuation` side. */
  mintVolume24hUsd: z.number().finite().nonnegative(),
  burnVolume24hUsd: z.number().finite().nonnegative(),
  mintCount24h: z.number().int().nonnegative(),
  /** Counts and gross volumes are observed subtotals, not a complete-history claim. */
  totalsSemantics: z.literal("observed-subtotals").optional(),
  burnCount24h: z.number().int().nonnegative(),
  netFlow7dUsd: z.number().finite().nullable(),
  netFlow30dUsd: z.number().finite().nullable(),
  netFlow90dUsd: z.number().finite().nullable(),
  largestEvent24h: z
    .object({
      direction: z.enum(["mint", "burn"]),
      amountUsd: z.number(),
      txHash: z.string(),
      timestamp: z.number(),
    })
    .nullable(),
  coverage: MintBurnCoinCoverageSchema.optional(),
  /** Absent on payloads produced before valuation completeness existed (unknown). */
  valuation: MintBurnCoinValuationSchema.optional(),
});
export type MintBurnCoinFlow = z.infer<typeof MintBurnCoinFlowSchema>;

const MintBurnHourlyBucketSchema = z.object({
  hourTs: z.number().int().nonnegative(),
  netFlowUsd: z.number().finite().nullable(),
  mintVolumeUsd: z.number().finite().nonnegative(),
  burnVolumeUsd: z.number().finite().nonnegative(),
  /** Absent on payloads produced before valuation completeness existed (unknown). */
  valuation: MintBurnValuationCompletenessSchema.optional(),
  scanCoverage: MintBurnScanWindowSchema.optional(),
});
export type MintBurnHourlyBucket = z.infer<typeof MintBurnHourlyBucketSchema>;

/**
 * Per-chain 24h net flow over the same tracked-pair universe as `coins`.
 * Published so consumers (daily digest) read one chain breakdown instead of
 * re-deriving one from a different universe. Optional: publications written
 * before the gauge unification do not carry it.
 */
const MintBurnAggregateChainSchema = z.object({
  chainId: z.string(),
  netFlow24hUsd: z.number().finite().nullable(),
  /** Absent on payloads produced before valuation completeness existed (unknown). */
  valuation: MintBurnValuationCompletenessSchema.optional(),
  scanCoverage: MintBurnScanWindowSchema.optional(),
});

const MintBurnHourlyWindowSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  semantics: z.literal("closed-utc-hours"),
  watermark: MintBurnWatermarkSchema.optional(),
});

export const MintBurnFlowsResponseSchema = z.object({
  publication: MintBurnPublicationSchema.optional(),
  gauge: MintBurnGaugeSchema,
  coins: z.array(MintBurnCoinFlowSchema),
  chains: z.array(MintBurnAggregateChainSchema).optional(),
  hourly: z.array(MintBurnHourlyBucketSchema),
  updatedAt: z.number(),
  windowHours: z.number().int().positive().optional(),
  /** Exact [start,end) UTC boundaries; absent on pre-cutover historical payloads. */
  window: MintBurnHourlyWindowSchema.optional(),
  scope: MintBurnScopeSchema.optional(),
  sync: MintBurnSyncSchema.optional(),
  _meta: ApiMetaEnvelopeSchema.optional(),
});
export type MintBurnFlowsResponse = z.infer<typeof MintBurnFlowsResponseSchema>;

const MintBurnPerCoinChainSchema = z.object({
  chainId: z.string(),
  mintVolumeUsd: z.number().finite().nonnegative(),
  burnVolumeUsd: z.number().finite().nonnegative(),
  mintCount: z.number().int().nonnegative(),
  burnCount: z.number().int().nonnegative(),
  netFlowUsd: z.number().finite().nullable(),
  valuation: MintBurnValuationSchema.optional(),
  scanCoverage: MintBurnScanWindowSchema.optional(),
});

export const MintBurnPerCoinResponseSchema = z.object({
  publication: MintBurnPublicationSchema.optional(),
  stablecoinId: z.string(),
  symbol: z.string(),
  mintVolumeUsd: z.number().finite().nonnegative(),
  burnVolumeUsd: z.number().finite().nonnegative(),
  netFlowUsd: z.number().finite().nullable(),
  mintCount: z.number().int().nonnegative(),
  burnCount: z.number().int().nonnegative(),
  chains: z.array(MintBurnPerCoinChainSchema),
  hourly: z.array(MintBurnHourlyBucketSchema),
  /** Qualifies the window totals. Absent on payloads produced before valuation completeness existed (unknown). */
  valuation: MintBurnValuationSchema.optional(),
  scanCoverage: MintBurnScanWindowSchema.optional(),
  totalsSemantics: z.literal("observed-subtotals").optional(),
  updatedAt: z.number(),
  windowHours: z.number().int().positive().optional(),
  window: MintBurnHourlyWindowSchema.optional(),
  scope: MintBurnScopeSchema.optional(),
  sync: MintBurnSyncSchema.optional(),
  _meta: ApiMetaEnvelopeSchema.optional(),
});
export type MintBurnPerCoinResponse = z.infer<typeof MintBurnPerCoinResponseSchema>;

const MintBurnFlowTypeSchema = z.enum(["standard", "atomic_roundtrip", "bridge_transfer", "protocol_internal"]);

const MintBurnEventSchema = z.object({
  id: z.string(),
  stablecoinId: z.string(),
  symbol: z.string(),
  chainId: z.string(),
  direction: z.enum(["mint", "burn"]),
  flowType: MintBurnFlowTypeSchema,
  burnType: z.enum(["effective_burn", "bridge_burn", "review_required"]).nullable(),
  burnReviewReason: z.string().nullable(),
  amount: z.number(),
  amountUsd: z.number().nullable(),
  priceUsed: z.number().nullable(),
  priceTimestamp: z.number().nullable(),
  priceSource: z.string().nullable(),
  counterparty: z.string().nullable(),
  txHash: z.string(),
  blockNumber: z.number(),
  timestamp: z.number(),
  explorerTxUrl: z.string(),
});
export type MintBurnEvent = z.infer<typeof MintBurnEventSchema>;

export const MintBurnEventsResponseSchema = z.object({
  events: z.array(MintBurnEventSchema),
  total: z.number(),
});
export type MintBurnEventsResponse = z.infer<typeof MintBurnEventsResponseSchema>;
