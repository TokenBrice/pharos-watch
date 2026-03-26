import type { YieldBenchmarkMeta, YieldSourceInputMeta } from "@shared/types/yield";
import { buildSelectionReason, type EvaluatedYieldSource } from "./evaluation";

export function buildYieldSourceProvenance(params: {
  source: EvaluatedYieldSource;
  isBest: boolean;
  evaluatedSources: EvaluatedYieldSource[];
  startSec: number;
  riskFreeRateMeta: YieldBenchmarkMeta;
  dlPoolsMeta: YieldSourceInputMeta;
}): Record<string, unknown> {
  const { source, isBest, evaluatedSources, startSec, riskFreeRateMeta, dlPoolsMeta } = params;

  const sourceObservedAt =
    source.sourceObservedAt
    ?? (source.dataSource === "defillama" || source.dataSource === "defillama-auto"
      ? (dlPoolsMeta.updatedAt ?? startSec)
      : source.dataSource === "rate-derived"
        ? (riskFreeRateMeta.fetchedAt ?? startSec)
        : startSec);
  const sourceAgeSeconds =
    source.dataSource === "defillama" || source.dataSource === "defillama-auto"
      ? (dlPoolsMeta.ageSeconds ?? Math.max(0, startSec - sourceObservedAt))
      : source.dataSource === "rate-derived"
        ? (riskFreeRateMeta.ageSeconds ?? Math.max(0, startSec - sourceObservedAt))
        : Math.max(0, startSec - sourceObservedAt);
  const comparisonAnchorObservedAt = source.comparisonAnchorObservedAt ?? null;
  const comparisonAnchorAgeSeconds =
    comparisonAnchorObservedAt != null ? Math.max(0, startSec - comparisonAnchorObservedAt) : null;
  const rejectedPeers = evaluatedSources.filter((candidate) => candidate.id === source.id && candidate.rejected).length;

  return {
    sourceKey: source.sourceKey,
    sourceObservedAt,
    sourceAgeSeconds,
    comparisonAnchorObservedAt,
    comparisonAnchorAgeSeconds,
    confidenceTier: source.confidenceTier,
    selectionMethod: "confidence-weighted",
    selectionReason: isBest
      ? buildSelectionReason(source, rejectedPeers)
      : "Alternative source retained for comparison",
    sourceSwitch:
      isBest &&
      source.previousBestSourceKey != null &&
      source.previousBestSourceKey !== "legacy-best" &&
      source.previousBestSourceKey !== source.sourceKey,
    previousBestSourceKey:
      source.previousBestSourceKey != null && source.previousBestSourceKey !== "legacy-best"
        ? source.previousBestSourceKey
        : null,
    usedLegacyHistory: source.usedLegacyHistory,
    usedDefaultSafety: source.usedDefaultSafety,
    benchmarkRecordDate: riskFreeRateMeta.recordDate,
    benchmarkIsFallback: riskFreeRateMeta.isFallback,
    benchmarkFallbackMode: riskFreeRateMeta.fallbackMode,
    anomalies: source.anomalies,
  };
}
