import { z } from "zod";
import type { MethodologyEnvelope, PegCurrency } from "./core";
import {
  DepegPrimaryTrustSchema,
  MethodologyEnvelopeSchema,
  PriceConfidenceSchema,
  PriceObservedAtModeSchema,
} from "./core";
import { ContractDeploymentSchema } from "./stablecoin-meta-schemas";

export {
  BluechipRatingSchema,
  BluechipRatingsMapSchema,
  BluechipSmidgeSchema,
  type BluechipRating,
  type BluechipRatingsMap,
  type BluechipSmidge,
} from "./bluechip";

const PegBucketsSchema = z.record(z.string(), z.number());
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PriceSourceConfidenceProfileSchema = z.object({
  activeDexLanes: z.number().int().min(0),
  freshestDexLaneAgeSec: z.number().int().min(0).nullable(),
  aggregateLaneOnly: z.boolean(),
});
const ChainCirculatingSchema = z.record(
  z.string(),
  z.object({
    current: z.number().finite().nonnegative(),
    circulatingPrevDay: z.number().finite().nonnegative(),
    circulatingPrevWeek: z.number().finite().nonnegative(),
    circulatingPrevMonth: z.number().finite().nonnegative(),
  }),
);

const StablecoinDataRawSchema = z.object({
  id: z.string(),
  name: z.string(),
  symbol: z.string(),
  geckoId: z.string().nullable().optional(),
  gecko_id: z.string().nullable().optional(),
  pegType: z.string(),
  pegMechanism: z.string(),
  price: z.number().nullable(),
  priceSource: z.string(),
  priceConfidence: PriceConfidenceSchema.nullable().optional(),
  priceUpdatedAt: z.number().nullable().optional(),
  priceObservedAt: z.number().nullable().optional(),
  priceObservedAtMode: PriceObservedAtModeSchema.nullable().optional(),
  priceSyncedAt: z.number().nullable().optional(),
  consensusSources: z.array(z.string()).optional(),
  agreeSources: z.array(z.string()).optional(),
  priceSourceConfidenceProfile: PriceSourceConfidenceProfileSchema.nullable().optional(),
  supplySource: z.string().optional(),
  supplyObservedAt: z.number().nullable().optional(),
  supplyRestored: z.boolean().optional(),
  circulating: PegBucketsSchema,
  circulatingPrevDay: PegBucketsSchema.nullish(),
  circulatingPrevWeek: PegBucketsSchema.nullish(),
  circulatingPrevMonth: PegBucketsSchema.nullish(),
  chainCirculating: ChainCirculatingSchema,
  chains: z.array(z.string()),
  contracts: z.array(ContractDeploymentSchema).optional(),
  frozen: z.boolean().optional(),
  frozenAt: IsoDateSchema.optional(),
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
  priceSyncedAt: asset.priceSyncedAt ?? null,
  consensusSources: asset.consensusSources ?? [],
  agreeSources: asset.agreeSources ?? [],
  ...(asset.priceSourceConfidenceProfile != null
    ? { priceSourceConfidenceProfile: asset.priceSourceConfidenceProfile }
    : {}),
  supplySource: asset.supplySource,
  ...(asset.supplyObservedAt != null ? { supplyObservedAt: asset.supplyObservedAt } : {}),
  ...(asset.supplyRestored === true ? { supplyRestored: true } : {}),
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

import type { CauseOfDeath } from "./cause-of-death";

export { CAUSE_OF_DEATH_VALUES } from "./cause-of-death";
export type { CauseOfDeath } from "./cause-of-death";

export interface DeadStablecoin {
  id: string;
  name: string;
  symbol: string;
  llamaId?: string;
  geckoId?: string;
  aliases?: string[];
  logo?: string;
  pegCurrency: PegCurrency;
  causeOfDeath: CauseOfDeath;
  deathDate: string;
  peakMcap?: number;
  epitaph?: string;
  obituary: string;
  sourceUrl: string;
  sourceLabel: string;
  contracts?: { chain: string; address: string }[];
}

export const LiquidityPoolSourceFamilySchema = z.enum([
  "dl",
  "cg_onchain",
  "gecko_terminal",
  "dexscreener",
  "cg_tickers",
  "direct_api",
]);
export type LiquidityPoolSourceFamily = z.infer<typeof LiquidityPoolSourceFamilySchema>;

const LegacyLiquidityPoolSourceSchema = z.enum(["cg", "gt", "ds"]);

export const LiquidityCoverageClassSchema = z.enum(["primary", "mixed", "fallback", "legacy", "unobserved"]);
export type LiquidityCoverageClass = z.infer<typeof LiquidityCoverageClassSchema>;

const LiquiditySourceMixEntrySchema = z.object({
  poolCount: z.number(),
  tvlUsd: z.number(),
});
export type LiquiditySourceMixEntry = z.infer<typeof LiquiditySourceMixEntrySchema>;

export const LiquiditySourceMixSchema = z.record(z.string(), LiquiditySourceMixEntrySchema);
export type LiquiditySourceMix = Record<string, LiquiditySourceMixEntry>;

const DexLiquidityPoolSchema = z.object({
  project: z.string(),
  chain: z.string(),
  tvlUsd: z.number(),
  symbol: z.string(),
  volumeUsd1d: z.number(),
  poolType: z.string(),
  source: z.union([LiquidityPoolSourceFamilySchema, LegacyLiquidityPoolSourceSchema]).optional(),
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
export type LiquidityEvidenceClass = z.infer<typeof LiquidityEvidenceClassSchema>;

export const DexExitEvidenceKindSchema = z.enum([
  "measured-executable-depth",
  "reserve-based-amm-simulation",
  "direct-orderbook-depth",
  "generic-tvl-proxy",
  "synthetic-or-fallback",
  "unobserved",
]);
export type DexExitEvidenceKind = z.infer<typeof DexExitEvidenceKindSchema>;

export const DexDeploymentOutcomeSchema = z.enum([
  "observed_pools",
  "verified_no_pools",
  "provider_inaccessible",
]);
export type DexDeploymentOutcome = z.infer<typeof DexDeploymentOutcomeSchema>;

const DexDeploymentCoverageSchema = z.object({
  observedPools: z.number().int().nonnegative(),
  verifiedNoPools: z.number().int().nonnegative(),
  providerInaccessible: z.number().int().nonnegative(),
  deployments: z.array(z.object({
    chain: z.string(),
    contractAddress: z.string(),
    outcome: DexDeploymentOutcomeSchema,
    providers: z.array(z.string()),
    reason: z.string(),
    observedPoolCount: z.number().int().nonnegative(),
    observedAt: z.number(),
    waiver: z.object({
      owner: z.string(),
      reason: z.string().nullable(),
      expiresAt: z.number(),
    }).nullable(),
  })),
});

const DexLiquidityDataSchema = z.object({
  totalTvlUsd: z.number(),
  totalVolume24hUsd: z.number(),
  totalVolume7dUsd: z.number(),
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
      volumeActivity: z.number(),
      poolQuality: z.number(),
      durability: z.number(),
      pairDiversity: z.number(),
    })
    .nullable(),
  lockedLiquidityPct: z.number().nullable(),
  methodologyVersion: z.string(),
  deploymentCoverage: DexDeploymentCoverageSchema.nullable().optional(),
});
export type DexLiquidityData = z.infer<typeof DexLiquidityDataSchema>;

export const DexLiquidityHistoryPointSchema = z.object({
  tvl: z.number(),
  volume24h: z.number(),
  score: z.number().nullable(),
  date: z.number(),
  coverageClass: LiquidityCoverageClassSchema,
  coverageConfidence: z.number(),
  liquidityEvidenceClass: LiquidityEvidenceClassSchema,
  hasMeasuredLiquidityEvidence: z.boolean(),
  trendworthy: z.boolean(),
  methodologyVersion: z.string(),
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

export const DepegEventSchema = z.object({
  id: z.number(),
  stablecoinId: z.string(),
  symbol: z.string(),
  pegType: z.string(),
  direction: DepegDirectionSchema,
  peakDeviationBps: z.number(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  startPrice: z.number(),
  peakPrice: z.number().nullable(),
  recoveryPrice: z.number().nullable(),
  pegReference: z.number(),
  source: z.enum(["live", "backfill"]),
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
      auditVerdict: z.string().nullable().optional(),
      pegScoreEligible: z.boolean().nullable().optional(),
      updatedAt: z.number().nullable().optional(),
    })
    .nullable()
    .optional()
    .default(null),
});
export type DepegEvent = z.infer<typeof DepegEventSchema>;

export const DepegPendingIncidentSchema = z.object({
  stablecoinId: z.string(),
  symbol: z.string(),
  direction: DepegDirectionSchema,
  firstSeenAt: z.number(),
  lastSeenAt: z.number(),
  firstSeenBps: z.number(),
  lastSeenBps: z.number(),
  peakSeenBps: z.number(),
  reason: z.string(),
  ageSec: z.number(),
  expiresAt: z.number(),
  availableConfirmationCategories: z.array(z.string()),
  missingConfirmationCategories: z.array(z.string()),
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

export type DepegDewsMethodology = MethodologyEnvelope;

export const PegSummaryCoinSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  pegType: z.string(),
  pegCurrency: z.string(),
  governance: z.string(),
  currentDeviationBps: z.number().nullable(),
  /**
   * True when the coin's peg reference is not authoritative (thin non-USD
   * peer group with no live FX fallback) — deviation is withheld rather than
   * shown as a self-referential ~0. Mirrors the detection engine's gate.
   */
  pegReferenceUnavailable: z.boolean().optional(),
  depegEventCoverageLimited: z.boolean().optional(),
  pegScore: z.number().nullable(),
  priceSource: z.string().optional(),
  priceConfidence: PriceConfidenceSchema.nullable().optional(),
  priceUpdatedAt: z.number().nullable().optional(),
  priceObservedAt: z.number().nullable().optional(),
  priceObservedAtMode: PriceObservedAtModeSchema.nullable().optional(),
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
  "MNEE",
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
  recoverableGapCount: z.number(),
  perCoinBlacklistCounts: z.record(z.enum(BLACKLIST_STABLECOINS), z.number()),
  perCoinTotalEvents: z.record(z.enum(BLACKLIST_STABLECOINS), z.number()),
  perCoinFrozenAddressCount: z.record(z.enum(BLACKLIST_STABLECOINS), z.number()),
  perCoinFrozenTotal: z.record(z.enum(BLACKLIST_STABLECOINS), z.number()),
  perCoinDestroyedTotal: z.record(z.enum(BLACKLIST_STABLECOINS), z.number()),
  perCoinQuarterlyEventTypes: z.record(z.enum(BLACKLIST_STABLECOINS), z.array(BlacklistQuarterlyEventTypePointSchema)),
  // Key is `z.string()` (not the BLACKLIST_STABLECOINS enum) so older cached
  // payloads — which either omit the field entirely or carry a partial record
  // — still parse. Optional with `{}` default covers the missing-field case;
  // the detail-page banner hook does `record[symbol] ?? zero-counts` for the
  // missing-coin case at runtime.
  perCoinRecentEventTypes: z
    .record(z.string(), BlacklistRecentEventTypeCountsSchema)
    .optional()
    .default({}),
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
    staleSnapshotCount: z.number(),
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

export const StressSignalAgeClassificationSchema = z.enum([
  "fresh",
  "lagging",
  "stale",
  "retainedLastValid",
]);
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

export const StressSignalEntrySchema = z.object({
  score: z.number(),
  band: z.string(),
  signals: z.record(z.string(), SignalDetailSchema),
  amplifiers: AmplifiersSchema.optional(),
  computedAt: z.number(),
  methodologyVersion: z.string(),
  ageClassification: StressSignalAgeClassificationSchema.optional(),
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

export const StablecoinChartResponseSchema = z.array(z.object({
  date: z.number(),
  totalCirculatingUSD: z.record(z.string(), z.number()),
}));
export type StablecoinChartPoint = z.infer<typeof StablecoinChartResponseSchema>[number];
