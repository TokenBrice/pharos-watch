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
import type { StablecoinStatus, YieldRanking, YieldRankingsResponse } from "@shared/types";

export const ALT_SOURCE_INITIAL_COUNT = 6;

export type YieldDetailModelMode = "embedded" | "full-page";

export interface YieldDetailRegistryStatus {
  stablecoinId: string;
  lifecycle: StablecoinStatus;
  shouldHaveYieldData: boolean;
  mode: YieldDetailModelMode;
  inactiveReason?: string | null;
}

export interface YieldDetailReadyModel {
  status: "ready";
  ranking: YieldRanking;
  benchmarkSubtitle?: string;
  benchmarkRate: number;
  medianApy: number;
  benchmarkIsFallback: boolean;
  sourceExplorer: YieldSourceExplorerModel;
  sourceDepthLens: YieldSourceDepthLens;
  sourceRiskDrivers: YieldSourceRiskDriver[];
  validatedSourceKeys: string[];
  externalSourceKeys?: string[];
  historySources: Array<{ sourceKey: string; yieldSource: string }>;
  dataSourceMeta: { label: string; badge: string };
  warningSignals: string[];
  singleWarning: string | null;
  stabilityValue: string;
  pysBreakdown: {
    adjustedRiskPenalty: number;
    benchmarkAdjustment: number;
    benchmarkSpread: number | null;
    effectiveYield: number;
    scalingFactor: number;
    sourceRiskPenalty: number;
    yieldEfficiency: number;
    sustainabilityMult: number;
  };
  pysColor: string;
  yieldTypeLabel: string;
  yieldTypeBadge: string;
  benchmarkLabel?: string | null;
}

export type YieldDetailModel =
  | YieldDetailReadyModel
  | { status: "unavailable"; shouldHaveYieldData: boolean }
  | { status: "hidden" }
  | { status: "pre-launch"; hasRanking: boolean }
  | { status: "inactive"; reason: string | null; hasRanking: boolean }
  | { status: "frozen" };

export function buildYieldDetailModel(
  rankingResponse: YieldRankingsResponse | null | undefined,
  registryStatus: YieldDetailRegistryStatus,
  requestedSourceKeys: Iterable<string>,
): YieldDetailModel {
  const ranking = rankingResponse?.rankings.find((row) => row.id === registryStatus.stablecoinId);

  if (registryStatus.mode === "full-page") {
    if (registryStatus.lifecycle === "pre-launch") {
      return { status: "pre-launch", hasRanking: !!ranking };
    }
    if (registryStatus.lifecycle === "quarantined" || registryStatus.lifecycle === "delisted") {
      return { status: "inactive", reason: registryStatus.inactiveReason ?? null, hasRanking: !!ranking };
    }
  }

  if (!ranking || !rankingResponse) {
    if (registryStatus.mode === "embedded" && !registryStatus.shouldHaveYieldData) {
      return { status: "hidden" };
    }
    if (registryStatus.mode === "full-page" && registryStatus.lifecycle === "frozen") {
      return { status: "frozen" };
    }
    return { status: "unavailable", shouldHaveYieldData: registryStatus.shouldHaveYieldData };
  }

  const pysBreakdown = {
    ...computePysBreakdown(
      ranking.apy30d,
      ranking.safetyScore,
      ranking.yieldStability,
      ranking.benchmarkRate,
      ranking.sourceRisk?.sourceRiskPenalty ?? null,
    ),
    scalingFactor: rankingResponse.scalingFactor,
  };
  const sourceExplorer = buildYieldSourceExplorerModel(ranking);
  const availableSourceKeys = new Set(sourceExplorer.historySources.map((source) => source.sourceKey));
  const validatedSourceKeys = [...requestedSourceKeys].filter((sourceKey) => availableSourceKeys.has(sourceKey));

  return {
    status: "ready",
    ranking,
    benchmarkSubtitle: getYieldBenchmarkGapReferenceText(ranking, { includePeriod: false }),
    benchmarkRate: ranking.benchmarkRate ?? rankingResponse.riskFreeRate ?? 0,
    medianApy: rankingResponse.medianApy ?? 0,
    benchmarkIsFallback: ranking.benchmarkSelectionMode === "fallback-usd" || !!ranking.benchmarkIsFallback,
    sourceExplorer,
    sourceDepthLens: sourceExplorer.sourceDepthLens,
    sourceRiskDrivers: sourceExplorer.sourceRiskDrivers,
    validatedSourceKeys,
    externalSourceKeys: validatedSourceKeys.length > 0 ? validatedSourceKeys : undefined,
    historySources: sourceExplorer.historySources,
    dataSourceMeta: getYieldDataSourceMeta(ranking.dataSource),
    warningSignals: ranking.warningSignals,
    singleWarning: ranking.warningSignals.length === 1 ? ranking.warningSignals[0] : null,
    stabilityValue: ranking.yieldStability !== null ? formatPercentFromRatio(ranking.yieldStability, 0) : "—",
    pysBreakdown,
    pysColor: getPysColor(ranking.pharosYieldScore),
    yieldTypeLabel: YIELD_TYPE_LABELS[ranking.yieldType] ?? ranking.yieldType,
    yieldTypeBadge: YIELD_TYPE_STYLES[ranking.yieldType]?.badge ?? "",
    benchmarkLabel: ranking.benchmarkLabel,
  };
}

