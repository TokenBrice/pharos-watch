export const WARNING_SIGNAL_LABELS: Record<string, string> = {
  "yield-spike": "Yield spike",
  "yield-divergence": "Yield divergence",
  "negative-trend": "Negative trend",
  "reward-heavy": "Reward heavy",
  "tvl-outflow": "TVL outflow",
  "data-stale": "Data stale",
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
 * This mirrors the intermediate values from the worker's `computePYS()` in yield-helpers.ts.
 * The final PYS score is served by the API — this is for breakdown UI only.
 */
export function computePysBreakdown(
  apy30d: number,
  safetyScore: number | null,
  yieldStability: number | null,
) {
  const effectiveSafety = safetyScore ?? 40;
  const riskPenalty = Math.max(0.5, (101 - effectiveSafety) / 20);
  const yieldEfficiency = apy30d / riskPenalty;
  const sustainabilityMult = Math.max(0.3, yieldStability ?? 1.0);
  return { riskPenalty, yieldEfficiency, sustainabilityMult };
}
