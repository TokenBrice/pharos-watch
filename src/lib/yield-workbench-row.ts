import { formatYieldDecisionReasonLine } from "@/lib/yield-decision-ledger";
import { YIELD_DECISION_REASON_LABELS } from "@/lib/yield-presentation";
import type { YieldBenchmarkSelectionMode, YieldRankChangeAttribution, YieldRanking } from "@shared/types/yield";
import type { YieldRankingSummary } from "@shared/types/yield-summary";

export type YieldWorkbenchRanking = YieldRanking | YieldRankingSummary;

export function isYieldRankingSummary(row: YieldWorkbenchRanking): row is YieldRankingSummary {
  return "alternateSourceCount" in row;
}

export function getYieldAlternateSourceCount(row: YieldWorkbenchRanking): number {
  return isYieldRankingSummary(row) ? row.alternateSourceCount : row.altSources.length;
}

export function getYieldAvailableSources(
  row: YieldWorkbenchRanking,
): Array<{ sourceKey: string; yieldSource: string }> {
  const selected = row.provenance?.sourceKey
    ? [{ sourceKey: row.provenance.sourceKey, yieldSource: row.yieldSource }]
    : [];
  if (isYieldRankingSummary(row)) return selected;
  return [
    ...selected,
    ...row.altSources.map((source) => ({
      sourceKey: source.sourceKey,
      yieldSource: source.yieldSource,
    })),
  ];
}

export function getYieldRankChangeAttribution(
  row: YieldWorkbenchRanking,
): YieldRankChangeAttribution | null | undefined {
  if (!isYieldRankingSummary(row)) return row.rankChangeAttribution;
  if (row.rankDelta === undefined && row.rankChangeDriver === undefined && row.rankPysDelta === undefined) {
    return undefined;
  }
  return {
    rankDelta: row.rankDelta,
    primaryDriver: row.rankChangeDriver,
    pysDelta: row.rankPysDelta,
  };
}

export function getYieldDecisionReasonLine(row: YieldWorkbenchRanking): string | null {
  if (!isYieldRankingSummary(row)) return formatYieldDecisionReasonLine(row.decisionLedger);
  return row.decisionReasonCode ? YIELD_DECISION_REASON_LABELS[row.decisionReasonCode] : null;
}

export function getYieldBenchmarkSelectionMode(row: YieldWorkbenchRanking): YieldBenchmarkSelectionMode | undefined {
  if (!isYieldRankingSummary(row)) return row.benchmarkSelectionMode;
  return row.benchmarkIsFallback ? "fallback-usd" : undefined;
}

export function isYieldBenchmarkFallback(row: YieldWorkbenchRanking): boolean {
  return getYieldBenchmarkSelectionMode(row) === "fallback-usd" || row.benchmarkIsFallback === true;
}

export function getYieldWorkbenchDataSource(row: YieldWorkbenchRanking): string {
  if (!isYieldRankingSummary(row)) return row.dataSource;
  switch (row.provenance?.calculationMode) {
    case "direct-read":
    case "exchange-rate-math":
      return "onchain";
    case "benchmark-model":
      return "rate-derived";
    case "price-return":
      return "price-derived";
    case "market-api":
      return row.provenance.confidenceTier === "discovered" ? "defillama-auto" : "protocol-api";
    default:
      return "unknown";
  }
}
