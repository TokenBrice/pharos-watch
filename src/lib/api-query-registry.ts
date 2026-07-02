import { ChainsResponseSchema } from "@shared/types/chains";
import { DdrResponseSchema } from "@shared/types/depeg-resolver";
import { DdrrResponseSchema } from "@shared/types/depeg-resolver-review";
import { TelegramPulseSchema } from "@shared/types/status";
import {
  DailyDigestResponseSchema,
  DigestArchiveResponseSchema,
  DigestSnapshotResponseSchema,
} from "@shared/types/digest";
import {
  BluechipRatingsMapSchema,
  BlacklistResponseSchema,
  BlacklistSummaryResponseSchema,
  DexLiquidityHistoryResponseSchema,
  DexLiquidityMapSchema,
  PegSummaryResponseSchema,
  StablecoinChartResponseSchema,
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
import { StabilityIndexResponseSchema, UsdsStatusResponseSchema } from "@shared/types/stability";
import { HealthResponseSchema } from "@shared/types/status";
import {
  YieldAdapterManifestResponseSchema,
  YieldHistoryResponseSchema,
  YieldRankingsResponseSchema,
} from "@shared/types/yield";
import {
  FRONTEND_API_QUERY_BASE_REGISTRY,
  type FrontendApiQueryBaseDescriptor,
  type FrontendStaticApiQueryBaseDescriptor,
  type MintBurnEventsDescriptorOptions,
  type NonUsdSharePoint,
} from "@/lib/api-query-base-registry";
import { NonUsdShareResponseSchema } from "@/lib/non-usd-share-schema";
import type { ZodType } from "zod";

export type { MintBurnEventsDescriptorOptions };
export type { NonUsdSharePoint };

export interface FrontendApiQueryDescriptor<T> extends FrontendApiQueryBaseDescriptor {
  schema?: ZodType<T>;
}

export interface FrontendStaticApiQueryDescriptor<T> extends FrontendStaticApiQueryBaseDescriptor {
  schema?: ZodType<T>;
}

const base = FRONTEND_API_QUERY_BASE_REGISTRY;

function withSchema<T>(
  descriptor: FrontendApiQueryBaseDescriptor,
  schema: ZodType<T>,
): FrontendApiQueryDescriptor<T> {
  return { ...descriptor, schema };
}

function withStaticSchema<T>(
  descriptor: FrontendStaticApiQueryBaseDescriptor,
  schema: ZodType<T>,
): FrontendStaticApiQueryDescriptor<T> {
  return { ...descriptor, schema };
}

export const FRONTEND_API_QUERY_REGISTRY = {
  stablecoins: withSchema(base.stablecoins, StablecoinListResponseSchema),
  chains: withSchema(base.chains, ChainsResponseSchema),
  bluechipRatings: withSchema(base.bluechipRatings, BluechipRatingsMapSchema),
  dailyDigest: withSchema(base.dailyDigest, DailyDigestResponseSchema),
  dexLiquidity: withSchema(base.dexLiquidity, DexLiquidityMapSchema),
  dexLiquidityHistory: (...args: Parameters<typeof base.dexLiquidityHistory>) =>
    withSchema(base.dexLiquidityHistory(...args), DexLiquidityHistoryResponseSchema),
  digestArchive: withSchema(base.digestArchive, DigestArchiveResponseSchema),
  digestSnapshot: (...args: Parameters<typeof base.digestSnapshot>) =>
    withStaticSchema(base.digestSnapshot(...args), DigestSnapshotResponseSchema),
  health: withSchema(base.health, HealthResponseSchema),
  blacklistSummary: withSchema(base.blacklistSummary, BlacklistSummaryResponseSchema),
  blacklistEvents: (...args: Parameters<typeof base.blacklistEvents>) =>
    withSchema(base.blacklistEvents(...args), BlacklistResponseSchema),
  mintBurnFlows: (...args: Parameters<typeof base.mintBurnFlows>) =>
    withSchema(base.mintBurnFlows(...args), MintBurnFlowsResponseSchema),
  mintBurnFlowsCoin: (...args: Parameters<typeof base.mintBurnFlowsCoin>) =>
    withSchema(base.mintBurnFlowsCoin(...args), MintBurnPerCoinResponseSchema),
  mintBurnEvents: (...args: Parameters<typeof base.mintBurnEvents>) =>
    withSchema(base.mintBurnEvents(...args), MintBurnEventsResponseSchema),
  pegSummary: withSchema(base.pegSummary, PegSummaryResponseSchema),
  reportCards: withSchema(base.reportCards, ReportCardsResponseSchema),
  depegResolver: withSchema(base.depegResolver, DdrResponseSchema),
  depegResolverReview: withSchema(base.depegResolverReview, DdrrResponseSchema),
  redemptionBackstops: withSchema(base.redemptionBackstops, RedemptionBackstopsResponseSchema),
  safetyScoreHistory: (...args: Parameters<typeof base.safetyScoreHistory>) =>
    withSchema(base.safetyScoreHistory(...args), SafetyScoreHistoryResponseSchema),
  stablecoinCharts: withSchema(base.stablecoinCharts, StablecoinChartResponseSchema),
  nonUsdShare: withSchema(base.nonUsdShare, NonUsdShareResponseSchema),
  stabilityIndex: withSchema(base.stabilityIndex, StabilityIndexResponseSchema),
  stabilityIndexDetail: withSchema(base.stabilityIndexDetail, StabilityIndexResponseSchema),
  usdsStatus: withSchema(base.usdsStatus, UsdsStatusResponseSchema),
  telegramPulse: withSchema(base.telegramPulse, TelegramPulseSchema),
  yieldHistory: (...args: Parameters<typeof base.yieldHistory>) =>
    withSchema(base.yieldHistory(...args), YieldHistoryResponseSchema),
  yieldRankings: withSchema(base.yieldRankings, YieldRankingsResponseSchema),
  yieldAdapterManifest: withSchema(base.yieldAdapterManifest, YieldAdapterManifestResponseSchema),
  stressSignals: withSchema(base.stressSignals, StressSignalsAllResponseSchema),
  stressSignalDetail: (...args: Parameters<typeof base.stressSignalDetail>) =>
    withSchema(base.stressSignalDetail(...args), StressSignalDetailResponseSchema),
  supplyHistory: (...args: Parameters<typeof base.supplyHistory>) =>
    withSchema(base.supplyHistory(...args), SupplyHistoryResponseSchema),
} as const;
