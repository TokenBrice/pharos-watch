"use client";

import { useCallback, useMemo } from "react";
import {
  useDexLiquidity,
  usePegSummary,
  useRedemptionBackstops,
  useReportCardsV9,
  useStressSignals,
  useYieldRankings,
} from "@/hooks/api-hooks";
import { useSupplyHistory, useStablecoins } from "@/hooks/use-stablecoins";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { useStablecoinReserves } from "@/hooks/use-stablecoin-reserves";
import { useBlacklistSummary } from "@/hooks/use-blacklist-events";
import { useQuerySlice, useQuerySlices } from "@/hooks/use-query-slice";
import { refetchQueryGroup, type QueryRefetchFn } from "@/lib/query-refetch-group";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import {
  buildStablecoinDetailViewModel,
  type StablecoinDetailSummary,
  type StablecoinDetailViewModel as BaseStablecoinDetailViewModel,
} from "@/lib/stablecoin-detail-view-model";
import type { StablecoinDetailCoinMeta } from "@/lib/stablecoin-detail-client-coin";

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
  const supplyQuery = useSupplyHistory(id);
  const listQuery = useStablecoins();
  const pegQuery = usePegSummary();
  const liquidityQuery = useDexLiquidity();
  const reportCardsQuery = useReportCardsV9();
  const redemptionBackstopsQuery = useRedemptionBackstops();
  const yieldRankingsQuery = useYieldRankings();
  const stressSignalsQuery = useStressSignals();
  const flowsEnabled = supplementalQueryControls?.flows ?? true;
  const blacklistSupported = (BLACKLIST_STABLECOINS as readonly string[]).includes(coin.symbol);
  const blacklistEnabled = blacklistSupported && (supplementalQueryControls?.blacklist ?? true);
  const reservesEnabled = !!coin?.liveReservesConfig && (supplementalQueryControls?.reserves ?? true);
  const flowsQuery = useMintBurnFlows(24, { enabled: flowsEnabled });
  const blacklistQuery = useBlacklistSummary({ enabled: blacklistEnabled });
  const liveReserves = useStablecoinReserves(id, reservesEnabled);

  const queries = useQuerySlices({
    supplyHistory: supplyQuery,
    stablecoinList: listQuery,
    pegSummary: pegQuery,
    dexLiquidity: liquidityQuery,
    reportCards: reportCardsQuery,
    redemptionBackstops: redemptionBackstopsQuery,
  });
  const yieldRankings = useQuerySlice(yieldRankingsQuery);
  const stressSignals = useQuerySlice(stressSignalsQuery);
  const flowsSlice = useQuerySlice(flowsQuery);
  const blacklistSlice = useQuerySlice(blacklistQuery);

  // The three supplemental lanes are query-gated: when disabled they must present as an
  // inert resource rather than as a stale one, which is the `enabled` fan-out below.
  const flows = useMemo(
    () => ({
      data: flowsEnabled ? flowsSlice.data : undefined,
      isLoading: flowsEnabled && flowsSlice.isLoading,
      error: flowsEnabled ? flowsSlice.error : null,
      dataUpdatedAt: flowsEnabled ? flowsSlice.dataUpdatedAt : 0,
      meta: flowsEnabled ? flowsSlice.meta : null,
      enabled: flowsEnabled,
    }),
    [flowsEnabled, flowsSlice],
  );
  const blacklist = useMemo(
    () => ({
      summary: blacklistEnabled ? blacklistSlice.data : undefined,
      isLoading: blacklistEnabled && blacklistSlice.isLoading,
      error: blacklistEnabled ? blacklistSlice.error : null,
      dataUpdatedAt: blacklistEnabled ? blacklistSlice.dataUpdatedAt : 0,
      meta: blacklistEnabled ? blacklistSlice.meta : null,
      enabled: blacklistEnabled,
    }),
    [blacklistEnabled, blacklistSlice],
  );
  const reserves = useMemo(
    () => ({
      live: reservesEnabled ? liveReserves.reserveResult : null,
      error: reservesEnabled ? liveReserves.error : null,
      dataUpdatedAt: reservesEnabled ? liveReserves.dataUpdatedAt : 0,
      isLoading: reservesEnabled && liveReserves.isLoading,
      enabled: reservesEnabled,
    }),
    [
      reservesEnabled,
      liveReserves.reserveResult,
      liveReserves.error,
      liveReserves.dataUpdatedAt,
      liveReserves.isLoading,
    ],
  );

  const handleRetryAll = useCallback(() => {
    return refetchQueryGroup(
      [
        supplyQuery.refetch,
        listQuery.refetch,
        pegQuery.refetch,
        liquidityQuery.refetch,
        reportCardsQuery.refetch,
        redemptionBackstopsQuery.refetch,
        yieldRankingsQuery.refetch,
        stressSignalsQuery.refetch,
        ...(flowsEnabled ? [flowsQuery.refetch] : []),
        ...(blacklistEnabled ? [blacklistQuery.refetch] : []),
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
    blacklistQuery.refetch,
    flowsQuery.refetch,
    liquidityQuery.refetch,
    listQuery.refetch,
    pegQuery.refetch,
    redemptionBackstopsQuery.refetch,
    reportCardsQuery.refetch,
    stressSignalsQuery.refetch,
    supplyQuery.refetch,
    yieldRankingsQuery.refetch,
    reservesEnabled,
  ]);

  const viewModel = useMemo(
    () =>
      buildStablecoinDetailViewModel({
        core: { id, coin, summary, logoSrc, handleRetryAll },
        queries,
        supplemental: { yieldRankings, stressSignals, flows, blacklist, reserves },
      }),
    [
      id,
      coin,
      summary,
      logoSrc,
      handleRetryAll,
      queries,
      yieldRankings,
      stressSignals,
      flows,
      blacklist,
      reserves,
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
