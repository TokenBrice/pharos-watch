import { z } from "zod";
import { DexMeasuredExecutionPublicProfileSchema } from "./measured-execution";
import { DexExitRouteObservationsSchema, ExitRouteObservationCoverageSchema } from "./exit-route";
import { CoinProjectionMetadataSchema } from "./coin-projection";
import { DexExecutionCapabilityGateSchema } from "./dex-execution";
import { DexStoredAmmExecutionModelSchema } from "./dex-execution-legacy";

export const LiquidityPoolSourceFamilySchema = z.enum([
  "dl",
  "cg_onchain",
  "gecko_terminal",
  "dexscreener",
  "cg_tickers",
  "horizon",
  "aquarius",
  "tezos",
  "icon-balanced",
  "kava-swap",
  "osmosis-sqs",
  "noble-swap",
  "direct_api",
]);
export type LiquidityPoolSourceFamily = z.infer<typeof LiquidityPoolSourceFamilySchema>;

export const LiquidityCoverageClassSchema = z.enum(["primary", "mixed", "fallback", "legacy", "unobserved"]);
export type LiquidityCoverageClass = z.infer<typeof LiquidityCoverageClassSchema>;

/**
 * Why a published LiquidityScore is null (NR). The `activity-*` codes are the
 * DEC-19 volume-activity outcomes decided by `resolveVolumeActivityComponent`;
 * `no-retained-pools` marks a placeholder or scored row that retained no pool; the publisher
 * adds `invalid-coverage-evidence` when it quarantines a row's coverage.
 */
export const LiquidityScoreUnavailableReasonSchema = z.enum([
  "activity-coverage-below-floor",
  "activity-missing",
  "activity-stale",
  "activity-completeness-unknown",
  "no-retained-pools",
  "invalid-coverage-evidence",
]);
export type LiquidityScoreUnavailableReason = z.infer<typeof LiquidityScoreUnavailableReasonSchema>;

const LiquiditySourceMixEntrySchema = z.object({
  poolCount: z.number(),
  tvlUsd: z.number(),
});
export type LiquiditySourceMixEntry = z.infer<typeof LiquiditySourceMixEntrySchema>;

export const LiquiditySourceMixSchema = z.record(z.string(), LiquiditySourceMixEntrySchema);
export type LiquiditySourceMix = Record<string, LiquiditySourceMixEntry>;

/**
 * Eligibility of one pool's provider volume reading for the current window:
 * `measured` = an in-budget observation is present (zero is a valid measurement);
 * `stale` = an observation exists but is older than the freshness budget;
 * `missing` = no usable value, or no observation clock proving its window.
 */
const DexPoolVolumeStatusSchema = z.enum(["measured", "missing", "stale"]);
export type DexPoolVolumeStatus = z.infer<typeof DexPoolVolumeStatusSchema>;

/**
 * Aggregate completeness of one volume window over every retained contributing
 * pool (DEC-19). `complete` = every pool measured (a genuine measured zero stays
 * complete); `partial` = some measured, some missing/stale; `missing` = none
 * measured and at least one pool lacks an observation; `stale` = none measured
 * and every observation is past its budget; `unknown` = completeness cannot be
 * established (legacy row without a record, or an unreadable record).
 */
const DexVolumeCompletenessSchema = z.enum(["complete", "partial", "missing", "stale", "unknown"]);
export type DexVolumeCompleteness = z.infer<typeof DexVolumeCompletenessSchema>;

const DexVolumeAvailabilityReasonSchema = z.enum([
  "pool-observations-missing",
  "pool-observations-stale",
  "pool-observations-missing-and-stale",
  "legacy-completeness-unrecorded",
  "availability-record-unreadable",
]);
export type DexVolumeAvailabilityReason = z.infer<typeof DexVolumeAvailabilityReasonSchema>;

const nullableCount = z.number().int().nonnegative().nullable();
const nullableEpochSec = z.number().int().nonnegative().nullable();

