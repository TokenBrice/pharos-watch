"use client";

import { useCallback, useMemo } from "react";
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
import { refetchQueryGroup, type QueryRefetchFn } from "@/lib/query-refetch-group";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import {
  buildStablecoinDetailViewModel,
  type StablecoinDetailSummary,
  type StablecoinDetailViewModel as BaseStablecoinDetailViewModel,
} from "@/lib/stablecoin-detail-view-model";
import type { StablecoinDetailCoinMeta } from "@/lib/stablecoin-detail-mint-authority-view-model";

export interface StablecoinDetailSupplementalQueryControls {
  flows?: boolean;
  blacklist?: boolean;
  reserves?: boolean;
}

interface UseStablecoinDetailViewModelParams {
  id: string;
  coin: StablecoinDetailCoinMeta;
  summary: StablecoinDetailSummary | null;
  logoSrc?: string;
  supplementalQueryControls?: StablecoinDetailSupplementalQueryControls;
}

export type StablecoinDetailViewModel =
  | Exclude<BaseStablecoinDetailViewModel, { status: "ready" }>
  | (Extract<BaseStablecoinDetailViewModel, { status: "ready" }> & {
      refetchReserves: QueryRefetchFn | null;
      isFetchingReserves: boolean;
    });

export type { StablecoinDetailSummary };

