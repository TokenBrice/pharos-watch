import { describe, expect, it } from "vitest";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { mockD1 } from "../../../api/__tests__/helpers/mock-d1";
import { loadYieldHealthSummary } from "../yield-health";
import type { CronStatus } from "@shared/types/status";

const NOW = 1_777_000_000;

function cron(status = "ok", ageSec = 120): CronStatus {
  return {
    expectedIntervalSec: CRON_INTERVALS["sync-yield-data"],
    healthy: true,
    recentRuns: [],
    lastRun: {
      startedAt: NOW - ageSec,
      durationMs: 1000,
      status,
    },
  };
}

function makeDb(rows: Record<string, unknown>[]) {
  return mockD1([{ match: "yield-rankings", rows }], { requireMatch: true });
}

describe("loadYieldHealthSummary", () => {
  it("summarizes rankings, safety coverage, supplemental, benchmark, and audit cache state", async () => {
    const summary = await loadYieldHealthSummary(
      makeDb([
        {
          key: "yield-rankings",
          updated_at: NOW - 600,
          value: JSON.stringify({
            updatedAt: NOW - 600,
            rankings: [{ id: "usdc-circle" }, { id: "usdt-tether" }],
            provenance: {
              safetySnapshot: {
                coverageRatio: 0.84,
                coveredCount: 84,
                trackedCount: 100,
                reason: null,
              },
              benchmark: {
                fetchedAt: NOW - 3600,
                ageSeconds: 3600,
                source: "tbill-cache",
                isFallback: false,
                fallbackMode: null,
              },
            },
          }),
        },
        {
          key: "yield:supplemental-sources:v1",
          updated_at: NOW - 3600,
          value: "{}",
        },
        {
          key: "yield-coverage-audit",
          updated_at: NOW - 86400,
          value: "{}",
        },
      ]),
      NOW,
      { "sync-yield-data": cron() },
    );

    expect(summary).toMatchObject({
      status: "healthy",
      statusImpact: "admin-watch",
      rankingCount: 2,
      rankingUpdatedAt: NOW - 600,
      rankingAgeSec: 600,
      rankingStatus: "healthy",
      safetyCoverage: {
        coveredCount: 84,
        trackedCount: 100,
        coverageRatio: 0.84,
        status: "healthy",
      },
      supplemental: {
        ageSec: 3600,
        status: "healthy",
      },
      benchmark: {
        ageSec: 3600,
        source: "tbill-cache",
        isFallback: false,
        status: "healthy",
      },
      coverageAudit: {
        ageSec: 86400,
        status: "healthy",
      },
      sourceRiskCoverage: {
        totalRows: 2,
        bestRows: 2,
        altRows: 0,
        rowsWithSourceRisk: 0,
      },
      latestCronStatus: "ok",
      latestCronStartedAt: NOW - 120,
    });
    expect(summary.sourceRiskCoverage.fields.sourceRiskScore.nullRate).toBe(1);
    expect(summary.sourceRiskCoverage.fields.sourceRiskPenalty.coverageRatio).toBe(0);
  });

  it("reports source-risk field coverage and null rates across best and alternate rows", async () => {
    const summary = await loadYieldHealthSummary(
      makeDb([
        {
          key: "yield-rankings",
          updated_at: NOW - 300,
          value: JSON.stringify({
            updatedAt: NOW - 300,
            rankings: [
              {
                id: "usdc-circle",
                sourceRisk: {
                  sourceRiskPenalty: 1,
                  sourceDepthRatio: 0.12,
                  rewardShare: 0,
                  sourceAgeSeconds: 120,
                  observationCount30d: 10,
                  sourceSwitchCount30d: 1,
                  venueRiskTier: "unknown",
                },
                altSources: [
                  {
                    sourceRisk: {
                      sourceRiskPenalty: 1,
                      sourceAgeSeconds: 600,
                      observationCount30d: 2,
                      venueRiskTier: "high",
                    },
                  },
                ],
              },
            ],
            provenance: {
              safetySnapshot: {
                coverageRatio: 1,
                coveredCount: 1,
                trackedCount: 1,
                reason: null,
              },
              benchmark: {
                fetchedAt: NOW - 3600,
                ageSeconds: 3600,
                source: "tbill-cache",
                isFallback: false,
                fallbackMode: null,
              },
            },
          }),
        },
        {
          key: "yield:supplemental-sources:v1",
          updated_at: NOW - 3600,
          value: "{}",
        },
        {
          key: "yield-coverage-audit",
          updated_at: NOW - 86400,
          value: "{}",
        },
      ]),
      NOW,
      { "sync-yield-data": cron() },
    );

    expect(summary.sourceRiskCoverage).toMatchObject({
      totalRows: 2,
      bestRows: 1,
      altRows: 1,
      rowsWithSourceRisk: 2,
    });
    expect(summary.sourceRiskCoverage.fields.sourceRiskPenalty).toMatchObject({
      eligibleCount: 2,
      populatedCount: 2,
      nullRate: 0,
    });
    expect(summary.sourceRiskCoverage.fields.sourceRiskScore).toMatchObject({
      eligibleCount: 2,
      populatedCount: 0,
      nullRate: 1,
    });
    expect(summary.sourceRiskCoverage.fields.sourceSwitchCount30d).toMatchObject({
      eligibleCount: 1,
      populatedCount: 1,
      nullRate: 0,
    });
    expect(summary.sourceRiskCoverage.fields.venueRiskTier).toMatchObject({
      eligibleCount: 2,
      populatedCount: 1,
      nullRate: 0.5,
    });
  });

  it("keeps sparse non-ranking signals as admin watch and marks missing rankings public critical", async () => {
    const summary = await loadYieldHealthSummary(makeDb([]), NOW, { "sync-yield-data": cron("error") });

    expect(summary.status).toBe("stale");
    expect(summary.statusImpact).toBe("public-critical");
    expect(summary.rankingStatus).toBe("stale");
    expect(summary.rankingCount).toBeNull();
    expect(summary.safetyCoverage.status).toBe("unknown");
    expect(summary.supplemental.status).toBe("unknown");
    expect(summary.benchmark.status).toBe("unknown");
    expect(summary.coverageAudit.status).toBe("unknown");
    expect(summary.sourceRiskCoverage.totalRows).toBe(0);
    expect(summary.latestCronStatus).toBe("error");
  });

  it("classifies low safety coverage and retained benchmark fallback as degraded admin-watch", async () => {
    const summary = await loadYieldHealthSummary(
      makeDb([
        {
          key: "yield-rankings",
          updated_at: NOW - 300,
          value: JSON.stringify({
            rankings: [{ id: "usdc-circle" }],
            provenance: {
              safetySnapshot: {
                coverageRatio: 0.5,
                coveredCount: 1,
                trackedCount: 2,
                reason: "low-row-safety-coverage",
              },
              benchmark: {
                fetchedAt: NOW - 3 * 3600,
                ageSeconds: 3 * 3600,
                source: "risk_free_rates",
                isFallback: true,
                fallbackMode: "retained-last-good",
              },
            },
          }),
        },
        {
          key: "yield:supplemental-sources:v1",
          updated_at: NOW - 10 * 3600,
          value: "{}",
        },
        {
          key: "yield-coverage-audit",
          updated_at: NOW - 60 * 86400,
          value: "{}",
        },
      ]),
      NOW,
      { "sync-yield-data": cron("degraded") },
    );

    expect(summary.status).toBe("degraded");
    expect(summary.statusImpact).toBe("admin-watch");
    expect(summary.rankingStatus).toBe("healthy");
    expect(summary.safetyCoverage.status).toBe("degraded");
    expect(summary.benchmark.status).toBe("degraded");
    expect(summary.supplemental.status).toBe("degraded");
    expect(summary.coverageAudit.status).toBe("degraded");
  });

  it("uses fresh per-family supplemental caches when the aggregate is stale", async () => {
    const summary = await loadYieldHealthSummary(
      makeDb([
        {
          key: "yield-rankings",
          updated_at: NOW - 300,
          value: JSON.stringify({
            rankings: [],
            provenance: {
              safetySnapshot: { coverageRatio: 1, coveredCount: 1, trackedCount: 1, reason: null },
              benchmark: { fetchedAt: NOW - 3600, ageSeconds: 3600, source: "tbill-cache", isFallback: false },
            },
          }),
        },
        {
          key: "yield:supplemental-sources:v1",
          updated_at: NOW - 20 * 3600,
          value: JSON.stringify({ sourceCount: 20 }),
        },
        ...["morpho", "pendle", "yearnKong", "beefy", "compoundV3", "aaveV3"].map((family) => ({
          key: `yield:supplemental-sources:v1:${family}`,
          updated_at: NOW - 1800,
          value: JSON.stringify({ sourceCount: 2 }),
        })),
        {
          key: "yield-coverage-audit",
          updated_at: NOW - 86400,
          value: "{}",
        },
      ]),
      NOW,
      { "sync-yield-data": cron() },
    );

    expect(summary.supplemental).toMatchObject({
      status: "healthy",
      familyCount: 6,
      freshFamilyCount: 6,
      missingFamilyCount: 0,
    });
  });

  it("surfaces partial supplemental family health", async () => {
    const summary = await loadYieldHealthSummary(
      makeDb([
        {
          key: "yield-rankings",
          updated_at: NOW - 300,
          value: JSON.stringify({
            rankings: [],
            provenance: {
              safetySnapshot: { coverageRatio: 1, coveredCount: 1, trackedCount: 1, reason: null },
              benchmark: { fetchedAt: NOW - 3600, ageSeconds: 3600, source: "tbill-cache", isFallback: false },
            },
          }),
        },
        {
          key: "yield:supplemental-sources:v1:morpho",
          updated_at: NOW - 1800,
          value: JSON.stringify({ sourceCount: 4 }),
        },
        {
          key: "yield:supplemental-sources:v1:beefy",
          updated_at: NOW - 20 * 3600,
          value: JSON.stringify({ sourceCount: 1 }),
        },
        {
          key: "yield-coverage-audit",
          updated_at: NOW - 86400,
          value: "{}",
        },
      ]),
      NOW,
      { "sync-yield-data": cron() },
    );

    expect(summary.supplemental.status).toBe("degraded");
    expect(summary.supplemental.freshFamilyCount).toBe(1);
    expect(summary.supplemental.degradedFamilyCount).toBe(1);
    expect(summary.supplemental.staleFamilyCount).toBe(0);
    expect(summary.supplemental.missingFamilyCount).toBe(4);
    expect(summary.supplemental.families?.morpho?.sourceCount).toBe(4);
  });
});
