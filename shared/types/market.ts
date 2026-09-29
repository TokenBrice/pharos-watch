import { z } from "zod";
import { DepegAuditVerdictSchema } from "./depeg-audit";
import { CAUSE_OF_DEATH_VALUES } from "./cause-of-death";
import { FreshnessAssessmentSchema } from "./api-meta";
import {
  DepegPrimaryTrustSchema,
  MethodologyEnvelopeSchema,
  NominalPriceReferenceSchema,
  PEG_CURRENCY_VALUES,
  PriceConfidenceSchema,
  PriceObservedAtModeSchema,
  PriceSourceConfidenceProfileSchema,
} from "./core";
import { ContractDeploymentSchema } from "./stablecoin-meta-schemas";
import {
  DexExitRouteObservationsSchema,
  ExitRouteObservationCoverageSchema,
} from "./exit-route";
import { DexMeasuredExecutionPublicProfileSchema } from "./measured-execution";
import { StrictIsoDateSchema } from "./safety-schema-primitives";

export {
  BluechipRatingSchema,
  BluechipRatingsMapSchema,
  BluechipSmidgeSchema,
  type BluechipRating,
  type BluechipRatingsMap,
  type BluechipSmidge,
} from "./bluechip";
export {
  DexExitEvidenceKindSchema,
  DexExitRouteObservationSchema,
  DexExitRouteObservationsSchema,
  ExitRouteCapacityPointSchema,
  ExitRouteConfidenceSchema,
  ExitRouteEvidenceKindSchema,
  ExitRouteFamilySchema,
  ExitRouteObservationCoverageSchema,
  ExitRouteObservationSchema,
  ExitRouteOutputKindSchema,
  ExitRouteOutputSchema,
  ExitRouteScopeSchema,
  MAX_DEX_EXIT_ROUTE_OBSERVATIONS,
  MAX_EXIT_ROUTE_COMMON_MODE_KEYS,
  type DexExitEvidenceKind,
  type DexExitRouteObservation,
  type ExitRouteCapacityPoint,
  type ExitRouteConfidence,
  type ExitRouteEvidenceKind,
  type ExitRouteFamily,
  type ExitRouteObservation,
  type ExitRouteObservationCoverage,
  type ExitRouteObservationHistory,
  type ExitRouteOutput,
  type ExitRouteOutputKind,
  type ExitRouteScope,
} from "./exit-route";

export const PegBucketsSchema = z.record(z.string(), z.number());

const StablecoinDetailTokenSchema = z.object({
  date: z.number().optional(),
  totalCirculatingUSD: PegBucketsSchema.optional(),
  totalCirculating: PegBucketsSchema.optional(),
  circulating: PegBucketsSchema.optional(),
}).passthrough();

/** Public per-coin detail response; provider-specific fields intentionally pass through. */
export const StablecoinDetailResponseSchema = z.object({
  price: z.number().nullable().optional(),
  priceSource: z.string().nullable().optional(),
  priceConfidence: PriceConfidenceSchema.nullable().optional(),
  priceUpdatedAt: z.number().nullable().optional(),
  priceObservedAt: z.number().nullable().optional(),
  tokens: z.array(StablecoinDetailTokenSchema).optional(),
}).passthrough();
export type StablecoinDetailResponse = z.infer<typeof StablecoinDetailResponseSchema>;

/**
 * Published aggregate peg buckets: finite nonnegative USD per bucket. `{}` stays absence (read it with
 * the `*OrNull` supply helpers); an explicit `0` is an observed zero (CR-13 / D01-2).
 */
const SupplyBucketsSchema = z.record(z.string(), z.number().finite().nonnegative());

/**
 * Per-chain supply scalars. `null` = the chain row exists but that observation was unavailable (empty or
 * invalid provider bucket); it is never a zero. Canonical storage and public wires carry `null` (Release B).
 */
const ChainSupplyValueSchema = z.number().finite().nonnegative().nullable();

const ChainCirculatingSchema = z.record(
  z.string(),
  z.object({
    chainId: z.string().optional(),
    current: ChainSupplyValueSchema,
    circulatingPrevDay: ChainSupplyValueSchema.optional(),
    circulatingPrevWeek: ChainSupplyValueSchema.optional(),
    circulatingPrevMonth: ChainSupplyValueSchema.optional(),
  }),
);

/**
 * DEC-01 provenance on a row whose aggregate supply was raised by the bounded CoinGecko gap-fill. The
 * canonical DefiLlama total stays visible beside the supplemental CoinGecko value and the admitted ratio.
 */
export const SupplyGapFillProvenanceSchema = z.object({
  method: z.literal("coingecko-single-missing-chain"),
  /** `entered` = admitted inside the entry band; `retained` = kept by the hysteresis band. */
  admission: z.enum(["entered", "retained"]),
  missingChainId: z.string(),
  canonicalSource: z.literal("defillama"),
  canonicalCurrentUsd: z.number().finite().positive(),
  supplementalSource: z.literal("coingecko"),
  supplementalCurrentUsd: z.number().finite().positive(),
  ratio: z.number().finite().positive(),
  maxRatio: z.number().finite().positive(),
  observedAt: z.number().int().nonnegative(),
  /** Consecutive no-decision publications; fresh reconciliation resets this bounded carry. */
  carryForwardRuns: z.number().int().nonnegative().optional(),
});
export type SupplyGapFillProvenance = z.infer<typeof SupplyGapFillProvenanceSchema>;

