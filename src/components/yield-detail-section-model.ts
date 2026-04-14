"use client";

import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useYieldRankings } from "@/hooks/api-hooks";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { getYieldBenchmarkReferenceText } from "@/lib/yield-benchmark";
import { computePysBreakdown, getPysColor } from "@/lib/yield-constants";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import { formatPercentFromRatio, formatSignedPercent as sharedFormatSignedPercent } from "@shared/lib/format";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { AltYieldSource, YieldRanking } from "@shared/types";

export const ALT_SOURCE_INITIAL_COUNT = 6;

const DATA_SOURCE_BADGES: Record<string, { label: string; badge: string }> = {
  onchain: {
    label: "On-chain",
    badge: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  },
  defillama: {
    label: "DeFiLlama",
    badge: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20",
  },
  "defillama-auto": {
    label: "DeFiLlama",
    badge: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20",
  },
  "protocol-api": {
    label: "Protocol-native",
    badge: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/20",
  },
  "price-derived": {
    label: "Price-derived",
    badge: "bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/20",
  },
  "rate-derived": {
    label: "Rate-derived",
    badge: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/20",
  },
};

export function formatSignedPercent(value: number | null) {
  if (value === null) return "\u2014";
  return sharedFormatSignedPercent(value);
}

export interface YieldDetailSectionReadyModel {
  status: "ready";
  ranking: YieldRanking;
  apiWarning: string | null;
  benchmarkSubtitle?: string;
  benchmarkRate: number;
  medianApy: number;
  benchmarkIsFallback: boolean;
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

function buildHistorySources(ranking: YieldRanking) {
  return [
    ...(ranking.provenance?.sourceKey
      ? [
          {
            sourceKey: ranking.provenance.sourceKey,
            yieldSource: ranking.yieldSource,
          },
        ]
      : []),
    ...ranking.altSources.map((source: AltYieldSource) => ({
      sourceKey: source.sourceKey,
      yieldSource: source.yieldSource,
    })),
  ];
}

export function useYieldDetailSectionModel(stablecoinId: string): YieldDetailSectionModel {
  const { getParam, replaceParams } = useUrlFilters();
  const { data, meta: apiMeta, error, isLoading } = useYieldRankings();

  const selectedSourceKeys = useMemo(
    () => new Set(getParam("sources").split(",").filter(Boolean)),
    [getParam],
  );
  const [showAllSources, setShowAllSources] = useState(false);

  const toggleSource = (sourceKey: string) => {
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
  );
  const pysColor = getPysColor(ranking.pharosYieldScore);
  const stabilityValue = ranking.yieldStability !== null ? formatPercentFromRatio(ranking.yieldStability, 0) : "—";
  const dataSourceMeta = DATA_SOURCE_BADGES[ranking.dataSource] ?? DATA_SOURCE_BADGES.defillama;
  const singleWarning = ranking.warningSignals.length === 1 ? ranking.warningSignals[0] : null;
  const historySources = buildHistorySources(ranking);
  const benchmarkSubtitle = getYieldBenchmarkReferenceText(ranking);

  return {
    status: "ready",
    ranking,
    apiWarning: apiMeta?.warning ?? null,
    benchmarkSubtitle,
    benchmarkRate: ranking.benchmarkRate ?? data?.riskFreeRate ?? 0,
    medianApy: data?.medianApy ?? 0,
    benchmarkIsFallback: ranking.benchmarkSelectionMode === "fallback-usd" || !!ranking.benchmarkIsFallback,
    externalSourceKeys: selectedSourceKeys.size > 0 ? [...selectedSourceKeys] : undefined,
    historySources,
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
