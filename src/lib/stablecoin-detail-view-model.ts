import type { SupplyHistoryPoint } from "@/hooks/use-stablecoins";
import type {
  DexLiquidityData,
  PegSummaryCoin,
  ReportCard,
  StablecoinData,
  StablecoinMeta,
  StablecoinListResponse,
  PegSummaryResponse,
  ReportCardsResponse,
  DexLiquidityMap,
  RedemptionBackstopsResponse,
  RedemptionBackstopEntry,
  StressSignalEntry,
  StressSignalsAllResponse,
  YieldRanking,
  YieldRankingsResponse,
} from "@shared/types";
import {
  getCirculatingRaw,
  getPrevDayRawOrNull,
  getPrevMonthRawOrNull,
  getPrevWeekRawOrNull,
} from "@shared/lib/supply";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { getReserves, type ReserveResult } from "@shared/lib/reserve-templates";
import {
  deriveDeviationBps,
  deriveGaugeDeviationBps,
  derivePegReferenceContext,
  deriveSupplyFromMarketCap,
} from "@/lib/stablecoin-detail-derive";
import type { MintBurnFlowsResponse } from "@shared/types";

export interface StablecoinDetailSummary {
  title: string;
  text: string;
  updatedAt: string;
}

interface BaseViewModel {
  handleRetryAll: () => void;
}

interface LoadingViewModel extends BaseViewModel {
  status: "loading";
}

interface ListErrorViewModel extends BaseViewModel {
  status: "list-error";
  listError: unknown;
}

interface NotFoundViewModel extends BaseViewModel {
  status: "not-found";
}

interface StablecoinDetailReadyViewModel extends BaseViewModel {
  status: "ready";
  id: string;
  coin: StablecoinMeta;
  summary: StablecoinDetailSummary | null;
  logoSrc?: string;
  reportCard: ReportCard | undefined;
  coinData: StablecoinData;
  mcap: number;
  supply: number | null;
  prevDay: number | null;
  prevWeek: number | null;
  prevMonth: number | null;
  performanceVsUsd1y: number | null;
  pegRef: number;
  deviationBps: number;
  gaugeDeviationBps: number;
  isNavToken: boolean;
  pegScoreResult: PegSummaryCoin | null;
  consensusSources: string[];
  agreeSources: string[];
  dexPriceCheck: PegSummaryCoin["dexPriceCheck"];
  liquidityData: DexLiquidityData | undefined;
  yieldRanking: YieldRanking | null;
  stressSignal: StressSignalEntry | null;
  redemptionBackstop: RedemptionBackstopEntry | undefined;
  hasFlows: boolean;
  supplyHistory: SupplyHistoryPoint[];
  earliestTrackingDate: string | null;
  reserves: ReserveResult | null;
  reserveFetchError: unknown | null;
  supplyError: unknown | null;
  staleQueries: {
    preset: "stablecoins" | "pegSummary" | "dexLiquidity" | "reportCards" | "redemptionBackstops";
    dataUpdatedAt: number;
    error: unknown | null;
    hasData: boolean;
  }[];
}

export type StablecoinDetailViewModel =
  | LoadingViewModel
  | ListErrorViewModel
  | NotFoundViewModel
  | StablecoinDetailReadyViewModel;

interface BuildStablecoinDetailViewModelParams {
  id: string;
  coin: StablecoinMeta;
  summary: StablecoinDetailSummary | null;
  logoSrc?: string;
  handleRetryAll: () => void;
  supplyData?: SupplyHistoryPoint[];
  supplyLoading: boolean;
  supplyError: unknown | null;
  listData?: StablecoinListResponse;
  listLoading: boolean;
  listError: unknown | null;
  isListError: boolean;
  listUpdatedAt: number;
  pegSummaryData?: PegSummaryResponse;
  pegUpdatedAt: number;
  pegError: unknown | null;
  liquidityMap?: DexLiquidityMap;
  liqUpdatedAt: number;
  liquidityError: unknown | null;
  reportCardsData?: ReportCardsResponse;
  rcUpdatedAt: number;
  reportCardsError: unknown | null;
  redemptionBackstopsData?: RedemptionBackstopsResponse;
  rbUpdatedAt?: number;
  redemptionBackstopsError?: unknown | null;
  yieldRankingsData?: YieldRankingsResponse;
  stressSignalsData?: StressSignalsAllResponse;
  flowsData?: MintBurnFlowsResponse;
  isFlowsLoading: boolean;
  liveReserves?: ReserveResult | null;
  liveReserveError?: unknown | null;
  nowMs?: number;
}

const YEAR_SECONDS = 365 * DAY_SECONDS;
const YEARLY_PERFORMANCE_ANCHOR_TOLERANCE_SECONDS = 14 * DAY_SECONDS;

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

  // For non-USD and commodity pegs, the tracked USD price series is the best
  // repo-local proxy we have for "asset vs USD" without introducing a new FX-history API.
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

  return ((currentPrice / anchor.price) - 1) * 100;
}

