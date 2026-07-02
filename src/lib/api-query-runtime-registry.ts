import type { ChainsResponse } from "@shared/types/chains";
import type { DdrResponse } from "@shared/types/depeg-resolver";
import type { DdrrResponse } from "@shared/types/depeg-resolver-review";
import type {
  DailyDigestResponse,
  DigestArchiveResponse,
  DigestSnapshotResponse,
} from "@shared/types/digest";
import type {
  BluechipRatingsMap,
  BlacklistResponse,
  BlacklistSummaryResponse,
  DexLiquidityHistoryPoint,
  DexLiquidityMap,
  PegSummaryResponse,
  StablecoinChartPoint,
  StablecoinListResponse,
  StressSignalsAllResponse,
  StressSignalDetailResponse,
  SupplyHistoryPoint,
} from "@shared/types/market";
import type {
  MintBurnEventsResponse,
  MintBurnFlowsResponse,
  MintBurnPerCoinResponse,
} from "@shared/types/mint-burn";
import type { RedemptionBackstopsResponse } from "@shared/types/redemption";
import type { ReportCardsResponse, SafetyScoreHistoryResponse } from "@shared/types/report-cards";
import type { StabilityIndexResponse, UsdsStatusResponse } from "@shared/types/stability";
import type { HealthResponse, TelegramPulse } from "@shared/types/status";
import type {
  YieldAdapterManifestResponse,
  YieldHistoryResponse,
  YieldRankingsResponse,
} from "@shared/types/yield";
import {
  FRONTEND_API_QUERY_BASE_REGISTRY,
  type FrontendApiQueryBaseDescriptor,
  type FrontendStaticApiQueryBaseDescriptor,
  type MintBurnEventsDescriptorOptions,
  type NonUsdSharePoint,
} from "@/lib/api-query-base-registry";
import type { SchemaLike, SchemaLikeLoader, SchemaLikeSource } from "@/lib/schema-like";

export type { MintBurnEventsDescriptorOptions, NonUsdSharePoint };

export interface FrontendApiQueryDescriptor<T> extends FrontendApiQueryBaseDescriptor {
  schema?: SchemaLikeSource<T>;
}

export interface FrontendStaticApiQueryDescriptor<T> extends FrontendStaticApiQueryBaseDescriptor {
  schema?: SchemaLikeSource<T>;
}

const base = FRONTEND_API_QUERY_BASE_REGISTRY;

function withSchema<T>(
  descriptor: FrontendApiQueryBaseDescriptor,
  schema: SchemaLikeSource<T>,
): FrontendApiQueryDescriptor<T> {
  return { ...descriptor, schema };
}

function withStaticSchema<T>(
  descriptor: FrontendStaticApiQueryBaseDescriptor,
  schema: SchemaLikeSource<T>,
): FrontendStaticApiQueryDescriptor<T> {
  return { ...descriptor, schema };
}

function lazySchema<T>(loader: () => Promise<SchemaLike<T>>): SchemaLikeLoader<T> {
  let cached: Promise<SchemaLike<T>> | null = null;
  return () => {
    cached ??= loader();
    return cached;
  };
}

const schemas = {
  stablecoins: lazySchema<StablecoinListResponse>(async () => (await import("@shared/types/market")).StablecoinListResponseSchema),
  chains: lazySchema<ChainsResponse>(async () => (await import("@shared/types/chains")).ChainsResponseSchema),
  bluechipRatings: lazySchema<BluechipRatingsMap>(async () => (await import("@shared/types/market")).BluechipRatingsMapSchema),
  dailyDigest: lazySchema<DailyDigestResponse>(async () => (await import("@shared/types/digest")).DailyDigestResponseSchema),
  dexLiquidity: lazySchema<DexLiquidityMap>(async () => (await import("@shared/types/market")).DexLiquidityMapSchema),
  dexLiquidityHistory: lazySchema<DexLiquidityHistoryPoint[]>(async () => (await import("@shared/types/market")).DexLiquidityHistoryResponseSchema),
  digestArchive: lazySchema<DigestArchiveResponse>(async () => (await import("@shared/types/digest")).DigestArchiveResponseSchema),
  digestSnapshot: lazySchema<DigestSnapshotResponse>(async () => (await import("@shared/types/digest")).DigestSnapshotResponseSchema),
  health: lazySchema<HealthResponse>(async () => (await import("@shared/types/status")).HealthResponseSchema),
  blacklistSummary: lazySchema<BlacklistSummaryResponse>(async () => (await import("@shared/types/market")).BlacklistSummaryResponseSchema),
  blacklistEvents: lazySchema<BlacklistResponse>(async () => (await import("@shared/types/market")).BlacklistResponseSchema),
  mintBurnFlows: lazySchema<MintBurnFlowsResponse>(async () => (await import("@shared/types/mint-burn")).MintBurnFlowsResponseSchema),
  mintBurnFlowsCoin: lazySchema<MintBurnPerCoinResponse>(async () => (await import("@shared/types/mint-burn")).MintBurnPerCoinResponseSchema),
  mintBurnEvents: lazySchema<MintBurnEventsResponse>(async () => (await import("@shared/types/mint-burn")).MintBurnEventsResponseSchema),
  pegSummary: lazySchema<PegSummaryResponse>(async () => (await import("@shared/types/market")).PegSummaryResponseSchema),
  reportCards: lazySchema<ReportCardsResponse>(async () => (await import("@shared/types/report-cards")).ReportCardsResponseSchema),
  depegResolver: lazySchema<DdrResponse>(async () => (await import("@shared/types/depeg-resolver")).DdrResponseSchema),
  depegResolverReview: lazySchema<DdrrResponse>(async () => (await import("@shared/types/depeg-resolver-review")).DdrrResponseSchema),
  redemptionBackstops: lazySchema<RedemptionBackstopsResponse>(async () => (await import("@shared/types/redemption")).RedemptionBackstopsResponseSchema),
  safetyScoreHistory: lazySchema<SafetyScoreHistoryResponse>(async () => (await import("@shared/types/report-cards")).SafetyScoreHistoryResponseSchema),
  stablecoinCharts: lazySchema<StablecoinChartPoint[]>(async () => (await import("@shared/types/market")).StablecoinChartResponseSchema),
  nonUsdShare: lazySchema<NonUsdSharePoint[]>(async () => (await import("@/lib/non-usd-share-schema")).NonUsdShareResponseSchema),
  stabilityIndex: lazySchema<StabilityIndexResponse>(async () => (await import("@shared/types/stability")).StabilityIndexResponseSchema),
  usdsStatus: lazySchema<UsdsStatusResponse>(async () => (await import("@shared/types/stability")).UsdsStatusResponseSchema),
  telegramPulse: lazySchema<TelegramPulse>(async () => (await import("@shared/types/status")).TelegramPulseSchema),
  yieldHistory: lazySchema<YieldHistoryResponse>(async () => (await import("@shared/types/yield")).YieldHistoryResponseSchema),
  yieldRankings: lazySchema<YieldRankingsResponse>(async () => (await import("@shared/types/yield")).YieldRankingsResponseSchema),
  yieldAdapterManifest: lazySchema<YieldAdapterManifestResponse>(async () => (await import("@shared/types/yield")).YieldAdapterManifestResponseSchema),
  stressSignals: lazySchema<StressSignalsAllResponse>(async () => (await import("@shared/types/market")).StressSignalsAllResponseSchema),
  stressSignalDetail: lazySchema<StressSignalDetailResponse>(async () => (await import("@shared/types/market")).StressSignalDetailResponseSchema),
  supplyHistory: lazySchema<SupplyHistoryPoint[]>(async () => (await import("@shared/types/market")).SupplyHistoryResponseSchema),
};