export function useStablecoinDetailViewModel({
  id,
  coin,
  summary,
  logoSrc,
  supplementalQueryControls,
}: UseStablecoinDetailViewModelParams): StablecoinDetailViewModel {
  const {
    data: supplyData,
    isLoading: supplyLoading,
    error: supplyError,
    dataUpdatedAt: supplyUpdatedAt,
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
    isLoading: liquidityLoading,
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
  const {
    data: yieldRankingsData,
    isLoading: yieldRankingsLoading,
    error: yieldRankingsError,
    dataUpdatedAt: yieldRankingsUpdatedAt,
    refetch: refetchYieldRankings,
    meta: yieldRankingsMeta,
  } = useYieldRankings();
  const {
    data: stressSignalsData,
    isLoading: stressSignalsLoading,
    error: stressSignalsError,
    dataUpdatedAt: stressSignalsUpdatedAt,
    refetch: refetchStressSignals,
    meta: stressSignalsMeta,
  } = useStressSignals();
  const flowsEnabled = supplementalQueryControls?.flows ?? true;
  const blacklistSupported = (BLACKLIST_STABLECOINS as readonly string[]).includes(coin.symbol);
  const blacklistEnabled = blacklistSupported && (supplementalQueryControls?.blacklist ?? true);
  const reservesEnabled = !!coin?.liveReservesConfig && (supplementalQueryControls?.reserves ?? true);
  const {
    data: flowsData,
    isLoading: isFlowsLoading,
    error: flowsError,
    dataUpdatedAt: flowsUpdatedAt,
    meta: flowsMeta,
    refetch: refetchFlows,
  } = useMintBurnFlows(24, { enabled: flowsEnabled });
  const {
    data: blacklistSummary,
    isLoading: isBlacklistLoading,
    error: blacklistError,
    dataUpdatedAt: blacklistUpdatedAt,
    meta: blacklistMeta,
    refetch: refetchBlacklist,
  } = useBlacklistSummary({ enabled: blacklistEnabled });
  const liveReserves = useStablecoinReserves(id, reservesEnabled);

  const handleRetryAll = useCallback(() => {
    return refetchQueryGroup(
      [
        refetchSupply,
        refetchList,
        refetchPeg,
        refetchLiquidity,
        refetchReportCards,
        refetchRedemptionBackstops,
        refetchYieldRankings,
        refetchStressSignals,
        ...(flowsEnabled ? [refetchFlows] : []),
        ...(blacklistEnabled ? [refetchBlacklist] : []),
        ...(reservesEnabled ? [liveReserves.refetch] : []),
      ],
      {
        warnLabel: "[refetch] Some queries failed to refresh",
      },
    );
  }, [
    liveReserves.refetch,
    blacklistEnabled,
    flowsEnabled,
    refetchBlacklist,
    refetchFlows,
    refetchLiquidity,
    refetchList,
    refetchPeg,
    refetchRedemptionBackstops,
    refetchReportCards,
    refetchStressSignals,
    refetchSupply,
    refetchYieldRankings,
    reservesEnabled,
  ]);

  const viewModel = useMemo(
    () =>
      buildStablecoinDetailViewModel({
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
            dataUpdatedAt: supplyUpdatedAt,
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
            isLoading: liquidityLoading,
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
          yieldRankings: {
            data: yieldRankingsData,
            isLoading: yieldRankingsLoading,
            error: yieldRankingsError,
            dataUpdatedAt: yieldRankingsUpdatedAt,
            meta: yieldRankingsMeta,
          },
          stressSignals: {
            data: stressSignalsData,
            isLoading: stressSignalsLoading,
            error: stressSignalsError,
            dataUpdatedAt: stressSignalsUpdatedAt,
            meta: stressSignalsMeta,
          },
          flows: {
            data: flowsEnabled ? flowsData : undefined,
            isLoading: flowsEnabled && isFlowsLoading,
            error: flowsEnabled ? flowsError : null,
            dataUpdatedAt: flowsEnabled ? flowsUpdatedAt : 0,
            meta: flowsEnabled ? flowsMeta : null,
            enabled: flowsEnabled,
          },
          blacklist: {
            summary: blacklistEnabled ? blacklistSummary : undefined,
            isLoading: blacklistEnabled && isBlacklistLoading,
            error: blacklistEnabled ? blacklistError : null,
            dataUpdatedAt: blacklistEnabled ? blacklistUpdatedAt : 0,
            meta: blacklistEnabled ? blacklistMeta : null,
            enabled: blacklistEnabled,
          },
          reserves: {
            live: reservesEnabled ? liveReserves.reserveResult : null,
            error: reservesEnabled ? liveReserves.error : null,
            dataUpdatedAt: reservesEnabled ? liveReserves.dataUpdatedAt : 0,
            isLoading: reservesEnabled && liveReserves.isLoading,
            enabled: reservesEnabled,
          },
        },
      }),
    [
      id,
      coin,
      summary,
      logoSrc,
      handleRetryAll,
      supplyData,
      supplyLoading,
      supplyError,
      supplyUpdatedAt,
      listData,
      listLoading,
      isListError,
      listError,
      listUpdatedAt,
      listMeta,
      pegSummaryData,
      pegUpdatedAt,
      pegError,
      pegMeta,
      liquidityMap,
      liquidityLoading,
      liqUpdatedAt,
      liquidityError,
      liquidityMeta,
      reportCardsData,
      rcUpdatedAt,
      reportCardsError,
      reportCardsMeta,
      redemptionBackstopsData,
      rbUpdatedAt,
      redemptionBackstopsError,
      redemptionBackstopsMeta,
      yieldRankingsData,
      yieldRankingsLoading,
      yieldRankingsError,
      yieldRankingsUpdatedAt,
      yieldRankingsMeta,
      stressSignalsData,
      stressSignalsLoading,
      stressSignalsError,
      stressSignalsUpdatedAt,
      stressSignalsMeta,
      flowsEnabled,
      flowsData,
      isFlowsLoading,
      flowsError,
      flowsUpdatedAt,
      flowsMeta,
      blacklistEnabled,
      blacklistSummary,
      isBlacklistLoading,
      blacklistError,
      blacklistUpdatedAt,
      blacklistMeta,
      reservesEnabled,
      liveReserves.reserveResult,
      liveReserves.error,
      liveReserves.dataUpdatedAt,
      liveReserves.isLoading,
    ],
  );

  if (viewModel.status !== "ready") {
    return viewModel;
  }

  return {
    ...viewModel,
    refetchReserves: reservesEnabled ? liveReserves.refetch : null,
    isFetchingReserves: liveReserves.isFetching,
  };
}
