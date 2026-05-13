import type { SupplyHistoryPoint } from "@/hooks/use-stablecoins";
import type {
  BlacklistSummaryResponse,
  PegSummaryCoin,
  PegSummaryResponse,
  RedemptionBackstopsResponse,
  ReportCardsResponse,
  StablecoinData,
  StablecoinListResponse,
  StablecoinMeta,
  StressSignalEntry,
  StressSignalsAllResponse,
  YieldRanking,
  YieldRankingsResponse,
  DexLiquidityMap,
} from "@shared/types";
import type { BlacklistStablecoin, MintBurnFlowsResponse } from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import {
  getCirculatingRaw,
  getPrevDayRawOrNull,
  getPrevMonthRawOrNull,
  getPrevWeekRawOrNull,
} from "@shared/lib/supply";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import {
  deriveDeviationBps,
  deriveGaugeDeviationBps,
  derivePegReferenceContext,
  deriveSupplyFromMarketCap,
} from "@/lib/stablecoin-detail-derive";
import type { ApiMeta } from "@/lib/api";
import type { ReserveResult } from "@shared/lib/reserve-templates";

const YEAR_SECONDS = 365 * DAY_SECONDS;
const YEARLY_PERFORMANCE_ANCHOR_TOLERANCE_SECONDS = 14 * DAY_SECONDS;

export interface DetailQueryResource<TData> {
  data?: TData;
  dataUpdatedAt: number;
  error: unknown | null;
  meta: ApiMeta | null;
}

export interface DetailSupplyHistoryInput {
  data?: SupplyHistoryPoint[];
  isLoading: boolean;
  error: unknown | null;
}

export interface DetailStablecoinListInput extends DetailQueryResource<StablecoinListResponse> {
  isLoading: boolean;
  isError: boolean;
}

export interface StablecoinDetailViewModelQueryInputs {
  supplyHistory: DetailSupplyHistoryInput;
  stablecoinList: DetailStablecoinListInput;
  pegSummary: DetailQueryResource<PegSummaryResponse>;
  dexLiquidity: DetailQueryResource<DexLiquidityMap>;
  reportCards: DetailQueryResource<ReportCardsResponse>;
  redemptionBackstops: DetailQueryResource<RedemptionBackstopsResponse>;
}

export interface DetailFlowsInput {
  data?: MintBurnFlowsResponse;
  isLoading: boolean;
}

export interface DetailBlacklistInput {
  summary?: BlacklistSummaryResponse;
  isLoading: boolean;
}

export interface DetailReservesInput {
  live?: ReserveResult | null;
  error?: unknown | null;
}

export interface StablecoinDetailViewModelSupplementalInputs {
  yieldRankingsData?: YieldRankingsResponse;
  stressSignalsData?: StressSignalsAllResponse;
  flows: DetailFlowsInput;
  blacklist: DetailBlacklistInput;
  reserves: DetailReservesInput;
  nowMs?: number;
}

export type StablecoinDetailStaleQuery = {
  preset: "stablecoins" | "pegSummary" | "dexLiquidity" | "reportCards" | "redemptionBackstops";
  dataUpdatedAt: number;
  error: unknown | null;
  hasData: boolean;
  meta: ApiMeta | null;
};

export type MarketSnapshot = {
  mcap: number;
  supply: number | null;
  prevDay: number | null;
  prevWeek: number | null;
  prevMonth: number | null;
  performanceVsUsd1y: number | null;
  earliestTrackingDate: number | null;
};

export type PegPriceSnapshot = {
  pegRef: number;
  deviationBps: number;
  gaugeDeviationBps: number;
  pegScoreResult: PegSummaryCoin | null;
  consensusSources: string[];
  agreeSources: string[];
  dexPriceCheck: PegSummaryCoin["dexPriceCheck"];
};

export type FeatureAvailabilitySnapshot = {
  yieldRanking: YieldRanking | null;
  hasYieldSection: boolean;
  stressSignal: StressSignalEntry | null;
  hasFlows: boolean;
  hasBlacklist: boolean;
};

function isEligibleForUsdPerformance(coin: StablecoinMeta): boolean {
  const pegCurrency = coin.flags.pegCurrency;
  return !coin.flags.navToken && pegCurrency !== "USD" && pegCurrency !== "VAR" && pegCurrency !== "OTHER";
}

function computePerformanceVsUsd1y(
  coin: StablecoinMeta,
  currentPrice: number | null | undefined,
  supplyHistory: SupplyHistoryPoint[],
  nowMs: number,
): number | null {
  if (!isEligibleForUsdPerformance(coin)) return null;
  if (currentPrice == null || !Number.isFinite(currentPrice) || currentPrice <= 0) return null;

  // The tracked USD price series is the repo-local proxy for non-USD/commodity
  // asset performance without adding an FX-history dependency.
  const pricedHistory = supplyHistory.filter(
    (point) => point.price != null && Number.isFinite(point.price) && point.price > 0,
  );
  if (pricedHistory.length === 0) return null;

  const targetDate = Math.floor(nowMs / 1000) - YEAR_SECONDS;
  if (pricedHistory[0].date > targetDate + YEARLY_PERFORMANCE_ANCHOR_TOLERANCE_SECONDS) {
    return null;
  }

  let anchor = pricedHistory[0];
  let closestDelta = Math.abs(anchor.date - targetDate);

  for (const point of pricedHistory) {
    const delta = Math.abs(point.date - targetDate);
    if (delta < closestDelta) {
      anchor = point;
      closestDelta = delta;
    }
  }

  if (closestDelta > YEARLY_PERFORMANCE_ANCHOR_TOLERANCE_SECONDS || anchor.price == null || anchor.price <= 0) {
    return null;
  }

  return (currentPrice / anchor.price - 1) * 100;
}