/**
 * Availability record for one measured-volume window. The advertised measured
 * total (`totalVolume24hUsd` / `totalVolume7dUsd`, history `volume24h`) is a
 * number only when `completeness === "complete"`; otherwise it is null and
 * `partialGrossUsd` separately labels the sum of the admitted (in-budget)
 * observations that were present — observed volume over the admitted pools, a
 * lower bound, never the complete statistic. `admittedTvlUsd` /
 * `retainedTvlUsd` / `volumeCoverage` publish the bound with that statistic:
 * the admitted pools' share of the retained scoring TVL (liquidity v6.9;
 * absent on records written before it). Clock fields name the observation
 * window and admission budget that produced the verdict.
 */
const DexVolumeAvailabilitySchema = z
  .object({
    completeness: DexVolumeCompletenessSchema,
    reason: DexVolumeAvailabilityReasonSchema.nullable(),
    partialGrossUsd: z.number().finite().nonnegative().nullable(),
    measuredPoolCount: nullableCount,
    missingPoolCount: nullableCount,
    stalePoolCount: nullableCount,
    windowSec: z.number().int().positive(),
    asOfSec: nullableEpochSec,
    maxObservationAgeSec: z.number().int().positive().nullable(),
    oldestObservedAtSec: nullableEpochSec,
    newestObservedAtSec: nullableEpochSec,
    admittedTvlUsd: z.number().finite().nonnegative().nullable().optional(),
    retainedTvlUsd: z.number().finite().nonnegative().nullable().optional(),
    volumeCoverage: z.number().finite().min(0).max(1).nullable().optional(),
  })
  .superRefine((availability, ctx) => {
    if ((availability.completeness === "complete") !== (availability.reason === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "complete volume windows carry no reason; every other completeness carries one",
      });
    }
    if (availability.measuredPoolCount != null && availability.measuredPoolCount > 0 && availability.partialGrossUsd === null) {
      ctx.addIssue({
        code: "custom",
        path: ["partialGrossUsd"],
        message: "measured nonempty volume windows require an admitted sum",
      });
    }
  });
export type DexVolumeAvailability = z.infer<typeof DexVolumeAvailabilitySchema>;

/** Stored `volume_availability_json` record: one availability per persisted window. */
export const DexVolumeAvailabilityRecordSchema = z.object({
  "24h": DexVolumeAvailabilitySchema,
  "7d": DexVolumeAvailabilitySchema.optional(),
});
export type DexVolumeAvailabilityRecord = z.infer<typeof DexVolumeAvailabilityRecordSchema>;
/** Measured DEX volume windows published by the liquidity pipeline (the record's window keys). */
export type DexVolumeWindow = keyof DexVolumeAvailabilityRecord;

export const DexPoolVolumeObservationSchema = z.object({
  status: DexPoolVolumeStatusSchema,
  observedAtSec: nullableEpochSec,
});

const DexLiquidityPoolSchema = z.object({
  project: z.string(),
  chain: z.string(),
  tvlUsd: z.number(),
  symbol: z.string(),
  // Null when the pool has no in-budget 24h observation (DEC-19 producers).
  volumeUsd1d: z.number().nullable(),
  volumeUsd7d: z.number().nullable().optional(),
  // Absent on legacy rows: the reading's eligibility was not recorded.
  volumeObservation: DexPoolVolumeObservationSchema.optional(),
  poolType: z.string(),
  source: LiquidityPoolSourceFamilySchema.optional(),
  price: z.number().optional(),
  extra: z
    .object({
      amplificationCoefficient: z.number().optional(),
      balanceRatio: z.number().optional(),
      feeTier: z.number().optional(),
      effectiveTvl: z.number().optional(),
      organicFraction: z.number().optional(),
      pairQuality: z.number().optional(),
      stressIndex: z.number().optional(),
      isMetaPool: z.boolean().optional(),
      maturityDays: z.number().optional(),
      registryId: z.string().optional(),
      orderbookDepthUsd: z.number().nonnegative().optional(),
      orderbookDepthUpUsd: z.number().nonnegative().optional(),
      orderbookTvlBasis: z.enum(["volume-derived", "coingecko-depth-2pct-capped-by-volume"]).optional(),
      balanceDetails: z
        .array(
          z.object({
            symbol: z.string(),
            balancePct: z.number(),
            isTracked: z.boolean(),
          }),
        )
        .optional(),
      measurement: z
        .object({
          tvlMeasured: z.boolean().optional(),
          volumeMeasured: z.boolean().optional(),
          balanceMeasured: z.boolean().optional(),
          maturityMeasured: z.boolean().optional(),
          priceMeasured: z.boolean().optional(),
          synthetic: z.boolean().optional(),
          decayed: z.boolean().optional(),
          capped: z.boolean().optional(),
        })
        .optional(),
      executionCapabilityGate: DexExecutionCapabilityGateSchema.optional(),
      ammExecutionModel: DexStoredAmmExecutionModelSchema.optional(),
      measuredExecution: DexMeasuredExecutionPublicProfileSchema.optional(),
    })
    .optional(),
});
export type DexLiquidityPool = z.infer<typeof DexLiquidityPoolSchema>;

