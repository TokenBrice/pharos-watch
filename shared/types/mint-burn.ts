import { z } from "zod";
import { NET_FLOW_DIRECTION_24H_VALUES, PRESSURE_SHIFT_STATE_VALUES } from "./mint-burn-signals";
import { SafetyScorePublicationIdentitySchema } from "./safety-score-publication";

export {
  NET_FLOW_DIRECTION_24H_VALUES,
  PRESSURE_SHIFT_STATE_VALUES,
  type NetFlowDirection24h,
  type PressureShiftState,
} from "./mint-burn-signals";

const SignedFlowIntensitySchema = z.number().min(-100).max(100);
const PressureShiftStateSchema = z.enum(PRESSURE_SHIFT_STATE_VALUES);
const NetFlowDirection24hSchema = z.enum(NET_FLOW_DIRECTION_24H_VALUES);

const MintBurnGaugeSchema = z.object({
  score: SignedFlowIntensitySchema.nullable(),
  band: z.string().nullable(),
  intensitySemantics: z.enum(["midpoint-v1", "signed-v2"]).optional(),
  flightToQuality: z.boolean(),
  flightIntensity: z.number().finite(),
  // The retired cache label is accepted for rolling/historical payload reads.
  classificationSource: z
    .enum(["safety-score-v9-publication", "report-card-cache", "unavailable"])
    .optional(),
  safetyScoreIdentity: SafetyScorePublicationIdentitySchema.nullable().optional(),
  trackedCoins: z.number().int().nonnegative(),
  trackedMcapUsd: z.number().finite().nonnegative(),
});
export type MintBurnGauge = z.infer<typeof MintBurnGaugeSchema>;

const MintBurnScopeSchema = z.object({
  chainIds: z.array(z.string()),
  label: z.string(),
});

const MintBurnSyncSchema = z.object({
  lastSuccessfulSyncAt: z.number().nullable(),
  freshnessStatus: z.enum(["fresh", "degraded", "stale"]),
  warning: z.string().nullable(),
  classificationWarning: z.string().nullable().optional(),
  criticalLaneHealthy: z.boolean(),
});

const MintBurnCoverageStatusSchema = z.enum([
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

const MintBurnCoinFlowSchema = z.object({
  stablecoinId: z.string(),
  symbol: z.string(),
  flowIntensity: SignedFlowIntensitySchema.nullable(),
  pressureShiftScore: SignedFlowIntensitySchema.nullable().optional(),
  pressureShiftState: PressureShiftStateSchema.optional(),
  netFlowDirection24h: NetFlowDirection24hSchema.optional(),
  has24hActivity: z.boolean().optional(),
  baselineDailyNetUsd: z.number().nullable().optional(),
  baselineDailyAbsUsd: z.number().nullable().optional(),
  baselineDataDays: z.number().nullable().optional(),
  netFlow24hUsd: z.number().finite(),
  mintVolume24hUsd: z.number().finite().nonnegative(),
  burnVolume24hUsd: z.number().finite().nonnegative(),
  mintCount24h: z.number().int().nonnegative(),
  burnCount24h: z.number().int().nonnegative(),
  netFlow7dUsd: z.number().finite(),
  netFlow30dUsd: z.number().finite(),
  netFlow90dUsd: z.number().finite(),
  largestEvent24h: z
    .object({
      direction: z.enum(["mint", "burn"]),
      amountUsd: z.number(),
      txHash: z.string(),
      timestamp: z.number(),
    })
    .nullable(),
  coverage: MintBurnCoinCoverageSchema.optional(),
});
export type MintBurnCoinFlow = z.infer<typeof MintBurnCoinFlowSchema>;

const MintBurnHourlyBucketSchema = z.object({
  hourTs: z.number().int().nonnegative(),
  netFlowUsd: z.number().finite(),
  mintVolumeUsd: z.number().finite().nonnegative(),
  burnVolumeUsd: z.number().finite().nonnegative(),
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
  netFlow24hUsd: z.number().finite(),
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
  netFlowUsd: z.number().finite(),
});

export const MintBurnPerCoinResponseSchema = z.object({
  stablecoinId: z.string(),
  symbol: z.string(),
  mintVolumeUsd: z.number().finite().nonnegative(),
  burnVolumeUsd: z.number().finite().nonnegative(),
  netFlowUsd: z.number().finite(),
  mintCount: z.number().int().nonnegative(),
  burnCount: z.number().int().nonnegative(),
  chains: z.array(MintBurnPerCoinChainSchema),
  hourly: z.array(MintBurnHourlyBucketSchema),
  updatedAt: z.number(),
  windowHours: z.number().int().positive().optional(),
  scope: MintBurnScopeSchema.optional(),
  sync: MintBurnSyncSchema.optional(),
});
export type MintBurnPerCoinResponse = z.infer<typeof MintBurnPerCoinResponseSchema>;

const MintBurnFlowTypeSchema = z.enum(["standard", "atomic_roundtrip", "bridge_transfer"]);

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
