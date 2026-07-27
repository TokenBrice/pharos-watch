import { describe, expect, it } from "vitest";
import type { CacheStatus, CronStatus, PublicationHealth } from "@shared/types/status";
import { buildDependencyHealth } from "../dependency-health";

const NOW = 1_775_900_000;

function cache(overrides: Partial<CacheStatus> = {}): CacheStatus {
  return {
    ageSeconds: 120,
    maxAge: 600,
    healthy: true,
    producerJob: "sync-stablecoins",
    producerIntervalSec: 900,
    ...overrides,
  };
}

function cron(overrides: Partial<CronStatus> = {}): CronStatus {
  return {
    lastRun: {
      startedAt: NOW - 120,
      durationMs: 250,
      status: "ok",
    },
    recentRuns: [],
    expectedIntervalSec: 1_800,
    healthy: true,
    ...overrides,
  };
}

function failedDexPublication(): PublicationHealth {
  return {
    checkedAt: NOW,
    surfaces: {
      "dex-liquidity": {
        surface: "dex-liquidity",
        label: "DEX liquidity publication",
        sourceOfTruth: "dex_liquidity_publication_generations",
        lastPublishedGeneration: {
          generationId: "dex-published",
          sourceState: "published",
          state: "published",
          startedAt: NOW - 8_000,
          validatedAt: null,
          publishedAt: NOW - 7_900,
          failedAt: null,
          candidateRows: 407,
          publishedRows: 407,
          expectedRows: 407,
          failureReason: null,
        },
        lastAttemptedGeneration: {
          generationId: "dex-failed",
          sourceState: "failed",
          state: "failed",
          startedAt: NOW - 600,
          validatedAt: null,
          publishedAt: null,
          failedAt: NOW - 580,
          candidateRows: 400,
          publishedRows: null,
          expectedRows: 407,
          failureReason: "candidate-row-count-mismatch",
        },
        lastFailureReason: "candidate-row-count-mismatch",
        candidateAgeSec: null,
        dependencyWatermarks: null,
      },
    },
  };
}

describe("buildDependencyHealth", () => {
  it("surfaces failed publication metadata as a degraded dependency signal", () => {
    const dependencyHealth = buildDependencyHealth({
      now: NOW,
      publicationHealth: {
        checkedAt: NOW - 30,
        surfaces: {},
        failedSurfaces: [
          {
            surface: "yield-rankings",
            code: "publication_surface_query_failed",
            message: "Publication surface query failed.",
          },
        ],
      },
      caches: {
        stablecoins: cache(),
        "dex-liquidity": cache({
          producerJob: "sync-dex-liquidity",
          maxAge: 43_200,
        }),
        "yield-data": cache({
          producerJob: "sync-yield-data",
          producerIntervalSec: 3_600,
        }),
      },
      crons: {
        "sync-stablecoins": cron(),
        "sync-dex-liquidity": cron(),
        "sync-yield-data": cron({
          expectedIntervalSec: 3_600,
        }),
      },
    });

    expect(dependencyHealth.dependencies["yield-rankings"]).toMatchObject({
      status: "degraded",
      updatedAt: NOW - 30,
      ageSeconds: 30,
      reason: "publication_surface_query_failed: Publication surface query failed.",
    });
    expect(dependencyHealth.dependencies["yield-rankings"].reason).not.toContain("unavailable");
  });

  it("groups downstream symptoms under a stale DEX liquidity root", () => {
    const dependencyHealth = buildDependencyHealth({
      now: NOW,
      publicationHealth: failedDexPublication(),
      caches: {
        stablecoins: cache(),
        "dex-liquidity": cache({
          ageSeconds: 50_000,
          maxAge: 43_200,
          healthy: false,
          producerJob: "sync-dex-liquidity",
          warning: "dex-liquidity freshness exceeded availability budget",
        }),
        "yield-data": cache({
          producerJob: "sync-yield-data",
          producerIntervalSec: 3_600,
        }),
        dews: cache({
          ageSeconds: 7_200,
          maxAge: 1_800,
          healthy: false,
          producerJob: "compute-dews",
          warning: "dews freshness exceeded availability budget",
        }),
      },
      crons: {
        "sync-stablecoins": cron(),
        "sync-dex-liquidity": cron({
          lastRun: { startedAt: NOW - 600, durationMs: 300, status: "error" },
          healthy: false,
        }),
        "sync-yield-data": cron({
          expectedIntervalSec: 3_600,
        }),
        "compute-dews": cron({
          lastRun: { startedAt: NOW - 3_600, durationMs: 300, status: "error" },
          healthy: false,
        }),
        "compute-safety-score-v9": cron({
          lastRun: { startedAt: NOW - 3_000, durationMs: 300, status: "error" },
          healthy: false,
        }),
        "sync-redemption-backstops": cron({
          lastRun: { startedAt: NOW - 3_000, durationMs: 300, status: "error" },
          healthy: false,
        }),
      },
    });

    expect(dependencyHealth.dependencies["dex-liquidity"]).toMatchObject({
      status: "stale",
      reason: "dex-liquidity freshness exceeded availability budget",
    });
    expect(dependencyHealth.dependencies.dews.status).toBe("stale");
    expect(dependencyHealth.dependencies["safety-score-v9"].status).toBe("degraded");

    const dexGroup = dependencyHealth.rootCauseGroups.find((group) => group.rootDependencyId === "dex-liquidity");
    expect(dexGroup).toMatchObject({
      rootStatus: "stale",
      criticality: "critical",
    });
    expect(dexGroup?.symptomDependencyIds).toEqual([
      "dews",
      "redemption-backstops",
      "safety-score-v9",
    ]);
    expect(dexGroup?.impactedDependencyIds).toEqual([
      "dews",
      "project-tape",
      "psi",
      "redemption-backstops",
      "safety-score-v9",
      "yield-rankings",
    ]);
  });

  it("keeps missing optional signals unknown without creating root-cause groups", () => {
    const dependencyHealth = buildDependencyHealth({
      now: NOW,
      caches: {},
      crons: {},
      publicationHealth: null,
    });

    expect(dependencyHealth.summary.unknown).toBeGreaterThan(0);
    expect(dependencyHealth.rootCauseGroups).toEqual([]);
  });
});
