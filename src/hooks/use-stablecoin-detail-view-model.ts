"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isDetailSnapshotQuery, type SavedSafetyAssessment } from "@/lib/api";
import { trackFreshDataReady } from "@/lib/analytics";
import { deriveDataHealth } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import { useDetailEvidence } from "@/lib/detail-evidence";
import {
  useDexLiquidityCoin,
  usePegSummary,
  useRegisteredApiQuery,
  useRedemptionBackstopCoin,
  useReportCardsV9Detail,
  useStressSignals,
  useYieldRankingsCoin,
} from "@/hooks/api-hooks";
import { useSupplyHistory } from "@/hooks/use-stablecoins";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { useStablecoinReserves } from "@/hooks/use-stablecoin-reserves";
import { useBlacklistSummary } from "@/hooks/use-blacklist-events";
import { useQuerySlice, type QueryResultLike, type QuerySlice } from "@/hooks/use-query-slice";
import { refetchQueryGroup, type QueryRefetchFn } from "@/lib/query-refetch-group";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import {
  buildStablecoinDetailViewModel,
  type StablecoinDetailSummary,
  type StablecoinDetailViewModel as BaseStablecoinDetailViewModel,
} from "@/lib/stablecoin-detail-view-model";
import type { StablecoinDetailCoinMeta } from "@/lib/stablecoin-detail-client-coin";
import { isAnnualUsdPerformanceEligible } from "@/lib/stablecoin-detail-query-view-model";
import {
  FRONTEND_API_QUERY_DESCRIPTORS,
  STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS,
} from "@/lib/api-query-descriptors";
import type { StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";

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
  /** Frozen coins only: archived list row used when the live detail row is unavailable. */
  archivedLiveSummary?: StablecoinLiveSummary | null;
  /** The build snapshot's dated scores-latest values, shown while live reads are pending. */
  savedAssessment?: SavedSafetyAssessment | null;
  supplementalQueryControls?: StablecoinDetailSupplementalQueryControls;
}

export type StablecoinDetailViewModel =
  | Exclude<BaseStablecoinDetailViewModel, { status: "ready" }>
  | (Extract<BaseStablecoinDetailViewModel, { status: "ready" }> & {
      refetchReserves: QueryRefetchFn | null;
      isFetchingReserves: boolean;
    });

export type { StablecoinDetailSummary };

function useGatedQuerySlice<TData>(
  query: QueryResultLike<TData>,
  enabled: boolean,
): QuerySlice<TData> & { enabled: boolean } {
  const slice = useQuerySlice(query);
  return useMemo(
    () => enabled
      ? { ...slice, enabled: true }
      : {
          data: undefined,
          isLoading: false,
          isError: false,
          error: null,
          dataUpdatedAt: 0,
          meta: null,
          enabled: false,
        },
    [enabled, slice],
  );
}


