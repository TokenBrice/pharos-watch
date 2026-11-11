import { z } from "zod";
import { MethodologyEnvelopeSchema } from "./methodology-envelope";

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
export const BlacklistValuationCoverageSchema = z.object({
  knownCount: z.number().int().nonnegative(),
  unavailableCount: z.number().int().nonnegative(),
});
export type BlacklistValuationCoverage = z.infer<typeof BlacklistValuationCoverageSchema>;


const BlacklistSummaryStatsSchema = z.object({
  usdcBlacklisted: z.number(),
  usdtBlacklisted: z.number(),
  goldBlacklisted: z.number(),
  frozenAddresses: z.number(),
  destroyedTotal: z.number().nullable(),
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
  recentFreezeAmount24hUsd: z.number().nullable(),
  recentFreezeAmount7dUsd: z.number().nullable(),
  recoverableGapCount: z.number(),
  perCoinBlacklistCounts: z.record(z.string(), z.number()),
  perCoinTotalEvents: z.record(z.string(), z.number()),
  perCoinFrozenAddressCount: z.record(z.string(), z.number()),
  perCoinFrozenTotal: z.record(z.string(), z.number().nullable()),
  perCoinDestroyedTotal: z.record(z.string(), z.number().nullable()),
  valuationCoverage: z.object({
    destroyed: BlacklistValuationCoverageSchema,
    recent24h: BlacklistValuationCoverageSchema,
    recent7d: BlacklistValuationCoverageSchema,
    perCoinFrozen: z.record(z.string(), BlacklistValuationCoverageSchema),
    perCoinDestroyed: z.record(z.string(), BlacklistValuationCoverageSchema),
  }).optional(),
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

/** Producer-observed refresh: when totals were rebuilt and which configs have not reached their safe head. */
const BlacklistSummaryRefreshSchema = z.object({
  observedAt: z.number(),
  behindConfigs: z.array(z.object({
    configKey: z.string(),
    symbol: z.string(),
    chainName: z.string(),
    lastSucceededAt: z.number().nullable(),
  })),
});
export type BlacklistSummaryRefresh = z.infer<typeof BlacklistSummaryRefreshSchema>;

export const BlacklistSummaryResponseSchema = z.object({
  stats: BlacklistSummaryStatsSchema,
  chart: z.array(BlacklistChartPointSchema),
  chains: z.array(BlacklistChainOptionSchema),
  coverage: BlacklistCoverageSchema.optional(),
  freezeLedgerMeta: BlacklistFreezeLedgerMetaSchema.optional(),
  dataQuality: BlacklistDataQualitySchema.optional(),
  refresh: BlacklistSummaryRefreshSchema.optional(),
  totalEvents: z.number(),
  methodology: MethodologyEnvelopeSchema.optional(),
});
export type BlacklistSummaryResponse = z.infer<typeof BlacklistSummaryResponseSchema>;