const StablecoinDataRawSchema = z.object({
  id: z.string(),
  name: z.string(),
  symbol: z.string(),
  geckoId: z.string().nullable().optional(),
  gecko_id: z.string().nullable().optional(),
  pegType: z.string(),
  pegMechanism: z.string(),
  price: z.number().nullable(),
  priceSource: z.string().nullable(),
  priceConfidence: PriceConfidenceSchema.nullable().optional(),
  priceUpdatedAt: z.number().nullable().optional(),
  priceObservedAt: z.number().nullable().optional(),
  priceObservedAtMode: PriceObservedAtModeSchema.nullable().optional(),
  nominalPriceReference: NominalPriceReferenceSchema.optional(),
  priceSyncedAt: z.number().nullable().optional(),
  consensusSources: z.array(z.string()).optional(),
  agreeSources: z.array(z.string()).optional(),
  priceSourceConfidenceProfile: PriceSourceConfidenceProfileSchema.nullable().optional(),
  supplySource: z.string().optional(),
  supplyObservedAt: z.number().nullable().optional(),
  supplyRestored: z.boolean().optional(),
  supplyGapFill: SupplyGapFillProvenanceSchema.optional(),
  circulating: SupplyBucketsSchema,
  circulatingPrevDay: SupplyBucketsSchema.nullish(),
  circulatingPrevWeek: SupplyBucketsSchema.nullish(),
  circulatingPrevMonth: SupplyBucketsSchema.nullish(),
  chainCirculating: ChainCirculatingSchema,
  chains: z.array(z.string()),
  contracts: z.array(ContractDeploymentSchema).optional(),
  frozen: z.boolean().optional(),
  frozenAt: StrictIsoDateSchema.optional(),
});

export const StablecoinDataSchema = StablecoinDataRawSchema.transform((asset) => ({
  id: asset.id,
  name: asset.name,
  symbol: asset.symbol,
  geckoId: asset.geckoId ?? asset.gecko_id ?? null,
  pegType: asset.pegType,
  pegMechanism: asset.pegMechanism,
  price: asset.price,
  priceSource: asset.priceSource,
  priceConfidence: asset.priceConfidence ?? null,
  priceUpdatedAt: asset.priceUpdatedAt ?? null,
  priceObservedAt: asset.priceObservedAt ?? asset.priceUpdatedAt ?? null,
  priceObservedAtMode: asset.priceObservedAtMode ?? null,
  ...(asset.nominalPriceReference != null ? { nominalPriceReference: asset.nominalPriceReference } : {}),
  priceSyncedAt: asset.priceSyncedAt ?? null,
  consensusSources: asset.consensusSources ?? [],
  agreeSources: asset.agreeSources ?? [],
  ...(asset.priceSourceConfidenceProfile != null
    ? { priceSourceConfidenceProfile: asset.priceSourceConfidenceProfile }
    : {}),
  supplySource: asset.supplySource,
  ...(asset.supplyObservedAt != null ? { supplyObservedAt: asset.supplyObservedAt } : {}),
  ...(asset.supplyRestored === true ? { supplyRestored: true } : {}),
  ...(asset.supplyGapFill != null ? { supplyGapFill: asset.supplyGapFill } : {}),
  circulating: asset.circulating,
  circulatingPrevDay: asset.circulatingPrevDay ?? {},
  circulatingPrevWeek: asset.circulatingPrevWeek ?? {},
  circulatingPrevMonth: asset.circulatingPrevMonth ?? {},
  chainCirculating: asset.chainCirculating,
  chains: asset.chains,
  ...(asset.contracts && asset.contracts.length > 0 ? { contracts: asset.contracts } : {}),
  ...(asset.frozen != null ? { frozen: asset.frozen } : {}),
  ...(asset.frozenAt != null ? { frozenAt: asset.frozenAt } : {}),
}));
export type StablecoinData = z.infer<typeof StablecoinDataSchema>;

export const StablecoinListResponseSchema = z.object({
  peggedAssets: z.array(StablecoinDataSchema),
  fxFallbackRates: z.record(z.string(), z.number()).optional(),
});
export type StablecoinListResponse = z.infer<typeof StablecoinListResponseSchema>;

export { CAUSE_OF_DEATH_VALUES } from "./cause-of-death";
export type { CauseOfDeath } from "./cause-of-death";

export const DeadStablecoinSchema = z
  .object({
    id: z.string(), name: z.string(), symbol: z.string(), llamaId: z.string().optional(), geckoId: z.string().optional(),
    aliases: z.array(z.string()).optional(), logo: z.string().optional(), pegCurrency: z.enum(PEG_CURRENCY_VALUES),
    causeOfDeath: z.enum(CAUSE_OF_DEATH_VALUES), deathDate: z.string(), peakMcap: z.number().optional(),
    epitaph: z.string().optional(), obituary: z.string(), sourceUrl: z.string(), sourceLabel: z.string(),
    contracts: z.array(z.object({ chain: z.string(), address: z.string() }).strict()).optional(),
  })
  .strict();
export type DeadStablecoin = z.output<typeof DeadStablecoinSchema>;

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

