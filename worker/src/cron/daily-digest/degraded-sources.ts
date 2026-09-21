/**
 * Collector degradation reasons that invalidate a published "nothing is wrong"
 * claim. A collector that could not read its input did not observe calm, so the
 * regime classifier and the risk tape must not publish the optimistic end of
 * their scales while one of these is present in `degradedSources`.
 */
export const ACTIVE_DEPEGS_DEGRADED_SOURCE = "active-depegs-query";

export const REGIME_CRITICAL_DEGRADED_SOURCES: readonly string[] = [
  ACTIVE_DEPEGS_DEGRADED_SOURCE,
  "dews-published-generation",
  "dews-stress-query",
  "mint-burn-gauge-read",
];
