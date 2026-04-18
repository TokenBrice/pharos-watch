"use client";

import { useCallback, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints";
import {
  useBluechipRatings,
  useDexLiquidity,
  usePegSummary,
  useReportCards,
} from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { apiFetch } from "@/lib/api";
import { CRON_1H, CRON_MINT_BURN } from "@/lib/cron-intervals";
import { COMPARE_COLORS } from "@/lib/compare-config";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import {
  deriveComparisonCoins,
  deriveSupplySeries,
  deriveFlowSeries,
  deriveFlowCardData,
} from "@/lib/compare-derive";
import { derivePegRates } from "@shared/lib/peg-rates";
import {
  MintBurnPerCoinResponseSchema,
  SupplyHistoryResponseSchema,
  type ReportCard,
  type StablecoinData,
  type SupplyHistoryPoint,
} from "@shared/types";

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
  } = useReportCards();
  const { data: flowData } = useMintBurnFlows();

  const globalError = listError ?? pegError ?? bluechipError ?? dexError ?? reportCardsError;

  const cardMap = useMemo(() => {
    if (!reportCardsData?.cards) return new Map<string, ReportCard>();
    return new Map(reportCardsData.cards.map((card) => [card.id, card]));
  }, [reportCardsData]);

  const radarCards = useMemo(() => {
    return selectedIds
      .map((id, index) => {
        const card = cardMap.get(id);
        if (!card) return null;
        return { card, color: COMPARE_COLORS[index % COMPARE_COLORS.length] };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry != null);
  }, [cardMap, selectedIds]);

  // pegRates and assetMap share the same dependency (listData), so they are
  // combined into one memoised block to avoid redundant re-computation.
  const { pegRates, assetMap } = useMemo(() => {
    if (!listData?.peggedAssets) {
      return {
        pegRates: {} as Record<string, number>,
        assetMap: new Map<string, StablecoinData>(),
      };
    }
    return {
      pegRates: derivePegRates(listData.peggedAssets, TRACKED_META_BY_ID, listData.fxFallbackRates).rates,
      assetMap: new Map(listData.peggedAssets.map((a) => [a.id, a] as const)),
    };
  }, [listData]);

  const detailQueries = useQueries({
    queries: selectedIds.map((id) => ({
      queryKey: ["supply-history", id, 1825],
      queryFn: () =>
        apiFetch<SupplyHistoryPoint[]>(
          API_PATHS.supplyHistory(id, 1825),
          SupplyHistoryResponseSchema,
        ),
      staleTime: CRON_1H,
      refetchInterval: 2 * CRON_1H,
      enabled: !!id,
    })),
  });

  const flowCoinQueries = useQueries({
    queries: selectedIds.map((id) => ({
      queryKey: ["mint-burn-flows", id, flowHours],
      queryFn: () => apiFetch(
        API_PATHS.mintBurnFlows({ stablecoin: id, hours: flowHours }),
        MintBurnPerCoinResponseSchema,
      ),
      staleTime: CRON_MINT_BURN,
      refetchInterval: 2 * CRON_MINT_BURN,
      enabled: !!id,
    })),
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
    if (!pegSummary?.coins) return new Map<string, NonNullable<typeof pegSummary>["coins"][number]>();
    return new Map(pegSummary.coins.map((c) => [c.id, c] as const));
  }, [pegSummary]);

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
      flowDetails: selectedIds.map((_, index) => flowCoinQueries[index]?.data),
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
    void Promise.allSettled([
      refetchList(),
      refetchPeg(),
      refetchBluechip(),
      refetchLiquidity(),
      refetchReportCards(),
      ...detailQueries.map((query) => query.refetch()),
      ...flowCoinQueries.map((query) => query.refetch()),
    ]).then((results) => {
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length > 0) {
        console.warn("[refetch] Some queries failed to refresh", failed);
      }
    });
  }, [
    detailQueries,
    flowCoinQueries,
    refetchBluechip,
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
