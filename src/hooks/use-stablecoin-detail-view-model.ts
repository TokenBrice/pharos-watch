"use client";

import { useCallback } from "react";
import { useSupplyHistory, useStablecoins } from "@/hooks/use-stablecoins";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { useReportCards } from "@/hooks/use-report-cards";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
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
import type {
  DexLiquidityData,
  PegSummaryCoin,
  ReportCard,
  StablecoinData,
  StablecoinMeta,
} from "@shared/types";
import type { SupplyHistoryPoint } from "@/hooks/use-stablecoins";

const SESSION_NOW_MS = Date.now();

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
  pegScoreBorderClass: string;
  liquidityData: DexLiquidityData | undefined;
  liqBorderClass: string;
  hasFlows: boolean;
  supplyHistory: SupplyHistoryPoint[];
  earliestTrackingDate: string | null;
  reserves: ReserveResult | null;
  supplyError: unknown | null;
  staleQueries: {
    preset: "stablecoins" | "pegSummary" | "dexLiquidity" | "reportCards";
    dataUpdatedAt: number;
    error: unknown | null;
    hasData: boolean;
  }[];
  usesFallbackPegRate: boolean;
}

type StablecoinDetailViewModel =
  | LoadingViewModel
  | ListErrorViewModel
  | NotFoundViewModel
  | StablecoinDetailReadyViewModel;

interface UseStablecoinDetailViewModelParams {
  id: string;
  coin: StablecoinMeta;
  summary: StablecoinDetailSummary | null;
  logoSrc?: string;
}

export function useStablecoinDetailViewModel({
  id,
  coin,
  summary,
  logoSrc,
}: UseStablecoinDetailViewModelParams): StablecoinDetailViewModel {
  const {
    data: supplyData,
    isLoading: supplyLoading,
    error: supplyError,
    refetch: refetchSupply,
  } = useSupplyHistory(id);
  const {
    data: listData,
    isLoading: listLoading,
    isError: isListError,
    error: listError,
    dataUpdatedAt: listUpdatedAt,
    refetch: refetchList,
  } = useStablecoins();
  const {
    data: pegSummaryData,
    dataUpdatedAt: pegUpdatedAt,
    error: pegError,
    refetch: refetchPeg,
  } = usePegSummary();
  const {
    data: liquidityMap,
    dataUpdatedAt: liqUpdatedAt,
    error: liquidityError,
    refetch: refetchLiquidity,
  } = useDexLiquidity();
  const {
    data: reportCardsData,
    dataUpdatedAt: rcUpdatedAt,
    error: reportCardsError,
    refetch: refetchReportCards,
  } = useReportCards();
  const { data: flowsData, isLoading: isFlowsLoading } = useMintBurnFlows();

  const handleRetryAll = useCallback(() => {
    void Promise.allSettled([
      refetchSupply(),
      refetchList(),
      refetchPeg(),
      refetchLiquidity(),
      refetchReportCards(),
    ]);
  }, [refetchLiquidity, refetchList, refetchPeg, refetchReportCards, refetchSupply]);

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
  const supplyHistory = supplyData ?? [];
  const earliestTrackingDate = supplyHistory.length > 0 ? String(supplyHistory[0].date) : null;
  const prev90d = derivePrev90dReferenceMcap(supplyHistory, SESSION_NOW_MS);
  const pegContext = derivePegReferenceContext({
    assets: listData?.peggedAssets ?? [],
    pegType: coinData.pegType,
    commodityOunces: coin.commodityOunces,
    fallbackRates: listData?.fxFallbackRates,
    metaById: TRACKED_META_BY_ID,
  });
  const deviationBps = deriveDeviationBps(coinData.price, pegContext.pegReference);
  const gaugeDeviationBps = deriveGaugeDeviationBps(deviationBps, isNavToken);
  const pegScoreResult = pegSummaryData?.coins.find((candidate) => candidate.id === id) ?? null;
  const pegScoreBorderClass = derivePegScoreBorderClass(pegScoreResult?.pegScore);
  const liquidityData = liquidityMap?.[id];
  const liqBorderClass = deriveLiquidityBorderClass(liquidityData);
  const reportCard = reportCardsData?.cards.find((candidate) => candidate.id === id);
  const reserves = getReserves(coin);
  const hasFlows = isFlowsLoading || !!flowsData?.coins.find((entry) => entry.stablecoinId === id);

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
    pegScoreBorderClass,
    liquidityData,
    liqBorderClass,
    hasFlows,
    supplyHistory,
    earliestTrackingDate,
    reserves,
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
    ],
    usesFallbackPegRate: pegContext.pegRateSources[coinData.pegType ?? ""] === "fallback",
  };
}
