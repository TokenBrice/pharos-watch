import { getYieldBenchmarkReferenceText } from "@/lib/yield-benchmark";
import { formatYieldDecisionReasonLine } from "@/lib/yield-decision-ledger";
import {
  PYS_NULL_REASON_TEXT,
  YIELD_DECISION_REASON_LABELS,
  buildRankChangeChipDisplay,
} from "@/lib/yield-presentation";
import {
  YIELD_SOURCE_CONFIDENCE_DEFINITIONS,
  getYieldSourceRiskDrivers,
} from "@/lib/yield-source-risk";
import {
  YIELD_SOURCE_CONFIDENCE_STYLES,
  getYieldSourceFreshnessDisplay,
} from "@/lib/yield-source-presentation";
import type {
  YieldBenchmarkSelectionMode,
  YieldRankChangeAttribution,
  YieldRanking,
  YieldSourceRole,
} from "@shared/types/yield";
import type { YieldRankingSummary } from "@shared/types/yield-summary";

export type YieldWorkbenchRanking = YieldRanking | YieldRankingSummary;

export function isYieldRankingSummary(row: YieldWorkbenchRanking): row is YieldRankingSummary {
  return "alternateSourceCount" in row;
}

export function getYieldAlternateSourceCount(row: YieldWorkbenchRanking): number {
  return isYieldRankingSummary(row) ? row.alternateSourceCount : row.altSources.length;
}

function getYieldAvailableSources(
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

function getYieldRankChangeAttribution(
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

/** A source-risk penalty above this multiplier reads as materially risky on every yield surface. */
const MATERIAL_SOURCE_RISK_PENALTY = 1.05;

/**
 * Row-level presentation values shared by the desktop instrument row and the
 * mobile card. Both surfaces derived these identically; the PYS breakdown stays
 * per-surface because their handling of it deliberately differs.
 */
export function deriveYieldRowPresentation(row: YieldWorkbenchRanking) {
  const confidenceTier = row.provenance?.confidenceTier ?? null;
  const rawSourceRiskPenalty = row.sourceRisk?.sourceRiskPenalty ?? null;

  return {
    confidenceStyle: confidenceTier ? YIELD_SOURCE_CONFIDENCE_STYLES[confidenceTier] : null,
    confidenceLabel: confidenceTier ? YIELD_SOURCE_CONFIDENCE_DEFINITIONS[confidenceTier].label : null,
    freshness: getYieldSourceFreshnessDisplay({
      sourceAgeSeconds: row.sourceRisk?.sourceAgeSeconds,
      sourceFreshness: row.provenance?.sourceFreshness,
      warningSignals: row.warningSignals,
    }),
    sourceRiskScore: row.sourceRisk?.sourceRiskScore ?? null,
    rawSourceRiskPenalty,
    sourceRiskMaterial: rawSourceRiskPenalty !== null && rawSourceRiskPenalty > MATERIAL_SOURCE_RISK_PENALTY,
    sourceRiskDrivers: getYieldSourceRiskDrivers({
      sourceRisk: row.sourceRisk,
      sourceChanged: row.provenance?.sourceSwitch ?? false,
      sourceFreshness: row.provenance?.sourceFreshness,
      warningSignals: row.warningSignals,
    }),
    rankChip: buildRankChangeChipDisplay(getYieldRankChangeAttribution(row)),
    pysNullReasonText:
      row.pharosYieldScore === null && row.pysNullReason ? PYS_NULL_REASON_TEXT[row.pysNullReason] : null,
    availableSources: getYieldAvailableSources(row),
    altSourceCount: getYieldAlternateSourceCount(row),
    benchmarkReferenceText: getYieldBenchmarkReferenceText(row),
  };
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

/**
 * Source role for a workbench row. The summary projection the leaderboard
 * consumes omits the field, so summary rows resolve to null and callers fall
 * back to the yield-type split.
 */
export function getYieldWorkbenchSourceRole(row: YieldWorkbenchRanking): YieldSourceRole | null {
  return isYieldRankingSummary(row) ? null : (row.sourceRole ?? null);
}
