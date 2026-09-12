import { describe, expect, it } from "vitest";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { loadYieldHealthSummary } from "../yield-health";
import type { CronRunStatus, CronStatus } from "@shared/types/status";
import { YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC } from "@shared/lib/yield-safety-fallback";
import {
  emptyYieldAudit,
  healthyYieldProvenance,
  liveShapeRankings,
  liveShapeSourceRows,
  stampedSafetyIdentity,
  yieldCacheRow,
} from "./yield-health.test-support";

const NOW = 1_777_000_000;
const SUPPLEMENTAL_SOURCE_FAMILIES = [
  "morpho",
  "pendle",
  "yearnKong",
  "beefy",
  "vaultsFyi",
  "compoundV3",
  "aaveV3",
  "roycoDawn",
] as const;

function supplementalFamilyRows(updatedAt: number, sourceCount = 0) {
  return SUPPLEMENTAL_SOURCE_FAMILIES.map((family) => (yieldCacheRow(`yield:supplemental-sources:v1:${family}`, updatedAt, { sourceCount })));
}

function cron(status: CronRunStatus = "ok", ageSec = 120, metadata?: Record<string, unknown>): CronStatus {
  return {
    expectedIntervalSec: CRON_INTERVALS["sync-yield-data"],
    healthy: true,
    recentRuns: [],
    lastRun: {
      startedAt: NOW - ageSec,
      durationMs: 1000,
      status,
      ...(metadata ? { metadata } : {}),
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
        yieldCacheRow("yield-rankings", NOW - 600, {
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
        {
          key: "yield:supplemental-sources:v1",
          updated_at: NOW - 3600,
          value: "{}",
        },
        ...supplementalFamilyRows(NOW - 3600),
        yieldCacheRow("yield-coverage-audit", NOW - 86400, emptyYieldAudit()),
      ]),
      NOW,
      { "sync-yield-data": cron() },
    );

    expect(summary).toMatchObject({
      status: "degraded",
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
        familyCount: 7,
        freshFamilyCount: 7,
        degradedFamilyCount: 0,
        staleFamilyCount: 0,
        missingFamilyCount: 0,
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
        headlineGapCount: 0,
        recommendationCandidateCount: 0,
      },
      sourceRiskCoverage: {
        status: "degraded",
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

  it("surfaces durable coverage-audit operator queue persistence", async () => {
    const summary = await loadYieldHealthSummary(
      makeDb([
        yieldCacheRow("yield-rankings", NOW - 600, {
          updatedAt: NOW - 600,
          rankings: [{ id: "usdc-circle" }],
        }),
        yieldCacheRow("yield-coverage-audit", NOW - 600, {
          operatorQueue: {
            persistence: "durable",
            promotionMode: "human-reviewed",
            allowedActions: ["accept", "dismiss", "intentional-gap", "watch"],
            headlineGaps: [
              {
                id: "manifest-missing:eurc",
                kind: "manifest-missing",
                title: "eurc",
                detail: "Yield-bearing tracked asset has no adapter-manifest entry.",
                actionHint: "accept",
                stablecoinIds: ["eurc"],
              },
            ],
            recommendationCandidates: [],
            suppressedItemCount: 0,
          },
        }),
      ]),
      NOW,
      { "sync-yield-data": cron() },
    );

    expect(summary.coverageAudit).toMatchObject({
      allowedActions: ["accept", "dismiss", "intentional-gap", "watch"],
      queuePersistence: "durable",
    });
    expect(summary.coverageAudit.headlineGaps).toEqual([
      expect.objectContaining({
        id: "manifest-missing:eurc",
        kind: "manifest-missing",
      }),
    ]);
  });

  it("treats a valid empty operator queue as authoritative after disposition filtering", async () => {
    const summary = await loadYieldHealthSummary(
      makeDb([
        yieldCacheRow("yield-coverage-audit", NOW - 600, {
          manifestMissingIds: ["dismissed-manifest-item"],
          staleVenueRiskScores: [{ protocol: "dismissed-venue-item" }],
          operatorQueue: {
            persistence: "durable",
            promotionMode: "human-reviewed",
            allowedActions: ["accept", "dismiss", "intentional-gap", "watch"],
            headlineGaps: [],
            recommendationCandidates: [],
            suppressedItemCount: 2,
          },
        }),
      ]),
      NOW,
      { "sync-yield-data": cron() },
    );

    expect(summary.coverageAudit).toMatchObject({
      headlineGapCount: 1,
      recommendationCandidateCount: 1,
      allowedActions: ["accept", "dismiss", "intentional-gap", "watch"],
      queuePersistence: "durable",
      headlineGaps: [],
      recommendationCandidates: [],
    });
  });

  it("returns an unavailable queue for a missing current operator-queue contract", async () => {
    const summary = await loadYieldHealthSummary(
      makeDb([yieldCacheRow("yield-coverage-audit", NOW - 600, {
        manifestMissingIds: ["legacy-item-must-not-reappear"],
      })]),
      NOW,
      { "sync-yield-data": cron() },
    );

    expect(summary.coverageAudit).toMatchObject({
      allowedActions: ["accept", "dismiss", "intentional-gap", "watch"],
      queuePersistence: "deferred",
      headlineGaps: [],
      recommendationCandidates: [],
    });
  });

  it("returns an unavailable queue for a malformed current operator-queue contract", async () => {
    const summary = await loadYieldHealthSummary(
      makeDb([yieldCacheRow("yield-coverage-audit", NOW - 600, {
        manifestMissingIds: ["legacy-item-must-not-reappear"],
        operatorQueue: {
          persistence: "durable",
          headlineGaps: "not-an-array",
          recommendationCandidates: [],
        },
      })]),
      NOW,
      { "sync-yield-data": cron() },
    );

    expect(summary.coverageAudit).toMatchObject({
      allowedActions: ["accept", "dismiss", "intentional-gap", "watch"],
      queuePersistence: "deferred",
      headlineGaps: [],
      recommendationCandidates: [],
    });
  });

  it("degrades aggregate health when a published non-USD benchmark is stale behind fresh USD", async () => {
    const sourceRisk = {
      sourceRiskScore: 0,
      sourceRiskPenalty: 1,
      sourceDepthRatio: 0.1,
      rewardShare: 0,
      sourceAgeSeconds: 60,
      observationCount30d: 10,
      venueRiskTier: "low",
    };
    const benchmark = (key: string, fetchedAt: number, source: string) => ({
      key,
      label: `${key} benchmark`,
      currency: key,
      rate: 4,
      recordDate: "2026-04-20",
      fetchedAt,
      ageSeconds: NOW - fetchedAt,
      source,
      isFallback: false,
      fallbackMode: null,
    });
    const usd = benchmark("USD", NOW - 3600, "fred-dgs3mo");
    const gbp = benchmark("GBP", NOW - 49 * 3600, "fred-sonia-compounded-index");
    const summary = await loadYieldHealthSummary(
      makeDb([
        yieldCacheRow("yield-rankings", NOW - 300, {
          updatedAt: NOW - 300,
          rankings: [
            { id: "usdc-circle", benchmarkKey: "USD", sourceRisk },
            { id: "tgbp-tokenised", benchmarkKey: "GBP", sourceRisk },
          ],
          benchmarks: { USD: usd, GBP: gbp },
          provenance: {
            safetySnapshot: {
              coverageRatio: 1,
              coveredCount: 2,
              trackedCount: 2,
              reason: null,
            },
            benchmark: usd,
            benchmarks: { USD: usd, GBP: gbp },
          },
        }),
        ...supplementalFamilyRows(NOW - 3600),
        yieldCacheRow("yield-coverage-audit", NOW - 86400, emptyYieldAudit()),
      ]),
      NOW,
      { "sync-yield-data": cron() },
    );

    expect(summary.status).toBe("degraded");
    expect(summary.benchmark.status).toBe("healthy");
    expect(summary.benchmarkRegistry).toMatchObject({
      status: "degraded",
      usedBenchmarkCount: 2,
      healthyBenchmarkCount: 1,
      staleBenchmarkCount: 1,
      degradedBenchmarkCount: 0,
      unknownBenchmarkCount: 0,
      benchmarks: {
        USD: { status: "healthy", rowCount: 1 },
        GBP: { status: "stale", rowCount: 1, ageSec: 49 * 3600 },
      },
    });
  });

  it("surfaces comparison-anchor freshness without affecting top-level yield health", async () => {
    const summary = await loadYieldHealthSummary(
      makeDb([
        yieldCacheRow("yield-rankings", NOW - 300, {
          updatedAt: NOW - 300,
          rankings: [{
            id: "usde-ethena",
            sourceRisk: {
              sourceRiskScore: 0,
              sourceRiskPenalty: 1,
              sourceDepthRatio: 0.12,
              rewardShare: 0,
              sourceAgeSeconds: 120,
              observationCount30d: 10,
              venueRiskTier: "low",
            },
          }],
          provenance: healthyYieldProvenance(NOW, 1),
        }),
        ...supplementalFamilyRows(NOW - 3600),
        yieldCacheRow("yield-coverage-audit", NOW - 86400, emptyYieldAudit()),
      ]),
      NOW,
      {
        "sync-yield-data": cron("ok", 120, {
          sourceCoverage: {
            comparisonAnchorFreshness: {
              anchoredRowCount: 2,
              staleAnchorCount: 1,
              oldestAnchorAgeSeconds: 15 * 86400,
              oldestAnchorStablecoinId: "usde-ethena",
              oldestAnchorSourceKey: "onchain:usde-ethena",
              staleAnchorExamples: [{
                stablecoinId: "usde-ethena",
                symbol: "USDe",
                sourceKey: "onchain:usde-ethena",
                dataSource: "onchain",
                anchorAgeSeconds: 15 * 86400,
                comparisonAnchorObservedAt: NOW - 15 * 86400,
              }],
              staleAnchorExamplesTruncated: false,
            },
          },
        }),
      },
    );

    expect(summary.status).toBe("healthy");
    expect(summary.comparisonAnchorFreshness).toEqual({
      status: "degraded",
      anchoredRowCount: 2,
      staleAnchorCount: 1,
      oldestAnchorAgeSeconds: 15 * 86400,
      oldestAnchorStablecoinId: "usde-ethena",
      oldestAnchorSourceKey: "onchain:usde-ethena",
      staleAnchorExamples: [{
        stablecoinId: "usde-ethena",
        symbol: "USDe",
        sourceKey: "onchain:usde-ethena",
        dataSource: "onchain",
        anchorAgeSeconds: 15 * 86400,
        comparisonAnchorObservedAt: NOW - 15 * 86400,
      }],
      staleAnchorExamplesTruncated: false,
    });
  });

  it("reads ranking deltas from coverage-regression guard metadata", async () => {
    const summary = await loadYieldHealthSummary(
      makeDb([
        yieldCacheRow("yield-rankings", NOW - 300, {
          updatedAt: NOW - 300,
          rankings: [{ id: "usdc-circle" }, { id: "usdt-tether" }],
          provenance: healthyYieldProvenance(NOW, 2),
        }),
        ...supplementalFamilyRows(NOW - 3600),
        yieldCacheRow("yield-coverage-audit", NOW - 86400, emptyYieldAudit()),
      ]),
      NOW,
      {
        "sync-yield-data": cron("degraded", 120, {
          reason: "published-ranking-coverage-regression",
          previousPublishedRankingCount: 11,
          currentPublishedRankingCount: 2,
          publishedRankingCountDelta: -9,
        }),
      },
    );

    expect(summary.previousRankingCount).toBe(11);
    expect(summary.rankingCountDelta).toBe(-9);
  });

  it("reports source-risk field coverage and null rates across best and alternate rows", async () => {
    const summary = await loadYieldHealthSummary(
      makeDb([
        yieldCacheRow("yield-rankings", NOW - 300, {
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
          provenance: healthyYieldProvenance(NOW, 1),
        }),
        ...supplementalFamilyRows(NOW - 3600),
        yieldCacheRow("yield-coverage-audit", NOW - 86400, {
          manifestMissingIds: ["missing-yield-asset"],
          yieldBearingMissingFromRankings: ["missing-ranking-asset"],
          unmatchedHighTvlPoolCount: 2,
          missingProtocols: [{ project: "new-protocol", pool: "new-pool", symbol: "USDC", chain: "Ethereum" }],
          nativeExactPoolRecommendationCount: 3,
          sourceFamilyAdapterRecommendations: [{
            project: "aave-v3",
            poolCount: 1,
            totalTvlUsd: 12_000_000,
            recommendedTier: "review-needed",
            examplePools: ["aave-usdc"],
          }],
          lendingAllowlistRecommendationCount: 5,
          venueRiskConfigMissingCount: 1,
          staleAutoLendingOverrideCount: 0,
          staleVenueRiskScoreCount: 2,
          staleVenueRiskScores: [
            { protocol: "aave-v3", reviewedAt: "2026-05-15", ageDays: 109, confidence: "verified" },
            { protocol: "maple", reviewedAt: "2026-06-09", ageDays: 94, confidence: "partial" },
          ],
        }),
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
    expect(summary.coverageAudit).toMatchObject({
      headlineGapCount: 5,
      recommendationCandidateCount: 12,
      manifestMissingCount: 1,
      yieldBearingMissingFromRankingsCount: 1,
      unmatchedHighTvlPoolCount: 2,
      missingProtocolCount: 1,
      nativeExactPoolRecommendationCount: 3,
      sourceFamilyAdapterRecommendationCount: 1,
      lendingAllowlistRecommendationCount: 5,
      venueRiskConfigMissingCount: 1,
      staleAutoLendingOverrideCount: 0,
      staleVenueRiskScoreCount: 2,
      allowedActions: ["accept", "dismiss", "intentional-gap", "watch"],
      queuePersistence: "deferred",
      headlineGaps: [],
      recommendationCandidates: [],
    });
  });

  it("treats unknown venue risk tiers as missing evidence for penalty coverage", async () => {
    const summary = await loadYieldHealthSummary(
      makeDb([
        yieldCacheRow("yield-rankings", NOW - 300, {
          updatedAt: NOW - 300,
          rankings: [
            {
              id: "usdc-circle",
              sourceRisk: {
                sourceRiskPenalty: 1,
                venueRiskTier: "unknown",
              },
            },
          ],
          provenance: healthyYieldProvenance(NOW, 1),
        }),
        ...supplementalFamilyRows(NOW - 3600),
        {
          key: "yield-coverage-audit",
          updated_at: NOW - 86400,
          value: "{}",
        },
      ]),
      NOW,
      { "sync-yield-data": cron() },
    );

    expect(summary.sourceRiskCoverage.fields.venueRiskTier).toMatchObject({
      eligibleCount: 1,
      populatedCount: 0,
      nullRate: 1,
    });
    expect(summary.sourceRiskCoverage.fields.sourceRiskPenalty).toMatchObject({
      eligibleCount: 1,
      populatedCount: 0,
      nullRate: 1,
    });
  });

  it("rejects fresh non-object ranking cache payloads as missing rankings", async () => {
    for (const value of ["[]", "0", "true", JSON.stringify("text")]) {
      const summary = await loadYieldHealthSummary(
        makeDb([
          {
            key: "yield-rankings",
            updated_at: NOW - 60,
            value,
          },
          {
            key: "yield:supplemental-sources:v1:morpho",
            updated_at: NOW - 60,
            value: "[]",
          },
          {
            key: "yield-coverage-audit",
            updated_at: NOW - 60,
            value: "true",
          },
        ]),
        NOW,
        { "sync-yield-data": cron() },
      );

      expect(summary.rankingStatus).toBe("stale");
      expect(summary.statusImpact).toBe("public-critical");
      expect(summary.rankingCount).toBeNull();
      expect(summary.supplemental.families?.morpho?.sourceCount).toBeNull();
      expect(summary.coverageAudit.manifestMissingCount).toBeNull();
    }
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
        yieldCacheRow("yield-rankings", NOW - 300, {
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
        ...supplementalFamilyRows(NOW - 10 * 3600),
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

  it("uses fresh per-family supplemental caches without aggregate fallback", async () => {
    const db = makeDb([
        yieldCacheRow("yield-rankings", NOW - 300, {
          rankings: [],
          provenance: {
            safetySnapshot: { coverageRatio: 1, coveredCount: 1, trackedCount: 1, reason: null },
            benchmark: { fetchedAt: NOW - 3600, ageSeconds: 3600, source: "tbill-cache", isFallback: false },
          },
        }),
        yieldCacheRow("yield:supplemental-sources:v1", NOW - 20 * 3600, { sourceCount: 20 }),
        ...["morpho", "pendle", "yearnKong", "beefy", "compoundV3", "aaveV3", "roycoDawn"].map((family) => (yieldCacheRow(`yield:supplemental-sources:v1:${family}`, NOW - 1800, { sourceCount: 2 }))),
        {
          key: "yield-coverage-audit",
          updated_at: NOW - 86400,
          value: "{}",
        },
      ]);
    const summary = await loadYieldHealthSummary(
      db,
      NOW,
      { "sync-yield-data": cron() },
    );

    expect(summary.supplemental).toMatchObject({
      status: "healthy",
      familyCount: 7,
      freshFamilyCount: 7,
      missingFamilyCount: 0,
    });
  });

  it("surfaces partial supplemental family health", async () => {
    const summary = await loadYieldHealthSummary(
      makeDb([
        yieldCacheRow("yield-rankings", NOW - 300, {
          rankings: [],
          provenance: {
            safetySnapshot: { coverageRatio: 1, coveredCount: 1, trackedCount: 1, reason: null },
            benchmark: { fetchedAt: NOW - 3600, ageSeconds: 3600, source: "tbill-cache", isFallback: false },
          },
        }),
        yieldCacheRow("yield:supplemental-sources:v1:morpho", NOW - 1800, { sourceCount: 4 }),
        yieldCacheRow("yield:supplemental-sources:v1:beefy", NOW - 20 * 3600, { sourceCount: 1 }),
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
    expect(summary.supplemental.missingFamilyCount).toBe(5);
    expect(summary.supplemental.families?.morpho?.sourceCount).toBe(4);
  });

  it("reports a fresh non-fallback USD feed with proxy-selecting rows as healthy", async () => {
    const rows = liveShapeSourceRows();
    const usd = {
      key: "USD",
      label: "USD 3M T-Bill",
      currency: "USD",
      rate: 3.95,
      recordDate: new Date((NOW - 2 * 86400) * 1000).toISOString().slice(0, 10),
      fetchedAt: NOW - 59_920,
      source: "fred-dgs3mo",
      isFallback: false,
      fallbackMode: null,
    };
    const summary = await loadYieldHealthSummary(
      makeDb([
        yieldCacheRow("yield-rankings", NOW - 300, {
          updatedAt: NOW - 300,
          rankings: liveShapeRankings(rows),
          benchmarks: { USD: usd, EUR: { ...usd, key: "EUR", currency: "EUR", source: "ecb-estr" } },
          provenance: healthyYieldProvenance(NOW, 157),
        }),
        ...supplementalFamilyRows(NOW - 3600),
        yieldCacheRow("yield-coverage-audit", NOW - 86400, emptyYieldAudit()),
      ]),
      NOW,
      { "sync-yield-data": cron() },
    );

    expect(summary.benchmarkRegistry.benchmarks.USD).toMatchObject({
      status: "healthy",
      rowCount: 137,
      fallbackSelectionRowCount: 4,
      proxySelectionRowCount: 4,
    });
    expect(summary.benchmarkRegistry.status).toBe("healthy");
  });

  it("measures source-risk coverage over rows that can carry each field", async () => {
    const rows = liveShapeSourceRows();
    const summary = await loadYieldHealthSummary(
      makeDb([
        yieldCacheRow("yield-rankings", NOW - 300, {
          updatedAt: NOW - 300,
          rankings: liveShapeRankings(rows),
          provenance: healthyYieldProvenance(NOW, 157),
        }),
        ...supplementalFamilyRows(NOW - 3600),
        yieldCacheRow("yield-coverage-audit", NOW - 86400, emptyYieldAudit()),
      ]),
      NOW,
      { "sync-yield-data": cron() },
    );

    expect(summary.sourceRiskCoverage).toMatchObject({ totalRows: 270, bestRows: 157, altRows: 113 });
    // 64 derivation-method rows have no venue, so they leave the depth denominator.
    expect(summary.sourceRiskCoverage.fields.sourceDepthRatio).toMatchObject({
      eligibleCount: 206,
      populatedCount: 199,
      ineligibleCount: 64,
      coverageRatio: 0.966,
    });
    // 98 rows publish one undivided rate, so they leave the reward denominator.
    expect(summary.sourceRiskCoverage.fields.rewardShare).toMatchObject({
      eligibleCount: 172,
      populatedCount: 172,
      coverageRatio: 1,
    });
    expect(summary.sourceRiskCoverage.fields.venueRiskTier).toMatchObject({
      eligibleCount: 206,
      bestEligibleCount: 93,
      altEligibleCount: 113,
      coverageRatio: 0,
    });
  });

  it("returns a null coverage ratio when no row can carry the field", async () => {
    const summary = await loadYieldHealthSummary(
      makeDb([
        yieldCacheRow("yield-rankings", NOW - 300, {
          updatedAt: NOW - 300,
          rankings: [{
            id: "usdy-ondo",
            dataSource: "price-derived",
            apyBase: 4,
            apyReward: null,
            sourceRisk: { sourceRiskPenalty: 1, sourceAgeSeconds: 60, observationCount30d: 4, deploymentPlace: "price-derived" },
          }],
          provenance: healthyYieldProvenance(NOW, 1),
        }),
        ...supplementalFamilyRows(NOW - 3600),
        yieldCacheRow("yield-coverage-audit", NOW - 86400, emptyYieldAudit()),
      ]),
      NOW,
      { "sync-yield-data": cron() },
    );

    expect(summary.sourceRiskCoverage.fields.rewardShare.coverageRatio).toBeNull();
    expect(summary.sourceRiskCoverage.fields.sourceDepthRatio.eligibleCount).toBe(0);
    expect(summary.sourceRiskCoverage.fields.venueRiskTier.coverageRatio).toBeNull();
  });

  it("requires two evidence families for penalty coverage and a populated field for sourceRisk", async () => {
    const summary = await loadYieldHealthSummary(
      makeDb([
        yieldCacheRow("yield-rankings", NOW - 300, {
          updatedAt: NOW - 300,
          rankings: [
            { id: "one-family", dataSource: "defillama", sourceRisk: { sourceRiskPenalty: 1.2, sourceAgeSeconds: 90 } },
            { id: "empty-risk", dataSource: "defillama", sourceRisk: {} },
          ],
          provenance: healthyYieldProvenance(NOW, 2),
        }),
        ...supplementalFamilyRows(NOW - 3600),
        yieldCacheRow("yield-coverage-audit", NOW - 86400, emptyYieldAudit()),
      ]),
      NOW,
      { "sync-yield-data": cron() },
    );

    expect(summary.sourceRiskCoverage.fields.sourceRiskPenalty.populatedCount).toBe(0);
    expect(summary.sourceRiskCoverage.rowsWithSourceRisk).toBe(1);
  });

  it("reports fetched-but-unused keys without degrading, and unknown published keys with degrading", async () => {
    const meta = (key: string, recordDate: string) => ({
      key,
      currency: key,
      rate: 4,
      recordDate,
      fetchedAt: NOW - 3600,
      source: `feed-${key.toLowerCase()}`,
      isFallback: false,
      fallbackMode: null,
    });
    const summary = await loadYieldHealthSummary(
      makeDb([
        yieldCacheRow("yield-rankings", NOW - 300, {
          updatedAt: NOW - 300,
          rankings: [
            { id: "usdc-circle", benchmarkKey: "USD" },
            { id: "mystery-coin", benchmarkKey: "XYZ" },
          ],
          benchmarks: {
            USD: meta("USD", new Date((NOW - 86400) * 1000).toISOString().slice(0, 10)),
            CAD: meta("CAD", new Date((NOW - 42 * 86400) * 1000).toISOString().slice(0, 10)),
          },
          provenance: healthyYieldProvenance(NOW, 2),
        }),
        ...supplementalFamilyRows(NOW - 3600),
        yieldCacheRow("yield-coverage-audit", NOW - 86400, emptyYieldAudit()),
      ]),
      NOW,
      { "sync-yield-data": cron() },
    );

    expect(summary.benchmarkRegistry.benchmarks.USD?.status).toBe("healthy");
    expect(summary.benchmarkRegistry.benchmarks.XYZ).toBeUndefined();
    expect(summary.benchmarkRegistry.unusedBenchmarkKeys).toEqual([
      expect.objectContaining({ key: "CAD", source: "feed-cad" }),
    ]);
    expect(summary.benchmarkRegistry.unusedBenchmarkKeys?.[0]?.recordAgeSec).toBeGreaterThan(41 * 86400);
    expect(summary.benchmarkRegistry.unknownKeys).toEqual(["XYZ"]);
    expect(summary.benchmarkRegistry.unknownKeyRowCount).toBe(1);
    expect(summary.benchmarkRegistry.status).toBe("degraded");
  });

  it("classifies ranking freshness on the public yield-data 2x/4x bands", async () => {
    const interval = CRON_INTERVALS["sync-yield-data"];
    const cases: Array<[number, string]> = [
      [interval * 2, "healthy"],
      [interval * 2 + 60, "degraded"],
      [interval * 4, "degraded"],
      [interval * 4 + 60, "stale"],
    ];
    for (const [ageSec, expected] of cases) {
      const summary = await loadYieldHealthSummary(
        makeDb([
          yieldCacheRow("yield-rankings", NOW - ageSec, {
            updatedAt: NOW - ageSec,
            rankings: [{ id: "usdc-circle" }],
            provenance: healthyYieldProvenance(NOW, 1),
          }),
          ...supplementalFamilyRows(NOW - 3600),
          yieldCacheRow("yield-coverage-audit", NOW - 86400, emptyYieldAudit()),
        ]),
        NOW,
        { "sync-yield-data": cron() },
      );
      expect(`${ageSec}:${summary.rankingStatus}`).toBe(`${ageSec}:${expected}`);
    }
  });

  it("degrades a fresh coverage audit whose queue exceeds the documented drain budget", async () => {
    const summary = await loadYieldHealthSummary(
      makeDb([
        yieldCacheRow("yield-coverage-audit", NOW - 600, emptyYieldAudit({
          manifestMissingCount: 200,
          nativeExactPoolRecommendationCount: 10,
          queueTotals: { byKind: { "manifest-missing": 6 }, suppressedItemCount: 4, truncated: true },
          operatorQueue: {
            persistence: "durable",
            allowedActions: ["accept", "watch"],
            headlineGaps: [],
            recommendationCandidates: [],
          },
        })),
      ]),
      NOW,
      { "sync-yield-data": cron() },
    );

    expect(summary.coverageAudit.status).toBe("degraded");
    expect(summary.coverageAudit.headlineGapCount).toBe(200);
    expect(summary.coverageAudit.queueTotals).toEqual({
      byKind: { "manifest-missing": 6 },
      suppressedItemCount: 4,
      truncated: true,
    });
    expect(summary.coverageAudit.allowedActions).toEqual(["accept", "watch"]);
    expect(summary.coverageAudit.queueDisplayOnly).toBe(true);
  });

  it("degrades when the publisher persisted no PYS inputs for part of the run", async () => {
    const summary = await loadYieldHealthSummary(
      makeDb([yieldCacheRow("yield-rankings", NOW - 300, {
        updatedAt: NOW - 300,
        rankings: [{ id: "usdc-circle" }],
        provenance: healthyYieldProvenance(NOW, 1),
      })]),
      NOW,
      { "sync-yield-data": cron("ok", 120, { pysInputsPersistedCount: 100, pysInputsNullCount: 57 }) },
    );

    expect(summary.pysInputs).toMatchObject({
      status: "degraded",
      persistedCount: 100,
      nullCount: 57,
      nullRate: 0.3631,
    });
    expect(summary.status).toBe("degraded");
  });

  it("surfaces a publish-time-snapshot safety fallback and its stale-coherent expiry", async () => {
    const identityRow = { key: "safety-score-v9:publication", publication_identity: null };
    const loadWithAge = async (ageSec: number) => loadYieldHealthSummary(
      mockD1(
        [
          {
            match: "json_extract(value, '$.identity')",
            rows: [identityRow],
            first: identityRow,
          },
          {
            match: "yield-rankings",
            rows: [yieldCacheRow("yield-rankings", NOW - ageSec, {
              updatedAt: NOW - ageSec,
              rankings: [{ id: "usdc-circle" }],
              provenance: {
                safetySnapshot: {
                  coverageRatio: 1,
                  coveredCount: 1,
                  trackedCount: 1,
                  reason: null,
                  safetyScoreIdentity: stampedSafetyIdentity(),
                },
              },
            })],
          },
        ],
        { requireMatch: true },
      ),
      NOW,
      { "sync-yield-data": cron() },
    );

    const fresh = await loadWithAge(3600);
    expect(fresh.liveSafetyHydration).toMatchObject({
      status: "degraded",
      reason: "safety-snapshot-unavailable",
      fallback: "publish-time-snapshot",
    });

    const expired = await loadWithAge(YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC + 3600);
    expect(expired.liveSafetyHydration).toMatchObject({ status: "stale", fallback: null });
  });
});
