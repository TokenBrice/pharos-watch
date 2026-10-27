import { inferLaneConfidenceTier } from "@/lib/yield-source-board-model";
import { YIELD_DECISION_REJECTION_REASON_LABELS } from "@/lib/yield-presentation";
import {
  classifyYieldSourceDepth,
  getYieldSourceRiskDrivers,
  projectYieldSourceDisplayDrivers,
  type YieldSourceConfidenceTier,
  type YieldSourceDepthLens,
  type YieldSourceRiskDriver,
} from "@/lib/yield-source-risk";
import {
  getYieldSourceFreshnessDisplay,
  type YieldSourceClockInput,
  type YieldSourceDisplayClock,
  type YieldSourceFreshnessDisplay,
} from "@/lib/yield-source-presentation";
import { getYieldRowSourceClockInput } from "@/lib/yield-workbench-row";
import type { AltYieldSource, YieldDecisionRejectionReasonCode, YieldRanking, YieldType } from "@shared/types";

export interface YieldRejectionHint {
  code: YieldDecisionRejectionReasonCode;
  label: string;
  description: string;
}

export interface YieldSourceExplorerSource {
  sourceKey: string;
  label: string;
  displayLabel: string;
  url: string | null;
  yieldType: YieldType;
  apy30d: number;
  sourceTvlUsd: number | null;
  dataSource: string;
  confidenceTier: YieldSourceConfidenceTier | null;
  sourceRisk: YieldRanking["sourceRisk"];
  depthLens: YieldSourceDepthLens;
  /** Display-projected: scoring-only stale drivers stay hidden below the public gate. */
  sourceRiskDrivers: YieldSourceRiskDriver[];
  /** This source's own observation clock, for parent boundary scheduling. */
  clockInput: YieldSourceClockInput;
  freshness: YieldSourceFreshnessDisplay | null;
  isChosen: boolean;
}

export interface YieldSourceExplorerAlternate extends YieldSourceExplorerSource {
  rejectionHint: YieldRejectionHint | null;
}

export interface YieldSourceExplorerModel {
  selectedSource: YieldSourceExplorerSource;
  retainedAlternates: YieldSourceExplorerAlternate[];
  allSources: YieldSourceExplorerSource[];
  historySources: Array<{ sourceKey: string; yieldSource: string }>;
  sourceSwitch: {
    changed: boolean;
    previousSourceKey: string | null;
    previousSourceDisplayLabel: string | null;
  };
  sourceRiskDrivers: YieldSourceRiskDriver[];
  sourceDepthLens: YieldSourceDepthLens;
}

function selectedSourceKey(ranking: YieldRanking): string {
  return ranking.provenance?.sourceKey ?? "best";
}

function sourceUrl(source: Pick<AltYieldSource, "yieldSourceUrl">): string | null {
  return source.yieldSourceUrl ?? null;
}

const DISAMBIGUATOR_MAX_LENGTH = 16;
const DISAMBIGUATOR_SUFFIX_LENGTH = 8;

function formatDisambiguator(sourceKey: string): string {
  if (sourceKey.length <= DISAMBIGUATOR_MAX_LENGTH) return sourceKey;
  return `…${sourceKey.slice(-DISAMBIGUATOR_SUFFIX_LENGTH)}`;
}

function buildDisplayLabels(sources: Array<{ sourceKey: string; label: string }>): Map<string, string> {
  const counts = new Map<string, number>();
  for (const source of sources) {
    counts.set(source.label, (counts.get(source.label) ?? 0) + 1);
  }

  return new Map(
    sources.map((source) => [
      source.sourceKey,
      (counts.get(source.label) ?? 0) > 1
        ? `${source.label} (${formatDisambiguator(source.sourceKey)})`
        : source.label,
    ]),
  );
}

/** Selected then alternate source clocks, each with its own identity and observation age. */
export function getYieldRankingSourceClockInputs(ranking: YieldRanking): YieldSourceClockInput[] {
  return [
    { ...getYieldRowSourceClockInput(ranking), sourceKey: selectedSourceKey(ranking) },
    ...ranking.altSources.map((source) => ({
      dataSource: source.dataSource,
      sourceKey: source.sourceKey,
      sourceAgeSeconds: source.sourceRisk?.sourceAgeSeconds ?? null,
    })),
  ];
}

