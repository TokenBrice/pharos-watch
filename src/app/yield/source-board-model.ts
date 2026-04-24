import { getYieldBenchmarkDisplayLabel } from "@/lib/yield-benchmark";
import { YIELD_TYPE_LABELS } from "@shared/lib/classification";
import type {
  AltYieldSource,
  YieldBenchmarkKey,
  YieldBenchmarkMeta,
  YieldBenchmarkRegistry,
  YieldRanking,
  YieldType,
} from "@shared/types";

export type YieldSourceConfidenceTier = NonNullable<YieldRanking["provenance"]>["confidenceTier"];

export const YIELD_SOURCE_CONFIDENCE_ORDER: readonly YieldSourceConfidenceTier[] = [
  "deterministic",
  "curated",
  "discovered",
  "fallback",
];

export type YieldSourceConfidenceCounts = Record<YieldSourceConfidenceTier, number>;

export interface YieldSourceBoardApySummary {
  min: number;
  median: number;
  max: number;
}

export interface YieldSourceBoardLabelCount {
  label: string;
  count: number;
}

export interface YieldSourceBoardGroup {
  key: string;
  yieldType: YieldType;
  yieldTypeLabel: string;
  dataSource: string;
  dataSourceLabel: string;
  selectedCount: number;
  alternateCount: number;
  representedSourceCount: number;
  apy: YieldSourceBoardApySummary | null;
  sourceLabels: YieldSourceBoardLabelCount[];
}

export interface YieldSourceBoardModel {
  selectedCount: number;
  alternateCount: number;
  representedSourceCount: number;
  representedDataSourceCount: number;
  selectedConfidenceCounts: YieldSourceConfidenceCounts;
  selectedConfidenceUnknownCount: number;
  sourceSwitchCount: number;
  anomalyCount: number;
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

function formatDataSourceLabel(dataSource: string): string {
  switch (dataSource) {
    case "defillama":
      return "DeFiLlama";
    case "defillama-auto":
      return "DeFiLlama auto";
    case "onchain":
      return "On-chain";
    case "price-derived":
      return "Price-derived";
    case "protocol-api":
      return "Protocol API";
    case "rate-derived":
      return "Rate-derived";
    default:
      return dataSource
        .split(/[-_\s]+/u)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ") || "Unknown";
  }
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

function getBenchmarkForKey(
  benchmarks: YieldBenchmarkRegistry | null | undefined,
  key: YieldBenchmarkKey,
): YieldBenchmarkMeta | null {
  return benchmarks?.[key] ?? null;
}

function getRankingBenchmarkLabel(
  ranking: YieldRanking,
  options: BuildYieldSourceBoardModelOptions,
): string | null {
  if (ranking.benchmarkLabel) {
    return getYieldBenchmarkDisplayLabel(ranking);
  }

  const key = ranking.benchmarkKey ?? "USD";
  const registryBenchmark = getBenchmarkForKey(options.benchmarks, key);
  if (registryBenchmark) return getYieldBenchmarkDisplayLabel(registryBenchmark);

  if (ranking.benchmarkKey || ranking.benchmarkSelectionMode || ranking.benchmarkIsFallback) {
    return getYieldBenchmarkDisplayLabel(ranking);
  }

  if (key === "USD" && options.fallbackBenchmark) {
    return getYieldBenchmarkDisplayLabel(options.fallbackBenchmark);
  }

  return null;
}

function getSourceRows(ranking: YieldRanking): SourceRow[] {
  return [
    {
      kind: "selected",
      yieldType: ranking.yieldType,
      dataSource: ranking.dataSource,
      yieldSource: ranking.yieldSource,
      apy30d: ranking.apy30d,
    },
    ...(ranking.altSources ?? []).map((source: AltYieldSource) => ({
      kind: "alternate" as const,
      yieldType: source.yieldType,
      dataSource: source.dataSource,
      yieldSource: source.yieldSource,
      apy30d: source.apy30d,
    })),
  ];
}

export function buildYieldSourceBoardModel(
  rankings: readonly YieldRanking[],
  options: BuildYieldSourceBoardModelOptions = {},
): YieldSourceBoardModel {
  const selectedConfidenceCounts = emptyConfidenceCounts();
  const benchmarkLabelCounts = new Map<string, number>();
  const groupMap = new Map<string, MutableGroup>();
  const sourceRowApyValues: number[] = [];
  const representedDataSources = new Set<string>();

  let alternateCount = 0;
  let selectedConfidenceUnknownCount = 0;
  let sourceSwitchCount = 0;
  let anomalyCount = 0;

  for (const ranking of rankings) {
    const altSources = ranking.altSources ?? [];
    alternateCount += altSources.length;

    const confidenceTier = ranking.provenance?.confidenceTier;
    if (confidenceTier) selectedConfidenceCounts[confidenceTier] += 1;
    else selectedConfidenceUnknownCount += 1;

    if (ranking.provenance?.sourceSwitch) sourceSwitchCount += 1;
    if ((ranking.provenance?.anomalies?.length ?? 0) > 0) anomalyCount += 1;

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
          dataSourceLabel: formatDataSourceLabel(sourceRow.dataSource),
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
    sourceSwitchCount,
    anomalyCount,
    sourceRowApy: summarizeApy(sourceRowApyValues),
    benchmarkLabels: sortedLabelCounts(benchmarkLabelCounts),
    groups,
  };
}
