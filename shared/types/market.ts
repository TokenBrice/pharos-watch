import { z } from "zod";
import type { MethodologyEnvelope, PegCurrency } from "./core";
import {
  BluechipGrade,
  BluechipGradeSchema,
  DepegPrimaryTrustSchema,
  MethodologyEnvelopeSchema,
  PriceConfidenceSchema,
  PriceObservedAtModeSchema,
} from "./core";

const PegBucketsSchema = z.record(z.string(), z.number());
const ChainCirculatingSchema = z.record(
  z.string(),
  z.object({
    current: z.number(),
    circulatingPrevDay: z.number(),
    circulatingPrevWeek: z.number(),
    circulatingPrevMonth: z.number(),
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
  supplySource: z.string().optional(),
  circulating: PegBucketsSchema,
  circulatingPrevDay: PegBucketsSchema.nullish(),
  circulatingPrevWeek: PegBucketsSchema.nullish(),
  circulatingPrevMonth: PegBucketsSchema.nullish(),
  chainCirculating: ChainCirculatingSchema,
  chains: z.array(z.string()),
  frozen: z.boolean().optional(),
  frozenAt: z.string().optional(),
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
  supplySource: asset.supplySource,
  circulating: asset.circulating,
  circulatingPrevDay: asset.circulatingPrevDay ?? {},
  circulatingPrevWeek: asset.circulatingPrevWeek ?? {},
  circulatingPrevMonth: asset.circulatingPrevMonth ?? {},
  chainCirculating: asset.chainCirculating,
  chains: asset.chains,
  ...(asset.frozen != null ? { frozen: asset.frozen } : {}),
  ...(asset.frozenAt != null ? { frozenAt: asset.frozenAt } : {}),
}));
export type StablecoinData = z.infer<typeof StablecoinDataSchema>;

export const StablecoinListResponseSchema = z.object({
  peggedAssets: z.array(StablecoinDataSchema),
  fxFallbackRates: z.record(z.string(), z.number()).optional(),
});
export type StablecoinListResponse = z.infer<typeof StablecoinListResponseSchema>;

import type { CauseOfDeath } from "../lib/cause-of-death";

export { CAUSE_OF_DEATH_VALUES } from "../lib/cause-of-death";
export type { CauseOfDeath } from "../lib/cause-of-death";

export interface DeadStablecoin {
  id: string;
  name: string;
  symbol: string;
  llamaId?: string;
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

export interface BluechipSmidge {
  stability: string | null;
  management: string | null;
  implementation: string | null;
  decentralization: string | null;
  governance: string | null;
  externals: string | null;
}

export const BluechipSmidgeSchema = z.object({
  stability: z.string().nullable(),
  management: z.string().nullable(),
  implementation: z.string().nullable(),
  decentralization: z.string().nullable(),
  governance: z.string().nullable(),
  externals: z.string().nullable(),
});

export interface BluechipRating {
  grade: BluechipGrade;
  slug: string;
  collateralization: number;
  smartContractAudit: boolean;
  dateOfRating: string;
  dateLastChange: string | null;
  smidge: BluechipSmidge;
}

export const BluechipRatingSchema = z.object({
  grade: BluechipGradeSchema,
  slug: z.string(),
  collateralization: z.number(),
  smartContractAudit: z.boolean(),
  dateOfRating: z.string(),
  dateLastChange: z.string().nullable(),
  smidge: BluechipSmidgeSchema,
});

export type BluechipRatingsMap = Record<string, BluechipRating>;
export const BluechipRatingsMapSchema = z.record(z.string(), BluechipRatingSchema);

export const LiquidityPoolSourceFamilySchema = z.enum([
  "dl",
  "cg_onchain",
  "gecko_terminal",
  "dexscreener",
  "cg_tickers",
  "direct_api",
]);
export type LiquidityPoolSourceFamily = z.infer<typeof LiquidityPoolSourceFamilySchema>;

const LegacyLiquidityPoolSourceSchema = z.enum([
  "cg",
  "gt",
  "ds",
]);

export const LiquidityCoverageClassSchema = z.enum([
  "primary",
  "mixed",
  "fallback",
  "legacy",
  "unobserved",
]);
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
});
export type DexLiquidityData = z.infer<typeof DexLiquidityDataSchema>;

export interface DexLiquidityHistoryPoint {
  tvl: number;
  volume24h: number;
  score: number | null;
  date: number;
  coverageClass: LiquidityCoverageClass;
  coverageConfidence: number;
  liquidityEvidenceClass: LiquidityEvidenceClass;
  hasMeasuredLiquidityEvidence: boolean;
  trendworthy: boolean;
  methodologyVersion: string;
}

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

export interface DepegEvent {
  id: number;
  stablecoinId: string;
  symbol: string;
  pegType: string;
  direction: "above" | "below";
  peakDeviationBps: number;
  startedAt: number;
  endedAt: number | null;
  startPrice: number;
  peakPrice: number | null;
  recoveryPrice: number | null;
  pegReference: number;
  source: "live" | "backfill";
  confirmationSources: string | null;
  pendingReason: string | null;
}

