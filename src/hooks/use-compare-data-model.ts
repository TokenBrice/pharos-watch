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
import { CRON_1H, CRON_20MIN } from "@/lib/cron-intervals";
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
  const { data: listData, dataUpdatedAt, error: listError, refetch: refetchList } = useStablecoins();
  const { data: pegSummary, dataUpdatedAt: pegUpdatedAt, error: pegError, refetch: refetchPeg } = usePegSummary();
  const {
    data: bluechipData,
    dataUpdatedAt: bcUpdatedAt,
    error: bluechipError,
    refetch: refetchBluechip,
  } = useBluechipRatings();
  const {
    data: dexData,
    dataUpdatedAt: liqUpdatedAt,
    error: dexError,
    refetch: refetchLiquidity,
  } = useDexLiquidity();
  const {
    data: reportCardsData,
    dataUpdatedAt: rcUpdatedAt,
    error: reportCardsError,
    refetch: refetchReportCards,
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

  const pegRates = useMemo(() => {
    if (!listData?.peggedAssets) return {};
    return derivePegRates(listData.peggedAssets, TRACKED_META_BY_ID, listData.fxFallbackRates).rates;
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
      enabled: !!id,
    })),
  });

  const flowCoinQueries = useQueries({
    queries: selectedIds.map((id) => ({
      queryKey: ["mint-burn-flows", id, flowHours],
      queryFn: async () => {
        const raw = await apiFetch(`/api/mint-burn-flows?stablecoin=${encodeURIComponent(id)}&hours=${flowHours}`);
        return MintBurnPerCoinResponseSchema.parse(raw);
      },
      staleTime: CRON_20MIN,
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

  const assetMap = useMemo(() => {
    if (!listData?.peggedAssets) return new Map<string, StablecoinData>();
    return new Map(listData.peggedAssets.map((a) => [a.id, a] as const));
  }, [listData]);

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
    ]);
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
    bcUpdatedAt,
    comparisonCoins,
    dataUpdatedAt,
    detailErrors,
    detailLoading,
    detailQueries,
    dexData,
    dexError,
    flowCardData,
    flowCoinQueries,
    flowData,
    flowSeries,
    globalError,
    liqUpdatedAt,
    listData,
    listError,
    pegError,
    pegRates,
    pegSummary,
    pegUpdatedAt,
    radarCards,
    rcUpdatedAt,
    reportCardsData,
    reportCardsError,
    supplySeries,
    handleRetry,
  };
}
