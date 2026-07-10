import type { YieldBenchmarkMeta, YieldSourceInputMeta } from "@shared/types/yield";
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
  const benchmarkMeta: YieldBenchmarkMeta = source.benchmarkMeta;

  const sourceObservedAt =
    source.sourceObservedAt
    ?? (source.dataSource === "defillama" || source.dataSource === "defillama-auto"
      ? (dlPoolsMeta.updatedAt ?? startSec)
      : source.dataSource === "rate-derived"
        ? (benchmarkMeta.fetchedAt ?? startSec)
        : startSec);
  const sourceAgeSeconds =
    source.dataSource === "defillama" || source.dataSource === "defillama-auto"
      ? (dlPoolsMeta.ageSeconds ?? Math.max(0, startSec - sourceObservedAt))
      : source.dataSource === "rate-derived"
        ? (benchmarkMeta.ageSeconds ?? Math.max(0, startSec - sourceObservedAt))
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
    sourceSwitch: isBest && isRealSourceSwitch(source.previousBestSourceKey, source.sourceKey),
    previousBestSourceKey:
      source.previousBestSourceKey != null &&
      source.previousBestSourceKey !== LEGACY_BEST_YIELD_SOURCE_KEY
        ? source.previousBestSourceKey
        : null,
    usedLegacyHistory: source.usedLegacyHistory,
    usedDefaultSafety: source.usedDefaultSafety,
    safetyReason: source.safetyReason,
    benchmarkKey: source.benchmarkKey,
    benchmarkLabel: source.benchmarkLabel,
    benchmarkCurrency: source.benchmarkCurrency,
    benchmarkRate: source.benchmarkRate,
    benchmarkRecordDate: source.benchmarkRecordDate,
    benchmarkIsFallback: source.benchmarkIsFallback,
    benchmarkFallbackMode: source.benchmarkFallbackMode,
    benchmarkSelectionMode: source.benchmarkSelectionMode,
    benchmarkIsProxy: source.benchmarkIsProxy,
    anomalies: source.anomalies,
  };
}
