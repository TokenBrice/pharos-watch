import { getYieldBenchmarkDisplayLabel } from "@/lib/yield-benchmark";
import { getYieldDataSourceLabel } from "@/lib/yield-data-source";
import {
  YIELD_SOURCE_CONFIDENCE_ORDER,
  classifyYieldSourceDepth,
  classifyYieldSourcePosture,
  getYieldSourceRiskDrivers,
  type YieldSourceConfidenceTier,
  type YieldSourceDepthLens,
  type YieldSourcePosture,
  type YieldSourceRiskDriver,
} from "@/lib/yield-source-risk";
import { YIELD_TYPE_LABELS } from "@shared/lib/classification";
import {
  getYieldAlternateSourceCount,
  getYieldBenchmarkSelectionMode,
  getYieldWorkbenchDataSource,
  isYieldRankingSummary,
  type YieldWorkbenchRanking,
} from "@/lib/yield-workbench-row";
import type {
  AltYieldSource,
  YieldBenchmarkKey,
  YieldBenchmarkMeta,
  YieldBenchmarkRegistry,
  YieldType,
} from "@shared/types";

export { YIELD_SOURCE_CONFIDENCE_ORDER, type YieldSourceConfidenceTier };

export type YieldSourceConfidenceCounts = Record<YieldSourceConfidenceTier, number>;
export type YieldSourceDepthCounts = Record<YieldSourceDepthLens, number>;
export type YieldSourcePostureCounts = Record<YieldSourcePosture, number>;

export interface YieldSourceBoardApySummary {
  min: number;
  median: number;
  max: number;
}

export interface YieldSourceBoardLabelCount {
  label: string;
  count: number;
}

export interface YieldSourceBoardRiskDriverCount extends YieldSourceBoardLabelCount {
  key: YieldSourceRiskDriver["key"];
  description: string;
}

export interface YieldSourceBoardGroup {
  key: string;
  yieldType: YieldType;
  yieldTypeLabel: string;
  dataSource: string;
  dataSourceLabel: string;
  laneConfidenceTier: YieldSourceConfidenceTier | null;
  selectedCount: number;
  alternateCount: number;
  representedSourceCount: number;
  apy: YieldSourceBoardApySummary | null;
  sourceLabels: YieldSourceBoardLabelCount[];
}

export function inferLaneConfidenceTier(dataSource: string): YieldSourceConfidenceTier | null {
  switch (dataSource) {
    case "onchain":
    case "rate-derived":
      return "deterministic";
    case "defillama":
    case "protocol-api":
      return "curated";
    case "defillama-auto":
      return "discovered";
    case "price-derived":
      return "fallback";
    default:
      return null;
  }
}

export interface YieldSourceBoardRowDetail {
  id: string;
  symbol: string;
  name: string;
  yieldType: YieldType;
  yieldTypeLabel: string;
  dataSourceLabel: string;
}

export interface YieldSourceBoardSourceSwitchDetail extends YieldSourceBoardRowDetail {
  previousSourceKey: string | null;
  currentYieldSource: string;
}

export interface YieldSourceBoardAnomalyDetail extends YieldSourceBoardRowDetail {
  anomalies: string[];
}

export interface YieldSourceBoardModel {
  selectedCount: number;
  alternateCount: number;
  representedSourceCount: number;
  representedDataSourceCount: number;
  selectedConfidenceCounts: YieldSourceConfidenceCounts;
  selectedConfidenceUnknownCount: number;
  depthCounts: YieldSourceDepthCounts;
  postureCounts: YieldSourcePostureCounts;
  topSourceRiskDrivers: YieldSourceBoardRiskDriverCount[];
  sourceSwitchCount: number;
  anomalyCount: number;
  sourceSwitchDetails: YieldSourceBoardSourceSwitchDetail[];
  anomalyDetails: YieldSourceBoardAnomalyDetail[];
  sourceRowApy: YieldSourceBoardApySummary | null;
  benchmarkLabels: YieldSourceBoardLabelCount[];
  groups: YieldSourceBoardGroup[];
}

export interface BuildYieldSourceBoardModelOptions {
  benchmarks?: YieldBenchmarkRegistry | null;
  fallbackBenchmark?: YieldBenchmarkMeta | null;
}

interface SourceRow {
  kind: "selected" | "alternate";
  yieldType: YieldType;
  dataSource: string;
  yieldSource: string;
  apy30d: number;
}

interface MutableGroup {
  key: string;
  yieldType: YieldType;
  yieldTypeLabel: string;
  dataSource: string;
  dataSourceLabel: string;
  selectedCount: number;
  alternateCount: number;
  apyValues: number[];
  sourceLabelCounts: Map<string, number>;
}

function emptyConfidenceCounts(): YieldSourceConfidenceCounts {
  return {
    deterministic: 0,
    curated: 0,
    discovered: 0,
    fallback: 0,
  };
}

