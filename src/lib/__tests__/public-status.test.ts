import { describe, expect, it } from "vitest";
import type { HealthResponse } from "@shared/types";
import {
  countPublicImpactOpenCircuits,
  isPublicImpactCircuitKey,
} from "@shared/lib/public-health";
import {
  getImpactedPublicSurfaces,
  getPublicMintBurnStatus,
  getPublicWorstCacheSummary,
} from "@/lib/status/public-status";

const BASE_HEALTH: HealthResponse = {
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
      lastSuccessfulSyncAt: 1_699_999_400,
      freshnessStatus: "fresh",
      warning: null,
      criticalLaneHealthy: true,
    },
  },
  circuits: {},
};

describe("public status helpers", () => {
  it("degrades mint/burn status when the critical writer lane is unhealthy despite fresh sync age", () => {
    const sync = {
      ...BASE_HEALTH.mintBurn.sync,
      criticalLaneHealthy: false,
      warning: "Critical mint/burn lane last run errored; cached or partial data may be served.",
    };

    expect(getPublicMintBurnStatus(sync)).toBe("degraded");

    const impacted = getImpactedPublicSurfaces({
      ...BASE_HEALTH,
      mintBurn: {
        ...BASE_HEALTH.mintBurn,
        sync,
      },
    });

    expect(impacted).toContainEqual(expect.objectContaining({ id: "mint-burn", tone: "degraded" }));
  });

  it("treats missing cache rows as stale in the worst cache summary", () => {
    const summary = getPublicWorstCacheSummary({
      stablecoins: {
        ageSeconds: null,
        maxAge: 900,
        healthy: false,
      },
    });

    expect(summary).toEqual({
      ratio: null,
      status: "stale",
      impactedCount: 1,
    });
  });

  it("treats source-degraded as informational — fresh cache stays healthy impact", () => {
    const ratio = 120 / 3_600;
    const summary = getPublicWorstCacheSummary({
      "fx-rates": {
        ageSeconds: 120,
        maxAge: 3_600,
        healthy: true,
        sourceStatus: "degraded",
      },
    });

    expect(summary).toEqual({
      ratio,
      status: "healthy",
      impactedCount: 0,
    });

    const impacted = getImpactedPublicSurfaces({
      ...BASE_HEALTH,
      caches: {
        "fx-rates": {
          ageSeconds: 120,
          maxAge: 3_600,
          healthy: true,
          sourceStatus: "degraded",
        },
      },
    });

    expect(impacted).not.toContainEqual(expect.objectContaining({ id: "cache-fx-rates", tone: "degraded" }));
  });

  it("excludes reserve-only circuit breakers from public-impact circuit counts", () => {
    expect(isPublicImpactCircuitKey("live-reserves:ousg-ondo")).toBe(false);
    expect(isPublicImpactCircuitKey("defillama-stablecoins")).toBe(true);

    const circuit = {
      state: "open",
      consecutiveFailures: 3,
      lastFailureAt: 1_700_000_000,
      lastSuccessAt: null,
      openedAt: 1_700_000_000,
    } as const;

    expect(countPublicImpactOpenCircuits({
      "live-reserves:ousg-ondo": circuit,
      "live-reserves:mtbill-midas": circuit,
    })).toBe(0);
  });
});
