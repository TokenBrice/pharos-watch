import { z } from "zod";
import { NET_FLOW_DIRECTION_24H_VALUES, PRESSURE_SHIFT_STATE_VALUES } from "./mint-burn-signals";
import { SafetyScorePublicationIdentitySchema } from "./safety-score-publication";
import { FreshnessStatusSchema } from "./api-meta";

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
 * - `complete`: every counted event carried a USD valuation, so totals are exact. A window with no
 *   counted events is complete (genuine zero activity).
 * - `partial`: counted events without a USD valuation exist. Mint/burn volumes are known-subtotal lower
 *   bounds; a signed net is not a bound in either direction.
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

const MintBurnGaugeSchema = z.object({
  score: SignedFlowIntensitySchema.nullable(),
  band: z.string().nullable(),
  intensitySemantics: z.literal("signed-v2"),
  /** Nullable for valuation gating: `null` means missing valuation can alter the flight-to-quality conclusion. */
  flightToQuality: z.boolean().nullable(),
  flightIntensity: z.number().finite().nullable(),
  // The retired cache label is accepted for rolling/historical payload reads.
  classificationSource: z
    .enum(["safety-score-v9-publication", "report-card-cache", "unavailable"])
    .optional(),
  safetyScoreIdentity: SafetyScorePublicationIdentitySchema.nullable().optional(),
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
  has30dWindow: z.boolean(),
  has90dWindow: z.boolean(),
  isPartial: z.boolean(),
  adapterKinds: z.array(z.string()).optional(),
  startBlockSource: z.string().optional(),
  startBlockConfidence: z.enum(["high", "medium", "low"]).optional(),
  status: MintBurnCoverageStatusSchema,
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
});

const MintBurnCoinFlowSchema = z.object({
  stablecoinId: z.string(),
  symbol: z.string(),
  pressureShiftScore: SignedFlowIntensitySchema.nullable(),
  pressureShiftState: PressureShiftStateSchema,
  /** Nullable for valuation gating: `null` means missing valuation leaves the direction unproven. */
  netFlowDirection24h: NetFlowDirection24hSchema.nullable(),
  has24hActivity: z.boolean(),
  baselineDailyNetUsd: z.number().nullable(),
  baselineDailyAbsUsd: z.number().nullable(),
  baselineDataDays: z.number().nullable(),
  /**
   * Signed nets are `null` when the matching window valuation is `partial` (a partial signed net is
   * not a bound in either direction). An `unknown` window (legacy buckets aggregated before
   * completeness was recorded) keeps its known-valuation net, labelled by `valuation`.
   */
  netFlow24hUsd: z.number().finite().nullable(),
  /** Known-valuation subtotals: lower bounds unless the matching `valuation` side is `complete`. */
  mintVolume24hUsd: z.number().finite().nonnegative(),
  burnVolume24hUsd: z.number().finite().nonnegative(),
  mintCount24h: z.number().int().nonnegative(),
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
});

export const MintBurnFlowsResponseSchema = z.object({
  gauge: MintBurnGaugeSchema,
  coins: z.array(MintBurnCoinFlowSchema),
  chains: z.array(MintBurnAggregateChainSchema).optional(),
  hourly: z.array(MintBurnHourlyBucketSchema),
  updatedAt: z.number(),
  windowHours: z.number().int().positive().optional(),
  scope: MintBurnScopeSchema.optional(),
  sync: MintBurnSyncSchema.optional(),
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
});

export const MintBurnPerCoinResponseSchema = z.object({
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
  updatedAt: z.number(),
  windowHours: z.number().int().positive().optional(),
  scope: MintBurnScopeSchema.optional(),
  sync: MintBurnSyncSchema.optional(),
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
