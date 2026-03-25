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
import {
  buildStablecoinDetailViewModel,
  type StablecoinDetailSummary,
  type StablecoinDetailViewModel,
} from "@/lib/stablecoin-detail-view-model";
import type { StablecoinMeta } from "@shared/types";

interface UseStablecoinDetailViewModelParams {
  id: string;
  coin: StablecoinMeta;
  summary: StablecoinDetailSummary | null;
  logoSrc?: string;
}

export type { StablecoinDetailSummary, StablecoinDetailViewModel };

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
  const {
    data: redemptionBackstopsData,
    dataUpdatedAt: rbUpdatedAt,
    error: redemptionBackstopsError,
    refetch: refetchRedemptionBackstops,
  } = useRedemptionBackstops();
  const { data: yieldRankingsData } = useYieldRankings();
  const { data: stressSignalsData } = useStressSignals();
  const { data: flowsData, isLoading: isFlowsLoading } = useMintBurnFlows();
  const liveReserves = useStablecoinReserves(id, !!coin.liveReservesConfig);

  const handleRetryAll = useCallback(() => {
    void Promise.allSettled([
      refetchSupply(),
      refetchList(),
      refetchPeg(),
      refetchLiquidity(),
      refetchReportCards(),
      refetchRedemptionBackstops(),
    ]);
  }, [
    refetchLiquidity,
    refetchList,
    refetchPeg,
    refetchRedemptionBackstops,
    refetchReportCards,
    refetchSupply,
  ]);

  return buildStablecoinDetailViewModel({
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
    rbUpdatedAt,
    redemptionBackstopsError,
    yieldRankingsData,
    stressSignalsData,
    flowsData,
    isFlowsLoading,
    liveReserves: liveReserves.reserveResult,
    liveReserveError: liveReserves.error,
  });
}