const LiquiditySourceMixEntrySchema = z.object({
  poolCount: z.number(),
  tvlUsd: z.number(),
});
export type LiquiditySourceMixEntry = z.infer<typeof LiquiditySourceMixEntrySchema>;

export const LiquiditySourceMixSchema = z.record(z.string(), LiquiditySourceMixEntrySchema);
export type LiquiditySourceMix = Record<string, LiquiditySourceMixEntry>;

export const DexAmmExecutionTokenSchema = z.object({
  address: z.string().min(1),
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(255),
  balance: z.number().finite().positive(),
  referencePriceUsd: z.number().finite().positive(),
  referencePriceSource: z.enum(["source-token-usd", "tracked-market", "peg-reference", "pool-implied"]),
  trackedAssetId: z.string().min(1).optional(),
  weight: z.number().finite().positive().max(1).optional(),
});
export type DexAmmExecutionToken = z.infer<typeof DexAmmExecutionTokenSchema>;

export const DexAmmExecutionModelSchema = z
  .object({
    source: z.enum(["raydium", "uniswap-v2", "pancakeswap-v2", "aerodrome-volatile", "balancer", "curve"]),
    invariant: z.enum(["constant-product", "weighted-constant-mean", "stableswap"]),
    trackedTokenIndex: z.number().int().nonnegative(),
    feeRate: z.number().finite().min(0).lt(1),
    /** StableSwap amplification coefficient A (plain paper convention, not A*n^n). */
    amplification: z.number().finite().positive().optional(),
    tokens: z.array(DexAmmExecutionTokenSchema).min(2).max(8),
  })
  .superRefine((model, ctx) => {
    if (model.trackedTokenIndex >= model.tokens.length) {
      ctx.addIssue({ code: "custom", path: ["trackedTokenIndex"], message: "tracked token index is out of range" });
    }
    if (model.invariant !== "stableswap" && model.amplification !== undefined) {
      ctx.addIssue({ code: "custom", path: ["amplification"], message: "amplification is a stableswap parameter" });
    }
    if (model.invariant === "constant-product") {
      if (
        !["raydium", "uniswap-v2", "pancakeswap-v2", "aerodrome-volatile"].includes(model.source) ||
        model.tokens.length !== 2
      ) {
        ctx.addIssue({ code: "custom", path: ["invariant"], message: "invalid constant-product model" });
      }
      return;
    }
    if (model.invariant === "stableswap") {
      if (model.source !== "curve" && model.source !== "balancer") {
        ctx.addIssue({
          code: "custom",
          path: ["source"],
          message: "stableswap models require a Curve or Balancer source",
        });
      }
      if (model.amplification === undefined) {
        ctx.addIssue({ code: "custom", path: ["amplification"], message: "stableswap models require amplification" });
      }
      return;
    }
    if (model.source !== "balancer") {
      ctx.addIssue({ code: "custom", path: ["source"], message: "weighted models require Balancer source" });
    }
    const weights = model.tokens.map((token) => token.weight);
    if (weights.some((weight) => weight == null)) {
      ctx.addIssue({ code: "custom", path: ["tokens"], message: "weighted models require every token weight" });
      return;
    }
    const weightSum = (weights as number[]).reduce((sum, weight) => sum + weight, 0);
    if (Math.abs(weightSum - 1) > 0.0001) {
      ctx.addIssue({ code: "custom", path: ["tokens"], message: "weighted model token weights must sum to one" });
    }
  });
export type DexAmmExecutionModel = z.infer<typeof DexAmmExecutionModelSchema>;

/**
 * Exact pool-family evidence that was retained, but whose execution model was
 * intentionally rejected by a reviewed fail-closed gate. These rows remain in
 * the exact-route completeness denominator instead of being mistaken for
 * generic shaped TVL.
 */
export const DexExecutionCapabilityGateSchema = z.object({
  family: z.enum([
    "curve-stableswap",
    "curve-cryptoswap",
    "balancer-amm",
    "raydium-amm",
    "constant-product-v2",
    "measured-execution",
  ]),
  reason: z.enum([
    "unsupported-invariant",
    "rate-bearing-inputs",
    "paused-or-swap-disabled",
    "metapool-unsupported",
    "incomplete-exact-capture",
    // The verification transport failed before anything was observed (request
    // failure, pinned block unavailable, or exhausted wall-time budget). The
    // pool was NOT semantically refused: distinct from
    // `incomplete-exact-capture`, which asserts an observed capture was
    // incomplete, so operators can tell a provider blip from a data refusal.
    "transport-unavailable",
    "invalid-invariant-parameters",
    "ambiguous-token-identity",
    "tracked-input-unresolved",
    "exact-pool-join-unresolved",
    "target-unresolved",
    "unsupported-chain",
    "target-missing",
    "quote-missing",
    "quote-failed",
    // A rotating producer admission budget deferred this target before any
    // capability was exercised. Distinct from `quote-failed`, which asserts an
    // attempted measurement did not produce a valid profile.
    "budget-deferred",
    "generation-mismatch",
    "stale-observation",
    "invalid-observation",
    "deployment-code-mismatch",
    "activation-pending",
  ]),
});
export type DexExecutionCapabilityGate = z.infer<typeof DexExecutionCapabilityGateSchema>;

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
      ammExecutionModel: DexAmmExecutionModelSchema.optional(),
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
    concentrationHhi: z.number().min(0).max(1).nullable(),
    depthStability: z.number().nullable(),
    tvlChange24h: z.number().nullable(),
    tvlChange7d: z.number().nullable(),
    updatedAt: z.number(),
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
    coverageConfidence: z.number().min(0).max(1),
    liquidityEvidenceClass: LiquidityEvidenceClassSchema,
    hasMeasuredLiquidityEvidence: z.boolean(),
    trendworthy: z.boolean(),
    sourceMix: LiquiditySourceMixSchema,
    balanceMeasuredTvlUsd: z.number(),
    organicMeasuredTvlUsd: z.number(),
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
    coverageClass: LiquidityCoverageClassSchema,
    coverageConfidence: z.number(),
    liquidityEvidenceClass: LiquidityEvidenceClassSchema,
    hasMeasuredLiquidityEvidence: z.boolean(),
    trendworthy: z.boolean(),
    methodologyVersion: z.string(),
    exitRouteObservations: DexExitRouteObservationsSchema.optional(),
    exitRouteObservationCoverage: ExitRouteObservationCoverageSchema.optional(),
  });