export function useStablecoinDetailViewModel({
  id,
  coin,
  summary,
  logoSrc,
  archivedLiveSummary = null,
  savedAssessment = null,
  supplementalQueryControls,
}: UseStablecoinDetailViewModelParams): StablecoinDetailViewModel {
  const queryClient = useQueryClient();
  const liquidityEnabled = supplementalQueryControls?.liquidity ?? true;
  const reportCardsEnabled = supplementalQueryControls?.reportCards ?? true;
  const redemptionEnabled = supplementalQueryControls?.redemption ?? true;
  const yieldEnabled = supplementalQueryControls?.yield ?? true;
  const stressEnabled = supplementalQueryControls?.stress ?? true;
  const flowsEnabled = supplementalQueryControls?.flows ?? true;
  const supplyQuery = useSupplyHistory(id, STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS);
  const annualPriceEnabled = isAnnualUsdPerformanceEligible(coin);
  // Include the 14-day anchor tolerance without fetching the full five-year chart.
  const annualPriceQuery = useSupplyHistory(id, 380, { enabled: annualPriceEnabled });
  const liveSummaryQuery = useRegisteredApiQuery<StablecoinLiveSummary>(
    FRONTEND_API_QUERY_DESCRIPTORS.stablecoinLiveSummary(id),
  );
  const summaryIsSnapshot = isDetailSnapshotQuery(queryClient, FRONTEND_API_QUERY_DESCRIPTORS.stablecoinLiveSummary(id).queryKey);
  const displayedSummary = useDetailEvidence(id, liveSummaryQuery, summaryIsSnapshot || liveSummaryQuery.isError);
  const liveSummary = useMemo(() => {
    // Live detail wins when present (as in sync-stablecoins intake). A frozen coin's detail row
    // is never refreshed, so once that row is gone the archived row backs the page; it has no freshness clock.
    const summaryData = displayedSummary.data ?? archivedLiveSummary;
    const usingArchive = displayedSummary.data == null && archivedLiveSummary != null;
    return {
      data: summaryData ?? undefined,
      isLoading: !usingArchive && !displayedSummary.data && liveSummaryQuery.isLoading,
      error: usingArchive ? null : liveSummaryQuery.error,
      dataUpdatedAt: usingArchive ? 0 : displayedSummary.isRetained
        ? (displayedSummary.meta?.updatedAt ?? 0) * 1000 : liveSummaryQuery.dataUpdatedAt,
      meta: usingArchive ? null : displayedSummary.meta ?? {
        updatedAt: null,
        ageSeconds: null,
        status: "unknown" as const,
        reason: "producer-timestamp-unavailable",
      },
      enabled: !usingArchive,
      awaitingLiveRead: summaryIsSnapshot && liveSummaryQuery.fetchStatus === "fetching",
    };
  }, [archivedLiveSummary, displayedSummary.data, displayedSummary.meta, displayedSummary.isRetained,
    liveSummaryQuery.dataUpdatedAt, liveSummaryQuery.error, liveSummaryQuery.isLoading,
    summaryIsSnapshot, liveSummaryQuery.fetchStatus]);
  useEffect(() => {
    // Early prefetch may finish before this observer mounts; explicit admitted
    // live provenance, not isFetchedAfterMount, distinguishes it from a seed.
    if (liveSummaryQuery.isFetching || liveSummaryQuery.isError
      || liveSummaryQuery.error || !liveSummaryQuery.data || summaryIsSnapshot
      || liveSummaryQuery.meta?.updatedAt == null) return;
    const health = deriveDataHealth({
      ...DATA_HEALTH_PRESETS.stablecoins,
      dataUpdatedAt: liveSummaryQuery.dataUpdatedAt,
      hasData: true,
      meta: liveSummaryQuery.meta,
    });
    if (health.state === "fresh") trackFreshDataReady("detail-summary");
  }, [liveSummaryQuery.data, liveSummaryQuery.dataUpdatedAt, liveSummaryQuery.error,
    liveSummaryQuery.isError, liveSummaryQuery.isFetching, liveSummaryQuery.meta, summaryIsSnapshot]);
  const pegQuery = usePegSummary();
  const liquidityQuery = useDexLiquidityCoin(id, { enabled: liquidityEnabled });
  const reportCardsQuery = useReportCardsV9Detail(id, { enabled: reportCardsEnabled });
  const redemptionBackstopsQuery = useRedemptionBackstopCoin(id, { enabled: redemptionEnabled });
  const yieldRankingsQuery = useYieldRankingsCoin(id, { enabled: yieldEnabled });
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

  const supplySlice = useQuerySlice(supplyQuery);
  const supplyAwaitingLiveRead = isDetailSnapshotQuery(queryClient,
    FRONTEND_API_QUERY_DESCRIPTORS.supplyHistory(id, STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS).queryKey)
    && supplyQuery.isFetching;
  const supplyHistory = useMemo(
    () => ({ ...supplySlice, awaitingLiveRead: supplyAwaitingLiveRead }),
    [supplySlice, supplyAwaitingLiveRead],
  );
  const annualPriceHistory = useGatedQuerySlice(annualPriceQuery, annualPriceEnabled);
  const pegSummary = useQuerySlice(pegQuery);
  const queries = useMemo(
    () => ({
      supplyHistory,
      annualPriceHistory,
      liveSummary,
      pegSummary,
      dexLiquidity: liquidity,
      reportCards,
      redemptionBackstops,
    }),
    [supplyHistory, annualPriceHistory, liveSummary, pegSummary, liquidity, reportCards, redemptionBackstops],
  );
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
        ...(annualPriceEnabled && annualPriceQuery.error != null ? [annualPriceQuery.refetch] : []),
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
    annualPriceEnabled,
    annualPriceQuery.error,
    annualPriceQuery.refetch,
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
        core: { id, coin, summary, logoSrc, handleRetryAll, savedAssessment },
        queries,
        supplemental: { yieldRankings, stressSignals, flows, blacklist, reserves },
      }),
    [
      id,
      coin,
      summary,
      logoSrc,
      handleRetryAll,
      savedAssessment,
      queries,
      yieldRankings,
      stressSignals,
      flows,
      blacklist,
      reserves,
    ],
  );

  return useMemo(() => viewModel.status === "ready" ? {
    ...viewModel,
    refetchReserves: reservesEnabled ? liveReserves.refetch : null,
    isFetchingReserves: liveReserves.isFetching,
  } : viewModel, [viewModel, reservesEnabled, liveReserves.refetch, liveReserves.isFetching]);
}
