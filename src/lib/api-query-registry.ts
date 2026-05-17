import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import type {
  BluechipRatingsMap,
  DailyDigestResponse,
  DexLiquidityHistoryPoint,
  DexLiquidityMap,
  DigestArchiveResponse,
  DigestSnapshotResponse,
  HealthResponse,
  BlacklistResponse,
  BlacklistSummaryResponse,
  MintBurnEventsResponse,
  MintBurnFlowsResponse,
  MintBurnPerCoinResponse,
  PegSummaryResponse,
  ReportCardsResponse,
  RedemptionBackstopsResponse,
  SafetyScoreHistoryResponse,
  StabilityIndexResponse,
  StablecoinListResponse,
  StablecoinChartPoint,
  StressSignalsAllResponse,
  StressSignalDetailResponse,
  SupplyHistoryPoint,
  UsdsStatusResponse,
  YieldHistoryResponse,
  YieldRankingsResponse,
} from "@shared/types";
import { StablecoinChartResponseSchema, UsdsStatusResponseSchema } from "@shared/types/digest";
import {
  BluechipRatingsMapSchema,
  BlacklistResponseSchema,
  BlacklistSummaryResponseSchema,
  DexLiquidityMapSchema,
  PegSummaryResponseSchema,
  StablecoinListResponseSchema,
  StressSignalsAllResponseSchema,
  StressSignalDetailResponseSchema,
  SupplyHistoryResponseSchema,
} from "@shared/types/market";
import {
  MintBurnEventsResponseSchema,
  MintBurnFlowsResponseSchema,
  MintBurnPerCoinResponseSchema,
} from "@shared/types/mint-burn";
import { RedemptionBackstopsResponseSchema } from "@shared/types/redemption";
import { ReportCardsResponseSchema, SafetyScoreHistoryResponseSchema } from "@shared/types/report-cards";
import { StabilityIndexResponseSchema } from "@shared/types/stability";
import { HealthResponseSchema } from "@shared/types/status";
import { YieldHistoryResponseSchema, YieldRankingsResponseSchema } from "@shared/types/yield";
import {
  CRON_1H,
  CRON_1MIN,
  CRON_15MIN,
  CRON_24H,
  CRON_30MIN,
  CRON_BLACKLIST,
  CRON_MINT_BURN,
  CRON_RESERVE_SYNC,
  CRON_YIELD,
} from "@/lib/cron-intervals";
import type { ZodType } from "zod";

export interface FrontendApiQueryDescriptor<T> {
  queryKey: readonly unknown[];
  path: string;
  producerIntervalMs: number;
  schema?: ZodType<T>;
  metaMaxAgeSec?: number;
}

export interface FrontendStaticApiQueryDescriptor<T> {
  queryKey: readonly unknown[];
  path: string;
  schema?: ZodType<T>;
}

export interface NonUsdSharePoint {
  date: number;
  commodityShare: number | null;
  fiatNonUsdShare: number | null;
  commodity: number | null;
  fiatNonUsd: number | null;
  total: number;
}

type YieldHistoryMode = "best" | "source";
type BlacklistEventsDescriptorInput = Pick<
  FrontendApiQueryDescriptor<BlacklistResponse>,
  "queryKey" | "path"
>;

export interface MintBurnEventsDescriptorOptions {
  direction?: string;
  burnType?: "effective_burn" | "bridge_burn" | "review_required";
  scope?: "all" | "counted";
  limit?: number;
  offset?: number;
}

const YIELD_META_MAX_AGE_SEC = CRON_YIELD / 1000;

function pollingDescriptor<T>(descriptor: FrontendApiQueryDescriptor<T>): FrontendApiQueryDescriptor<T> {
  return descriptor;
}

function staticDescriptor<T>(descriptor: FrontendStaticApiQueryDescriptor<T>): FrontendStaticApiQueryDescriptor<T> {
  return descriptor;
}

