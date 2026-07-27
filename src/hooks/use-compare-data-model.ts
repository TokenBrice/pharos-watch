"use client";

import { useCallback, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  useBluechipRatings,
  useDexLiquidity,
  usePegSummary,
  useReportCardsV9,
} from "@/hooks/api-hooks";
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
  const { data: listData, dataUpdatedAt, error: listError, refetch: refetchList, meta: listMeta } = useStablecoins();
  const { data: pegSummary, dataUpdatedAt: pegUpdatedAt, error: pegError, refetch: refetchPeg, meta: pegMeta } = usePegSummary();
  const {
    data: bluechipData,
    dataUpdatedAt: bcUpdatedAt,
    error: bluechipError,
    refetch: refetchBluechip,
    meta: bluechipMeta,
  } = useBluechipRatings();
  const {
    data: dexData,
    dataUpdatedAt: liqUpdatedAt,
    error: dexError,
    refetch: refetchLiquidity,
    meta: dexMeta,
  } = useDexLiquidity();
  const {
    data: reportCardsData,
    dataUpdatedAt: rcUpdatedAt,
    error: reportCardsError,
    refetch: refetchReportCards,
    meta: reportCardsMeta,
  } = useReportCardsV9();
  const { data: flowData, refetch: refetchFlows } = useMintBurnFlows();

  const globalError = listError ?? pegError ?? bluechipError ?? dexError ?? reportCardsError;

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

  const comparisonCoins = useMemo(() => {
    return deriveComparisonCoins({
      selectedIds,
      assetMap,
      metaMap: TRACKED_META_BY_ID,
      pegCoinMap,
      dexData,
      cardMap,
      flowCoinMap,
    });
  }, [assetMap, cardMap, dexData, flowCoinMap, pegCoinMap, selectedIds]);

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
      refetchList,
      refetchPeg,
      refetchBluechip,
      refetchLiquidity,
      refetchReportCards,
      refetchFlows,
      ...detailQueries.map((query) => query.refetch),
      ...flowCoinQueries.map((query) => query.refetch),
    ], {
      warnLabel: "[refetch] Some queries failed to refresh",
    });
  }, [
    detailQueries,
    flowCoinQueries,
    refetchBluechip,
    refetchFlows,
    refetchLiquidity,
    refetchList,
    refetchPeg,
    refetchReportCards,
  ]);

  return {
    bluechipData,
    bluechipError,
    bluechipMeta,
    bcUpdatedAt,
    comparisonCoins,
    dataUpdatedAt,
    detailErrors,
    detailLoading,
    detailQueries,
    dexData,
    dexError,
    dexMeta,
    flowCardData,
    flowCoinQueries,
    flowData,
    flowSeries,
    globalError,
    liqUpdatedAt,
    listData,
    listError,
    listMeta,
    pegError,
    pegMeta,
    pegRates,
    pegSummary,
    pegUpdatedAt,
    radarCards,
    rcUpdatedAt,
    reportCardsData,
    reportCardsError,
    reportCardsMeta,
    supplySeries,
    handleRetry,
  };
}
