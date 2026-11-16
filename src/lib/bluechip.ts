
/**
 * Neutral public provenance for an external grade: the original successful observation date, or
 * an explicit unavailable date. Operator observation states (retained, stale, unknown) and the
 * 48h Selector admission window in `@shared/lib/bluechip-freshness` are not reader warnings.
 */
export function bluechipObservationText(lastObservedAt: number | null | undefined, nowSeconds: number): string {
  if (lastObservedAt == null || !Number.isFinite(lastObservedAt) || lastObservedAt > nowSeconds) {
    return "Observation date unavailable";
  }
  return `Observed ${new Date(lastObservedAt * 1000).toISOString().slice(0, 10)}`;
}
