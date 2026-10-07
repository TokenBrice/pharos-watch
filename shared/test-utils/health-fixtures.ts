import type { HealthResponse } from "@shared/types";

/**
 * Canonical healthy public-health payload shared by src and worker status
 * fixtures so their field defaults cannot drift apart.
 */
export function makeHealthyHealthResponse(): HealthResponse {
  return {
    status: "healthy",
    timestamp: 1_700_000_000,
    warnings: [],
    schedulerLiveness: {
      status: "healthy", observedAt: 1_700_000_000,
      lastAnyStartedAt: 1_699_999_970, lastFiveMinuteStartedAt: 1_699_999_970, ageSeconds: 30,
      warningAfterSec: 600, staleAfterSec: 1200,
      lanes: ["fiveMinuteReserveRecovery", "fiveMinuteTelegramAlerts", "digestTriggerPoll"].map((scheduleKey) => ({
        scheduleKey, lastStartedAt: 1_699_999_970,
      })),
      unavailableReason: null,
      heavy: {
        scheduleKey: "v9SupplyAttributionOffset", lastStartedAt: 1_699_999_970, ageSeconds: 30,
        warningAfterSec: 1800, staleAfterSec: 2700, status: "healthy", unavailableReason: null,
      },
    },
    caches: {},
    blacklist: {
      totalEvents: 0,
      missingAmounts: 0,
      recentMissingAmounts: 0,
      recentWindowSec: 86_400,
      missingRatio: 0,
    },
    mintBurn: {
      totalEvents: 0,
      latestEventTs: null,
      latestHourlyTs: null,
      freshnessAgeSec: null,
      majorStaleCount: 0,
      staleMajorSymbols: [],
      sync: {
        lastSuccessfulSyncAt: null,
        freshnessStatus: "fresh",
        warning: null,
        criticalLaneHealthy: true,
      },
    },
    circuits: {},
  };
}
