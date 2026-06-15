"use client";

import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useYieldRankings } from "@/hooks/api-hooks";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { getYieldBenchmarkGapReferenceText } from "@/lib/yield-benchmark";
import { getYieldDataSourceMeta } from "@/lib/yield-data-source";
import { computePysBreakdown, getPysColor } from "@/lib/yield-constants";
import { buildYieldSourceExplorerModel, type YieldSourceExplorerModel } from "@/lib/yield-source-explorer-model";
import type { YieldSourceDepthLens, YieldSourceRiskDriver } from "@/lib/yield-source-risk";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import { formatPercentFromRatio } from "@shared/lib/format";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { YieldRanking } from "@shared/types";

export const ALT_SOURCE_INITIAL_COUNT = 6;

export interface YieldDetailSectionReadyModel {
  status: "ready";
  ranking: YieldRanking;
  apiWarning: string | null;
  benchmarkSubtitle?: string;
  benchmarkRate: number;
  medianApy: number;
  benchmarkIsFallback: boolean;
  sourceExplorer: YieldSourceExplorerModel;
  sourceDepthLens: YieldSourceDepthLens;
  sourceRiskDrivers: YieldSourceRiskDriver[];
  externalSourceKeys?: string[];
  historySources: Array<{ sourceKey: string; yieldSource: string }>;
  dataSourceMeta: { label: string; badge: string };
  warningSignals: string[];
  singleWarning: string | null;
  stabilityValue: string;
  showAllSources: boolean;
  setShowAllSources: Dispatch<SetStateAction<boolean>>;
  selectedSourceKeys: Set<string>;
  toggleSource: (sourceKey: string) => void;
  pysBreakdown: {
    adjustedRiskPenalty: number;
    benchmarkAdjustment: number;
    benchmarkSpread: number | null;
    effectiveYield: number;
    sourceRiskPenalty: number;
    yieldEfficiency: number;
    sustainabilityMult: number;
  };
  pysColor: string;
  yieldTypeLabel: string;
  yieldTypeBadge: string;
  benchmarkLabel?: string | null;
}

export interface YieldDetailSectionLoadingModel {
  status: "loading";
  shouldHaveYieldData: boolean;
}

export interface YieldDetailSectionUnavailableModel {
  status: "unavailable";
  shouldHaveYieldData: boolean;
}

export interface YieldDetailSectionErrorModel {
  status: "error";
  shouldHaveYieldData: boolean;
  error: Error | null;
}

export interface YieldDetailSectionHiddenModel {
  status: "hidden";
}

export type YieldDetailSectionModel =
  | YieldDetailSectionReadyModel
  | YieldDetailSectionLoadingModel
  | YieldDetailSectionUnavailableModel
  | YieldDetailSectionErrorModel
  | YieldDetailSectionHiddenModel;

export function useYieldDetailSectionModel(stablecoinId: string): YieldDetailSectionModel {
  const { getParam, replaceParams } = useUrlFilters();
  const { data, meta: apiMeta, error, isLoading } = useYieldRankings();

  const rawSelectedSourceKeys = useMemo(
    () => new Set(getParam("sources").split(",").filter(Boolean)),
    [getParam],
  );
  const [showAllSources, setShowAllSources] = useState(false);

  const ranking = data?.rankings.find((row) => row.id === stablecoinId);
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  const shouldHaveYieldData = meta?.flags.yieldBearing ?? false;

  if (!ranking && data?.rankings && !shouldHaveYieldData) {
    return { status: "hidden" };
  }

  if (!ranking && !shouldHaveYieldData && !data?.rankings && !error) {
    return { status: "hidden" };
  }

  if (!ranking && error && !shouldHaveYieldData) {
    return { status: "hidden" };
  }

  if (!ranking && isLoading && shouldHaveYieldData) {
    return { status: "loading", shouldHaveYieldData };
  }

  if (!ranking && error && shouldHaveYieldData) {
    return { status: "error", shouldHaveYieldData, error: error instanceof Error ? error : null };
  }

  if (!ranking) {
    return { status: "unavailable", shouldHaveYieldData };
  }

  const pysBreakdown = computePysBreakdown(
    ranking.apy30d,
    ranking.safetyScore,
    ranking.yieldStability,
    ranking.benchmarkRate,
    ranking.sourceRisk?.sourceRiskPenalty ?? null,
  );
  const pysColor = getPysColor(ranking.pharosYieldScore);
  const stabilityValue = ranking.yieldStability !== null ? formatPercentFromRatio(ranking.yieldStability, 0) : "—";
  const dataSourceMeta = getYieldDataSourceMeta(ranking.dataSource);
  const sourceExplorer = buildYieldSourceExplorerModel(ranking);
  const availableSourceKeys = new Set(sourceExplorer.historySources.map((source) => source.sourceKey));
  const selectedSourceKeys = new Set(
    [...rawSelectedSourceKeys].filter((sourceKey) => availableSourceKeys.has(sourceKey)),
  );
  const externalSourceKeys = selectedSourceKeys.size > 0 ? [...selectedSourceKeys] : undefined;
  const singleWarning = ranking.warningSignals.length === 1 ? ranking.warningSignals[0] : null;
  const benchmarkSubtitle = getYieldBenchmarkGapReferenceText(ranking, { includePeriod: false });
  const toggleSource = (sourceKey: string) => {
    if (!availableSourceKeys.has(sourceKey)) return;
    const next = new Set(selectedSourceKeys);
    if (next.has(sourceKey)) {
      next.delete(sourceKey);
    } else if (next.size < 4) {
      next.add(sourceKey);
    }
    replaceParams((params) => {
      if (next.size > 0) {
        params.set("sources", [...next].join(","));
      } else {
        params.delete("sources");
      }
    });
  };

  return {
    status: "ready",
    ranking,
    apiWarning: apiMeta?.warning ?? null,
    benchmarkSubtitle,
    benchmarkRate: ranking.benchmarkRate ?? data?.riskFreeRate ?? 0,
    medianApy: data?.medianApy ?? 0,
    benchmarkIsFallback: ranking.benchmarkSelectionMode === "fallback-usd" || !!ranking.benchmarkIsFallback,
    sourceExplorer,
    sourceDepthLens: sourceExplorer.sourceDepthLens,
    sourceRiskDrivers: sourceExplorer.sourceRiskDrivers,
    externalSourceKeys,
    historySources: sourceExplorer.historySources,
    dataSourceMeta,
    warningSignals: ranking.warningSignals,
    singleWarning,
    stabilityValue,
    showAllSources,
    setShowAllSources,
    selectedSourceKeys,
    toggleSource,
    pysBreakdown,
    pysColor,
    yieldTypeLabel: YIELD_TYPE_LABELS[ranking.yieldType] ?? ranking.yieldType,
    yieldTypeBadge: YIELD_TYPE_STYLES[ranking.yieldType]?.badge ?? "",
    benchmarkLabel: ranking.benchmarkLabel,
  };
}
