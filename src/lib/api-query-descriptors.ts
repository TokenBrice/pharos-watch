import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { DATA_SURFACE_DESCRIPTORS, type YieldHistoryMode } from "@shared/lib/data-surface-descriptors";
import type { ChainsResponse } from "@shared/types/chains";
import type { DdrResponse } from "@shared/types/depeg-resolver";
import type { DdrrResponse } from "@shared/types/depeg-resolver-review";
import type { DailyDigestResponse, DigestArchiveResponse, DigestSnapshotResponse } from "@shared/types/digest";
import type {
  BlacklistResponse,
  BlacklistSummaryResponse,
  BluechipRatingsMap,
  DexLiquidityHistoryPoint,
  DexLiquidityMap,
  PegSummaryResponse,
  StablecoinChartPoint,
  StablecoinListResponse,
  StressSignalDetailResponse,
  StressSignalsAllResponse,
  SupplyHistoryPoint,
} from "@shared/types/market";
import type { MintBurnEventsResponse, MintBurnFlowsResponse, MintBurnPerCoinResponse } from "@shared/types/mint-burn";
import type { RedemptionBackstopsResponse } from "@shared/types/redemption";
import type { SafetyScoreHistoryResponse } from "@shared/types/report-cards";
import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";
import type { HealthResponse } from "@shared/types/status/public-health";
import type { TelegramPulse } from "@shared/types/status/telegram";
import type { UsdsStatusResponse } from "@shared/types/stability";
import type { YieldAdapterManifestResponse, YieldHistoryResponse, YieldRankingsResponse } from "@shared/types/yield";
import type { YieldRankingsSummaryResponse } from "@shared/types/yield-summary";
import {
  defineApiQuery,
  defineParameterizedApiQuery,
  defineParameterizedStaticApiQuery,
} from "@/lib/api-query-contract";
import { STABILITY_INDEX_QUERY_DESCRIPTOR } from "@/lib/api-query-domains/stability-light";
import { STABILITY_INDEX_DETAIL_QUERY_DESCRIPTOR } from "@/lib/api-query-domains/stability-detail";
import {
  CRON_1H,
  CRON_15MIN,
  CRON_24H,
  CRON_30MIN,
  CRON_BLACKLIST,
  CRON_MINT_BURN,
  CRON_RESERVE_SYNC,
  CRON_TELEGRAM_PULSE,
} from "@/lib/cron-intervals";
import { createLazySchema } from "@/lib/schema-like";
import type { NonUsdSharePoint } from "@/lib/non-usd-share-types";

export type { NonUsdSharePoint } from "@/lib/non-usd-share-types";

export interface MintBurnEventsDescriptorOptions {
  direction?: string;
  burnType?: "effective_burn" | "bridge_burn" | "review_required";
  scope?: "all" | "counted";
  limit?: number;
  offset?: number;
}

type BlacklistEventsDescriptorInput = {
  queryKey: readonly unknown[];
  path: string;
};

const DATA_SURFACE_PRODUCER_INTERVAL_MS = {
  stablecoins: DATA_SURFACE_DESCRIPTORS.stablecoins.producerIntervalSec * 1000,
  dexLiquidity: DATA_SURFACE_DESCRIPTORS.dexLiquidity.producerIntervalSec * 1000,
  yieldRankings: DATA_SURFACE_DESCRIPTORS.yieldRankings.producerIntervalSec * 1000,
  yieldHistory: DATA_SURFACE_DESCRIPTORS.yieldHistory.producerIntervalSec * 1000,
  stressSignals: DATA_SURFACE_DESCRIPTORS.stressSignals.producerIntervalSec * 1000,
  reportCards: DATA_SURFACE_DESCRIPTORS.reportCards.producerIntervalSec * 1000,
  publicHealth: DATA_SURFACE_DESCRIPTORS.publicHealth.producerIntervalSec * 1000,
} as const;

