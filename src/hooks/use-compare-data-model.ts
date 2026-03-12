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
import { CRON_1H, CRON_20MIN } from "@/hooks/use-api-query";
import { CHART_PALETTE } from "@/lib/chart-colors";
import { COMPARE_COLORS } from "@/lib/compare-config";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { derivePegRates } from "@shared/lib/peg-rates";
import {
  MintBurnPerCoinResponseSchema,
  SupplyHistoryResponseSchema,
  type ReportCard,
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

  const comparisonCoins = useMemo(() => {
    if (!listData?.peggedAssets) return [];
    return selectedIds
      .map((id) => {
        const data = listData.peggedAssets.find((asset) => asset.id === id);
        const meta = TRACKED_META_BY_ID.get(id);
        if (!data || !meta) return null;
        const pegCoin = pegSummary?.coins?.find((coin) => coin.id === id);
        const dexCoin = dexData?.[id];
        const safetyGrade = cardMap.get(id)?.overallGrade ?? null;
        const flowCoin = flowData?.coins.find((coin) => coin.stablecoinId === id);
        return {
          id,
          symbol: data.symbol,
          name: data.name,
          data,
          meta,
          pegScore: pegCoin?.pegScore ?? null,
          liquidityScore: dexCoin?.liquidityScore ?? null,
          safetyGrade,
          netFlow30d: flowCoin?.netFlow30dUsd ?? null,
        };
      })
      .filter((coin): coin is NonNullable<typeof coin> => coin != null);
  }, [cardMap, dexData, flowData, listData, pegSummary, selectedIds]);

  const supplySeries = useMemo(() => {
    return selectedIds
      .map((id, index) => {
        const history = detailQueries[index]?.data ?? [];
        if (history.length === 0) return null;
        const meta = TRACKED_META_BY_ID.get(id);
        return {
          id,
          label: meta?.name ?? id,
          data: history.map((point) => ({ ts: point.date * 1000, value: point.circulatingUsd })),
          color: CHART_PALETTE[index % CHART_PALETTE.length],
        };
      })
      .filter((series): series is NonNullable<typeof series> => series != null);
  }, [detailQueries, selectedIds]);

  const flowSeries = useMemo(() => {
    return selectedIds
      .map((id, index) => {
        const detail = flowCoinQueries[index]?.data;
        if (!detail?.hourly?.length) return null;
        const meta = TRACKED_META_BY_ID.get(id);
        return {
          id,
          label: meta?.symbol ?? id,
          color: COMPARE_COLORS[index % COMPARE_COLORS.length],
          data: detail.hourly.map((bucket) => ({ ts: bucket.hourTs * 1000, netFlowUsd: bucket.netFlowUsd })),
        };
      })
      .filter((series): series is NonNullable<typeof series> => series != null);
  }, [flowCoinQueries, selectedIds]);

  const flowCardData = useMemo(() => {
    if (!flowData?.coins) return [];
    return selectedIds
      .map((id, index) => {
        const coin = flowData.coins.find((entry) => entry.stablecoinId === id);
        if (!coin) return null;
        const meta = TRACKED_META_BY_ID.get(id);
        return {
          id,
          symbol: meta?.symbol ?? id,
          color: COMPARE_COLORS[index % COMPARE_COLORS.length],
          netFlow24hUsd: coin.netFlow24hUsd,
          pressureShiftScore: coin.pressureShiftScore ?? null,
          netFlowDirection24h: coin.netFlowDirection24h ?? "inactive",
          pressureShiftState: coin.pressureShiftState ?? "nr",
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry != null);
  }, [flowData, selectedIds]);

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
