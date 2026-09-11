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
