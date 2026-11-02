import { describe, expect, it } from "vitest";
import type { CacheStatus, CronStatus, PublicationHealth } from "@shared/types/status";
import { buildDependencyHealth } from "../dependency-health";
import { buildFxCacheStatus, hydrateFxRateState } from "../fx-rate-state";
import { fxRatesCacheRows } from "./fx-rate-state.test-support";

const NOW = 1_775_900_000;

function cache(overrides: Partial<CacheStatus> = {}): CacheStatus {
  return {
    ageSeconds: 120,
    maxAge: 600,
    healthy: true,
    producerJob: "sync-stablecoins",
    producerIntervalSec: 900,
    ...overrides,
    publishedAt: overrides.publishedAt !== undefined ? overrides.publishedAt : NOW - (overrides.ageSeconds ?? 120),
  };
}

function cron(overrides: Partial<CronStatus> = {}): CronStatus {
  return {
    runs: [{
      startedAt: NOW - 120,
      durationMs: 250,
      status: "ok",
    }],
    expectedIntervalSec: 1_800,
    healthy: true,
    confirmedOutputAt: null,
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
  it("attributes an unhealthy neutral skip to the required attempt it inherits", () => {
    const failedRun = {
      startedAt: NOW - 2_400, durationMs: 731, status: "error" as const,
      degradedReason: "dex-source-stage-unavailable",
    };
    const skip = { startedAt: NOW - 600, durationMs: 1, status: "skipped_neutral" as const };
    const result = buildDependencyHealth({
      now: NOW, publicationHealth: null,
      caches: { "dex-liquidity": cache({ producerJob: "sync-dex-liquidity" }) },
      crons: { "sync-dex-liquidity": cron({ healthy: false, runs: [skip, failedRun] }) },
    });
    expect(result.dependencies["dex-liquidity"]).toMatchObject({
      status: "degraded", updatedAt: failedRun.startedAt, ageSeconds: 2_400,
      reason: "Latest required cron status is error: dex-source-stage-unavailable.",
    });
  });

  it.each(["ordinary", "sentinel"] as const)("keeps immutable publication clocks across cached %s assessments", (kind) => {
    const publishedAt = NOW - 420;
    const caches = { stablecoins: cache({
      publishedAt, ageSeconds: 120,
      ...(kind === "sentinel" ? { generationId: "generation", freshnessSource: "freshness-sentinel" as const } : {}),
    }) };
    const crons = { "sync-stablecoins": cron({ runs: [{ startedAt: NOW - 1_000, durationMs: 1, status: "ok" }] }) };
    const first = buildDependencyHealth({ now: NOW, caches, crons, publicationHealth: null }).dependencies.stablecoins;
    const later = buildDependencyHealth({ now: NOW + 60, caches, crons, publicationHealth: null }).dependencies.stablecoins;
    expect(first).toMatchObject({ updatedAt: publishedAt, ageSeconds: 420 });
    expect(later).toMatchObject({ updatedAt: publishedAt, ageSeconds: 480 });
  });
  it.each([
    { ageSeconds: 700, healthy: true, expectedStatus: "healthy" },
    { ageSeconds: 8 * 600 + 1, healthy: true, expectedStatus: "degraded" },
    { ageSeconds: 12 * 600 + 1, healthy: false, expectedStatus: "stale" },
  ] as const)(
    "classifies a stablecoins cache at $ageSeconds seconds as $expectedStatus using availability ratios",
    ({ ageSeconds, healthy, expectedStatus }) => {
      const dependencyHealth = buildDependencyHealth({
        now: NOW,
        publicationHealth: null,
        caches: {
          stablecoins: cache({ ageSeconds, healthy }),
        },
        crons: {
          "sync-stablecoins": cron({ expectedIntervalSec: 900 }),
        },
      });

      expect(dependencyHealth.dependencies.stablecoins.status).toBe(expectedStatus);
      if (expectedStatus === "healthy") {
        expect(
          dependencyHealth.rootCauseGroups.some((group) => group.rootDependencyId === "stablecoins"),
        ).toBe(false);
      }
    },
  );

  it.each([
    { ageSeconds: 3 * 3_600 + 1, expectedStatus: "degraded" },
    { ageSeconds: 6 * 3_600 + 1, expectedStatus: "stale" },
  ] as const)(
    "honors the yield cache override at $ageSeconds seconds",
    ({ ageSeconds, expectedStatus }) => {
      const dependencyHealth = buildDependencyHealth({
        now: NOW,
        publicationHealth: null,
        caches: {
          "yield-data": cache({
            ageSeconds,
            maxAge: 3_600,
            healthy: false,
            producerJob: "sync-yield-data",
            producerIntervalSec: 3_600,
          }),
        },
        crons: {
          "sync-yield-data": cron({ expectedIntervalSec: 3_600 }),
        },
      });

      expect(dependencyHealth.dependencies["yield-rankings"].status).toBe(expectedStatus);
    },
  );

  it("names the cache-quality verdict instead of age when a fresh cache's producer streak degraded", () => {
    const dependencyHealth = buildDependencyHealth({
      now: NOW,
      publicationHealth: null,
      caches: {
        "yield-data": cache({
          ageSeconds: 347,
          maxAge: 3_600,
          healthy: false,
          degraded: true,
          degradedReason: "yield-supplemental:family-degraded:aaveV3:upstream-unavailable",
          streakDegradedRuns: 135,
          producerJob: "sync-yield-data",
          producerIntervalSec: 3_600,
        }),
      },
      crons: {
        "sync-yield-data": cron({ expectedIntervalSec: 3_600 }),
      },
    });

    const yieldRankings = dependencyHealth.dependencies["yield-rankings"];
    expect(yieldRankings.status).toBe("degraded");
    expect(yieldRankings.reason).toContain("yield-supplemental:family-degraded:aaveV3:upstream-unavailable");
    expect(yieldRankings.reason).toContain("135");
    expect(yieldRankings.reason).not.toContain("Freshness age");
  });

  it("keeps the age sentence for an age-driven unhealthy cache even when its quality is also degraded", () => {
    const dependencyHealth = buildDependencyHealth({
      now: NOW,
      publicationHealth: null,
      caches: {
        "yield-data": cache({
          ageSeconds: 3 * 3_600 + 1,
          maxAge: 3_600,
          healthy: false,
          degraded: true,
          degradedReason: "producer-degraded-since-last-clean-run",
          streakDegradedRuns: 3,
          producerJob: "sync-yield-data",
          producerIntervalSec: 3_600,
        }),
      },
      crons: {
        "sync-yield-data": cron({ expectedIntervalSec: 3_600 }),
      },
    });

    expect(dependencyHealth.dependencies["yield-rankings"].reason).toBe(
      "Freshness age 10801s is outside the healthy budget.",
    );
  });

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

  it("attributes a degraded yield publication to the safety-score-v9 input it names", () => {
    const dependencyHealth = buildDependencyHealth({
      now: NOW,
      publicationHealth: {
        checkedAt: NOW - 30,
        surfaces: {},
        failedSurfaces: [{
          surface: "safety-score-v9",
          code: "v9-snapshot-unavailable",
          message: "Safety Score V9 publication is unavailable.",
        }],
      },
      caches: {
        stablecoins: cache(),
        "dex-liquidity": cache({ producerJob: "sync-dex-liquidity", maxAge: 43_200 }),
        "yield-data": cache({ producerJob: "sync-yield-data", producerIntervalSec: 7_200 }),
      },
      crons: {
        "sync-stablecoins": cron(),
        "sync-dex-liquidity": cron(),
        "sync-yield-data": cron({
          expectedIntervalSec: 7_200,
          healthy: false,
          runs: [{
            startedAt: NOW - 120,
            durationMs: 300,
            status: "degraded",
            degradedReason: "safety-snapshot-unavailable:v9-snapshot-unavailable",
          }],
        }),
      },
    });

    expect(dependencyHealth.dependencies["yield-rankings"].status).toBe("degraded");
    const v9Group = dependencyHealth.rootCauseGroups.find((group) => group.rootDependencyId === "safety-score-v9");
    expect(v9Group?.symptomDependencyIds).toContain("yield-rankings");
    expect(v9Group?.impactedDependencyIds).toContain("yield-rankings");
  });

  it("groups downstream symptoms under a stale DEX liquidity root", () => {
    const dependencyHealth = buildDependencyHealth({
      now: NOW,
      publicationHealth: failedDexPublication(),
      caches: {
        stablecoins: cache(),
        "dex-liquidity": cache({
          ageSeconds: 13 * 43_200,
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
          ageSeconds: 13 * 1_800,
          maxAge: 1_800,
          healthy: false,
          producerJob: "compute-dews",
          warning: "dews freshness exceeded availability budget",
        }),
      },
      crons: {
        "sync-stablecoins": cron(),
        "sync-dex-liquidity": cron({
          runs: [{ startedAt: NOW - 600, durationMs: 300, status: "error" }],
          healthy: false,
        }),
        "sync-yield-data": cron({
          expectedIntervalSec: 3_600,
        }),
        "compute-dews": cron({
          runs: [{ startedAt: NOW - 3_600, durationMs: 300, status: "error" }],
          healthy: false,
        }),
        "compute-safety-score-v9": cron({
          runs: [{ startedAt: NOW - 3_000, durationMs: 300, status: "error" }],
          healthy: false,
        }),
        "sync-redemption-backstops": cron({
          runs: [{ startedAt: NOW - 3_000, durationMs: 300, status: "error" }],
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

  it("keeps a stale fx-rates cache age stale when its upstream source is only degraded", () => {
    const stalledForSec = 7 * 3_600;
    const [ratesRow, metaRow] = fxRatesCacheRows(NOW - stalledForSec);
    const state = hydrateFxRateState(
      { value: ratesRow.value, updatedAt: ratesRow.updated_at },
      { value: metaRow.value, updatedAt: metaRow.updated_at },
    );
    if (!state) throw new Error("FX fixture did not hydrate");
    const { cacheStatus } = buildFxCacheStatus(state, 1_800, NOW);
    const fx = buildDependencyHealth({
      now: NOW,
      // The same publication clock buildCacheStatuses publishes.
      caches: { "fx-rates": { ...cacheStatus, publishedAt: state.usableSyncAt } },
      crons: {},
      publicationHealth: null,
    }).dependencies["fx-rates"];

    // 14x the availability budget must not be downgraded by the source band.
    expect(fx.status).toBe("stale");
  });

  it("ages the pending-candidate clock its degraded verdict names", () => {
    const health = buildDependencyHealth({
      now: NOW,
      caches: {},
      crons: {},
      publicationHealth: {
        checkedAt: NOW,
        surfaces: {
          "dex-liquidity": {
            surface: "dex-liquidity",
            label: "DEX liquidity publication",
            sourceOfTruth: "dex_liquidity_publication_generations",
            lastPublishedGeneration: {
              generationId: "dex-published", sourceState: "published", state: "published",
              startedAt: NOW - 10_000, validatedAt: null, publishedAt: NOW - 60, failedAt: null,
              candidateRows: 407, publishedRows: 407, expectedRows: 407, failureReason: null,
            },
            lastAttemptedGeneration: {
              generationId: "dex-candidate", sourceState: "staged", state: "candidate",
              startedAt: NOW - 9_000, validatedAt: null, publishedAt: null, failedAt: null,
              candidateRows: 400, publishedRows: null, expectedRows: 407, failureReason: null,
            },
            lastFailureReason: null,
            candidateAgeSec: 9_000,
            dependencyWatermarks: null,
          },
        },
      },
    });

    expect(health.dependencies["dex-liquidity"]).toMatchObject({
      status: "degraded",
      updatedAt: NOW - 9_000,
      ageSeconds: 9_000,
      maxAgeSec: 7_200,
      reason: "Candidate generation has been pending for 9000s.",
    });
  });

  it("does not publish a future-dated publication as healthy with a clamped zero age", () => {
    const publishedAt = NOW + 600;
    const generation = {
      generationId: `psi:${publishedAt}`,
      sourceState: "published", state: "published" as const,
      startedAt: NOW - 240, validatedAt: publishedAt, publishedAt, failedAt: null,
      candidateRows: 1, publishedRows: 1, expectedRows: 1, failureReason: null,
    };
    const psi = buildDependencyHealth({
      now: NOW,
      publicationHealth: {
        checkedAt: NOW,
        surfaces: {
          psi: {
            surface: "psi", label: "PSI samples", sourceOfTruth: "surface_publication_generations",
            lastPublishedGeneration: generation, lastAttemptedGeneration: generation,
            lastFailureReason: null, candidateAgeSec: null, dependencyWatermarks: null,
          },
        },
      },
      caches: {},
      // A healthy producer heartbeat beside the rejected publication clock.
      crons: { "stability-index": cron() },
    }).dependencies.psi;

    expect(psi.status).not.toBe("healthy");
    expect(psi.ageSeconds).toBeNull();
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