const DexPriceSourceSchema = z.object({
  protocol: z.string(),
  chain: z.string(),
  price: z.number(),
  tvl: z.number(),
});

export const LiquidityEvidenceClassSchema = z.enum([
  "unobserved",
  "measured",
  "partial_measured",
  "observed_unmeasured",
]);

export const DexDeploymentOutcomeSchema = z.enum(["observed_pools", "verified_no_pools", "provider_inaccessible"]);
export type DexDeploymentOutcome = z.infer<typeof DexDeploymentOutcomeSchema>;

const DexDeploymentCoverageSchema = z.object({
  observedPools: z.number().int().nonnegative(),
  verifiedNoPools: z.number().int().nonnegative(),
  providerInaccessible: z.number().int().nonnegative(),
  deployments: z.array(
    z.object({
      chain: z.string(),
      contractAddress: z.string(),
      outcome: DexDeploymentOutcomeSchema,
      providers: z.array(z.string()),
      reason: z.string(),
      observedPoolCount: z.number().int().nonnegative(),
      observedAt: z.number(),
      waiver: z
        .object({
          owner: z.string(),
          reason: z.string().nullable(),
          expiresAt: z.number(),
        })
        .nullable(),
    }),
  ),
});

const DexLiquidityDataSchema = z
  .object({
    warning: z.string().nullable().optional(),
    advisoryUnavailableReason: z.literal("dex-advisory-read-failed").nullable().optional(),
    unavailableReason: z.literal("invalid-coverage-evidence").nullable().optional(),
    totalTvlUsd: z.number(),
    // Full-window measured sums: null unless the matching availability is complete.
    totalVolume24hUsd: z.number().nullable(),
    totalVolume7dUsd: z.number().nullable(),
    // Absent on legacy rows (completeness unrecorded; interpret as `unknown`).
    volume24hAvailability: DexVolumeAvailabilitySchema.optional(),
    volume7dAvailability: DexVolumeAvailabilitySchema.optional(),
    poolCount: z.number(),
    pairCount: z.number(),
    chainCount: z.number(),
    protocolTvl: z.record(z.string(), z.number()),
    chainTvl: z.record(z.string(), z.number()),
    topPools: z.array(DexLiquidityPoolSchema),
    liquidityScore: z.number().min(0).max(100).nullable(),
    // Producer reason for a null score; null when rated, absent on rows scored before it was recorded.
    liquidityScoreUnavailableReason: LiquidityScoreUnavailableReasonSchema.nullable().optional(),
    concentrationHhi: z.number().min(0).max(1).nullable(),
    depthStability: z.number().nullable(),
    tvlChange24h: z.number().nullable(),
    tvlChange7d: z.number().nullable(),
    updatedAt: z.number(),
    dexPriceUpdatedAt: nullableEpochSec.optional(),
    dexPriceAgeSeconds: z.number().nonnegative().nullable().optional(),
    dexPriceMaxAgeSec: z.number().positive().optional(),
    dexPriceUnavailableReason: z.enum([
      "missing-price", "missing-timestamp", "invalid-timestamp", "future-timestamp",
      "stale-price", "publication-mismatch",
    ]).nullable().optional(),
    dexPriceUsd: z.number().nullable(),
    dexDeviationBps: z.number().nullable(),
    priceSourceCount: z.number().nullable(),
    priceSourceTvl: z.number().nullable(),
    priceSources: z.array(DexPriceSourceSchema).nullable(),
    effectiveTvlUsd: z.number(),
    avgPoolStress: z.number().min(0).max(100).nullable(),
    weightedBalanceRatio: z.number().nullable(),
    organicFraction: z.number().nullable(),
    durabilityScore: z.number().min(0).max(100).nullable(),
    coverageClass: LiquidityCoverageClassSchema.nullable(),
    coverageConfidence: z.number().min(0).max(1).nullable(),
    liquidityEvidenceClass: LiquidityEvidenceClassSchema.nullable(),
    hasMeasuredLiquidityEvidence: z.boolean(),
    trendworthy: z.boolean(),
    sourceMix: LiquiditySourceMixSchema,
    balanceMeasuredTvlUsd: z.number().nullable(),
    organicMeasuredTvlUsd: z.number().nullable(),
    scoreComponents: z
      .object({
        tvlDepth: z.number(),
        // Null when DEC-19 marks required 24h activity unavailable (composite is NR).
        volumeActivity: z.number().nullable(),
        poolQuality: z.number(),
        durability: z.number(),
        pairDiversity: z.number(),
      })
      .nullable(),
    lockedLiquidityPct: z.number().nullable(),
    methodologyVersion: z.string(),
    deploymentCoverage: DexDeploymentCoverageSchema.nullable().optional(),
    exitRouteObservations: DexExitRouteObservationsSchema.nullable().optional(),
    exitRouteObservationCoverage: ExitRouteObservationCoverageSchema.optional(),
  });