export type DexLiquidityHistoryPoint = z.infer<typeof DexLiquidityHistoryPointSchema>;

export const DexLiquidityHistoryResponseSchema = z.array(DexLiquidityHistoryPointSchema);

const SupplyHistoryPointSchema = z.object({
  date: z.number(),
  circulatingUsd: z.number(),
  price: z.number().nullable(),
});
export type SupplyHistoryPoint = z.infer<typeof SupplyHistoryPointSchema>;
export const SupplyHistoryResponseSchema = z.array(SupplyHistoryPointSchema);

const NonUsdSharePointSchema = z.object({
  date: z.number(),
  // SQL cohort aggregates are complete numbers; unavailable history is not a zero point.
  commodityShare: z.number(),
  fiatNonUsdShare: z.number(),
  commodity: z.number(),
  fiatNonUsd: z.number(),
  total: z.number(),
});
export type NonUsdSharePoint = z.infer<typeof NonUsdSharePointSchema>;
export const NonUsdShareResponseSchema = z.array(NonUsdSharePointSchema);

export type DexLiquidityMap = Record<string, DexLiquidityData>;
export const DexLiquidityMapSchema = z.record(z.string(), DexLiquidityDataSchema);

export const DEX_GLOBAL_KEY = "__global__";

export type DepegDirection = "above" | "below";
export const DepegDirectionSchema = z.enum(["above", "below"]);

export interface DepegEventSearchEntry {
  slug: string;
  stablecoinId: DepegEvent["stablecoinId"];
  symbol: DepegEvent["symbol"];
  pegType: DepegEvent["pegType"];
  direction: DepegDirection;
  peakDeviationBps: DepegEvent["peakDeviationBps"];
  startedAt: DepegEvent["startedAt"];
}

export const DEPEG_EVENT_CLOSE_REASON_VALUES = [
  "recovered-primary",
  "recovered-dex",
  "recovered-native",
  "coverage-lost-supply",
  "superseded-direction",
  "orphan-tracking-removed",
] as const;
export const DepegEventCloseReasonSchema = z.enum(DEPEG_EVENT_CLOSE_REASON_VALUES);
export type DepegEventCloseReason = z.infer<typeof DepegEventCloseReasonSchema>;

const DepegTimestampSchema = z.number().int().nonnegative();

/**
 * Chronology invariant shared by the public depeg surfaces and the V9
 * peg-provenance parser: a closed event must end after it starts. Negative
 * durations are impossible values, not data.
 */
export function refineDepegEventChronology(
  event: { startedAt: number; endedAt: number | null },
  ctx: z.RefinementCtx,
): void {
  if (event.endedAt != null && event.endedAt <= event.startedAt) {
    ctx.addIssue({
      code: "custom",
      path: ["endedAt"],
      message: "A closed event must end after it starts",
    });
  }
}

const DepegEventObjectSchema = z.object({
  id: z.number(),
  stablecoinId: z.string(),
  symbol: z.string(),
  pegType: z.string(),
  direction: DepegDirectionSchema,
  peakDeviationBps: z.number(),
  startedAt: DepegTimestampSchema,
  endedAt: DepegTimestampSchema.nullable(),
  startPrice: z.number(),
  peakPrice: z.number().nullable(),
  recoveryPrice: z.number().nullable(),
  pegReference: z.number(),
  source: z.enum(["live", "backfill"]),
  /** Raw threshold-crossing rows grouped into this public incident. */
  constituentEventCount: z.number().int().positive().optional(),
  confirmationSources: z.string().nullable().optional().default(null),
  pendingReason: z.string().nullable().optional().default(null),
  closeReason: DepegEventCloseReasonSchema.nullable().optional().default(null),
  provenance: z
    .object({
      sourceKind: z.string().nullable().optional(),
      replayRunId: z.string().nullable().optional(),
      replayVersion: z.string().nullable().optional(),
      sourcePriceProviders: z.array(z.string()).nullable().optional(),
      quoteMode: z.string().nullable().optional(),
      pegReferenceSource: z.string().nullable().optional(),
      supplySource: z.string().nullable().optional(),
      confirmationPolicy: z.string().nullable().optional(),
      confirmationPointCount: z.number().nullable().optional(),
      confidenceTier: z.string().nullable().optional(),
      auditVerdict: DepegAuditVerdictSchema.nullable().optional(),
      pegScoreEligible: z.boolean().nullable().optional(),
      updatedAt: z.number().nullable().optional(),
    })
    .nullable()
    .optional()
    .default(null),
});
export const DepegEventSchema = DepegEventObjectSchema.superRefine(refineDepegEventChronology);
export type DepegEvent = z.infer<typeof DepegEventSchema>;

