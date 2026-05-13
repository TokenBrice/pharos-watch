import {
  classifyYieldSourceDepth,
  getYieldSourceRiskDrivers,
  type YieldSourceDepthLens,
  type YieldSourceRiskDriver,
} from "@/lib/yield-source-risk";
import type { AltYieldSource, YieldRanking, YieldType } from "@shared/types";

export interface YieldSourceExplorerSource {
  sourceKey: string;
  label: string;
  displayLabel: string;
  url: string | null;
  yieldType: YieldType;
  currentApy: number;
  apy30d: number;
  sourceTvlUsd: number | null;
  dataSource: string;
  sourceRisk: YieldRanking["sourceRisk"];
  depthLens: YieldSourceDepthLens;
  sourceRiskDrivers: YieldSourceRiskDriver[];
  isChosen: boolean;
}

export interface YieldSourceExplorerModel {
  selectedSource: YieldSourceExplorerSource;
  retainedAlternates: YieldSourceExplorerSource[];
  allSources: YieldSourceExplorerSource[];
  historySources: Array<{ sourceKey: string; yieldSource: string }>;
  sourceIdentity: {
    sourceKey: string;
    label: string;
    displayLabel: string;
    url: string | null;
  };
  sourceSwitch: {
    changed: boolean;
    previousSourceKey: string | null;
    previousSourceLabel: string | null;
    previousSourceDisplayLabel: string | null;
  };
  sourceRiskDrivers: YieldSourceRiskDriver[];
  sourceDepthLens: YieldSourceDepthLens;
  benchmarkContext: {
    key: YieldRanking["benchmarkKey"] | null;
    label: string | null;
    rate: number | null;
    isFallback: boolean;
    fallbackMode: string | null;
    selectionMode: YieldRanking["benchmarkSelectionMode"] | null;
  };
}

function selectedSourceKey(ranking: YieldRanking): string {
  return ranking.provenance?.sourceKey ?? "best";
}

function sourceUrl(source: Pick<AltYieldSource, "yieldSourceUrl">): string | null {
  return source.yieldSourceUrl ?? null;
}

function buildDisplayLabels(sources: Array<{ sourceKey: string; label: string }>): Map<string, string> {
  const counts = new Map<string, number>();
  for (const source of sources) {
    counts.set(source.label, (counts.get(source.label) ?? 0) + 1);
  }

  return new Map(
    sources.map((source) => [
      source.sourceKey,
      (counts.get(source.label) ?? 0) > 1 ? `${source.label} (${source.sourceKey})` : source.label,
    ]),
  );
}

export function buildYieldSourceExplorerModel(ranking: YieldRanking): YieldSourceExplorerModel {
  const selectedKey = selectedSourceKey(ranking);
  const sourceRows = [
    {
      sourceKey: selectedKey,
      label: ranking.yieldSource,
      url: ranking.yieldSourceUrl ?? null,
      yieldType: ranking.yieldType,
      currentApy: ranking.currentApy,
      apy30d: ranking.apy30d,
      sourceTvlUsd: ranking.sourceTvlUsd,
      dataSource: ranking.dataSource,
      sourceRisk: ranking.sourceRisk ?? null,
      isChosen: true,
    },
    ...ranking.altSources.map((source) => ({
      sourceKey: source.sourceKey,
      label: source.yieldSource,
      url: sourceUrl(source),
      yieldType: source.yieldType,
      currentApy: source.currentApy,
      apy30d: source.apy30d,
      sourceTvlUsd: source.sourceTvlUsd,
      dataSource: source.dataSource,
      sourceRisk: source.sourceRisk ?? null,
      isChosen: false,
    })),
  ];
  const displayLabels = buildDisplayLabels(sourceRows);
  const allSources = sourceRows.map((source) => {
    const sourceChanged = source.isChosen ? ranking.provenance?.sourceSwitch ?? false : false;
    return {
      ...source,
      displayLabel: displayLabels.get(source.sourceKey) ?? source.label,
      depthLens: classifyYieldSourceDepth({
        sourceRisk: source.sourceRisk,
        sourceTvlUsd: source.sourceTvlUsd,
      }),
      sourceRiskDrivers: getYieldSourceRiskDrivers({
        sourceRisk: source.sourceRisk,
        sourceChanged,
      }),
    };
  });
  const selectedSource = allSources[0]!;
  const previousSourceKey = ranking.provenance?.previousBestSourceKey ?? null;
  const previousSource = previousSourceKey
    ? allSources.find((source) => source.sourceKey === previousSourceKey)
    : null;

  return {
    selectedSource,
    retainedAlternates: allSources.filter((source) => !source.isChosen),
    allSources,
    historySources: allSources.map((source) => ({
      sourceKey: source.sourceKey,
      yieldSource: source.displayLabel,
    })),
    sourceIdentity: {
      sourceKey: selectedSource.sourceKey,
      label: selectedSource.label,
      displayLabel: selectedSource.displayLabel,
      url: selectedSource.url,
    },
    sourceSwitch: {
      changed: ranking.provenance?.sourceSwitch ?? false,
      previousSourceKey,
      previousSourceLabel: previousSource?.label ?? previousSourceKey,
      previousSourceDisplayLabel: previousSource?.displayLabel ?? previousSourceKey,
    },
    sourceRiskDrivers: selectedSource.sourceRiskDrivers,
    sourceDepthLens: selectedSource.depthLens,
    benchmarkContext: {
      key: ranking.benchmarkKey ?? null,
      label: ranking.benchmarkLabel ?? null,
      rate: ranking.benchmarkRate ?? null,
      isFallback: ranking.benchmarkSelectionMode === "fallback-usd" || !!ranking.benchmarkIsFallback,
      fallbackMode: ranking.benchmarkFallbackMode ?? null,
      selectionMode: ranking.benchmarkSelectionMode ?? null,
    },
  };
}
