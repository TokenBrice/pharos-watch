import { getYieldBenchmarkSelectionMode, getYieldWorkbenchSourceRole, deriveYieldRowPresentation } from "@/lib/yield-workbench-row";
import { getPysColor } from "@shared/lib/classification";
import { isOpportunityDerivedSafety } from "@shared/lib/yield-opportunity-provenance";
import { formatCurrency, formatPercent, formatScore } from "@shared/lib/format";
import { formatYieldSourceRiskSummary, getYieldSourceDepthDisplay, isNativeYieldSource } from "@/lib/yield-source-risk";
import { buildPysNeutralizeInput, selectPysRowDrags } from "@/lib/yield-presentation";
import { buildYieldPysBreakdown, type YieldPresentationContext } from "@/lib/yield-presentation-context";
import type { YieldViewModelRow } from "@/lib/yield-view-model";
import { selectInvestmentWarningSignals } from "@shared/lib/yield-warning-signals";

export type PysBreakdownValues = {
  scalingFactor: number;
  adjustedRiskPenalty: number;
  benchmarkAdjustment: number;
  benchmarkSpread: number | null;
  hurdleRebase: number;
  effectiveYield: number;
  sourceRiskPenalty: number;
  sustainabilityMult: number | null;
};

export function isOpportunityDerivedYieldRow(row: YieldViewModelRow): boolean {
  return isOpportunityDerivedSafety(row.provenance?.safetyProvenance);
}

export function formatYieldSafetySrLabel(
  grade: YieldViewModelRow["safetyGrade"],
  safetyScore: number | null,
): string {
  return grade && grade !== "NR"
    ? safetyScore !== null
      ? `Safety grade: ${grade}, score ${Math.round(safetyScore)} out of 100`
      : `Safety grade: ${grade}`
    : safetyScore !== null
      ? `Safety score: ${Math.round(safetyScore)} out of 100, grade unavailable`
      : "Safety unavailable";
}

export function deriveYieldRowDisplay(
  row: YieldViewModelRow,
  context: YieldPresentationContext,
) {
  const labels = formatYieldRowLabels(row);
  const presentation = deriveYieldRowPresentation(row, context.sourceClock);
  const sourceRole = getYieldWorkbenchSourceRole(row);
  const breakdown = buildYieldPysBreakdown(row, context);

  return {
    ...presentation,
    ...labels,
    breakdown,
    pysDrags: selectPysRowDrags(
      row.pharosYieldScore,
      buildPysNeutralizeInput({ apy30d: row.apy30d, safetyScore: row.safetyScore, ...breakdown }),
    ),
    grade: row.safetyGrade,
    safetyScore: row.safetyScore,
    pysColor: getPysColor(row.pharosYieldScore),
    warningCount: selectInvestmentWarningSignals(row.warningSignals).length,
    sourceRiskSummary: formatYieldSourceRiskSummary(row.sourceRisk),
    depthDisplay: getYieldSourceDepthDisplay({
      depthLens: row.sourceDepthLens,
      yieldType: row.yieldType,
      sourceRole,
      sourceTvlUsd: row.sourceTvlUsd,
    }),
    isCurrencyMismatchedBenchmark:
      getYieldBenchmarkSelectionMode(row) === "fallback-usd" && row.peg !== null && row.peg !== "USD",
  };
}

function formatYieldRowLabels(row: YieldViewModelRow) {
  const grade = row.safetyGrade;
  const safetyScore = row.safetyScore;
  // A native row has no venue to size apart from the asset itself, so a null
  // TVL is "not applicable", not a gap: it reads "Native" instead of a dash.
  const tvlIsNative =
    row.sourceTvlUsd === null && isNativeYieldSource(getYieldWorkbenchSourceRole(row), row.yieldType);
  const tvlLabel =
    row.sourceTvlUsd !== null ? formatCurrency(row.sourceTvlUsd) : tvlIsNative ? "Native" : "—";
  const apyLabel = formatPercent(row.apy30d);
  const stabilityPct = row.yieldStability !== null ? Math.round(row.yieldStability * 100) : null;
  const apySrLabel = `30-day APY: ${formatPercent(row.apy30d)}`;
  return {
    apyLabel,
    tvlLabel,
    tvlIsNative,
    stabilityPct,
    apySrLabel,
    safetySrLabel: formatYieldSafetySrLabel(grade, safetyScore),
    pysSrLabel:
      row.pharosYieldScore !== null
        ? `Pharos Yield Score ${formatScore(row.pharosYieldScore)} out of 100`
        : "Pharos Yield Score unavailable",
    tvlSrLabel:
      row.sourceTvlUsd !== null
        ? `TVL: ${tvlLabel}`
        : tvlIsNative
          ? "Venue TVL not applicable: yield accrues on the asset itself"
          : "TVL unavailable",
    stabilitySrLabel:
      stabilityPct !== null ? `30-day stability: ${stabilityPct} percent` : "30-day stability unavailable",
  };
}