/** Build-time depeg archive written to data/depeg-events/*.json. */
export const DepegEventStoredSnapshotSchema = z.array(
  DepegEventObjectSchema
    .extend({
      slug: z.string().min(1),
    })
    .superRefine(refineDepegEventChronology),
);
export type DepegEventEntry = z.infer<typeof DepegEventStoredSnapshotSchema>[number];

export const DepegPendingIncidentSchema = z
  .object({
    stablecoinId: z.string(),
    symbol: z.string(),
    direction: DepegDirectionSchema,
    firstSeenAt: DepegTimestampSchema,
    lastSeenAt: DepegTimestampSchema,
    firstSeenBps: z.number(),
    lastSeenBps: z.number(),
    peakSeenBps: z.number(),
    reason: z.string(),
    ageSec: z.number(),
    expiresAt: DepegTimestampSchema,
    availableConfirmationCategories: z.array(z.string()),
    missingConfirmationCategories: z.array(z.string()),
  })
  .superRefine((incident, ctx) => {
    if (incident.lastSeenAt < incident.firstSeenAt) {
      ctx.addIssue({
        code: "custom",
        path: ["lastSeenAt"],
        message: "A pending incident cannot be last seen before it is first seen",
      });
    }
    // `expiresAt` is the base expiry (`firstSeenAt + DEPEG_PENDING_EXPIRY_SEC`).
    // The confirmation cron keeps a row pending past it under the extended and
    // severe limits, so a row last seen after `expiresAt` is legitimate.
    if (incident.expiresAt <= incident.firstSeenAt) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "A pending incident's base expiry must fall after it is first seen",
      });
    }
  });

export type DepegPendingIncident = z.infer<typeof DepegPendingIncidentSchema>;

export const DepegEventsResponseSchema = z.object({
  events: z.array(DepegEventSchema),
  total: z.number(),
  totalExact: z.boolean().optional(),
  nextCursor: z.string().nullable().optional(),
  pending: z.array(DepegPendingIncidentSchema).optional(),
  methodology: MethodologyEnvelopeSchema.optional(),
});
export type DepegEventsResponse = z.infer<typeof DepegEventsResponseSchema>;


export const PegSummaryCoinSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  pegType: z.string(),
  pegCurrency: z.string(),
  governance: z.string(),
  currentDeviationBps: z.number().nullable(),
  pegReference: z
    .object({
      valueUsd: z.number().positive(),
      /** Unscaled commodity reference; never the per-token peg value. */
      usdPerTroyOunce: z.number().finite().positive().optional(),
      source: z.enum(["median", "fx", "fallback"]),
      contributorCount: z.number().int().nonnegative(),
      asOf: z.number().int().positive(),
    })
    .nullable()
    .optional(),
  /**
   * True when the coin's peg reference is not authoritative (thin non-USD
   * peer group with no live FX fallback) — deviation is withheld rather than
   * shown as a self-referential ~0. Mirrors the detection engine's gate.
   */
  pegReferenceUnavailable: z.boolean().optional(),
  /**
   * True when no usable current price observation exists for the coin at all
   * (no price row, or a price the intake pipeline rejected). Deviation is then
   * unobserved rather than withheld: consumers must never read the null
   * deviation as "at peg".
   */
  currentPriceUnavailable: z.boolean().optional(),
  /**
   * True when the coin's current circulating supply is unavailable (asset absent or buckets
   * absent/empty/invalid), so the live-event supply floor cannot be assessed. The deviation is
   * withheld, but this is not a below-floor claim: `depegEventCoverageLimited` stays false.
   */
  currentSupplyUnavailable: z.boolean().optional(),
  depegEventCoverageLimited: z.boolean().optional(),
  pegScore: z.number().nullable(),
  priceSource: z.string().optional(),
  priceConfidence: PriceConfidenceSchema.nullable().optional(),
  priceUpdatedAt: z.number().nullable().optional(),
  priceObservedAt: z.number().nullable().optional(),
  priceObservedAtMode: PriceObservedAtModeSchema.nullable().optional(),
  nominalPriceReference: NominalPriceReferenceSchema.optional(),
  priceSyncedAt: z.number().nullable().optional(),
  consensusSources: z.array(z.string()).optional(),
  agreeSources: z.array(z.string()).optional(),
  primaryTrust: DepegPrimaryTrustSchema.optional(),
  pegPct: z.number(),
  severityScore: z.number(),
  spreadPenalty: z.number(),
  eventCount: z.number(),
  worstDeviationBps: z.number().nullable(),
  activeDepeg: z.boolean(),
  lastEventAt: z.number().nullable(),
  trackingSpanDays: z.number(),
  historyCoverage: z
    .object({
      startedAt: z.number().int().nonnegative(),
      source: z.enum(["audited-replay", "asset-age", "first-observation", "first-event"]),
      status: z.enum(["verified", "assumed"]),
    })
    .nullable()
    .optional(),
  recent90d: z
    .object({
      windowDays: z.literal(90),
      observedDays: z.number().nonnegative(),
      coverageLimited: z.boolean(),
      pegPct: z.number().min(0).max(100),
      incidentCount: z.number().int().nonnegative(),
      thresholdCrossingCount: z.number().int().nonnegative(),
      worstDeviationBps: z.number().nullable(),
    })
    .nullable()
    .optional(),
  methodologyVersion: z.string(),
  dexPriceCheck: z
    .object({
      dexPrice: z.number(),
      dexDeviationBps: z.number(),
      agrees: z.boolean(),
      sourcePools: z.number(),
      sourceTvl: z.number(),
    })
    .nullable()
    .optional(),
});
export type PegSummaryCoin = z.infer<typeof PegSummaryCoinSchema>;