export const FRONTEND_API_QUERY_REGISTRY = {
  stablecoins: pollingDescriptor<StablecoinListResponse>({
    queryKey: ["stablecoins"],
    path: API_PATHS.stablecoins(),
    producerIntervalMs: CRON_15MIN,
    schema: StablecoinListResponseSchema,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stablecoins,
  }),
  bluechipRatings: pollingDescriptor<BluechipRatingsMap | null>({
    queryKey: ["bluechip-ratings"],
    path: API_PATHS.bluechipRatings(),
    producerIntervalMs: CRON_24H,
    schema: BluechipRatingsMapSchema,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.bluechip,
  }),
  dailyDigest: pollingDescriptor<DailyDigestResponse>({
    queryKey: ["daily-digest"],
    path: API_PATHS.dailyDigest(),
    producerIntervalMs: CRON_24H,
  }),
  dexLiquidity: pollingDescriptor<DexLiquidityMap>({
    queryKey: ["dex-liquidity"],
    path: API_PATHS.dexLiquidity(),
    producerIntervalMs: CRON_30MIN,
    schema: DexLiquidityMapSchema,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.dexLiquidity,
  }),
  dexLiquidityHistory: (stablecoinId: string, days = 90) =>
    pollingDescriptor<DexLiquidityHistoryPoint[]>({
      queryKey: ["dex-liquidity-history", stablecoinId, days],
      path: API_PATHS.dexLiquidityHistory(stablecoinId, days),
      producerIntervalMs: CRON_1H,
    }),
  digestArchive: pollingDescriptor<DigestArchiveResponse>({
    queryKey: ["digest-archive"],
    path: API_PATHS.digestArchive(),
    producerIntervalMs: CRON_24H,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.digestArchive,
  }),
  digestSnapshot: (date: string) =>
    staticDescriptor<DigestSnapshotResponse>({
      queryKey: ["digest-snapshot", date],
      path: API_PATHS.digestSnapshot(date),
    }),
  health: pollingDescriptor<HealthResponse>({
    queryKey: ["health"],
    path: API_PATHS.health(),
    producerIntervalMs: CRON_1MIN,
    schema: HealthResponseSchema,
  }),
  blacklistSummary: pollingDescriptor<BlacklistSummaryResponse>({
    queryKey: ["blacklist-summary"],
    path: API_PATHS.blacklistSummary(),
    producerIntervalMs: CRON_BLACKLIST,
    schema: BlacklistSummaryResponseSchema,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.blacklistSummary,
  }),
  blacklistEvents: ({ queryKey, path }: BlacklistEventsDescriptorInput) =>
    pollingDescriptor<BlacklistResponse>({
      queryKey,
      path,
      producerIntervalMs: CRON_BLACKLIST,
      schema: BlacklistResponseSchema,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.blacklist,
    }),
  mintBurnFlows: (hours = 24) =>
    pollingDescriptor<MintBurnFlowsResponse>({
      queryKey: ["mint-burn-flows", "all", hours],
      path: API_PATHS.mintBurnFlows(hours !== 24 ? { hours } : undefined),
      producerIntervalMs: CRON_MINT_BURN,
      schema: MintBurnFlowsResponseSchema,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows,
    }),
  mintBurnFlowsCoin: (stablecoinId: string, hours = 24) =>
    pollingDescriptor<MintBurnPerCoinResponse>({
      queryKey: ["mint-burn-flows", stablecoinId, hours],
      path: API_PATHS.mintBurnFlows({ stablecoin: stablecoinId, hours: hours !== 24 ? hours : undefined }),
      producerIntervalMs: CRON_MINT_BURN,
      schema: MintBurnPerCoinResponseSchema,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows,
    }),
  mintBurnEvents: (stablecoinId: string, opts?: MintBurnEventsDescriptorOptions) => {
    const params = new URLSearchParams({ stablecoin: stablecoinId });
    if (opts?.direction) params.set("direction", opts.direction);
    if (opts?.burnType) params.set("burnType", opts.burnType);
    if (opts?.scope && opts.scope !== "all") params.set("scope", opts.scope);
    if (opts?.limit) params.set("limit", opts.limit.toString());
    if (opts?.offset) params.set("offset", opts.offset.toString());

    return pollingDescriptor<MintBurnEventsResponse>({
      queryKey: [
        "mint-burn-events",
        stablecoinId,
        opts?.scope ?? "all",
        opts?.direction ?? "all",
        opts?.burnType ?? "all",
        opts?.limit ?? 50,
        opts?.offset ?? 0,
      ],
      path: API_PATHS.mintBurnEvents(Object.fromEntries(params.entries())),
      producerIntervalMs: CRON_MINT_BURN,
      schema: MintBurnEventsResponseSchema,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.mintBurnEvents,
    });
  },
  pegSummary: pollingDescriptor<PegSummaryResponse>({
    queryKey: ["peg-summary"],
    path: API_PATHS.pegSummary(),
    producerIntervalMs: CRON_15MIN,
    schema: PegSummaryResponseSchema,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.pegSummary,
  }),
  reportCards: pollingDescriptor<ReportCardsResponse>({
    queryKey: ["report-cards"],
    path: API_PATHS.reportCards(),
    producerIntervalMs: CRON_15MIN,
    schema: ReportCardsResponseSchema,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.reportCards,
  }),
  redemptionBackstops: pollingDescriptor<RedemptionBackstopsResponse>({
    queryKey: ["redemption-backstops"],
    path: API_PATHS.redemptionBackstops(),
    producerIntervalMs: CRON_RESERVE_SYNC,
    schema: RedemptionBackstopsResponseSchema,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops,
  }),
  safetyScoreHistory: (stablecoinId: string, days = 3650) =>
    pollingDescriptor<SafetyScoreHistoryResponse>({
      queryKey: ["safety-score-history", stablecoinId, days],
      path: API_PATHS.safetyScoreHistory(stablecoinId, days),
      producerIntervalMs: CRON_24H,
      schema: SafetyScoreHistoryResponseSchema,
      metaMaxAgeSec: CRON_24H / 1000,
    }),
  stablecoinCharts: pollingDescriptor<StablecoinChartPoint[]>({
    queryKey: ["stablecoin-charts"],
    path: API_PATHS.stablecoinCharts(),
    producerIntervalMs: CRON_1H,
    schema: StablecoinChartResponseSchema,
  }),
  nonUsdShare: pollingDescriptor<NonUsdSharePoint[]>({
    queryKey: ["non-usd-share"],
    path: API_PATHS.nonUsdShare(),
    producerIntervalMs: CRON_24H,
  }),
  stabilityIndex: pollingDescriptor<StabilityIndexResponse>({
    queryKey: ["stability-index"],
    path: API_PATHS.stabilityIndex(),
    producerIntervalMs: CRON_30MIN,
    schema: StabilityIndexResponseSchema,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stabilityIndex,
  }),
  stabilityIndexDetail: pollingDescriptor<StabilityIndexResponse>({
    queryKey: ["stability-index-detail"],
    path: API_PATHS.stabilityIndex(true),
    producerIntervalMs: CRON_30MIN,
    schema: StabilityIndexResponseSchema,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stabilityIndex,
  }),
  usdsStatus: pollingDescriptor<UsdsStatusResponse | null>({
    queryKey: ["usds-status"],
    path: API_PATHS.usdsStatus(),
    producerIntervalMs: CRON_15MIN,
    schema: UsdsStatusResponseSchema,
  }),
  yieldHistory: (stablecoinId: string, days: number, mode: YieldHistoryMode, sourceKey?: string | null) =>
    pollingDescriptor<YieldHistoryResponse>({
      queryKey: ["yield-history", stablecoinId, days, mode, sourceKey ?? null],
      path: API_PATHS.yieldHistory(stablecoinId, days, mode, sourceKey ?? undefined),
      producerIntervalMs: CRON_YIELD,
      schema: YieldHistoryResponseSchema,
      metaMaxAgeSec: YIELD_META_MAX_AGE_SEC,
    }),
  yieldRankings: pollingDescriptor<YieldRankingsResponse>({
    queryKey: ["yield-rankings"],
    path: API_PATHS.yieldRankings(),
    producerIntervalMs: CRON_YIELD,
    schema: YieldRankingsResponseSchema,
    metaMaxAgeSec: YIELD_META_MAX_AGE_SEC,
  }),
  stressSignals: pollingDescriptor<StressSignalsAllResponse>({
    queryKey: ["stress-signals"],
    path: API_PATHS.stressSignals(),
    producerIntervalMs: CRON_30MIN,
    schema: StressSignalsAllResponseSchema,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stressSignals,
  }),
  stressSignalDetail: (stablecoinId: string, days = 30) =>
    pollingDescriptor<StressSignalDetailResponse>({
      queryKey: ["stress-signals", stablecoinId, days],
      path: API_PATHS.stressSignals(stablecoinId, days),
      producerIntervalMs: CRON_30MIN,
      schema: StressSignalDetailResponseSchema,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stressSignals,
    }),
  supplyHistory: (stablecoinId: string, days = 1825) =>
    pollingDescriptor<SupplyHistoryPoint[]>({
      queryKey: ["supply-history", stablecoinId, days],
      path: API_PATHS.supplyHistory(stablecoinId, days),
      producerIntervalMs: CRON_1H,
      schema: SupplyHistoryResponseSchema,
    }),
} as const;
