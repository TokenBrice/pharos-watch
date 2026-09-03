"use client";

import { useCallback, useMemo } from "react";
import {
  useDexLiquidity,
  usePegSummary,
  useRegisteredApiQuery,
  useReportCardsV9,
  useStressSignals,
  useYieldRankings,
} from "@/hooks/api-hooks";
import { useSupplyHistory } from "@/hooks/use-stablecoins";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { useStablecoinReserves } from "@/hooks/use-stablecoin-reserves";
import { useBlacklistSummary } from "@/hooks/use-blacklist-events";
import { useQuerySlice, useQuerySlices, type QueryResultLike, type QuerySlice } from "@/hooks/use-query-slice";
import { refetchQueryGroup, type QueryRefetchFn } from "@/lib/query-refetch-group";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import {
  buildStablecoinDetailViewModel,
  type StablecoinDetailSummary,
  type StablecoinDetailViewModel as BaseStablecoinDetailViewModel,
} from "@/lib/stablecoin-detail-view-model";
import type { StablecoinDetailCoinMeta } from "@/lib/stablecoin-detail-client-coin";
import {
  FRONTEND_API_QUERY_DESCRIPTORS,
  STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS,
  type StablecoinLiveSummary,
} from "@/lib/api-query-descriptors";
import type { RedemptionBackstopsResponse } from "@shared/types/redemption";
import type { StablecoinData } from "@shared/types";