export const PegSummaryStatsSchema = z.object({
  activeDepegCount: z.number(),
  medianDeviationBps: z.number(),
  worstCurrent: z.object({ id: z.string(), symbol: z.string(), bps: z.number() }).nullable(),
  coinsAtPeg: z.number(),
  totalTracked: z.number(),
  depegEventsToday: z.number(),
  depegEventsYesterday: z.number(),
  fallbackPegRates: z.array(z.string()).optional(),
  fxPegRates: z.array(z.string()).optional(),
});
export type PegSummaryStats = z.infer<typeof PegSummaryStatsSchema>;

export const PegSummaryResponseSchema = z.object({
  coins: z.array(PegSummaryCoinSchema),
  summary: PegSummaryStatsSchema.nullable(),
  methodology: MethodologyEnvelopeSchema,
});
export type PegSummaryResponse = z.infer<typeof PegSummaryResponseSchema>;

export const BLACKLIST_STABLECOINS = [
  "USDC",
  "USDT",
  "PAXG",
  "XAUT",
  "PYUSD",
  "USD1",
  "USDG",
  "RLUSD",
  "U",
  "USDTB",
  "A7A5",
  "FDUSD",
  "BRZ",
  "AUSD",
  "EURI",
  "USDQ",
  "USDO",
  "USDX",
  "AID",
  "TGBP",
  "EURC",
  "BUIDL",
  "USDP",
  "TUSD",
  "NUSD",
  "EURCV",
  "USDA",
  "USAT",
  "AEUR",
  "XUSD",
  "XAUM",
  "JPYC",
  "FRXUSD",
  "FIDD",
] as const;

export type BlacklistStablecoin = (typeof BLACKLIST_STABLECOINS)[number];
export type BlacklistEventType = "blacklist" | "unblacklist" | "destroy";
export type BlacklistSortKey = "date" | "stablecoin" | "chain" | "event";
export type BlacklistSortDirection = "asc" | "desc";
export const BLACKLIST_AMOUNT_SOURCE_VALUES = [
  "event",
  "historical_balance",
  "derived",
  "unavailable",
  "current_balance_snapshot",
  "legacy_migration",
] as const;
export type BlacklistAmountSource = (typeof BLACKLIST_AMOUNT_SOURCE_VALUES)[number];
export const BLACKLIST_AMOUNT_STATUS_VALUES = [
  "resolved",
  "recoverable_pending",
  "permanently_unavailable",
  "provider_failed",
  "ambiguous",
] as const;
export type BlacklistAmountStatus = (typeof BLACKLIST_AMOUNT_STATUS_VALUES)[number];

const BlacklistEventSchema = z.object({
  id: z.string(),
  stablecoin: z.enum(BLACKLIST_STABLECOINS),
  chainId: z.string(),
  chainName: z.string(),
  eventType: z.enum(["blacklist", "unblacklist", "destroy"]),
  address: z.string(),
  amountNative: z.number().nullable(),
  amountUsdAtEvent: z.number().nullable(),
  amountSource: z.enum(BLACKLIST_AMOUNT_SOURCE_VALUES),
  amountStatus: z.enum(BLACKLIST_AMOUNT_STATUS_VALUES),
  txHash: z.string(),
  blockNumber: z.number(),
  transactionIndex: z.number().int().nonnegative().nullable().optional(),
  timestamp: z.number(),
  methodologyVersion: z.string(),
  contractAddress: z.string().nullable(),
  configKey: z.string().nullable(),
  eventSignature: z.string().nullable(),
  eventTopic0: z.string().nullable(),
  suppressionReason: z.string().nullable().optional(),
  explorerTxUrl: z.string(),
  explorerAddressUrl: z.string(),
});
export type BlacklistEvent = z.infer<typeof BlacklistEventSchema>;

export const BlacklistResponseSchema = z.object({
  events: z.array(BlacklistEventSchema),
  total: z.number(),
  totalExact: z.boolean().optional(),
  nextCursor: z.string().nullable().optional(),
  methodology: MethodologyEnvelopeSchema.optional(),
});
export type BlacklistResponse = z.infer<typeof BlacklistResponseSchema>;

const BlacklistChartPointSchema = z.object({
  quarter: z.string(),
  ...Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, z.number()])),
  total: z.number(),
});

export const BlacklistQuarterlyEventTypePointSchema = z.object({
  quarter: z.string(),
  blacklist: z.number(),
  unblacklist: z.number(),
  destroy: z.number(),
});
export type BlacklistQuarterlyEventTypePoint = z.infer<typeof BlacklistQuarterlyEventTypePointSchema>;