export function buildYieldSourceExplorerModel(
  ranking: YieldRanking,
  clock?: YieldSourceDisplayClock | null,
): YieldSourceExplorerModel {
  const selectedKey = selectedSourceKey(ranking);
  const clockInputs = getYieldRankingSourceClockInputs(ranking);
  const sourceRows = [
    {
      sourceKey: selectedKey,
      label: ranking.yieldSource,
      url: ranking.yieldSourceUrl ?? null,
      yieldType: ranking.yieldType,
      apy30d: ranking.apy30d,
      sourceTvlUsd: ranking.sourceTvlUsd,
      dataSource: ranking.dataSource,
      confidenceTier: ranking.provenance?.confidenceTier ?? inferLaneConfidenceTier(ranking.dataSource),
      sourceRisk: ranking.sourceRisk ?? null,
      clockInput: clockInputs[0]!,
      isChosen: true,
      rejectionReasonCode: undefined,
    },
    ...ranking.altSources.map((source, index) => ({
      sourceKey: source.sourceKey,
      label: source.yieldSource,
      url: sourceUrl(source),
      yieldType: source.yieldType,
      apy30d: source.apy30d,
      sourceTvlUsd: source.sourceTvlUsd,
      dataSource: source.dataSource,
      confidenceTier: source.confidenceTier ?? inferLaneConfidenceTier(source.dataSource),
      sourceRisk: source.sourceRisk ?? null,
      clockInput: clockInputs[index + 1]!,
      isChosen: false,
      rejectionReasonCode: source.rejectionReasonCode,
    })),
  ];
  const displayLabels = buildDisplayLabels(sourceRows);
  const allSources = sourceRows.map((source) => {
    const sourceChanged = source.isChosen ? ranking.provenance?.sourceSwitch ?? false : false;
    const freshness = getYieldSourceFreshnessDisplay({ ...source.clockInput, clock });
    return {
      ...source,
      freshness,
      displayLabel: displayLabels.get(source.sourceKey) ?? source.label,
      depthLens: classifyYieldSourceDepth({
        sourceRisk: source.sourceRisk,
        sourceTvlUsd: source.sourceTvlUsd,
      }),
      sourceRiskDrivers: projectYieldSourceDisplayDrivers(getYieldSourceRiskDrivers({
        sourceRisk: source.sourceRisk,
        sourceChanged,
        sourceFreshness: source.isChosen ? ranking.provenance?.sourceFreshness : undefined,
        warningSignals: source.isChosen ? ranking.warningSignals : undefined,
      }), freshness?.status === "stale"),
    };
  });
  const selectedSource = allSources[0]!;
  const previousSourceKey = ranking.provenance?.previousBestSourceKey ?? null;
  const previousSource = previousSourceKey
    ? allSources.find((source) => source.sourceKey === previousSourceKey)
    : null;

  const retainedAlternates: YieldSourceExplorerAlternate[] = allSources
    .filter((source) => !source.isChosen)
    .map((source) => ({
      ...source,
      rejectionHint: source.rejectionReasonCode && source.rejectionReasonCode !== "unspecified"
        ? {
          code: source.rejectionReasonCode,
          label: YIELD_DECISION_REJECTION_REASON_LABELS[source.rejectionReasonCode],
          description: YIELD_DECISION_REJECTION_REASON_LABELS[source.rejectionReasonCode],
        }
        : null,
    }));

  return {
    selectedSource,
    retainedAlternates,
    allSources,
    historySources: allSources.map((source) => ({
      sourceKey: source.sourceKey,
      yieldSource: source.displayLabel,
    })),
    sourceSwitch: {
      changed: ranking.provenance?.sourceSwitch ?? false,
      previousSourceKey,
      previousSourceDisplayLabel: previousSource?.displayLabel ?? (previousSourceKey ? "previous source (not retained)" : null),
    },
    sourceRiskDrivers: selectedSource.sourceRiskDrivers,
    sourceDepthLens: selectedSource.depthLens,
  };
}
