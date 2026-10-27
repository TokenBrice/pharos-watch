/**
 * Operational advisories describe how fresh or comparable a yield source is,
 * not an investment risk. They never count as, filter on, or headline a yield
 * warning (ADR-42). Unknown keys are kept: only these exact keys are excluded.
 */
const OPERATIONAL_YIELD_ADVISORY_SIGNALS: ReadonlySet<string> = new Set([
  "aging",
  "data-stale",
  "data-freshness-unknown",
  "reference-benchmark-degraded",
  "benchmark-degraded",
  "benchmark-stale",
]);

export function isOperationalYieldAdvisory(signal: string): boolean {
  return OPERATIONAL_YIELD_ADVISORY_SIGNALS.has(signal);
}

/** Investment warnings only; order and unknown keys are preserved. */
export function selectInvestmentWarningSignals<T extends string>(
  signals: readonly T[] | null | undefined,
): T[] {
  return (signals ?? []).filter((signal) => !OPERATIONAL_YIELD_ADVISORY_SIGNALS.has(signal));
}