export const BlacklistRecentEventTypeCountsSchema = z.object({
  freezes: z.number(),
  destroys: z.number(),
  releases: z.number(),
});
export type BlacklistRecentEventTypeCounts = z.infer<typeof BlacklistRecentEventTypeCountsSchema>;

const BlacklistSummaryStatsSchema = z.object({
  usdcBlacklisted: z.number(),
  usdtBlacklisted: z.number(),
  goldBlacklisted: z.number(),
  frozenAddresses: z.number(),
  destroyedTotal: z.number(),
  activeAddressCount: z.number(),
  activeFrozenTotal: z.number(),
  activeAmountGapCount: z.number(),
  trackedAddressCount: z.number(),
  trackedFrozenTotal: z.number(),
  trackedAmountGapCount: z.number(),
  recentCount: z.number(),
  recentCount24h: z.number(),
  recentFreezeCount24h: z.number(),
  recentFreezeCount7d: z.number(),
  recentFreezeAmount24hUsd: z.number(),
  recentFreezeAmount7dUsd: z.number(),
  recoverableGapCount: z.number(),
  perCoinBlacklistCounts: z.record(z.string(), z.number()),
  perCoinTotalEvents: z.record(z.string(), z.number()),
  perCoinFrozenAddressCount: z.record(z.string(), z.number()),
  perCoinFrozenTotal: z.record(z.string(), z.number()),
  perCoinDestroyedTotal: z.record(z.string(), z.number()),
  // Key is `z.string()` like the sibling maps above: Zod 4 enum-keyed records
  // are exhaustive, so a cache snapshot written before the next
  // BLACKLIST_STABLECOINS addition would fail the whole summary parse.
  perCoinQuarterlyEventTypes: z.record(z.string(), z.array(BlacklistQuarterlyEventTypePointSchema)),
  // Key is `z.string()` (not the BLACKLIST_STABLECOINS enum) so older cached
  // payloads — which either omit the field entirely or carry a partial record
  // — still parse. Optional with `{}` default covers the missing-field case;
  // the detail-page banner hook does `record[symbol] ?? zero-counts` for the
  // missing-coin case at runtime.
  perCoinRecentEventTypes: z.record(z.string(), BlacklistRecentEventTypeCountsSchema).optional().default({}),
});

const BlacklistChainOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const BlacklistNumericDistributionSchema = z.record(z.string(), z.number());

const BlacklistCoverageSupportedSchema = z.object({
  symbol: z.enum(BLACKLIST_STABLECOINS),
  stablecoinId: z.string(),
  chainId: z.string(),
  chainName: z.string(),
  contractAddress: z.string(),
  configKey: z.string(),
  providerSource: z.enum(["evm-logs", "trongrid", "other"]),
  eventFamilies: z.array(z.string()),
  eventTypes: z.array(z.enum(["blacklist", "unblacklist", "destroy"])),
});

const BlacklistCoverageDeferredSchema = z.object({
  symbol: z.enum(BLACKLIST_STABLECOINS),
  chainId: z.string(),
  reason: z.string(),
});

const BlacklistCoverageSchema = z.object({
  supported: z.array(BlacklistCoverageSupportedSchema),
  unsupportedDeferred: z.array(BlacklistCoverageDeferredSchema),
  counts: z.object({
    supportedConfigs: z.number(),
    unsupportedDeferredConfigs: z.number(),
    bySymbol: BlacklistNumericDistributionSchema,
    byChain: BlacklistNumericDistributionSchema,
    byProviderSource: BlacklistNumericDistributionSchema,
  }),
});

const BlacklistFreshnessDistributionSchema = z.object({
  fresh: z.number(),
  degraded: z.number(),
  stale: z.number(),
});

const BlacklistFreezeLedgerMetaSchema = z.object({
  totalRows: z.number(),
  scopedRows: z.number(),
  legacyRows: z.number(),
  oldestObservedAt: z.number().nullable(),
  newestObservedAt: z.number().nullable(),
  oldestAgeSec: z.number().nullable(),
  newestAgeSec: z.number().nullable(),
  statusDistribution: BlacklistNumericDistributionSchema,
  sourceDistribution: BlacklistNumericDistributionSchema,
  freshnessDistribution: BlacklistFreshnessDistributionSchema,
  currentFreshnessDistribution: BlacklistFreshnessDistributionSchema.optional(),
  providerFailedCount: z.number(),
  lastErrorClassDistribution: BlacklistNumericDistributionSchema,
  sourceCategoryCounts: z.object({
    bootstrap: z.number(),
    current: z.number(),
    destroy: z.number(),
    other: z.number(),
  }),
  gaps: z.object({
    tracked: z.number(),
    recoverable: z.number(),
    unrecoverable: z.number(),
    recentRecoverable: z.number(),
    neverAttempted: z.number(),
    repeatedFailures: z.number(),
    oldestRecoverableAgeSec: z.number().nullable(),
    amountStatusDistribution: BlacklistNumericDistributionSchema,
    amountSourceDistribution: BlacklistNumericDistributionSchema,
  }),
});

