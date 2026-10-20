import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { PER_COIN_CACHE_TTL_SECONDS } from "@shared/lib/api-cache-profiles";
import type { SupplyHistoryWindow } from "@shared/lib/api-query-history";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { DATA_SURFACE_DESCRIPTORS, type YieldHistoryMode } from "@shared/lib/data-surface-descriptors";
import type { ChainsResponse } from "@shared/types/chains";
import type { StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";
import type { DdrResponse } from "@shared/types/depeg-resolver";
import type { DdrrResponse } from "@shared/types/depeg-resolver-review";
import type { DailyDigestResponse, DigestArchiveResponse, DigestPromoResponse, DigestSnapshotResponse } from "@shared/types/digest";
import type {
  BlacklistResponse,
  BlacklistSummaryResponse,
  BluechipRatingsMap,
  DexLiquidityHistoryPoint,
  DexLiquidityMap,
  DexLiquidityTableMap,
  NonUsdSharePoint,
  PegSummaryResponse,
  StablecoinChartPoint,
  StablecoinListResponse,
  StressSignalDetailResponse,
  StressSignalsAllResponse,
  SupplyHistoryPoint,
} from "@shared/types/market";
import type { MintBurnEventsResponse, MintBurnFlowsResponse, MintBurnPerCoinResponse } from "@shared/types/mint-burn";
import type { RedemptionBackstopsResponse } from "@shared/types/redemption";
import type { RedemptionBackstopCoinResponse } from "@shared/types/redemption";
import type { YieldRankingsCoinResponse } from "@shared/types/yield";
import type {
  SafetyScoreHistoryResponse,
  SafetyScoreHistoryV2Response,
} from "@shared/types/safety-score-history";
import type { ReportCardsV9CurrentResponse, SafetyGradesResponse } from "@shared/types/report-cards-v9";
import type { ReportCardsV9TableResponse, ReportCardsV9DetailResponse } from "@shared/types/report-cards-v9-projections";
import type { DependencyGraphResponse } from "@shared/types/dependency-graph";
import type {
  HealthResponse,
  PublicStatusHistoryResponse,
  PublicStatusHistoryWindow,
} from "@shared/types/status/public-health";
import type { TelegramPulse } from "@shared/types/status/telegram";
import type { UsdsStatusResponse } from "@shared/types/stability";
import type { TapeEventsResponse } from "@shared/types/tape-event";
import type { YieldAdapterManifestResponse, YieldHistoryResponse, YieldRankingsResponse } from "@shared/types/yield";
import type { YieldRankingsSummaryResponse } from "@shared/types/yield-summary";
import {
  defineApiQuery,
  defineParameterizedApiQuery,
  defineParameterizedStaticApiQuery,
} from "@/lib/api-query-contract";
import { STABILITY_INDEX_QUERY_DESCRIPTOR } from "@/lib/api-query-domains/stability-light";
import {
  STABILITY_INDEX_DETAIL_QUERY_DESCRIPTOR,
  STABILITY_INDEX_FULL_HISTORY_QUERY_DESCRIPTOR,
} from "@/lib/api-query-domains/stability-detail";
import {
  CRON_15MIN,
  CRON_1MIN,
  CRON_BLACKLIST,
  CRON_BLUECHIP,
  CRON_CHARTS,
  CRON_DAILY_DIGEST,
  CRON_MINT_BURN,
  CRON_SAFETY_GRADE_HISTORY,
  CRON_SUPPLY_SNAPSHOT,
  CRON_TELEGRAM_PULSE,
  CRON_TAPE,
  CRON_USDS_STATUS,
} from "@/lib/cron-intervals";
import { createLazySchema } from "@shared/lib/schema-like";

export type { NonUsdSharePoint } from "@shared/types/market";

/** First-paint window selected by the stablecoin detail market charts. */
export const STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS = 90;



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

type TapeEventsResponseBody = Omit<TapeEventsResponse, "_meta">;

type TapeEventsDescriptorInput = {
  queryKey: readonly unknown[];
  path: string;
};

export const TAPE_EVENTS_RESPONSE_BODY_SCHEMA = createLazySchema<TapeEventsResponseBody>(async () =>
  (await import("@shared/types/tape-event")).TapeEventsResponseSchema.omit({ _meta: true }),
);

function defineTapeEventsQuery() {
  return defineParameterizedApiQuery(
    "meta",
    TAPE_EVENTS_RESPONSE_BODY_SCHEMA,
    ({ queryKey, path }: TapeEventsDescriptorInput) => ({ queryKey, path, producerIntervalMs: CRON_TAPE }),
  );
}

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
  stablecoinLiveSummary: defineParameterizedApiQuery(
    "meta",
    // Schema loading stays outside the shared shell's eager module graph.
    createLazySchema<StablecoinLiveSummary>(async () =>
      (await import("@shared/types/stablecoin-live-summary")).StablecoinLiveSummarySchema,
    ),
    (stablecoinId: string) => ({
      queryKey: ["stablecoin-live-summary", stablecoinId] as const,
      path: API_PATHS.stablecoinLiveSummary(stablecoinId),
      producerIntervalMs: PER_COIN_CACHE_TTL_SECONDS * 1000,
    }),
  ),
  stablecoins: defineApiQuery(
    {
      queryKey: DATA_SURFACE_DESCRIPTORS.stablecoins.queryKey,
      path: DATA_SURFACE_DESCRIPTORS.stablecoins.apiPath,
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.stablecoins,
    },
    "meta",
    createLazySchema<StablecoinListResponse>(
      async () => (await import("@shared/types/market")).StablecoinListResponseSchema,
    ),
  ),
  homepageSnapshot: defineApiQuery(
    { queryKey: ["homepage-snapshot"] as const, path: API_PATHS.homepageSnapshot(), producerIntervalMs: CRON_15MIN },
    "plain",
    createLazySchema(async () => (await import("@shared/types/homepage")).HomepageSnapshotSchema),
  ),
  homepageHistory: defineApiQuery(
    { queryKey: ["homepage-history"] as const, path: API_PATHS.homepageHistory(), producerIntervalMs: CRON_CHARTS },
    "plain",
    createLazySchema(async () => (await import("@shared/types/homepage")).HomepageHistorySchema),
  ),
  chains: defineApiQuery(
    {
      queryKey: ["chains"] as const,
      path: API_PATHS.chains(),
      producerIntervalMs: CRON_15MIN,
    },
    "meta",
    createLazySchema<ChainsResponse>(async () => (await import("@shared/types/chains")).ChainsResponseSchema),
  ),
  chainsDetail: defineParameterizedApiQuery(
    "meta",
    createLazySchema<ChainsResponse>(async () => (await import("@shared/types/chains")).ChainsResponseSchema),
    (chainId: string) => ({
      queryKey: ["chains", "detail", chainId] as const,
      path: API_PATHS.chainsDetail(chainId),
      producerIntervalMs: CRON_15MIN,
    }),
  ),
  bluechipRatings: defineApiQuery(
    {
      queryKey: ["bluechip-ratings"] as const,
      path: API_PATHS.bluechipRatings(),
      producerIntervalMs: CRON_BLUECHIP,
    },
    "meta",
    createLazySchema<BluechipRatingsMap>(async () => (await import("@shared/types/market")).BluechipRatingsMapSchema),
  ),
  dailyDigest: defineApiQuery(
    {
      queryKey: ["daily-digest"] as const,
      path: API_PATHS.dailyDigest(),
      producerIntervalMs: CRON_DAILY_DIGEST,
    },
    "plain",
    createLazySchema<DailyDigestResponse>(async () => (await import("@shared/types/digest")).DailyDigestResponseSchema),
  ),
  dexLiquidity: defineApiQuery(
    {
      queryKey: DATA_SURFACE_DESCRIPTORS.dexLiquidity.queryKey,
      path: DATA_SURFACE_DESCRIPTORS.dexLiquidity.apiPath,
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.dexLiquidity,
    },
    "meta",
    createLazySchema<DexLiquidityMap>(async () => (await import("@shared/types/market")).DexLiquidityMapSchema),
  ),
  // Lazy schema boundaries keep executable cohort validators out of the eager shell.
  dexLiquidityCoin: defineParameterizedApiQuery(
    "meta",
    createLazySchema<DexLiquidityMap>(async () =>
      (await import("@shared/types/market")).DexLiquidityCoinResponseSchema.transform(({ coins }) => coins),
    ),
    (stablecoinId: string) => ({
      queryKey: ["dex-liquidity-coin", stablecoinId] as const,
      path: API_PATHS.dexLiquidityCoin(stablecoinId),
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.dexLiquidity,
    }),
  ),
  dexLiquidityTable: defineApiQuery(
    {
      queryKey: ["dex-liquidity-table"] as const,
      path: API_PATHS.dexLiquidityTable(),
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.dexLiquidity,
    },
    "meta",
    createLazySchema<DexLiquidityTableMap>(async () => (await import("@shared/types/market")).DexLiquidityTableMapSchema),
  ),
  redemptionBackstopCoin: defineParameterizedApiQuery(
    "meta",
    createLazySchema<RedemptionBackstopCoinResponse>(async () => (await import("@shared/types/redemption")).RedemptionBackstopCoinResponseSchema),
    (stablecoinId: string) => ({
      queryKey: ["redemption-backstop-coin", stablecoinId] as const,
      path: API_PATHS.redemptionBackstopCoin(stablecoinId),
      producerIntervalMs: CRON_INTERVALS["sync-redemption-backstops"] * 1000,
    }),
  ),
  yieldRankingsCoin: defineParameterizedApiQuery(
    "meta",
    createLazySchema<YieldRankingsCoinResponse>(async () => (await import("@shared/types/yield")).YieldRankingsCoinResponseSchema),
    (stablecoinId: string) => ({
      queryKey: ["yield-rankings-coin", stablecoinId] as const,
      path: API_PATHS.yieldRankingsCoin(stablecoinId),
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.yieldRankings,
    }),
  ),
  dexLiquidityHistory: defineParameterizedApiQuery(
    "plain",
    createLazySchema<DexLiquidityHistoryPoint[]>(
      async () => (await import("@shared/types/market")).DexLiquidityHistoryResponseSchema,
    ),
    (stablecoinId: string, days: number = 90) => ({
      queryKey: ["dex-liquidity-chart-history", stablecoinId, days] as const,
      path: API_PATHS.dexLiquidityChartHistory(stablecoinId, days),
      // Same producer as the `dexLiquidity` sibling: `sync-dex-liquidity` (2h)
      // delete-and-replaces today's `dex_liquidity_history` row every run, so the
      // chart's newest point changes every two hours even though its granularity is daily.
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.dexLiquidity,
    }),
  ),
  digestArchive: defineApiQuery(
    {
      queryKey: ["digest-archive"] as const,
      path: API_PATHS.digestArchive(),
      producerIntervalMs: CRON_DAILY_DIGEST,
    },
    "meta",
    createLazySchema<DigestArchiveResponse>(
      async () => (await import("@shared/types/digest")).DigestArchiveResponseSchema,
    ),
  ),
  digestPromo: defineApiQuery(
    {
      queryKey: ["digest-promo"] as const,
      path: API_PATHS.digestPromo(),
      producerIntervalMs: CRON_DAILY_DIGEST,
    },
    "plain",
    // Keep digest validators out of the eager client bundle, like archive reads.
    createLazySchema<DigestPromoResponse>(
      async () => (await import("@shared/types/digest")).DigestPromoResponseSchema,
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
  publicStatusHistory: defineParameterizedApiQuery(
    "plain",
    createLazySchema<PublicStatusHistoryResponse>(
      async () => (await import("@shared/types/status/public-health")).PublicStatusHistoryResponseSchema,
    ),
    (window: PublicStatusHistoryWindow) => ({
      queryKey: ["public-status-history", window] as const,
      path: API_PATHS.publicStatusHistory({ window, limit: 200 }),
      producerIntervalMs: CRON_1MIN,
    }),
  ),
  latestEvents: defineTapeEventsQuery(),
  blacklistSummary: defineApiQuery(
    {
      queryKey: ["blacklist-summary"] as const,
      path: API_PATHS.blacklistSummary(),
      producerIntervalMs: CRON_BLACKLIST,
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
      };
    },
  ),
  pegSummary: defineApiQuery(
    {
      queryKey: ["peg-summary"] as const,
      path: API_PATHS.pegSummary(),
      producerIntervalMs: CRON_15MIN,
    },
    "meta",
    createLazySchema<PegSummaryResponse>(async () => (await import("@shared/types/market")).PegSummaryResponseSchema),
  ),
  reportCardsV9: defineApiQuery(
    {
      queryKey: DATA_SURFACE_DESCRIPTORS.reportCards.queryKey,
      path: `${DATA_SURFACE_DESCRIPTORS.reportCards.apiPath}?freshness=operands`,
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.reportCards,
    },
    "meta",
    createLazySchema<ReportCardsV9CurrentResponse>(
      async () => (await import("@shared/types/report-cards-v9")).ReportCardsV9CurrentResponseSchema,
    ),
  ),
  // Lazy schemas preserve the report family client chunk boundary.
  reportCardsV9Table: defineApiQuery(
    {
      queryKey: ["report-cards", "v9", "table", 1] as const,
      path: API_PATHS.reportCardsV9Table(),
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.reportCards,
    },
    "meta",
    createLazySchema<ReportCardsV9TableResponse>(
      async () => (await import("@shared/types/report-cards-v9-projections")).ReportCardsV9TableResponseSchema,
    ),
  ),
  reportCardsV9Detail: defineParameterizedApiQuery(
    "meta",
    createLazySchema<ReportCardsV9DetailResponse>(
      async () => (await import("@shared/types/report-cards-v9-projections")).ReportCardsV9DetailResponseSchema,
    ),
    (stablecoinId: string) => ({
      queryKey: ["report-cards", "v9", "detail", 1, stablecoinId] as const,
      path: `${API_PATHS.reportCardsV9Detail(stablecoinId)}&freshness=operands`,
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.reportCards,
    }),
  ),
  // Free no-key grade projection of the same V9 publication; `/api/` reads it
  // only when a visitor checks a donor wallet.
  safetyGrades: defineApiQuery(
    {
      queryKey: ["safety-grades"] as const,
      path: API_PATHS.safetyGrades(),
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.reportCards,
    },
    "plain",
    createLazySchema<SafetyGradesResponse>(
      async () => (await import("@shared/types/report-cards-v9")).SafetyGradesResponseSchema,
    ),
  ),
  // Lazy validators keep the report-card schema family out of the eager client bundle.
  dependencyGraph: defineApiQuery(
    {
      queryKey: ["dependency-graph", "v2"] as const,
      path: API_PATHS.dependencyGraph(),
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.reportCards,
    },
    "plain",
    createLazySchema<DependencyGraphResponse>(
      async () => (await import("@shared/types/dependency-graph")).DependencyGraphResponseSchema,
    ),
  ),
  depegResolver: defineApiQuery(
    {
      queryKey: ["depeg-resolver"] as const,
      path: API_PATHS.depegResolver(),
      producerIntervalMs: CRON_INTERVALS["compute-depeg-resolver"] * 1000,
    },
    "meta",
    createLazySchema<DdrResponse>(async () => (await import("@shared/types/depeg-resolver")).DdrResponseSchema),
  ),
  depegResolverReview: defineApiQuery(
    {
      queryKey: ["depeg-resolver-review"] as const,
      path: API_PATHS.depegResolverReview(),
      producerIntervalMs: CRON_INTERVALS["compute-depeg-resolver"] * 1000,
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
      producerIntervalMs: CRON_INTERVALS["sync-redemption-backstops"] * 1000,
    },
    "meta",
    createLazySchema<RedemptionBackstopsResponse>(
      async () => (await import("@shared/types/redemption")).RedemptionBackstopsResponseSchema,
    ),
  ),
  safetyScoreHistory: defineParameterizedApiQuery(
    "meta",
    createLazySchema<SafetyScoreHistoryResponse>(
      async () => (await import("@shared/types/safety-score-history")).SafetyScoreHistoryResponseSchema,
    ),
    (stablecoinId: string, days: number = 3650) => ({
      queryKey: ["safety-score-history", stablecoinId, days] as const,
      path: API_PATHS.safetyScoreHistory(stablecoinId, days),
      producerIntervalMs: CRON_SAFETY_GRADE_HISTORY,
    }),
  ),
  safetyScoreHistoryV2: defineParameterizedApiQuery(
    "meta",
    createLazySchema<SafetyScoreHistoryV2Response>(
      async () => (await import("@shared/types/safety-score-history")).SafetyScoreHistoryV2ResponseSchema,
    ),
    (stablecoinId: string, days: number = 3650) => ({
      queryKey: ["safety-score-history-v2", stablecoinId, days] as const,
      path: API_PATHS.safetyScoreHistoryV2(stablecoinId, days),
      producerIntervalMs: CRON_SAFETY_GRADE_HISTORY,
    }),
  ),
  stablecoinCharts: defineApiQuery(
    {
      queryKey: ["stablecoin-charts"] as const,
      path: API_PATHS.stablecoinCharts(),
      producerIntervalMs: CRON_CHARTS,
    },
    "meta",
    createLazySchema<StablecoinChartPoint[]>(
      async () => (await import("@shared/types/market")).StablecoinChartResponseSchema,
    ),
  ),
  nonUsdShare: defineApiQuery(
    {
      queryKey: ["non-usd-share"] as const,
      path: API_PATHS.nonUsdShare(),
      producerIntervalMs: CRON_SUPPLY_SNAPSHOT,
    },
    "meta",
    createLazySchema<NonUsdSharePoint[]>(
      async () => (await import("@shared/types/market")).NonUsdShareResponseSchema,
    ),
  ),
  stabilityIndex: STABILITY_INDEX_QUERY_DESCRIPTOR,
  stabilityIndexDetail: STABILITY_INDEX_DETAIL_QUERY_DESCRIPTOR,
  stabilityIndexFullHistory: STABILITY_INDEX_FULL_HISTORY_QUERY_DESCRIPTOR,
  usdsStatus: defineApiQuery(
    {
      queryKey: ["usds-status"] as const,
      path: API_PATHS.usdsStatus(),
      // `sync-usds-status` runs daily (0 8 * * *); the `usdsStatus` freshness lane
      // already declares that cadence.
      producerIntervalMs: CRON_USDS_STATUS,
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
    }),
  ),
  yieldRankings: defineApiQuery(
    {
      queryKey: DATA_SURFACE_DESCRIPTORS.yieldRankings.queryKey,
      path: DATA_SURFACE_DESCRIPTORS.yieldRankings.apiPath,
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.yieldRankings,
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
      producerIntervalMs: DATA_SURFACE_PRODUCER_INTERVAL_MS.stressSignals,
    }),
  ),
  supplyHistory: defineParameterizedApiQuery(
    "meta",
    createLazySchema<SupplyHistoryPoint[]>(
      async () => (await import("@shared/types/market")).SupplyHistoryResponseSchema,
    ),
    (stablecoinId: string, window: SupplyHistoryWindow = 1825) => ({
      queryKey: ["supply-history", stablecoinId, window] as const,
      path: API_PATHS.supplyHistory(stablecoinId, window),
      producerIntervalMs: CRON_SUPPLY_SNAPSHOT,
    }),
  ),
} as const;