export interface StablecoinDetailSupplementalQueryControls {
  liquidity?: boolean;
  reportCards?: boolean;
  redemption?: boolean;
  yield?: boolean;
  stress?: boolean;
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

function useGatedQuerySlice<TData>(query: QueryResultLike<TData>, enabled: boolean): QuerySlice<TData> {
  const slice = useQuerySlice(query);
  return useMemo(
    () => enabled
      ? slice
      : {
          data: undefined,
          isLoading: false,
          isError: false,
          error: null,
          dataUpdatedAt: 0,
          meta: null,
        },
    [enabled, slice],
  );
}

function projectLiveSummary(
  coin: StablecoinDetailCoinMeta,
  summary: StablecoinLiveSummary,
): StablecoinData {
  const chains = [...new Set(coin.contracts?.map((contract) => contract.chain) ?? [])];

  return {
    id: coin.id,
    name: coin.name,
    symbol: coin.symbol,
    geckoId: coin.geckoId ?? null,
    pegType: `pegged${coin.flags.pegCurrency}`,
    pegMechanism: coin.pegMechanism ?? "unknown",
    price: summary.price,
    priceSource: summary.priceSource ?? (coin.detailProvider === "coingecko" ? "coingecko" : "defillama"),
    priceConfidence: summary.priceConfidence,
    priceUpdatedAt: summary.priceUpdatedAt,
    priceObservedAt: summary.priceObservedAt,
    priceObservedAtMode: null,
    priceSyncedAt: null,
    consensusSources: [],
    agreeSources: [],
    supplySource: "stablecoin-detail",
    ...(summary.supplyObservedAt != null ? { supplyObservedAt: summary.supplyObservedAt } : {}),
    circulating: summary.circulating,
    circulatingPrevDay: summary.circulatingPrevDay,
    circulatingPrevWeek: summary.circulatingPrevWeek,
    circulatingPrevMonth: summary.circulatingPrevMonth,
    chainCirculating: {},
    chains,
  };
}

export function useStablecoinDetailViewModel({
  id,
  coin,
  summary,
  logoSrc,
  supplementalQueryControls,
}: UseStablecoinDetailViewModelParams): StablecoinDetailViewModel {
  const liquidityEnabled = supplementalQueryControls?.liquidity ?? true;
  const reportCardsEnabled = supplementalQueryControls?.reportCards ?? true;
  const redemptionEnabled = supplementalQueryControls?.redemption ?? true;
  const yieldEnabled = supplementalQueryControls?.yield ?? true;
  const stressEnabled = supplementalQueryControls?.stress ?? true;
  const flowsEnabled = supplementalQueryControls?.flows ?? true;
  const supplyQuery = useSupplyHistory(id, STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS);
  const liveSummaryQuery = useRegisteredApiQuery<StablecoinLiveSummary>(
    FRONTEND_API_QUERY_DESCRIPTORS.stablecoinLiveSummary(id),
  );
  const listQuery = useMemo(() => ({
    data: liveSummaryQuery.data
      ? { peggedAssets: [projectLiveSummary(coin, liveSummaryQuery.data)] }
      : undefined,
    isLoading: liveSummaryQuery.isLoading,
    isError: liveSummaryQuery.isError,
    error: liveSummaryQuery.error,
    dataUpdatedAt: liveSummaryQuery.dataUpdatedAt,
    meta: null,
  }), [coin, liveSummaryQuery.data, liveSummaryQuery.dataUpdatedAt, liveSummaryQuery.error,
    liveSummaryQuery.isError, liveSummaryQuery.isLoading]);
  const pegQuery = usePegSummary();
  const liquidityQuery = useDexLiquidity({ enabled: liquidityEnabled });
  const reportCardsQuery = useReportCardsV9({ enabled: reportCardsEnabled });
  const redemptionBackstopsQuery = useRegisteredApiQuery<RedemptionBackstopsResponse>(
    FRONTEND_API_QUERY_DESCRIPTORS.redemptionBackstops,
    { enabled: redemptionEnabled },
  );
  const yieldRankingsQuery = useYieldRankings({ enabled: yieldEnabled });
  const stressSignalsQuery = useStressSignals({ enabled: stressEnabled });
  const blacklistSupported = (BLACKLIST_STABLECOINS as readonly string[]).includes(coin.symbol);
  const blacklistEnabled = blacklistSupported && (supplementalQueryControls?.blacklist ?? true);
  const reservesEnabled = !!coin?.liveReservesConfig && (supplementalQueryControls?.reserves ?? true);
  const flowsQuery = useMintBurnFlows(24, { enabled: flowsEnabled });
  const blacklistQuery = useBlacklistSummary({ enabled: blacklistEnabled });
  const liveReserves = useStablecoinReserves(id, reservesEnabled);

  const liquidity = useGatedQuerySlice(liquidityQuery, liquidityEnabled);
  const reportCards = useGatedQuerySlice(reportCardsQuery, reportCardsEnabled);
  const redemptionBackstops = useGatedQuerySlice(redemptionBackstopsQuery, redemptionEnabled);
  const yieldRankings = useGatedQuerySlice(yieldRankingsQuery, yieldEnabled);
  const stressSignals = useGatedQuerySlice(stressSignalsQuery, stressEnabled);

  const queries = useQuerySlices({
    supplyHistory: supplyQuery,
    stablecoinList: listQuery,
    pegSummary: pegQuery,
    dexLiquidity: liquidity,
    reportCards,
    redemptionBackstops,
  });
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
        ...(supplyQuery.error != null ? [supplyQuery.refetch] : []),
        ...(liveSummaryQuery.error != null ? [liveSummaryQuery.refetch] : []),
        ...(pegQuery.error != null ? [pegQuery.refetch] : []),
        ...(liquidityEnabled && liquidityQuery.error != null ? [liquidityQuery.refetch] : []),
        ...(reportCardsEnabled && reportCardsQuery.error != null ? [reportCardsQuery.refetch] : []),
        ...(redemptionEnabled && redemptionBackstopsQuery.error != null ? [redemptionBackstopsQuery.refetch] : []),
        ...(yieldEnabled && yieldRankingsQuery.error != null ? [yieldRankingsQuery.refetch] : []),
        ...(stressEnabled && stressSignalsQuery.error != null ? [stressSignalsQuery.refetch] : []),
        ...(flowsEnabled && flowsQuery.error != null ? [flowsQuery.refetch] : []),
        ...(blacklistEnabled && blacklistQuery.error != null ? [blacklistQuery.refetch] : []),
        ...(reservesEnabled && liveReserves.error != null ? [liveReserves.refetch] : []),
      ],
      {
        warnLabel: "[refetch] Some queries failed to refresh",
      },
    );
  }, [
    liveReserves.error,
    liveReserves.refetch,
    blacklistEnabled,
    blacklistQuery.error,
    flowsEnabled,
    flowsQuery.error,
    blacklistQuery.refetch,
    flowsQuery.refetch,
    liquidityEnabled,
    liquidityQuery.error,
    liquidityQuery.refetch,
    liveSummaryQuery.error,
    liveSummaryQuery.refetch,
    pegQuery.error,
    pegQuery.refetch,
    redemptionBackstopsQuery.error,
    redemptionBackstopsQuery.refetch,
    reportCardsQuery.error,
    reportCardsQuery.refetch,
    stressSignalsQuery.error,
    stressSignalsQuery.refetch,
    supplyQuery.error,
    supplyQuery.refetch,
    yieldRankingsQuery.error,
    yieldRankingsQuery.refetch,
    redemptionEnabled,
    reportCardsEnabled,
    reservesEnabled,
    stressEnabled,
    yieldEnabled,
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
