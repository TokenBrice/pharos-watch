import { inferLaneConfidenceTier } from "@/lib/yield-source-board-model";
import {
  YIELD_SOURCE_CONFIDENCE_ORDER,
  classifyYieldSourceDepth,
  getYieldSourceRiskDrivers,
  type YieldSourceConfidenceTier,
  type YieldSourceDepthLens,
  type YieldSourceRiskDriver,
} from "@/lib/yield-source-risk";
import { numberValue as finiteNumber } from "@shared/lib/type-guards";
import type { AltYieldSource, YieldRanking, YieldType } from "@shared/types";

export type YieldRejectionHintCode =
  | "thinner"
  | "stale"
  | "rewards-only"
  | "lower-conf"
  | "smaller";

export interface YieldRejectionHint {
  code: YieldRejectionHintCode;
  label: string;
  description: string;
}

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
  confidenceTier: YieldSourceConfidenceTier | null;
  sourceRisk: YieldRanking["sourceRisk"];
  depthLens: YieldSourceDepthLens;
  sourceRiskDrivers: YieldSourceRiskDriver[];
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

const REJECTION_HINT_DESCRIPTIONS: Record<YieldRejectionHintCode, string> = {
  thinner: "Lower venue depth than the chosen source.",
  stale: "Older observation than the chosen source.",
  "rewards-only": "Most APY comes from incentives, not base yield.",
  "lower-conf": "Inferred confidence is lower than the chosen source.",
  smaller: "Smaller venue TVL than the chosen source.",
};

function confidenceTierRank(tier: YieldSourceConfidenceTier | null): number {
  if (!tier) return YIELD_SOURCE_CONFIDENCE_ORDER.length;
  const index = YIELD_SOURCE_CONFIDENCE_ORDER.indexOf(tier);
  return index === -1 ? YIELD_SOURCE_CONFIDENCE_ORDER.length : index;
}

function buildRejectionHint(
  alternate: YieldSourceExplorerSource,
  selected: YieldSourceExplorerSource,
): YieldRejectionHint | null {
  const altDepth = finiteNumber(alternate.sourceRisk?.sourceDepthRatio);
  const selDepth = finiteNumber(selected.sourceRisk?.sourceDepthRatio);
  if (altDepth !== null && selDepth !== null && altDepth > 0 && selDepth >= altDepth * 5) {
    return { code: "thinner", label: "thinner", description: REJECTION_HINT_DESCRIPTIONS.thinner };
  }

  const altAge = finiteNumber(alternate.sourceRisk?.sourceAgeSeconds);
  const selAge = finiteNumber(selected.sourceRisk?.sourceAgeSeconds);
  if (altAge !== null && selAge !== null && selAge > 0 && altAge >= selAge * 2) {
    return { code: "stale", label: "stale", description: REJECTION_HINT_DESCRIPTIONS.stale };
  }

  const altRewardShare = finiteNumber(alternate.sourceRisk?.rewardShare);
  if (altRewardShare !== null && altRewardShare > 0.5) {
    return {
      code: "rewards-only",
      label: "rewards-only",
      description: REJECTION_HINT_DESCRIPTIONS["rewards-only"],
    };
  }

  const altTier = inferLaneConfidenceTier(alternate.dataSource);
  const selTier = inferLaneConfidenceTier(selected.dataSource);
  if (altTier && selTier && confidenceTierRank(altTier) > confidenceTierRank(selTier)) {
    return {
      code: "lower-conf",
      label: "lower-conf",
      description: REJECTION_HINT_DESCRIPTIONS["lower-conf"],
    };
  }

  const altTvl = finiteNumber(alternate.sourceTvlUsd);
  const selTvl = finiteNumber(selected.sourceTvlUsd);
  if (altTvl !== null && selTvl !== null && altTvl > 0 && selTvl >= altTvl * 5) {
    return { code: "smaller", label: "smaller", description: REJECTION_HINT_DESCRIPTIONS.smaller };
  }

  return null;
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
      confidenceTier: ranking.provenance?.confidenceTier ?? inferLaneConfidenceTier(ranking.dataSource),
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
      confidenceTier: inferLaneConfidenceTier(source.dataSource),
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
        sourceFreshness: source.isChosen ? ranking.provenance?.sourceFreshness : undefined,
        warningSignals: source.isChosen ? ranking.warningSignals : undefined,
      }),
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
      rejectionHint: buildRejectionHint(source, selectedSource),
    }));

  return {
    selectedSource,
    retainedAlternates,
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
