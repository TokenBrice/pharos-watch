import { computePysComponents, yieldStabilityToApyVarianceScore } from "@shared/lib/yield-scoring";
import { scoreToColorClass } from "@/lib/severity-colors";

export const WARNING_SIGNAL_LABELS: Record<string, string> = {
  "yield-spike": "Yield spike",
  "yield-divergence": "Yield divergence",
  "negative-trend": "Negative trend",
  "reward-heavy": "Reward heavy",
  "tvl-outflow": "TVL outflow",
  "data-stale": "Data stale",
  "zero-yield": "Zero yield",
};

export function formatYieldWarningSignal(signal: string) {
  return WARNING_SIGNAL_LABELS[signal] ?? signal.replace(/-/g, " ");
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
) {
  const apyVarianceScore = yieldStabilityToApyVarianceScore(yieldStability);
  const {
    riskPenalty,
    adjustedRiskPenalty,
    benchmarkSpread,
    benchmarkAdjustment,
    effectiveYield,
    yieldEfficiency,
    sustainabilityMultiplier,
  } = computePysComponents({ apy30d, safetyScore, apyVarianceScore, benchmarkRate });
  return {
    riskPenalty,
    adjustedRiskPenalty,
    benchmarkSpread,
    benchmarkAdjustment,
    effectiveYield,
    yieldEfficiency,
    sustainabilityMult: sustainabilityMultiplier,
  };
}