/**
 * Single source of truth for frontend endpoint policy and response validation.
 * Compatibility base/runtime registries are projections of this table; schema
 * imports stay lazy and are cached per endpoint declaration.
 */
export const FRONTEND_API_QUERY_DESCRIPTORS = {
  stablecoins: defineApiQuery(
    {
      queryKey: DATA_SURFACE_DESCRIPTORS.stablecoins.queryKey,
      path: DATA_SURFACE_DESCRIPTORS.stablecoins.apiPath,
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.stablecoins,
      metaMaxAgeSec: DATA_SURFACE_DESCRIPTORS.stablecoins.endpointMaxAgeSec,
    },
    "meta",
    createLazySchema<StablecoinListResponse>(
      async () => (await import("@shared/types/market")).StablecoinListResponseSchema,
    ),
  ),
  chains: defineApiQuery(
    {
      queryKey: ["chains"] as const,
      path: API_PATHS.chains(),
      producerIntervalMs: CRON_15MIN,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.chains,
    },
    "meta",
    createLazySchema<ChainsResponse>(async () => (await import("@shared/types/chains")).ChainsResponseSchema),
  ),
  bluechipRatings: defineApiQuery(
    {
      queryKey: ["bluechip-ratings"] as const,
      path: API_PATHS.bluechipRatings(),
      producerIntervalMs: CRON_24H,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.bluechip,
    },
    "meta",
    createLazySchema<BluechipRatingsMap>(async () => (await import("@shared/types/market")).BluechipRatingsMapSchema),
  ),
  dailyDigest: defineApiQuery(
    {
      queryKey: ["daily-digest"] as const,
      path: API_PATHS.dailyDigest(),
      producerIntervalMs: CRON_24H,
    },
    "plain",
    createLazySchema<DailyDigestResponse>(async () => (await import("@shared/types/digest")).DailyDigestResponseSchema),
  ),
  dexLiquidity: defineApiQuery(
    {
      queryKey: DATA_SURFACE_DESCRIPTORS.dexLiquidity.queryKey,
      path: DATA_SURFACE_DESCRIPTORS.dexLiquidity.apiPath,
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.dexLiquidity,
      metaMaxAgeSec: DATA_SURFACE_DESCRIPTORS.dexLiquidity.endpointMaxAgeSec,
    },
    "meta",
    createLazySchema<DexLiquidityMap>(async () => (await import("@shared/types/market")).DexLiquidityMapSchema),
  ),
  dexLiquidityHistory: defineParameterizedApiQuery(
    "plain",
    createLazySchema<DexLiquidityHistoryPoint[]>(
      async () => (await import("@shared/types/market")).DexLiquidityHistoryResponseSchema,
    ),
    (stablecoinId: string, days: number = 90) => ({
      queryKey: ["dex-liquidity-history", stablecoinId, days] as const,
      path: API_PATHS.dexLiquidityHistory(stablecoinId, days),
      producerIntervalMs: CRON_24H,
    }),
  ),
  digestArchive: defineApiQuery(
    {
      queryKey: ["digest-archive"] as const,
      path: API_PATHS.digestArchive(),
      producerIntervalMs: CRON_24H,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.digestArchive,
    },
    "meta",
    createLazySchema<DigestArchiveResponse>(
      async () => (await import("@shared/types/digest")).DigestArchiveResponseSchema,
    ),
  ),
  digestSnapshot: defineParameterizedStaticApiQuery(
    createLazySchema<DigestSnapshotResponse>(
      async () => (await import("@shared/types/digest")).DigestSnapshotResponseSchema,
    ),
    (date: string) => ({
      queryKey: ["digest-snapshot", date] as const,
      path: API_PATHS.digestSnapshot(date),
    }),
  ),
  health: defineApiQuery(
    {
      queryKey: DATA_SURFACE_DESCRIPTORS.publicHealth.queryKey,
      path: DATA_SURFACE_DESCRIPTORS.publicHealth.apiPath,
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.publicHealth,
    },
    "plain",
    createLazySchema<HealthResponse>(
      async () => (await import("@shared/types/status/public-health")).HealthResponseSchema,
    ),
  ),
  blacklistSummary: defineApiQuery(
    {
      queryKey: ["blacklist-summary"] as const,
      path: API_PATHS.blacklistSummary(),
      producerIntervalMs: CRON_BLACKLIST,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.blacklistSummary,
    },
    "meta",
    createLazySchema<BlacklistSummaryResponse>(
      async () => (await import("@shared/types/market")).BlacklistSummaryResponseSchema,
    ),
  ),
  blacklistEvents: defineParameterizedApiQuery(
    "meta",
    createLazySchema<BlacklistResponse>(async () => (await import("@shared/types/market")).BlacklistResponseSchema),
    ({ queryKey, path }: BlacklistEventsDescriptorInput) => ({
      queryKey,
      path,
      producerIntervalMs: CRON_BLACKLIST,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.blacklist,
    }),
  ),
  mintBurnFlows: defineParameterizedApiQuery(
    "meta",
    createLazySchema<MintBurnFlowsResponse>(
      async () => (await import("@shared/types/mint-burn")).MintBurnFlowsResponseSchema,
    ),
    (hours: number = 24) => ({
      queryKey: ["mint-burn-flows", "all", hours] as const,
      path: API_PATHS.mintBurnFlows(hours !== 24 ? { hours } : undefined),
      producerIntervalMs: CRON_MINT_BURN,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows,
    }),
  ),
  mintBurnFlowsCoin: defineParameterizedApiQuery(
    "meta",
    createLazySchema<MintBurnPerCoinResponse>(
      async () => (await import("@shared/types/mint-burn")).MintBurnPerCoinResponseSchema,
    ),
    (stablecoinId: string, hours: number = 24) => ({
      queryKey: ["mint-burn-flows", stablecoinId, hours] as const,
      path: API_PATHS.mintBurnFlows({
        stablecoin: stablecoinId,
        hours: hours !== 24 ? hours : undefined,
      }),
      producerIntervalMs: CRON_MINT_BURN,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows,
    }),
  ),
  mintBurnEvents: defineParameterizedApiQuery(
    "meta",
    createLazySchema<MintBurnEventsResponse>(
      async () => (await import("@shared/types/mint-burn")).MintBurnEventsResponseSchema,
    ),
    (stablecoinId: string, opts?: MintBurnEventsDescriptorOptions) => {
      const params = new URLSearchParams({ stablecoin: stablecoinId });
      if (opts?.direction) params.set("direction", opts.direction);
      if (opts?.burnType) params.set("burnType", opts.burnType);
      if (opts?.scope && opts.scope !== "all") params.set("scope", opts.scope);
      if (opts?.limit) params.set("limit", opts.limit.toString());
      if (opts?.offset) params.set("offset", opts.offset.toString());

      return {
        queryKey: [
          "mint-burn-events",
          stablecoinId,
          opts?.scope ?? "all",
          opts?.direction ?? "all",
          opts?.burnType ?? "all",
          opts?.limit ?? 50,
          opts?.offset ?? 0,
        ] as const,
        path: API_PATHS.mintBurnEvents(Object.fromEntries(params.entries())),
        producerIntervalMs: CRON_MINT_BURN,
        metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.mintBurnEvents,
      };
    },
  ),
  pegSummary: defineApiQuery(
    {
      queryKey: ["peg-summary"] as const,
      path: API_PATHS.pegSummary(),
      producerIntervalMs: CRON_15MIN,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.pegSummary,
    },
    "meta",
    createLazySchema<PegSummaryResponse>(async () => (await import("@shared/types/market")).PegSummaryResponseSchema),
  ),
  reportCardsV9: defineApiQuery(
    {
      queryKey: DATA_SURFACE_DESCRIPTORS.reportCards.queryKey,
      path: DATA_SURFACE_DESCRIPTORS.reportCards.apiPath,
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.reportCards,
      metaMaxAgeSec: DATA_SURFACE_DESCRIPTORS.reportCards.endpointMaxAgeSec,
    },
    "meta",
    createLazySchema<ReportCardsV9CurrentResponse>(
      async () => (await import("@shared/types/report-cards-v9")).ReportCardsV9CurrentResponseSchema,
    ),
  ),
  depegResolver: defineApiQuery(
    {
      queryKey: ["depeg-resolver"] as const,
      path: API_PATHS.depegResolver(),
      producerIntervalMs: CRON_15MIN,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolver,
    },
    "meta",
    createLazySchema<DdrResponse>(async () => (await import("@shared/types/depeg-resolver")).DdrResponseSchema),
  ),
  depegResolverReview: defineApiQuery(
    {
      queryKey: ["depeg-resolver-review"] as const,
      path: API_PATHS.depegResolverReview(),
      producerIntervalMs: CRON_15MIN,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolverReview,
    },
    "meta",
    createLazySchema<DdrrResponse>(
      async () => (await import("@shared/types/depeg-resolver-review")).DdrrResponseSchema,
    ),
  ),
  redemptionBackstops: defineApiQuery(
    {
      queryKey: ["redemption-backstops"] as const,
      path: API_PATHS.redemptionBackstops(),
      producerIntervalMs: CRON_RESERVE_SYNC,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops,
    },
    "meta",
    createLazySchema<RedemptionBackstopsResponse>(
      async () => (await import("@shared/types/redemption")).RedemptionBackstopsResponseSchema,
    ),
  ),
  safetyScoreHistory: defineParameterizedApiQuery(
    "meta",
    createLazySchema<SafetyScoreHistoryResponse>(
      async () => (await import("@shared/types/report-cards")).SafetyScoreHistoryResponseSchema,
    ),
    (stablecoinId: string, days: number = 3650) => ({
      queryKey: ["safety-score-history", stablecoinId, days] as const,
      path: API_PATHS.safetyScoreHistory(stablecoinId, days),
      producerIntervalMs: CRON_24H,
      metaMaxAgeSec: CRON_24H / 1000,
    }),
  ),
  stablecoinCharts: defineApiQuery(
    {
      queryKey: ["stablecoin-charts"] as const,
      path: API_PATHS.stablecoinCharts(),
      producerIntervalMs: CRON_1H,
    },
    "plain",
    createLazySchema<StablecoinChartPoint[]>(
      async () => (await import("@shared/types/market")).StablecoinChartResponseSchema,
    ),
  ),
  nonUsdShare: defineApiQuery(
    {
      queryKey: ["non-usd-share"] as const,
      path: API_PATHS.nonUsdShare(),
      producerIntervalMs: CRON_24H,
    },
    "plain",
    createLazySchema<NonUsdSharePoint[]>(
      async () => (await import("@/lib/non-usd-share-schema")).NonUsdShareResponseSchema,
    ),
  ),
  stabilityIndex: STABILITY_INDEX_QUERY_DESCRIPTOR,
  stabilityIndexDetail: STABILITY_INDEX_DETAIL_QUERY_DESCRIPTOR,
  usdsStatus: defineApiQuery(
    {
      queryKey: ["usds-status"] as const,
      path: API_PATHS.usdsStatus(),
      producerIntervalMs: CRON_15MIN,
    },
    "plain",
    createLazySchema<UsdsStatusResponse>(
      async () => (await import("@shared/types/stability")).UsdsStatusResponseSchema,
    ),
  ),
  telegramPulse: defineApiQuery(
    {
      queryKey: ["telegram-pulse"] as const,
      path: API_PATHS.telegramPulse(),
      producerIntervalMs: CRON_TELEGRAM_PULSE,
    },
    "plain",
    createLazySchema<TelegramPulse>(async () => (await import("@shared/types/status/telegram")).TelegramPulseSchema),
  ),
  yieldHistory: defineParameterizedApiQuery(
    "meta",
    createLazySchema<YieldHistoryResponse>(
      async () => (await import("@shared/types/yield")).YieldHistoryResponseSchema,
    ),
    (stablecoinId: string, days: number, mode: YieldHistoryMode, sourceKey?: string | null) => ({
      queryKey: DATA_SURFACE_DESCRIPTORS.yieldHistory.buildQueryKey(stablecoinId, days, mode, sourceKey),
      path: DATA_SURFACE_DESCRIPTORS.yieldHistory.buildApiPath(stablecoinId, days, mode, sourceKey),
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.yieldHistory,
      metaMaxAgeSec: DATA_SURFACE_DESCRIPTORS.yieldHistory.endpointMaxAgeSec,
    }),
  ),
  yieldRankings: defineApiQuery(
    {
      queryKey: DATA_SURFACE_DESCRIPTORS.yieldRankings.queryKey,
      path: DATA_SURFACE_DESCRIPTORS.yieldRankings.apiPath,
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.yieldRankings,
      metaMaxAgeSec: DATA_SURFACE_DESCRIPTORS.yieldRankings.endpointMaxAgeSec,
    },
    "meta",
    createLazySchema<YieldRankingsResponse>(
      async () => (await import("@shared/types/yield")).YieldRankingsResponseSchema,
    ),
  ),
  yieldRankingsSummary: defineApiQuery(
    {
      queryKey: DATA_SURFACE_DESCRIPTORS.yieldRankings.summaryQueryKey,
      path: DATA_SURFACE_DESCRIPTORS.yieldRankings.summaryApiPath,
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.yieldRankings,
      metaMaxAgeSec: DATA_SURFACE_DESCRIPTORS.yieldRankings.endpointMaxAgeSec,
    },
    "meta",
    createLazySchema<YieldRankingsSummaryResponse>(
      async () => (await import("@shared/types/yield-summary")).YieldRankingsSummaryResponseSchema,
    ),
  ),
  yieldAdapterManifest: defineParameterizedStaticApiQuery(
    createLazySchema<YieldAdapterManifestResponse>(
      async () => (await import("@shared/types/yield")).YieldAdapterManifestResponseSchema,
    ),
    () => ({
      queryKey: ["yield-adapter-manifest"] as const,
      path: API_PATHS.yieldAdapterManifest(),
    }),
  )(),
  stressSignals: defineApiQuery(
    {
      queryKey: DATA_SURFACE_DESCRIPTORS.stressSignals.queryKey,
      path: DATA_SURFACE_DESCRIPTORS.stressSignals.apiPath,
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.stressSignals,
      metaMaxAgeSec: DATA_SURFACE_DESCRIPTORS.stressSignals.endpointMaxAgeSec,
    },
    "meta",
    createLazySchema<StressSignalsAllResponse>(
      async () => (await import("@shared/types/market")).StressSignalsAllResponseSchema,
    ),
  ),
  stressSignalDetail: defineParameterizedApiQuery(
    "meta",
    createLazySchema<StressSignalDetailResponse>(
      async () => (await import("@shared/types/market")).StressSignalDetailResponseSchema,
    ),
    (stablecoinId: string, days: number = 30) => ({
      queryKey: ["stress-signals", stablecoinId, days] as const,
      path: API_PATHS.stressSignals(stablecoinId, days),
      producerIntervalMs: CRON_30MIN,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stressSignals,
    }),
  ),
  supplyHistory: defineParameterizedApiQuery(
    "plain",
    createLazySchema<SupplyHistoryPoint[]>(
      async () => (await import("@shared/types/market")).SupplyHistoryResponseSchema,
    ),
    (stablecoinId: string, days: number = 1825) => ({
      queryKey: ["supply-history", stablecoinId, days] as const,
      path: API_PATHS.supplyHistory(stablecoinId, days),
      producerIntervalMs: CRON_24H,
    }),
  ),
} as const;

export type FrontendApiQueryDescriptorRegistry = typeof FRONTEND_API_QUERY_DESCRIPTORS;
