import { computePysComponents } from "@shared/lib/yield-scoring";

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
  if (pys === null) return "text-muted-foreground";
  if (pys > 40) return "text-emerald-700 dark:text-emerald-400";
  if (pys > 20) return "text-amber-700 dark:text-amber-400";
  return "text-red-700 dark:text-red-400";
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
) {
  // yieldStability in the API = 1.0 - apyVarianceScore
  const apyVarianceScore = 1.0 - (yieldStability ?? 1.0);
  const { riskPenalty, yieldEfficiency, sustainabilityMultiplier } =
    computePysComponents({ apy30d, safetyScore, apyVarianceScore });
  return { riskPenalty, yieldEfficiency, sustainabilityMult: sustainabilityMultiplier };
}