export function buildStablecoinDetailViewModel({
  id,
  coin,
  summary,
  logoSrc,
  handleRetryAll,
  supplyData,
  supplyLoading,
  supplyError,
  listData,
  listLoading,
  listError,
  isListError,
  listUpdatedAt,
  pegSummaryData,
  pegUpdatedAt,
  pegError,
  liquidityMap,
  liqUpdatedAt,
  liquidityError,
  reportCardsData,
  rcUpdatedAt,
  reportCardsError,
  redemptionBackstopsData,
  rbUpdatedAt = 0,
  redemptionBackstopsError = null,
  yieldRankingsData,
  stressSignalsData,
  flowsData,
  isFlowsLoading,
  liveReserves = null,
  liveReserveError = null,
  nowMs = Date.now(),
}: BuildStablecoinDetailViewModelParams): StablecoinDetailViewModel {
  if (supplyLoading || listLoading) {
    return { status: "loading", handleRetryAll };
  }

  if (isListError) {
    return { status: "list-error", listError, handleRetryAll };
  }

  const coinData = listData?.peggedAssets?.find((candidate) => candidate.id === id);
  if (!coinData) {
    return { status: "not-found", handleRetryAll };
  }

  const isNavToken = coin.flags.navToken ?? false;
  const mcap = getCirculatingRaw(coinData);
  const supply = deriveSupplyFromMarketCap(mcap, coinData.price);
  const prevDay = getPrevDayRawOrNull(coinData);
  const prevWeek = getPrevWeekRawOrNull(coinData);
  const prevMonth = getPrevMonthRawOrNull(coinData);
  const resolvedSupplyHistory = supplyData ?? [];
  const performanceVsUsd1y = computePerformanceVsUsd1y(coin, coinData.price, resolvedSupplyHistory, nowMs);
  const earliestTrackingDate =
    resolvedSupplyHistory.length > 0
      ? String(resolvedSupplyHistory[0].date)
      : null;
  const pegContext = derivePegReferenceContext({
    assets: listData?.peggedAssets ?? [],
    pegType: coinData.pegType,
    commodityOunces: coin.commodityOunces,
    fallbackRates: listData?.fxFallbackRates,
    metaById: TRACKED_META_BY_ID,
  });
  const deviationBps = deriveDeviationBps(coinData.price, pegContext.pegReference);
  const gaugeDeviationBps = deriveGaugeDeviationBps(deviationBps, isNavToken);
  const pegScoreResult =
    pegSummaryData?.coins.find((candidate) => candidate.id === id)
    ?? null;
  const consensusSources = pegScoreResult?.consensusSources ?? [];
  const agreeSources = pegScoreResult?.agreeSources ?? [];
  const dexPriceCheck = pegScoreResult?.dexPriceCheck ?? null;
  const liquidityData = liquidityMap?.[id];
  const yieldRanking = yieldRankingsData?.rankings.find((candidate) => candidate.id === id) ?? null;
  const stressSignal = stressSignalsData?.signals[id] ?? null;
  const redemptionBackstop = redemptionBackstopsData?.coins?.[id];
  const reportCard = reportCardsData?.cards.find((candidate) => candidate.id === id);
  const reserves = liveReserves ?? getReserves(coin);
  const hasFlows =
    isFlowsLoading
    || !!flowsData?.coins.find((entry) => entry.stablecoinId === id);

  return {
    status: "ready",
    handleRetryAll,
    id,
    coin,
    summary,
    logoSrc,
    reportCard,
    coinData,
    mcap,
    supply,
    prevDay,
    prevWeek,
    prevMonth,
    performanceVsUsd1y,
    pegRef: pegContext.pegReference,
    deviationBps,
    gaugeDeviationBps,
    isNavToken,
    pegScoreResult,
    consensusSources,
    agreeSources,
    dexPriceCheck,
    liquidityData,
    yieldRanking,
    stressSignal,
    redemptionBackstop,
    hasFlows,
    supplyHistory: resolvedSupplyHistory,
    earliestTrackingDate,
    reserves,
    reserveFetchError: liveReserveError,
    supplyError,
    staleQueries: [
      {
        preset: "stablecoins",
        dataUpdatedAt: listUpdatedAt,
        error: listError,
        hasData: !!listData?.peggedAssets?.length,
      },
      {
        preset: "pegSummary",
        dataUpdatedAt: pegUpdatedAt,
        error: pegError,
        hasData: !!pegSummaryData?.coins?.length,
      },
      {
        preset: "dexLiquidity",
        dataUpdatedAt: liqUpdatedAt,
        error: liquidityError,
        hasData: !!liquidityMap,
      },
      {
        preset: "reportCards",
        dataUpdatedAt: rcUpdatedAt,
        error: reportCardsError,
        hasData: !!reportCardsData?.cards?.length,
      },
      {
        preset: "redemptionBackstops",
        dataUpdatedAt: rbUpdatedAt,
        error: redemptionBackstopsError,
        hasData: !!redemptionBackstopsData?.coins,
      },
    ],
  };
}
