import { computePysComponents, yieldStabilityToApyVarianceScore } from "@shared/lib/yield-scoring";
import { scoreToColorClass } from "@/lib/severity-colors";

const WARNING_SIGNAL_LABELS: Record<string, string> = {
  "yield-spike": "Yield spike",
  "yield-divergence": "Yield divergence",
  "negative-trend": "Negative trend",
  "reward-heavy": "Reward heavy",
  "tvl-outflow": "TVL outflow",
  "data-stale": "Data stale",
  "benchmark-degraded": "Benchmark degraded",
  "benchmark-stale": "Benchmark stale",
  "safety-unrated": "Safety unrated",
  "opportunity-evidence-missing": "Opportunity evidence incomplete",
  "zero-yield": "Zero yield",
  "low-source-tvl": "Low source TVL",
};

const WARNING_SIGNAL_DESCRIPTIONS: Record<string, string> = {
  "yield-spike": "APY moved sharply above recent history. Check the chart and source sheet before treating it as durable.",
  "yield-divergence": "Current APY diverges from comparable source history. Cross-check retained alternates before sizing exposure.",
  "negative-trend": "APY trend is falling. Compare the 7d and 30d views before relying on the headline APY.",
  "reward-heavy": "A large share of APY comes from incentives. Inspect the base/reward split and expect rewards to change faster than base yield.",
  "tvl-outflow": "Venue TVL is falling. Check venue depth and recent withdrawals before relying on the quote.",
  "data-stale": "Latest source observation is older than expected. Treat APY as stale until the source refreshes.",
  "benchmark-degraded": "The row uses a retained or fallback benchmark. Treat benchmark-relative comparisons with caution.",
  "benchmark-stale": "The selected benchmark is older than its scoring window, so PYS is unavailable until it refreshes.",
  "safety-unrated": "This estimated PYS uses the conservative 40-point safety fallback until a Report Card score is available.",
  "opportunity-evidence-missing": "This estimated PYS is missing a venue review or market-size input, so it cannot be treated as an exact opportunity-risk rating.",
  "zero-yield": "Current source reports zero yield. Verify whether the program paused or the source failed.",
  "low-source-tvl": "Venue TVL is small. Use the depth lens and retained alternates before comparing this APY with deeper venues.",
};

export function formatYieldWarningSignal(signal: string) {
  return WARNING_SIGNAL_LABELS[signal] ?? signal.replace(/-/g, " ");
}

export function formatYieldWarningSignalDescription(signal: string) {
  return WARNING_SIGNAL_DESCRIPTIONS[signal] ?? "Review the source sheet and history chart before treating this warning as durable.";
}

/** Static PYS color classes (Tailwind purge-safe). */
export function getPysColor(pys: number | null): string {
  return scoreToColorClass(pys, [
    { min: 41, className: "text-emerald-700 dark:text-emerald-400" },
    { min: 21, className: "text-amber-700 dark:text-amber-400" },
    { min: Number.NEGATIVE_INFINITY, className: "text-red-700 dark:text-red-400" },
  ]);
}

/**
 * Compute PYS breakdown components for display (tooltips, stat cards).
 * Delegates to the shared PYS module — single source of truth.
 * The final PYS score is served by the API — this is for breakdown UI only.
 */
export function computePysBreakdown(
  apy30d: number,
  safetyScore: number | null,
  yieldStability: number | null,
  benchmarkRate?: number | null,
  sourceRiskPenalty?: number | null,
) {
  const apyVarianceScore = yieldStabilityToApyVarianceScore(yieldStability);
  const {
    riskPenalty,
    adjustedRiskPenalty,
    benchmarkSpread,
    benchmarkAdjustment,
    effectiveYield,
    rowUtility,
    sourceRiskPenalty: resolvedSourceRiskPenalty,
    yieldEfficiency,
    sustainabilityMultiplier,
  } = computePysComponents({ apy30d, safetyScore, apyVarianceScore, benchmarkRate, sourceRiskPenalty });
  return {
    riskPenalty,
    adjustedRiskPenalty,
    benchmarkSpread,
    benchmarkAdjustment,
    effectiveYield,
    rowUtility,
    sourceRiskPenalty: resolvedSourceRiskPenalty,
    yieldEfficiency,
    sustainabilityMult: sustainabilityMultiplier,
  };
}