export const FRONTEND_API_QUERY_RUNTIME_REGISTRY = {
  stablecoins: withSchema(base.stablecoins, schemas.stablecoins),
  chains: withSchema(base.chains, schemas.chains),
  bluechipRatings: withSchema(base.bluechipRatings, schemas.bluechipRatings),
  dailyDigest: withSchema(base.dailyDigest, schemas.dailyDigest),
  dexLiquidity: withSchema(base.dexLiquidity, schemas.dexLiquidity),
  dexLiquidityHistory: (...args: Parameters<typeof base.dexLiquidityHistory>) =>
    withSchema(base.dexLiquidityHistory(...args), schemas.dexLiquidityHistory),
  digestArchive: withSchema(base.digestArchive, schemas.digestArchive),
  digestSnapshot: (...args: Parameters<typeof base.digestSnapshot>) =>
    withStaticSchema(base.digestSnapshot(...args), schemas.digestSnapshot),
  health: withSchema(base.health, schemas.health),
  blacklistSummary: withSchema(base.blacklistSummary, schemas.blacklistSummary),
  blacklistEvents: (...args: Parameters<typeof base.blacklistEvents>) =>
    withSchema(base.blacklistEvents(...args), schemas.blacklistEvents),
  mintBurnFlows: (...args: Parameters<typeof base.mintBurnFlows>) =>
    withSchema(base.mintBurnFlows(...args), schemas.mintBurnFlows),
  mintBurnFlowsCoin: (...args: Parameters<typeof base.mintBurnFlowsCoin>) =>
    withSchema(base.mintBurnFlowsCoin(...args), schemas.mintBurnFlowsCoin),
  mintBurnEvents: (...args: Parameters<typeof base.mintBurnEvents>) =>
    withSchema(base.mintBurnEvents(...args), schemas.mintBurnEvents),
  pegSummary: withSchema(base.pegSummary, schemas.pegSummary),
  reportCards: withSchema(base.reportCards, schemas.reportCards),
  depegResolver: withSchema(base.depegResolver, schemas.depegResolver),
  depegResolverReview: withSchema(base.depegResolverReview, schemas.depegResolverReview),
  redemptionBackstops: withSchema(base.redemptionBackstops, schemas.redemptionBackstops),
  safetyScoreHistory: (...args: Parameters<typeof base.safetyScoreHistory>) =>
    withSchema(base.safetyScoreHistory(...args), schemas.safetyScoreHistory),
  stablecoinCharts: withSchema(base.stablecoinCharts, schemas.stablecoinCharts),
  nonUsdShare: withSchema(base.nonUsdShare, schemas.nonUsdShare),
  stabilityIndex: withSchema(base.stabilityIndex, schemas.stabilityIndex),
  stabilityIndexDetail: withSchema(base.stabilityIndexDetail, schemas.stabilityIndex),
  usdsStatus: withSchema(base.usdsStatus, schemas.usdsStatus),
  telegramPulse: withSchema(base.telegramPulse, schemas.telegramPulse),
  yieldHistory: (...args: Parameters<typeof base.yieldHistory>) =>
    withSchema(base.yieldHistory(...args), schemas.yieldHistory),
  yieldRankings: withSchema(base.yieldRankings, schemas.yieldRankings),
  yieldAdapterManifest: withSchema(base.yieldAdapterManifest, schemas.yieldAdapterManifest),
  stressSignals: withSchema(base.stressSignals, schemas.stressSignals),
  stressSignalDetail: (...args: Parameters<typeof base.stressSignalDetail>) =>
    withSchema(base.stressSignalDetail(...args), schemas.stressSignalDetail),
  supplyHistory: (...args: Parameters<typeof base.supplyHistory>) =>
    withSchema(base.supplyHistory(...args), schemas.supplyHistory),
} as const;