export interface YieldDetailSectionReadyModel extends YieldDetailReadyModel {
  apiWarning: string | null;
  showAllSources: boolean;
  setShowAllSources: Dispatch<SetStateAction<boolean>>;
  selectedSourceKeys: Set<string>;
  toggleSource: (sourceKey: string) => void;
}

export interface YieldDetailSectionLoadingModel {
  status: "loading";
  shouldHaveYieldData: boolean;
}

export interface YieldDetailSectionErrorModel {
  status: "error";
  shouldHaveYieldData: boolean;
  error: Error | null;
}

export type YieldDetailSectionModel =
  | YieldDetailSectionReadyModel
  | YieldDetailSectionLoadingModel
  | YieldDetailSectionErrorModel
  | Extract<YieldDetailModel, { status: "unavailable" | "hidden" }>;

export function useYieldDetailSectionModel(stablecoinId: string): YieldDetailSectionModel {
  const { getParam, replaceParams } = useUrlFilters();
  const { data, meta: apiMeta, error, isLoading } = useYieldRankings();
  const sourcesParam = getParam("sources");
  const requestedSourceKeys = useMemo(() => sourcesParam.split(",").filter(Boolean), [sourcesParam]);
  const [showAllSources, setShowAllSources] = useState(false);
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  const shouldHaveYieldData = meta?.flags.yieldBearing ?? false;
  const model = useMemo(
    () =>
      buildYieldDetailModel(
        data,
        {
          stablecoinId,
          lifecycle: meta?.status ?? "active",
          shouldHaveYieldData,
          mode: "embedded",
        },
        requestedSourceKeys,
      ),
    [data, meta?.status, requestedSourceKeys, shouldHaveYieldData, stablecoinId],
  );

  if (model.status === "hidden") {
    return model;
  }

  if (model.status !== "ready") {
    if (isLoading && shouldHaveYieldData) {
      return { status: "loading", shouldHaveYieldData };
    }
    if (error && shouldHaveYieldData) {
      return { status: "error", shouldHaveYieldData, error: error instanceof Error ? error : null };
    }
    return model;
  }

  const selectedSourceKeys = new Set(model.validatedSourceKeys);
  const availableSourceKeys = new Set(model.historySources.map((source) => source.sourceKey));
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
    ...model,
    apiWarning: apiMeta?.warning ?? null,
    showAllSources,
    setShowAllSources,
    selectedSourceKeys,
    toggleSource,
  };
}
