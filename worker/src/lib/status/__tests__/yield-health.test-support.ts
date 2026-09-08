export function yieldCacheRow(key: string, updatedAt: number, payload: unknown) {
  return { key, updated_at: updatedAt, value: JSON.stringify(payload) };
}

export function healthyYieldProvenance(now: number, coveredCount: number, overrides: Record<string, unknown> = {}) {
  return {
    safetySnapshot: { coverageRatio: 1, coveredCount, trackedCount: coveredCount, reason: null },
    benchmark: {
      fetchedAt: now - 3600,
      ageSeconds: 3600,
      source: "tbill-cache",
      isFallback: false,
      fallbackMode: null,
    },
    ...overrides,
  };
}

export function emptyYieldAudit(overrides: Record<string, unknown> = {}) {
  return {
    manifestMissingCount: 0,
    yieldBearingMissingFromRankingsCount: 0,
    unmatchedHighTvlPoolCount: 0,
    missingProtocolCount: 0,
    nativeExactPoolRecommendationCount: 0,
    sourceFamilyAdapterRecommendationCount: 0,
    lendingAllowlistRecommendationCount: 0,
    venueRiskConfigMissingCount: 0,
    staleAutoLendingOverrideCount: 0,
    staleVenueRiskScoreCount: 0,
    ...overrides,
  };
}
