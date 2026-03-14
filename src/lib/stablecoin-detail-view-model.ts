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
} from "@shared/types";
import {
  getCirculatingRaw,
  getPrevDayRawOrNull,
  getPrevMonthRawOrNull,
  getPrevWeekRawOrNull,
} from "@shared/lib/supply";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { getReserves, type ReserveResult } from "@shared/lib/reserve-templates";
import {
  deriveDeviationBps,
  deriveGaugeDeviationBps,
  deriveLiquidityBorderClass,
  derivePegReferenceContext,
  derivePegScoreBorderClass,
  derivePrev90dReferenceMcap,
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
  prev90d: number;
  pegRef: number;
  deviationBps: number;
  gaugeDeviationBps: number;
  isNavToken: boolean;
  pegScoreResult: PegSummaryCoin | null;
  consensusSources: string[];
  dexPriceCheck: PegSummaryCoin["dexPriceCheck"];
  pegScoreBorderClass: string;
  liquidityData: DexLiquidityData | undefined;
  redemptionBackstop: RedemptionBackstopEntry | undefined;
  liqBorderClass: string;
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
  usesFallbackPegRate: boolean;
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
  flowsData?: MintBurnFlowsResponse;
  isFlowsLoading: boolean;
  liveReserves?: ReserveResult | null;
  liveReserveError?: unknown | null;
  nowMs?: number;
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
  const earliestTrackingDate =
    resolvedSupplyHistory.length > 0
      ? String(resolvedSupplyHistory[0].date)
      : null;
  const prev90d = derivePrev90dReferenceMcap(resolvedSupplyHistory, nowMs);
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
  const dexPriceCheck = pegScoreResult?.dexPriceCheck ?? null;
  const pegScoreBorderClass = derivePegScoreBorderClass(pegScoreResult?.pegScore);
  const liquidityData = liquidityMap?.[id];
  const redemptionBackstop = redemptionBackstopsData?.coins?.[id];
  const liqBorderClass = deriveLiquidityBorderClass(liquidityData);
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
    prev90d,
    pegRef: pegContext.pegReference,
    deviationBps,
    gaugeDeviationBps,
    isNavToken,
    pegScoreResult,
    consensusSources,
    dexPriceCheck,
    pegScoreBorderClass,
    liquidityData,
    redemptionBackstop,
    liqBorderClass,
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
    usesFallbackPegRate: pegContext.pegRateSources[coinData.pegType ?? ""] === "fallback",
  };
}
