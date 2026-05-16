"use client";

import { useCallback } from "react";
import {
  useDexLiquidity,
  usePegSummary,
  useRedemptionBackstops,
  useReportCards,
  useStressSignals,
  useYieldRankings,
} from "@/hooks/api-hooks";
import { useSupplyHistory, useStablecoins } from "@/hooks/use-stablecoins";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { useStablecoinReserves } from "@/hooks/use-stablecoin-reserves";
import { useBlacklistSummary } from "@/hooks/use-blacklist-events";
import { refetchQueryGroup } from "@/lib/query-refetch-group";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  buildStablecoinDetailViewModel,
  type StablecoinDetailSummary,
  type StablecoinDetailViewModel,
} from "@/lib/stablecoin-detail-view-model";

interface UseStablecoinDetailViewModelParams {
  id: string;
  summary: StablecoinDetailSummary | null;
  logoSrc?: string;
}

export type { StablecoinDetailSummary, StablecoinDetailViewModel };

export function useStablecoinDetailViewModel({
  id,
  summary,
  logoSrc,
}: UseStablecoinDetailViewModelParams): StablecoinDetailViewModel {
  const coin = TRACKED_META_BY_ID.get(id);
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
    meta: listMeta,
  } = useStablecoins();
  const {
    data: pegSummaryData,
    dataUpdatedAt: pegUpdatedAt,
    error: pegError,
    refetch: refetchPeg,
    meta: pegMeta,
  } = usePegSummary();
  const {
    data: liquidityMap,
    dataUpdatedAt: liqUpdatedAt,
    error: liquidityError,
    refetch: refetchLiquidity,
    meta: liquidityMeta,
  } = useDexLiquidity();
  const {
    data: reportCardsData,
    dataUpdatedAt: rcUpdatedAt,
    error: reportCardsError,
    refetch: refetchReportCards,
    meta: reportCardsMeta,
  } = useReportCards();
  const {
    data: redemptionBackstopsData,
    dataUpdatedAt: rbUpdatedAt,
    error: redemptionBackstopsError,
    refetch: refetchRedemptionBackstops,
    meta: redemptionBackstopsMeta,
  } = useRedemptionBackstops();
  const { data: yieldRankingsData } = useYieldRankings();
  const { data: stressSignalsData } = useStressSignals();
  const { data: flowsData, isLoading: isFlowsLoading } = useMintBurnFlows();
  const { data: blacklistSummary, isLoading: isBlacklistLoading } = useBlacklistSummary();
  const liveReserves = useStablecoinReserves(id, !!coin?.liveReservesConfig);

  const handleRetryAll = useCallback(() => {
    return refetchQueryGroup([
      refetchSupply,
      refetchList,
      refetchPeg,
      refetchLiquidity,
      refetchReportCards,
      refetchRedemptionBackstops,
    ], {
      warnLabel: "[refetch] Some queries failed to refresh",
    });
  }, [
    refetchLiquidity,
    refetchList,
    refetchPeg,
    refetchRedemptionBackstops,
    refetchReportCards,
    refetchSupply,
  ]);

  if (!coin) {
    return { status: "not-found", handleRetryAll };
  }

  return buildStablecoinDetailViewModel({
    core: {
      id,
      coin,
      summary,
      logoSrc,
      handleRetryAll,
    },
    queries: {
      supplyHistory: {
        data: supplyData,
        isLoading: supplyLoading,
        error: supplyError,
      },
      stablecoinList: {
        data: listData,
        isLoading: listLoading,
        isError: isListError,
        error: listError,
        dataUpdatedAt: listUpdatedAt,
        meta: listMeta,
      },
      pegSummary: {
        data: pegSummaryData,
        dataUpdatedAt: pegUpdatedAt,
        error: pegError,
        meta: pegMeta,
      },
      dexLiquidity: {
        data: liquidityMap,
        dataUpdatedAt: liqUpdatedAt,
        error: liquidityError,
        meta: liquidityMeta,
      },
      reportCards: {
        data: reportCardsData,
        dataUpdatedAt: rcUpdatedAt,
        error: reportCardsError,
        meta: reportCardsMeta,
      },
      redemptionBackstops: {
        data: redemptionBackstopsData,
        dataUpdatedAt: rbUpdatedAt,
        error: redemptionBackstopsError,
        meta: redemptionBackstopsMeta,
      },
    },
    supplemental: {
      yieldRankingsData,
      stressSignalsData,
      flows: {
        data: flowsData,
        isLoading: isFlowsLoading,
      },
      blacklist: {
        summary: blacklistSummary,
        isLoading: isBlacklistLoading,
      },
      reserves: {
        live: liveReserves.reserveResult,
        error: liveReserves.error,
      },
    },
  });
}