function emptyDepthCounts(): YieldSourceDepthCounts {
  return {
    deep: 0,
    moderate: 0,
    thin: 0,
    unknown: 0,
  };
}

function emptyPostureCounts(): YieldSourcePostureCounts {
  return {
    clean: 0,
    watch: 0,
    speculative: 0,
  };
}

function addCount(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function summarizeApy(values: readonly number[]): YieldSourceBoardApySummary | null {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;

  const mid = Math.floor(finite.length / 2);
  const median = finite.length % 2 === 0 ? (finite[mid - 1] + finite[mid]) / 2 : finite[mid];

  return {
    min: finite[0],
    median,
    max: finite[finite.length - 1],
  };
}

function sortedLabelCounts(labelCounts: Map<string, number>): YieldSourceBoardLabelCount[] {
  return Array.from(labelCounts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function sortedRiskDriverCounts(
  driverCounts: Map<YieldSourceRiskDriver["key"], { label: string; count: number; description: string }>,
): YieldSourceBoardRiskDriverCount[] {
  return Array.from(driverCounts.entries())
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function getBenchmarkForKey(
  benchmarks: YieldBenchmarkRegistry | null | undefined,
  key: YieldBenchmarkKey,
): YieldBenchmarkMeta | null {
  return benchmarks?.[key] ?? null;
}

function getRankingBenchmarkLabel(
  ranking: YieldWorkbenchRanking,
  options: BuildYieldSourceBoardModelOptions,
): string | null {
  if (ranking.benchmarkLabel) {
    return getYieldBenchmarkDisplayLabel(ranking);
  }

  const key = ranking.benchmarkKey ?? "USD";
  const registryBenchmark = getBenchmarkForKey(options.benchmarks, key);
  if (registryBenchmark) return getYieldBenchmarkDisplayLabel(registryBenchmark);

  if (ranking.benchmarkKey || getYieldBenchmarkSelectionMode(ranking) || ranking.benchmarkIsFallback) {
    return getYieldBenchmarkDisplayLabel(ranking);
  }

  if (key === "USD" && options.fallbackBenchmark) {
    return getYieldBenchmarkDisplayLabel(options.fallbackBenchmark);
  }

  return null;
}

function getSourceRows(ranking: YieldWorkbenchRanking): SourceRow[] {
  const dataSource = getYieldWorkbenchDataSource(ranking);
  return [
    {
      kind: "selected",
      yieldType: ranking.yieldType,
      dataSource,
      yieldSource: ranking.yieldSource,
      apy30d: ranking.apy30d,
    },
    ...(isYieldRankingSummary(ranking) ? [] : ranking.altSources).map((source: AltYieldSource) => ({
      kind: "alternate" as const,
      yieldType: source.yieldType,
      dataSource: source.dataSource,
      yieldSource: source.yieldSource,
      apy30d: source.apy30d,
    })),
  ];
}

export function buildYieldSourceBoardModel(
  rankings: readonly YieldWorkbenchRanking[],
  options: BuildYieldSourceBoardModelOptions = {},
): YieldSourceBoardModel {
  const selectedConfidenceCounts = emptyConfidenceCounts();
  const depthCounts = emptyDepthCounts();
  const postureCounts = emptyPostureCounts();
  const benchmarkLabelCounts = new Map<string, number>();
  const sourceRiskDriverCounts = new Map<
    YieldSourceRiskDriver["key"],
    {
      label: string;
      count: number;
      description: string;
    }
  >();
  const groupMap = new Map<string, MutableGroup>();
  const sourceRowApyValues: number[] = [];
  const representedDataSources = new Set<string>();
  const sourceSwitchDetails: YieldSourceBoardSourceSwitchDetail[] = [];
  const anomalyDetails: YieldSourceBoardAnomalyDetail[] = [];

  let alternateCount = 0;
  let selectedConfidenceUnknownCount = 0;
  let sourceSwitchCount = 0;
  let anomalyCount = 0;

  for (const ranking of rankings) {
    alternateCount += getYieldAlternateSourceCount(ranking);

    const confidenceTier = ranking.provenance?.confidenceTier;
    if (confidenceTier) selectedConfidenceCounts[confidenceTier] += 1;
    else selectedConfidenceUnknownCount += 1;

    const sourceDepthLens = classifyYieldSourceDepth({
      sourceRisk: ranking.sourceRisk,
      sourceTvlUsd: ranking.sourceTvlUsd,
    });
    depthCounts[sourceDepthLens] += 1;
    postureCounts[
      classifyYieldSourcePosture({
        sourceRisk: ranking.sourceRisk,
        sourceTvlUsd: ranking.sourceTvlUsd,
        sourceDepthLens,
        sourceChanged: ranking.provenance?.sourceSwitch ?? false,
        sourceFreshness: ranking.provenance?.sourceFreshness,
        warningSignals: ranking.warningSignals,
      })
    ] += 1;

    for (const driver of getYieldSourceRiskDrivers({
      sourceRisk: ranking.sourceRisk,
      sourceChanged: ranking.provenance?.sourceSwitch ?? false,
      sourceFreshness: ranking.provenance?.sourceFreshness,
      warningSignals: ranking.warningSignals,
    })) {
      const existing = sourceRiskDriverCounts.get(driver.key);
      if (existing) existing.count += 1;
      else
        sourceRiskDriverCounts.set(driver.key, {
          label: driver.label,
          count: 1,
          description: driver.description,
        });
    }

    const yieldTypeLabel = YIELD_TYPE_LABELS[ranking.yieldType] ?? ranking.yieldType;
    const dataSourceLabel = getYieldDataSourceLabel(getYieldWorkbenchDataSource(ranking));

    if (ranking.provenance?.sourceSwitch) {
      sourceSwitchCount += 1;
      sourceSwitchDetails.push({
        id: ranking.id,
        symbol: ranking.symbol,
        name: ranking.name,
        yieldType: ranking.yieldType,
        yieldTypeLabel,
        dataSourceLabel,
        previousSourceKey: isYieldRankingSummary(ranking) ? null : (ranking.provenance.previousBestSourceKey ?? null),
        currentYieldSource: ranking.yieldSource,
      });
    }
    const anomalies = isYieldRankingSummary(ranking) ? [] : (ranking.provenance?.anomalies ?? []);
    if (anomalies.length > 0) {
      anomalyCount += 1;
      anomalyDetails.push({
        id: ranking.id,
        symbol: ranking.symbol,
        name: ranking.name,
        yieldType: ranking.yieldType,
        yieldTypeLabel,
        dataSourceLabel,
        anomalies,
      });
    }

    const benchmarkLabel = getRankingBenchmarkLabel(ranking, options);
    if (benchmarkLabel) addCount(benchmarkLabelCounts, benchmarkLabel);

    for (const sourceRow of getSourceRows(ranking)) {
      representedDataSources.add(sourceRow.dataSource);
      sourceRowApyValues.push(sourceRow.apy30d);

      const groupKey = `${sourceRow.yieldType}:${sourceRow.dataSource}`;
      let group = groupMap.get(groupKey);
      if (!group) {
        group = {
          key: groupKey,
          yieldType: sourceRow.yieldType,
          yieldTypeLabel: YIELD_TYPE_LABELS[sourceRow.yieldType] ?? sourceRow.yieldType,
          dataSource: sourceRow.dataSource,
          dataSourceLabel: getYieldDataSourceLabel(sourceRow.dataSource),
          selectedCount: 0,
          alternateCount: 0,
          apyValues: [],
          sourceLabelCounts: new Map<string, number>(),
        };
        groupMap.set(groupKey, group);
      }

      if (sourceRow.kind === "selected") group.selectedCount += 1;
      else group.alternateCount += 1;
      group.apyValues.push(sourceRow.apy30d);
      addCount(group.sourceLabelCounts, sourceRow.yieldSource);
    }
  }

  const groups = Array.from(groupMap.values())
    .map((group): YieldSourceBoardGroup => ({
      key: group.key,
      yieldType: group.yieldType,
      yieldTypeLabel: group.yieldTypeLabel,
      dataSource: group.dataSource,
      dataSourceLabel: group.dataSourceLabel,
      laneConfidenceTier: inferLaneConfidenceTier(group.dataSource),
      selectedCount: group.selectedCount,
      alternateCount: group.alternateCount,
      representedSourceCount: group.selectedCount + group.alternateCount,
      apy: summarizeApy(group.apyValues),
      sourceLabels: sortedLabelCounts(group.sourceLabelCounts),
    }))
    .sort(
      (a, b) =>
        b.representedSourceCount - a.representedSourceCount ||
        b.selectedCount - a.selectedCount ||
        a.dataSourceLabel.localeCompare(b.dataSourceLabel) ||
        a.yieldTypeLabel.localeCompare(b.yieldTypeLabel),
    );

  return {
    selectedCount: rankings.length,
    alternateCount,
    representedSourceCount: rankings.length + alternateCount,
    representedDataSourceCount: representedDataSources.size,
    selectedConfidenceCounts,
    selectedConfidenceUnknownCount,
    depthCounts,
    postureCounts,
    topSourceRiskDrivers: sortedRiskDriverCounts(sourceRiskDriverCounts).slice(0, 4),
    sourceSwitchCount,
    anomalyCount,
    sourceSwitchDetails,
    anomalyDetails,
    sourceRowApy: summarizeApy(sourceRowApyValues),
    benchmarkLabels: sortedLabelCounts(benchmarkLabelCounts),
    groups,
  };
}
