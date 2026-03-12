"use client";

import { useCallback } from "react";
import { useSupplyHistory, useStablecoins } from "@/hooks/use-stablecoins";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { useReportCards } from "@/hooks/use-report-cards";
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
  const { data: flowsData, isLoading: isFlowsLoading } = useMintBurnFlows();
  const liveReserves = useStablecoinReserves(id, !!coin.liveReservesConfig);

  const handleRetryAll = useCallback(() => {
    void Promise.allSettled([
      refetchSupply(),
      refetchList(),
      refetchPeg(),
      refetchLiquidity(),
      refetchReportCards(),
    ]);
  }, [refetchLiquidity, refetchList, refetchPeg, refetchReportCards, refetchSupply]);

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
    flowsData,
    isFlowsLoading,
    liveReserves: liveReserves.reserveResult,
    liveReserveError: liveReserves.error,
  });
}
