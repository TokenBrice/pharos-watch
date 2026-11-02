import { getYieldDataSourceLabel } from "@/lib/yield-data-source";
import {
  classifyYieldSourceDepth,
  classifyYieldSourcePosture,
  getYieldSourceRiskDrivers,
  isYieldSourceDisplayStale,
  isYieldSourcePostureScoringWindowOnly,
  projectYieldSourceDisplayDrivers,
  type YieldSourceConfidenceTier,
  type YieldSourceDepthLens,
  type YieldSourcePosture,
  type YieldSourceRiskDriver,
} from "@/lib/yield-source-risk";
import { YIELD_TYPE_LABELS } from "@shared/lib/classification";
import type { YieldSourceDisplayClock } from "@/lib/yield-source-presentation";
import {
  getYieldAlternateSourceCount,
  getYieldRowSourceClockInput,
  getYieldWorkbenchDataSource,
  isYieldRankingSummary,
  type YieldWorkbenchRanking,
} from "@/lib/yield-workbench-row";
import type { YieldType } from "@shared/types";

export type YieldSourceConfidenceCounts = Record<YieldSourceConfidenceTier, number>;
export type YieldSourceDepthCounts = Record<YieldSourceDepthLens, number>;
export type YieldSourcePostureCounts = Record<YieldSourcePosture, number>;

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
  compositionMissingSourceCount: number;
  selectedConfidenceCounts: YieldSourceConfidenceCounts;
  selectedConfidenceUnknownCount: number;
  depthCounts: YieldSourceDepthCounts;
  postureCounts: YieldSourcePostureCounts;
  /** Speculative rows whose posture rests only on the scoring window (subset, not a bucket). */
  speculativeScoringWindowCount: number;
  topSourceRiskDrivers: YieldSourceBoardRiskDriverCount[];
  sourceSwitchCount: number;
  anomalyCount: number;
  anomalyUnavailableCount: number;
  sourceSwitchDetails: YieldSourceBoardSourceSwitchDetail[];
  anomalyDetails: YieldSourceBoardAnomalyDetail[];
  groups: YieldSourceBoardGroup[];
}

interface SourceRow {
  kind: "selected" | "alternate";
  yieldType: YieldType;
  dataSource: string;
  yieldSource: string;
}

interface MutableGroup {
  key: string;
  yieldType: YieldType;
  yieldTypeLabel: string;
  dataSource: string;
  dataSourceLabel: string;
  selectedCount: number;
  alternateCount: number;
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

function sortedLabelCounts(labelCounts: Map<string, number>): YieldSourceBoardLabelCount[] {
  return Array.from(labelCounts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function sortedRiskDriverCounts(
  driverCounts: Map<string, { key: YieldSourceRiskDriver["key"]; label: string; count: number; description: string }>,
): YieldSourceBoardRiskDriverCount[] {
  return Array.from(driverCounts.values())
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function getSourceRows(ranking: YieldWorkbenchRanking): SourceRow[] {
  const dataSource = getYieldWorkbenchDataSource(ranking);
  return [
    {
      kind: "selected",
      yieldType: ranking.yieldType,
      dataSource,
      yieldSource: ranking.yieldSource,
    },
    ...(ranking.altSources ?? []).flatMap((source) =>
      source.yieldType != null && source.yieldSource != null && source.apy30d != null
        ? [{
          kind: "alternate" as const,
          yieldType: source.yieldType,
          dataSource: source.dataSource,
          yieldSource: source.yieldSource,
        }]
        : [],
    ),
  ];
}

export function buildYieldSourceBoardModel(
  rankings: readonly YieldWorkbenchRanking[],
  clock?: YieldSourceDisplayClock | null,
): YieldSourceBoardModel {
  const selectedConfidenceCounts = emptyConfidenceCounts();
  const depthCounts = emptyDepthCounts();
  const postureCounts = emptyPostureCounts();
  const sourceRiskDriverCounts = new Map<
    string,
    {
      key: YieldSourceRiskDriver["key"];
      label: string;
      count: number;
      description: string;
    }
  >();
  const groupMap = new Map<string, MutableGroup>();
  const sourceSwitchDetails: YieldSourceBoardSourceSwitchDetail[] = [];
  const anomalyDetails: YieldSourceBoardAnomalyDetail[] = [];

  let alternateCount = 0;
  let selectedConfidenceUnknownCount = 0;
  let sourceSwitchCount = 0;
  let anomalyCount = 0;
  let compositionMissingSourceCount = 0;
  let anomalyUnavailableCount = 0;
  let speculativeScoringWindowCount = 0;

  for (const ranking of rankings) {
    alternateCount += getYieldAlternateSourceCount(ranking);
    const sourceRows = getSourceRows(ranking);
    compositionMissingSourceCount += Math.max(0, getYieldAlternateSourceCount(ranking) - (sourceRows.length - 1));

    const confidenceTier = ranking.provenance?.confidenceTier;
    if (confidenceTier) selectedConfidenceCounts[confidenceTier] += 1;
    else selectedConfidenceUnknownCount += 1;

    const sourceDepthLens = classifyYieldSourceDepth({
      sourceRisk: ranking.sourceRisk,
      sourceTvlUsd: ranking.sourceTvlUsd,
    });
    depthCounts[sourceDepthLens] += 1;
    const postureInput = {
      sourceRisk: ranking.sourceRisk,
      sourceTvlUsd: ranking.sourceTvlUsd,
      sourceDepthLens,
      sourceChanged: ranking.provenance?.sourceSwitch ?? false,
      sourceFreshness: ranking.provenance?.sourceFreshness,
      warningSignals: ranking.warningSignals,
    };
    const posture = classifyYieldSourcePosture(postureInput);
    postureCounts[posture] += 1;
    const displayStale = isYieldSourceDisplayStale(getYieldRowSourceClockInput(ranking), clock);
    if (isYieldSourcePostureScoringWindowOnly(postureInput, posture, displayStale)) speculativeScoringWindowCount += 1;

    // Display drivers are projected before the top-N cut, so a suppressed
    // scoring-only stale driver never occupies a visible slot. The aggregate is
    // keyed by the full driver text: a same-key chip carries one row's
    // ecosystem or venue evidence, so it must never absorb another row's count.
    for (const driver of projectYieldSourceDisplayDrivers(getYieldSourceRiskDrivers(postureInput), displayStale)) {
      const driverKey = `${driver.key}|${driver.label}|${driver.description}`;
      const existing = sourceRiskDriverCounts.get(driverKey);
      if (existing) existing.count += 1;
      else
        sourceRiskDriverCounts.set(driverKey, {
          key: driver.key,
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
    const anomalies = ranking.provenance?.anomalies;
    if (anomalies == null) anomalyUnavailableCount += 1;
    if (anomalies && anomalies.length > 0) {
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

    for (const sourceRow of sourceRows) {
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
          sourceLabelCounts: new Map<string, number>(),
        };
        groupMap.set(groupKey, group);
      }

      if (sourceRow.kind === "selected") group.selectedCount += 1;
      else group.alternateCount += 1;
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
    compositionMissingSourceCount,
    selectedConfidenceCounts,
    selectedConfidenceUnknownCount,
    depthCounts,
    postureCounts,
    speculativeScoringWindowCount,
    topSourceRiskDrivers: sortedRiskDriverCounts(sourceRiskDriverCounts).slice(0, 4),
    sourceSwitchCount,
    anomalyCount,
    anomalyUnavailableCount,
    sourceSwitchDetails,
    anomalyDetails,
    groups,
  };
}