export type DexLiquidityData = z.infer<typeof DexLiquidityDataSchema>;

export const DexLiquidityHistoryPointSchema = z
  .object({
    tvl: z.number(),
    // Null unless the snapshot's 24h window was complete; legacy rows keep their number.
    volume24h: z.number().nullable(),
    volume24hAvailability: DexVolumeAvailabilitySchema.optional(),
    score: z.number().nullable(),
    date: z.number(),
    unavailableReason: z.literal("invalid-coverage-evidence").nullable().optional(),
    coverageClass: LiquidityCoverageClassSchema.nullable(),
    coverageConfidence: z.number().nullable(),
    liquidityEvidenceClass: LiquidityEvidenceClassSchema.nullable(),
    hasMeasuredLiquidityEvidence: z.boolean(),
    trendworthy: z.boolean(),
    methodologyVersion: z.string(),
    exitRouteObservations: DexExitRouteObservationsSchema.optional(),
    exitRouteObservationCoverage: ExitRouteObservationCoverageSchema.optional(),
  });
export type DexLiquidityHistoryPoint = z.infer<typeof DexLiquidityHistoryPointSchema>;

export const DexLiquidityHistoryResponseSchema = z.array(DexLiquidityHistoryPointSchema);

export type DexLiquidityMap = Record<string, DexLiquidityData>;
export const DexLiquidityMapSchema = z.record(z.string(), DexLiquidityDataSchema);
export const DexLiquidityCoinResponseSchema = z.object({
  coins: DexLiquidityMapSchema,
  projection: CoinProjectionMetadataSchema,
});
export type DexLiquidityCoinResponse = z.infer<typeof DexLiquidityCoinResponseSchema>;
export const DexLiquidityTableRowSchema = DexLiquidityDataSchema.pick({
  liquidityScore: true,
  warning: true,
  unavailableReason: true,
  advisoryUnavailableReason: true,
  updatedAt: true,
  methodologyVersion: true,
});
export const DexLiquidityTableMapSchema = z.record(z.string(), DexLiquidityTableRowSchema);
export type DexLiquidityTableMap = z.infer<typeof DexLiquidityTableMapSchema>;

export const DEX_GLOBAL_KEY = "__global__";
