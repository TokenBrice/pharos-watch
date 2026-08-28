// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { YieldHealthCard } from "@/components/status/yield-health";
import { SOURCE_RISK_GOLDEN_ROWS } from "@shared/test-utils/yield-source-risk-golden-fixtures";
import type { YieldHealthSummary } from "@shared/types";

function fieldCoverage(coverageRatio: number, eligibleCount = 120) {
  const populatedCount = Math.round(coverageRatio * eligibleCount);
  return {
    eligibleCount,
    populatedCount,
    nullCount: eligibleCount - populatedCount,
    coverageRatio,
    nullRate: eligibleCount > 0 ? (eligibleCount - populatedCount) / eligibleCount : 0,
  };
}

function sourceRiskGoldenCoverage(populatedCount: number, eligibleCount = SOURCE_RISK_GOLDEN_ROWS.length) {
  return {
    eligibleCount,
    populatedCount,
    nullCount: eligibleCount - populatedCount,
    coverageRatio: eligibleCount > 0 ? populatedCount / eligibleCount : 1,
    nullRate: eligibleCount > 0 ? (eligibleCount - populatedCount) / eligibleCount : 0,
  };
}

function makeHealth(overrides: Partial<YieldHealthSummary> = {}): YieldHealthSummary {
  return {
    status: "degraded",
    statusImpact: "admin-watch",
    runbookUrl: "/docs/runbooks/yield-health",
    rankingCount: 120,
    rankingCountDelta: 2,
    previousRankingCount: 118,
    rankingUpdatedAt: 1_700_000_000,
    rankingAgeSec: 900,
    rankingMaxAgeSec: 43_200,
    rankingStatus: "healthy",
    safetyCoverage: {
      coveredCount: 100,
      trackedCount: 120,
      coverageRatio: 100 / 120,
      threshold: 0.75,
      status: "healthy",
      reason: null,
    },
    supplemental: {
      updatedAt: 1_700_000_000,
      ageSec: 1800,
      maxAgeSec: 21_600,
      status: "degraded",
      familyCount: 4,
      freshFamilyCount: 1,
      degradedFamilyCount: 1,
      staleFamilyCount: 1,
      missingFamilyCount: 1,
    },
    benchmark: {
      fetchedAt: 1_700_000_000,
      ageSec: 1200,
      maxAgeSec: 172_800,
      source: "SOFR",
      isFallback: false,
      fallbackMode: null,
      status: "healthy",
    },
    benchmarkRegistry: {
      status: "degraded",
      usedBenchmarkCount: 2,
      healthyBenchmarkCount: 1,
      degradedBenchmarkCount: 0,
      staleBenchmarkCount: 1,
      unknownBenchmarkCount: 0,
      benchmarks: {
        USD: {
          key: "USD",
          label: "USD 3M T-Bill",
          currency: "USD",
          rowCount: 119,
          fallbackSelectionRowCount: 0,
          fetchedAt: 1_700_000_000,
          ageSec: 1200,
          maxAgeSec: 172_800,
          source: "SOFR",
          isFallback: false,
          fallbackMode: null,
          status: "healthy",
        },
        GBP: {
          key: "GBP",
          label: "GBP 3M compounded SONIA",
          currency: "GBP",
          rowCount: 1,
          fallbackSelectionRowCount: 0,
          fetchedAt: 1_699_800_000,
          ageSec: 200_000,
          maxAgeSec: 172_800,
          source: "SONIA",
          isFallback: true,
          fallbackMode: "retained",
          status: "stale",
        },
      },
    },
    coverageAudit: {
      updatedAt: 1_700_000_000,
      ageSec: 3600,
      maxAgeSec: 3_888_000,
      status: "healthy",
      headlineGapCount: 3,
      recommendationCandidateCount: 5,
      manifestMissingCount: 1,
      yieldBearingMissingFromRankingsCount: 1,
      unmatchedHighTvlPoolCount: 1,
      missingProtocolCount: 0,
      nativeExactPoolRecommendationCount: 2,
      sourceFamilyAdapterRecommendationCount: 1,
      lendingAllowlistRecommendationCount: 2,
      venueRiskConfigMissingCount: 0,
      staleAutoLendingOverrideCount: 0,
      staleVenueRiskScoreCount: 0,
      headlineGaps: [
        {
          id: "manifest-missing:coin-a",
          kind: "manifest-missing",
          title: "coin-a",
          detail: "Yield-bearing tracked asset has no adapter-manifest entry.",
          actionHint: "accept",
          stablecoinIds: ["coin-a"],
        },
      ],
      recommendationCandidates: [
        {
          id: "native-exact-pool:pool-a",
          kind: "native-exact-pool",
          title: "sUSDe on ethena",
          detail: "Ethereum native pool for susde-ethena",
          actionHint: "accept",
          stablecoinIds: ["susde-ethena"],
          project: "ethena",
          pool: "pool-a",
          symbol: "sUSDe",
          chain: "Ethereum",
          tvlUsd: 50_000_000,
          apy: 5.25,
        },
      ],
      allowedActions: ["accept", "dismiss", "intentional-gap", "watch"],
      queuePersistence: "deferred",
    },
    sourceRiskCoverage: {
      status: "degraded",
      threshold: 0.75,
      totalRows: 120,
      bestRows: 100,
      altRows: 20,
      rowsWithSourceRisk: 80,
      fields: {
        sourceRiskScore: fieldCoverage(0.25),
        sourceRiskPenalty: fieldCoverage(0.82),
        sourceDepthRatio: fieldCoverage(0.5),
        rewardShare: fieldCoverage(0.9),
        sourceAgeSeconds: fieldCoverage(0.85),
        observationCount30d: fieldCoverage(0.7),
        sourceSwitchCount30d: fieldCoverage(0.6, 100),
        deploymentPlace: fieldCoverage(0.4),
        venueProtocol: fieldCoverage(0.8),
        venueChain: fieldCoverage(0.8),
        venueRiskTier: fieldCoverage(0.3),
      },
    },
    comparisonAnchorFreshness: {
      status: "healthy",
      anchoredRowCount: 0,
      staleAnchorCount: 0,
      oldestAnchorAgeSeconds: null,
      oldestAnchorStablecoinId: null,
      oldestAnchorSourceKey: null,
      staleAnchorExamples: [],
      staleAnchorExamplesTruncated: false,
    },
    latestCronStatus: "ok",
    latestCronStartedAt: 1_700_000_000,
    ...overrides,
  };
}

