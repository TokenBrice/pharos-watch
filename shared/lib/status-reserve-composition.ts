import type { StatusResponse } from "../types/status";

export function unavailableReserveComposition(): Extract<StatusResponse["reserveComposition"], { status: "unavailable" }> {
  return {
    status: "unavailable",
    reason: "reserve_composition_query_failed",
    configuredCoins: null,
    freshCoins: null,
    staleCoins: null,
    missingCoins: null,
    degradedCoins: null,
    errorCoins: null,
    corruptCoins: null,
    independentFreshEligible: null,
    independentFreshUnverified: null,
    staticValidatedFresh: null,
    weakProbeFresh: null,
    writeTimeoutUncertain: null,
    deferredCoins: null,
    runBudgetTruncated: null,
    deferredAt: null,
    nextCursorStablecoinId: null,
    cursorRecordedAt: null,
    persistentlyStaleIndependentCoins: null,
    lastSuccessAt: null,
    oldestFreshAgeSec: null,
    adapterReliability: null,
    freshCoverageRatio: null,
    authoritativeFreshCoverageRatio: null,
  };
}