const DepegEventSchema = z.object({
  id: z.number(),
  stablecoinId: z.string(),
  symbol: z.string(),
  pegType: z.string(),
  direction: z.enum(["above", "below"]),
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
});

export const DepegEventsResponseSchema = z.object({
  events: z.array(DepegEventSchema),
  total: z.number(),
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
export type BlacklistAmountSource = "event" | "historical_balance" | "derived" | "unavailable" | "current_balance_snapshot" | "legacy_migration";
export type BlacklistAmountStatus =
  | "resolved"
  | "recoverable_pending"
  | "permanently_unavailable"
  | "provider_failed"
  | "ambiguous";

export interface BlacklistEvent {
  id: string;
  stablecoin: BlacklistStablecoin;
  chainId: string;
  chainName: string;
  eventType: BlacklistEventType;
  address: string;
  amountNative: number | null;
  amountUsdAtEvent: number | null;
  amountSource: BlacklistAmountSource;
  amountStatus: BlacklistAmountStatus;
  txHash: string;
  blockNumber: number;
  timestamp: number;
  methodologyVersion: string;
  contractAddress: string | null;
  configKey: string | null;
  eventSignature: string | null;
  eventTopic0: string | null;
  suppressionReason?: string | null;
  explorerTxUrl: string;
  explorerAddressUrl: string;
}

const BlacklistEventSchema = z.object({
  id: z.string(),
  stablecoin: z.enum(BLACKLIST_STABLECOINS),
  chainId: z.string(),
  chainName: z.string(),
  eventType: z.enum(["blacklist", "unblacklist", "destroy"]),
  address: z.string(),
  amountNative: z.number().nullable(),
  amountUsdAtEvent: z.number().nullable(),
  amountSource: z.enum(["event", "historical_balance", "derived", "unavailable", "current_balance_snapshot", "legacy_migration"]),
  amountStatus: z.enum([
    "resolved",
    "recoverable_pending",
    "permanently_unavailable",
    "provider_failed",
    "ambiguous",
  ]),
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

export const BlacklistResponseSchema = z.object({
  events: z.array(BlacklistEventSchema),
  total: z.number(),
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

const BlacklistSummaryStatsSchema = z.object({
  usdcBlacklisted: z.number(),
  usdtBlacklisted: z.number(),
  goldBlacklisted: z.number(),
  frozenAddresses: z.number(),
  destroyedTotal: z.number(),
  activeAddressCount: z.number(),
  activeFrozenTotal: z.number(),
  activeAmountGapCount: z.number(),
  trackedAddressCount: z.number().optional(),
  trackedFrozenTotal: z.number().optional(),
  trackedAmountGapCount: z.number().optional(),
  recentCount: z.number(),
  recentCount24h: z.number(),
  recoverableGapCount: z.number(),
  perCoinBlacklistCounts: z.record(z.enum(BLACKLIST_STABLECOINS), z.number()),
  perCoinTotalEvents: z.record(z.enum(BLACKLIST_STABLECOINS), z.number()),
  perCoinFrozenAddressCount: z.record(z.enum(BLACKLIST_STABLECOINS), z.number()),
  perCoinFrozenTotal: z.record(z.enum(BLACKLIST_STABLECOINS), z.number()),
  perCoinDestroyedTotal: z.record(z.enum(BLACKLIST_STABLECOINS), z.number()),
  perCoinQuarterlyEventTypes: z.record(
    z.enum(BLACKLIST_STABLECOINS),
    z.array(BlacklistQuarterlyEventTypePointSchema),
  ),
});

const BlacklistChainOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const BlacklistSummaryResponseSchema = z.object({
  stats: BlacklistSummaryStatsSchema,
  chart: z.array(BlacklistChartPointSchema),
  chains: z.array(BlacklistChainOptionSchema),
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

export const StressSignalEntrySchema = z.object({
  score: z.number(),
  band: z.string(),
  signals: z.record(z.string(), SignalDetailSchema),
  amplifiers: AmplifiersSchema.optional(),
  computedAt: z.number(),
  methodologyVersion: z.string(),
});

export interface StressSignalEntry {
  score: number;
  band: string;
  signals: Record<string, { value: number; available: boolean; [key: string]: unknown }>;
  amplifiers?: { psi: number; contagion: number };
  computedAt: number;
  methodologyVersion: string;
}

export const StressSignalsAllResponseSchema = z.object({
  signals: z.record(z.string(), StressSignalEntrySchema),
  updatedAt: z.number(),
  oldestComputedAt: z.number().optional(),
  malformedRows: z.number().optional(),
  methodology: MethodologyEnvelopeSchema,
});

export interface StressSignalsAllResponse {
  signals: Record<string, StressSignalEntry>;
  updatedAt: number;
  oldestComputedAt?: number;
  malformedRows?: number;
  methodology: DepegDewsMethodology;
}

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
  methodology: MethodologyEnvelopeSchema,
});

export interface StressSignalDetailResponse {
  current: StressSignalEntry | null;
  history: {
    date: number;
    score: number;
    band: string;
    signals: Record<string, { value: number; available: boolean; [key: string]: unknown }>;
    amplifiers?: { psi: number; contagion: number };
    methodologyVersion: string;
  }[];
  methodology: DepegDewsMethodology;
}
