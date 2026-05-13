// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { YieldHealthCard } from "@/components/status/yield-health";
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

function makeHealth(overrides: Partial<YieldHealthSummary> = {}): YieldHealthSummary {
  return {
    status: "degraded",
    statusImpact: "admin-watch",
    runbookUrl: "/docs/runbooks/yield-health",
    rankingCount: 120,
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
    latestCronStatus: "ok",
    latestCronStartedAt: 1_700_000_000,
    ...overrides,
  };
}

describe("YieldHealthCard", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders per-family supplemental health counts", () => {
    render(<YieldHealthCard health={makeHealth()} />);

    expect(screen.getByText("1/4 fresh · 1 degraded · 1 stale · 1 missing")).toBeTruthy();
  });

  it("renders source-risk coverage and coverage audit queue counts", () => {
    render(<YieldHealthCard health={makeHealth()} />);

    expect(screen.getByText("80/120 rows with sourceRisk")).toBeTruthy();
    expect(screen.getByText("Warn below 75%")).toBeTruthy();
    expect(screen.getByText(/Coverage queue: 3 gaps · 5 candidates/)).toBeTruthy();
    expect(screen.getByText("Venue tier")).toBeTruthy();
    expect(screen.getByText("30%")).toBeTruthy();
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
          },
        })}
      />,
    );

    expect(screen.getByText("no ranking rows")).toBeTruthy();
    expect(screen.getByText(/Coverage queue: queue unavailable/)).toBeTruthy();
  });
});