describe("YieldHealthCard", () => {

  it("renders per-family supplemental health counts", () => {
    render(<YieldHealthCard health={makeHealth()} />);

    expect(screen.getByText("1/4 fresh · 1 degraded · 1 stale · 1 missing")).toBeTruthy();
    expect(screen.getByText(/\+2 vs 118/)).toBeTruthy();
    expect(screen.getByText("1/2 healthy · 0 degraded · 1 stale · 0 unknown")).toBeTruthy();
    expect(screen.getByText(/GBP · 1 row/)).toBeTruthy();
    expect(screen.getAllByText(/stale ·/).length).toBeGreaterThan(0);
  });

  it("renders source-risk coverage and coverage audit queue counts", () => {
    render(
      <YieldHealthCard
        health={makeHealth({
          coverageAudit: {
            ...makeHealth().coverageAudit,
            staleAutoLendingOverrideCount: 2,
          },
        })}
      />,
    );

    expect(screen.getByText("80/120 rows with sourceRisk")).toBeTruthy();
    expect(screen.getByText("Warn below 75%")).toBeTruthy();
    expect(screen.getByText(/Coverage queue: 3 gaps · 5 candidates · 2 stale overrides/)).toBeTruthy();
    expect(screen.getByText("Coverage audit operator queue")).toBeTruthy();
    expect(screen.getAllByText("coin-a").length).toBeGreaterThan(0);
    expect(screen.getByText("sUSDe on ethena")).toBeTruthy();
    expect(screen.getByText("Actions: accept, dismiss, intentional-gap, watch")).toBeTruthy();
    expect(screen.getByText("Venue tier")).toBeTruthy();
    expect(screen.getByText("30%")).toBeTruthy();
  });

  it("renders healthy source-risk coverage state", () => {
    render(
      <YieldHealthCard
        health={makeHealth({
          status: "healthy",
          sourceRiskCoverage: {
            status: "healthy",
            threshold: 0.75,
            totalRows: 120,
            bestRows: 100,
            altRows: 20,
            rowsWithSourceRisk: 120,
            fields: {
              sourceRiskScore: fieldCoverage(0.95),
              sourceRiskPenalty: fieldCoverage(0.98),
              sourceDepthRatio: fieldCoverage(0.94),
              rewardShare: fieldCoverage(0.96),
              sourceAgeSeconds: fieldCoverage(0.97),
              observationCount30d: fieldCoverage(0.92),
              sourceSwitchCount30d: fieldCoverage(0.9, 100),
              deploymentPlace: fieldCoverage(0.9),
              venueProtocol: fieldCoverage(0.93),
              venueChain: fieldCoverage(0.93),
              venueRiskTier: fieldCoverage(0.91),
            },
          },
        })}
      />,
    );

    expect(screen.getByText("120/120 rows with sourceRisk")).toBeTruthy();
    expect(screen.getByText("95%")).toBeTruthy();
    expect(screen.getByText("91%")).toBeTruthy();
  });

  it("renders missing source-risk coverage without crashing", () => {
    render(
      <YieldHealthCard
        health={makeHealth({
          sourceRiskCoverage: {
            status: "unknown",
            threshold: 0.75,
            totalRows: 0,
            bestRows: 0,
            altRows: 0,
            rowsWithSourceRisk: 0,
            fields: {} as YieldHealthSummary["sourceRiskCoverage"]["fields"],
          },
          coverageAudit: {
            ...makeHealth().coverageAudit,
            headlineGapCount: null,
            recommendationCandidateCount: null,
            headlineGaps: [],
            recommendationCandidates: [],
          },
        })}
      />,
    );

    expect(screen.getByText("no ranking rows")).toBeTruthy();
    expect(screen.getByText(/Coverage queue: queue unavailable/)).toBeTruthy();
  });

  it("renders source-risk coverage ratios derived from the shared golden fixture", () => {
    render(
      <YieldHealthCard
        health={makeHealth({
          sourceRiskCoverage: {
            status: "degraded",
            threshold: 0.75,
            totalRows: SOURCE_RISK_GOLDEN_ROWS.length,
            bestRows: SOURCE_RISK_GOLDEN_ROWS.length,
            altRows: 0,
            rowsWithSourceRisk: SOURCE_RISK_GOLDEN_ROWS.length,
            fields: {
              sourceRiskScore: sourceRiskGoldenCoverage(0),
              sourceRiskPenalty: sourceRiskGoldenCoverage(
                SOURCE_RISK_GOLDEN_ROWS.filter((row) => row.expectedDerivedPenalty > 1).length,
              ),
              sourceDepthRatio: sourceRiskGoldenCoverage(
                SOURCE_RISK_GOLDEN_ROWS.filter((row) => row.input.sourceDepthRatio != null).length,
              ),
              rewardShare: sourceRiskGoldenCoverage(
                SOURCE_RISK_GOLDEN_ROWS.filter((row) => row.input.rewardShare != null).length,
              ),
              sourceAgeSeconds: sourceRiskGoldenCoverage(
                SOURCE_RISK_GOLDEN_ROWS.filter((row) => row.input.sourceAgeSeconds != null).length,
              ),
              observationCount30d: sourceRiskGoldenCoverage(
                SOURCE_RISK_GOLDEN_ROWS.filter((row) => row.input.observationCount30d != null).length,
              ),
              sourceSwitchCount30d: sourceRiskGoldenCoverage(
                SOURCE_RISK_GOLDEN_ROWS.filter((row) => row.input.sourceSwitchCount30d != null).length,
              ),
              deploymentPlace: sourceRiskGoldenCoverage(0),
              venueProtocol: sourceRiskGoldenCoverage(0),
              venueChain: sourceRiskGoldenCoverage(0),
              venueRiskTier: sourceRiskGoldenCoverage(0),
            },
          },
        })}
      />,
    );

    expect(screen.getByText(`${SOURCE_RISK_GOLDEN_ROWS.length}/${SOURCE_RISK_GOLDEN_ROWS.length} rows with sourceRisk`)).toBeTruthy();
    expect(screen.getByText("63%")).toBeTruthy();
    expect(screen.getAllByText("13%").length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText("0%").length).toBeGreaterThanOrEqual(2);
  });
});