export function buildMarketSnapshot(
  coin: StablecoinMeta,
  coinData: StablecoinData,
  supplyHistory: SupplyHistoryPoint[],
  nowMs: number,
): MarketSnapshot {
  const mcap = getCirculatingRaw(coinData);
  return {
    mcap,
    supply: deriveSupplyFromMarketCap(mcap, coinData.price),
    prevDay: getPrevDayRawOrNull(coinData),
    prevWeek: getPrevWeekRawOrNull(coinData),
    prevMonth: getPrevMonthRawOrNull(coinData),
    performanceVsUsd1y: computePerformanceVsUsd1y(coin, coinData.price, supplyHistory, nowMs),
    earliestTrackingDate: supplyHistory.length > 0 ? supplyHistory[0].date : null,
  };
}

export function buildPegPriceSnapshot(
  id: string,
  coin: StablecoinMeta,
  coinData: StablecoinData,
  listData: StablecoinListResponse,
  pegSummaryData?: PegSummaryResponse,
): PegPriceSnapshot {
  const isNavToken = coin.flags.navToken ?? false;
  const pegContext = derivePegReferenceContext({
    assets: listData.peggedAssets ?? [],
    pegType: coinData.pegType,
    commodityOunces: coin.commodityOunces,
    fallbackRates: listData.fxFallbackRates,
    metaById: TRACKED_META_BY_ID,
  });
  const deviationBps = deriveDeviationBps(coinData.price, pegContext.pegReference);
  const pegScoreResult = pegSummaryData?.coins.find((candidate) => candidate.id === id) ?? null;

  return {
    pegRef: pegContext.pegReference,
    deviationBps,
    gaugeDeviationBps: deriveGaugeDeviationBps(deviationBps, isNavToken),
    pegScoreResult,
    consensusSources: pegScoreResult?.consensusSources ?? [],
    agreeSources: pegScoreResult?.agreeSources ?? [],
    dexPriceCheck: pegScoreResult?.dexPriceCheck ?? null,
  };
}

export function buildFeatureAvailability(
  id: string,
  coin: StablecoinMeta,
  supplemental: StablecoinDetailViewModelSupplementalInputs,
): FeatureAvailabilitySnapshot {
  const yieldRanking = supplemental.yieldRankingsData?.rankings.find((candidate) => candidate.id === id) ?? null;
  const hasYieldSection = (coin.flags.yieldBearing ?? false) || yieldRanking !== null;
  const stressSignal = supplemental.stressSignalsData?.signals[id] ?? null;
  const hasFlows =
    supplemental.flows.isLoading || !!supplemental.flows.data?.coins.find((entry) => entry.stablecoinId === id);
  const isBlacklistSupported = (BLACKLIST_STABLECOINS as readonly string[]).includes(coin.symbol);
  const hasBlacklist =
    isBlacklistSupported &&
    (supplemental.blacklist.isLoading ||
      (!!supplemental.blacklist.summary &&
        (supplemental.blacklist.summary.stats.perCoinTotalEvents[coin.symbol as BlacklistStablecoin] ?? 0) > 0));

  return {
    yieldRanking,
    hasYieldSection,
    stressSignal,
    hasFlows,
    hasBlacklist,
  };
}

export function buildStaleQueryInputs(
  queries: StablecoinDetailViewModelQueryInputs,
): StablecoinDetailStaleQuery[] {
  return [
    {
      preset: "stablecoins",
      dataUpdatedAt: queries.stablecoinList.dataUpdatedAt,
      error: queries.stablecoinList.error,
      hasData: !!queries.stablecoinList.data?.peggedAssets?.length,
      meta: queries.stablecoinList.meta,
    },
    {
      preset: "pegSummary",
      dataUpdatedAt: queries.pegSummary.dataUpdatedAt,
      error: queries.pegSummary.error,
      hasData: !!queries.pegSummary.data?.coins?.length,
      meta: queries.pegSummary.meta,
    },
    {
      preset: "dexLiquidity",
      dataUpdatedAt: queries.dexLiquidity.dataUpdatedAt,
      error: queries.dexLiquidity.error,
      hasData: !!queries.dexLiquidity.data,
      meta: queries.dexLiquidity.meta,
    },
    {
      preset: "reportCards",
      dataUpdatedAt: queries.reportCards.dataUpdatedAt,
      error: queries.reportCards.error,
      hasData: !!queries.reportCards.data?.cards?.length,
      meta: queries.reportCards.meta,
    },
    {
      preset: "redemptionBackstops",
      dataUpdatedAt: queries.redemptionBackstops.dataUpdatedAt,
      error: queries.redemptionBackstops.error,
      hasData: !!queries.redemptionBackstops.data?.coins,
      meta: queries.redemptionBackstops.meta,
    },
  ];
}