const BlacklistDataQualitySchema = z.object({
  status: z.enum(["ok", "degraded", "stale"]),
  warnings: z.array(z.string()),
  ambiguousOrderCount: z.number().int().nonnegative().optional(),
  ambiguousOrderReason: z.literal("tron-cross-transaction-order").nullable().optional(),
  amountGaps: z.object({
    totalEvents: z.number(),
    recoverable: z.number(),
    unrecoverable: z.number(),
    recentRecoverable: z.number(),
    missingRatio: z.number(),
    recentWindowSec: z.number(),
  }),
  freezeLedger: z.object({
    providerFailedCount: z.number(),
    trackedGapCount: z.number(),
    scopedRows: z.number(),
    legacyRows: z.number(),
  }),
  coverage: z.object({
    supportedConfigs: z.number(),
    unsupportedDeferredConfigs: z.number(),
  }),
});

export const BlacklistSummaryResponseSchema = z.object({
  stats: BlacklistSummaryStatsSchema,
  chart: z.array(BlacklistChartPointSchema),
  chains: z.array(BlacklistChainOptionSchema),
  coverage: BlacklistCoverageSchema.optional(),
  freezeLedgerMeta: BlacklistFreezeLedgerMetaSchema.optional(),
  dataQuality: BlacklistDataQualitySchema.optional(),
  totalEvents: z.number(),
  methodology: MethodologyEnvelopeSchema.optional(),
});
export type BlacklistSummaryResponse = z.infer<typeof BlacklistSummaryResponseSchema>;

const SignalDetailSchema = z
  .object({
    value: z.number(),
    available: z.boolean(),
  })
  .passthrough();

const AmplifiersSchema = z.object({
  psi: z.number(),
  contagion: z.number(),
});

export const StressSignalAgeClassificationSchema = z.enum(["fresh", "lagging", "stale", "retainedLastValid"]);
export type StressSignalAgeClassification = z.infer<typeof StressSignalAgeClassificationSchema>;

export const StressSignalDataStatusSchema = z.enum(["ok", "degraded", "unavailable"]);
export type StressSignalDataStatus = z.infer<typeof StressSignalDataStatusSchema>;

export const StressSignalDataReasonSchema = z.enum([
  "no-current-rows",
  "no-readable-current-rows",
  "all-current-rows-malformed",
  "single-coin-current-row-missing",
  "current-row-malformed",
  "computed-count-zero",
  "partial-coverage",
]);
export type StressSignalDataReason = z.infer<typeof StressSignalDataReasonSchema>;

export const StressSignalEntrySchema = FreshnessAssessmentSchema.partial().extend({
  score: z.number(),
  band: z.string(),
  signals: z.record(z.string(), SignalDetailSchema),
  amplifiers: AmplifiersSchema.optional(),
  computedAt: z.number(),
  methodologyVersion: z.string(),
  ageClassification: StressSignalAgeClassificationSchema.optional(),
  // Null in single-coin mode, where no cross-coin generation comparison is made.
  newestReturnedComputedAt: z.number().nullable().optional(),
});

export type StressSignalEntry = z.infer<typeof StressSignalEntrySchema>;

export const StressSignalsAllResponseSchema = z.object({
  signals: z.record(z.string(), StressSignalEntrySchema),
  updatedAt: z.number(),
  eligibleCount: z.number().int().nonnegative().optional(),
  computedCount: z.number().int().nonnegative().optional(),
  missingCount: z.number().int().nonnegative().optional(),
  oldestComputedAt: z.number().optional(),
  coverageRatio: z.number().min(0).max(1).optional(),
  malformedRows: z.number().optional(),
  coverageStatus: StressSignalDataStatusSchema.optional(),
  coverageReasons: z.array(StressSignalDataReasonSchema).optional(),
  methodology: MethodologyEnvelopeSchema,
});

export type StressSignalsAllResponse = z.infer<typeof StressSignalsAllResponseSchema>;

const StressSignalHistoryEntrySchema = z.object({
  date: z.number(),
  score: z.number(),
  band: z.string(),
  signals: z.record(z.string(), SignalDetailSchema),
  amplifiers: AmplifiersSchema.optional(),
  methodologyVersion: z.string(),
});

export const StressSignalDetailResponseSchema = z.object({
  current: StressSignalEntrySchema.nullable(),
  history: z.array(StressSignalHistoryEntrySchema),
  malformedRows: z.number().optional(),
  currentStatus: StressSignalDataStatusSchema.optional(),
  currentReasons: z.array(StressSignalDataReasonSchema).optional(),
  methodology: MethodologyEnvelopeSchema,
});

export type StressSignalDetailResponse = z.infer<typeof StressSignalDetailResponseSchema>;

export const STABLECOIN_CHART_LEGACY_AGGREGATE_UNIVERSE = "legacy-provider-all-stablecoins-v1" as const;
export const StablecoinChartAggregateUniverseSchema = z.enum([
  STABLECOIN_CHART_LEGACY_AGGREGATE_UNIVERSE,
  "core-stablecoins-v1",
]);

export const StablecoinChartResponseSchema = z.array(
  z.object({
    date: z.number(),
    totalCirculatingUSD: z.record(z.string(), z.number()),
    aggregateUniverse: StablecoinChartAggregateUniverseSchema.optional(),
  }),
);
export type StablecoinChartPoint = z.infer<typeof StablecoinChartResponseSchema>[number];
