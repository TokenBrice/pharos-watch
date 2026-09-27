import type { YieldSourceInputMeta } from "@shared/types/yield";
import { getRankingStaleThresholdMs } from "../../lib/yield-ranking-helpers";
import {
  isRealSourceSwitch,
  LEGACY_BEST_YIELD_SOURCE_KEY,
} from "../../lib/yield-history-ownership-handoffs";
import { buildSelectionReason, type EvaluatedYieldSource } from "./evaluation";

export function buildYieldSourceProvenance(params: {
  source: EvaluatedYieldSource;
  isBest: boolean;
  evaluatedSources: EvaluatedYieldSource[];
  startSec: number;
  dlPoolsMeta: YieldSourceInputMeta;
}): Record<string, unknown> {
  const { source, isBest, evaluatedSources, startSec, dlPoolsMeta } = params;

  const sourceObservedAt =
    source.sourceObservedAt
    ?? (source.dataSource === "defillama" || source.dataSource === "defillama-auto"
      ? (dlPoolsMeta.updatedAt ?? (dlPoolsMeta.ageSeconds != null ? startSec - dlPoolsMeta.ageSeconds : null))
      : source.dataSource === "rate-derived"
        ? null
        : startSec);
  // A source-local market print is authoritative over a family fetch age.
  const sourceAgeSeconds = sourceObservedAt != null ? Math.max(0, startSec - sourceObservedAt) : null;
  const comparisonAnchorObservedAt = source.comparisonAnchorObservedAt ?? null;
  const comparisonAnchorAgeSeconds =
    comparisonAnchorObservedAt != null ? Math.max(0, startSec - comparisonAnchorObservedAt) : null;
  const rejectedPeers = evaluatedSources.filter((candidate) => candidate.id === source.id && candidate.rejected).length;

  return {
    sourceKey: source.sourceKey,
    sourceObservedAt,
    sourceAgeSeconds,
    sourceMaxAgeSeconds: getRankingStaleThresholdMs(source.dataSource, source.sourceKey) / 1000,
    comparisonAnchorObservedAt,
    comparisonAnchorAgeSeconds,
    confidenceTier: source.confidenceTier,
    calculationMode: source.calculationMode,
    evidenceClass: source.evidenceClass,
    evidenceCompleteness: source.evidenceCompleteness,
    scoreQualification: source.scoreQualification,
    selectionMethod: "confidence-weighted",
    selectionReason: isBest
      ? buildSelectionReason(source, rejectedPeers)
      : "Alternative source retained for comparison",
    sourceSwitch: isBest && isRealSourceSwitch(source.previousBestSourceKey, source.sourceKey),
    previousBestSourceKey:
      source.previousBestSourceKey != null &&
      source.previousBestSourceKey !== LEGACY_BEST_YIELD_SOURCE_KEY
        ? source.previousBestSourceKey
        : null,
    usedLegacyHistory: source.usedLegacyHistory,
    usedDefaultSafety: source.usedDefaultSafety,
    safetyReason: source.safetyReason,
    safetyScoreIdentity: source.safetyScoreIdentity ?? null,
    benchmarkKey: source.benchmarkKey,
    benchmarkLabel: source.benchmarkLabel,
    benchmarkCurrency: source.benchmarkCurrency,
    benchmarkRate: source.benchmarkRate,
    benchmarkRecordDate: source.benchmarkRecordDate,
    benchmarkIsFallback: source.benchmarkIsFallback,
    benchmarkFallbackMode: source.benchmarkFallbackMode,
    benchmarkSelectionMode: source.benchmarkSelectionMode,
    benchmarkIsProxy: source.benchmarkIsProxy,
    sourceFreshness: source.sourceFreshness,
    benchmarkFreshness: source.benchmarkFreshness,
    scoreQualified: source.scoreQualified,
    anomalies: source.anomalies,
  };
}
