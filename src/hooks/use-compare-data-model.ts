"use client";

import { useCallback, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  useBluechipRatings,
  useDexLiquidity,
  usePegSummary,
  useRedemptionBackstops,
  useReportCardsV9,
  useStressSignals,
  useYieldRankings,
} from "@/hooks/api-hooks";
import { useQuerySlices } from "@/hooks/use-query-slice";
import { supplyHistoryQueryOptions, useStablecoins } from "@/hooks/use-stablecoins";
import { mintBurnFlowsCoinQueryOptions, useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { COMPARE_COLORS } from "@/lib/compare-config";
import { refetchQueryGroup } from "@/lib/query-refetch-group";
import { buildPegSummaryCoinMap } from "@/lib/stablecoin-lookups";
import { buildStablecoinTableInputs } from "@/lib/stablecoin-table-inputs";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import {
  deriveComparisonCoins,
  deriveSupplySeries,
  deriveFlowSeries,
  deriveFlowCardData,
} from "@/lib/compare-derive";
import type { StablecoinData } from "@shared/types";
import type { V9ConsumerCard } from "@/lib/safety-score-v9-consumers";

interface UseCompareDataModelOptions {
  selectedIds: string[];
  flowHours: 24 | 168 | 720;
}

export function useCompareDataModel({
  selectedIds,
  flowHours,
}: UseCompareDataModelOptions) {
  const listQuery = useStablecoins();
  const pegQuery = usePegSummary();
  const bluechipQuery = useBluechipRatings();
  const dexQuery = useDexLiquidity();
  const reportCardsQuery = useReportCardsV9();
  const redemptionQuery = useRedemptionBackstops();
  const yieldQuery = useYieldRankings();
  const stressQuery = useStressSignals();
  const { data: flowData, refetch: refetchFlows } = useMintBurnFlows();

  const { list, peg, bluechip, dex, reportCards, redemption, yieldRankings, stress } = useQuerySlices({
    list: listQuery,
    peg: pegQuery,
    bluechip: bluechipQuery,
    dex: dexQuery,
    reportCards: reportCardsQuery,
    redemption: redemptionQuery,
    yieldRankings: yieldQuery,
    stress: stressQuery,
  });
  const listData = list.data;
  const pegSummary = peg.data;
  const dexData = dex.data;
  const reportCardsData = reportCards.data;

  const globalError = list.error ?? peg.error ?? bluechip.error ?? dex.error ?? reportCards.error
    ?? redemption.error ?? yieldRankings.error ?? stress.error;

  const cardMap = useMemo(() => {
    if (!reportCardsData?.cards) return new Map<string, V9ConsumerCard>();
    return new Map(reportCardsData.cards.map((card) => [card.id, card]));
  }, [reportCardsData]);

  const radarCards = useMemo(() => {
    return selectedIds
      .map((id, index) => {
        const card = cardMap.get(id);
        if (!card) return null;
        return {
          card,
          identity: reportCardsData!.safetyScoreIdentity,
          color: COMPARE_COLORS[index % COMPARE_COLORS.length],
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry != null);
  }, [cardMap, reportCardsData, selectedIds]);

  // pegRates and assetMap share the same dependency (listData), so they are
  // combined into one memoised block to avoid redundant re-computation.
  const { pegRates, assetMap } = useMemo(() => {
    if (!listData?.peggedAssets) {
      return {
        pegRates: {} as Record<string, number>,
        assetMap: new Map<string, StablecoinData>(),
      };
    }
    const tableInputs = buildStablecoinTableInputs({
      stablecoins: listData.peggedAssets,
      fxFallbackRates: listData.fxFallbackRates,
    });
    return {
      pegRates: tableInputs.pegRates,
      assetMap: new Map(listData.peggedAssets.map((a) => [a.id, a] as const)),
    };
  }, [listData]);

  const detailQueries = useQueries({
    queries: selectedIds.map((id) => supplyHistoryQueryOptions(id)),
  });

  const flowCoinQueries = useQueries({
    queries: selectedIds.map((id) => mintBurnFlowsCoinQueryOptions(id, flowHours)),
  });

  const detailErrors = useMemo(() => {
    const errors: Record<string, boolean> = {};
    selectedIds.forEach((id, index) => {
      if (detailQueries[index]?.isError) {
        errors[id] = true;
      }
    });
    return errors;
  }, [detailQueries, selectedIds]);

  // pegCoinMap and flowCoinMap depend on different queries (pegSummary vs flowData)
  // and cannot be combined without introducing unnecessary re-computation.
  const pegCoinMap = useMemo(() => {
    return buildPegSummaryCoinMap(pegSummary?.coins);
  }, [pegSummary?.coins]);

  const flowCoinMap = useMemo(() => {
    if (!flowData?.coins) return new Map<string, NonNullable<typeof flowData>["coins"][number]>();
    return new Map(flowData.coins.map((c) => [c.stablecoinId, c] as const));
  }, [flowData]);

  const yieldMap = useMemo(() => {
    return new Map((yieldRankings.data?.rankings ?? []).map((row) => [row.id, row] as const));
  }, [yieldRankings.data?.rankings]);

  const comparisonCoins = useMemo(() => {
    return deriveComparisonCoins({
      selectedIds,
      assetMap,
      metaMap: TRACKED_META_BY_ID,
      pegCoinMap,
      dexData,
      cardMap,
      flowCoinMap,
      bluechipMap: bluechip.data,
      redemptionMap: redemption.data?.coins,
      yieldMap,
      stressMap: stress.data?.signals,
    });
  }, [assetMap, bluechip.data, cardMap, dexData, flowCoinMap, pegCoinMap, redemption.data?.coins, selectedIds, stress.data?.signals, yieldMap]);

  const supplySeries = useMemo(() => {
    return deriveSupplySeries({
      selectedIds,
      histories: selectedIds.map((_, index) => detailQueries[index]?.data ?? []),
      metaMap: TRACKED_META_BY_ID,
    });
  }, [detailQueries, selectedIds]);

  const flowSeries = useMemo(() => {
    return deriveFlowSeries({
      selectedIds,
      flowDetails: selectedIds.map((_, index) => flowCoinQueries[index]?.data?.data),
      metaMap: TRACKED_META_BY_ID,
    });
  }, [flowCoinQueries, selectedIds]);

  const flowCardData = useMemo(() => {
    return deriveFlowCardData({
      selectedIds,
      flowCoinMap,
      metaMap: TRACKED_META_BY_ID,
    });
  }, [flowCoinMap, selectedIds]);

  const detailLoading = detailQueries.some((query) => query.isLoading);

  const handleRetry = useCallback(() => {
    return refetchQueryGroup([
      listQuery.refetch,
      pegQuery.refetch,
      bluechipQuery.refetch,
      dexQuery.refetch,
      reportCardsQuery.refetch,
      redemptionQuery.refetch,
      yieldQuery.refetch,
      stressQuery.refetch,
      refetchFlows,
      ...detailQueries.map((query) => query.refetch),
      ...flowCoinQueries.map((query) => query.refetch),
    ], {
      warnLabel: "[refetch] Some queries failed to refresh",
    });
  }, [
    detailQueries,
    flowCoinQueries,
    bluechipQuery.refetch,
    refetchFlows,
    dexQuery.refetch,
    listQuery.refetch,
    pegQuery.refetch,
    reportCardsQuery.refetch,
    redemptionQuery.refetch,
    stressQuery.refetch,
    yieldQuery.refetch,
  ]);

  return {
    bluechip,
    comparisonCoins,
    detailErrors,
    detailLoading,
    detailQueries,
    dex,
    flowCardData,
    flowCoinQueries,
    flowData,
    flowSeries,
    globalError,
    list,
    peg,
    pegRates,
    radarCards,
    reportCards,
    redemption,
    stress,
    supplySeries,
    yieldRankings,
    handleRetry,
  };
}
