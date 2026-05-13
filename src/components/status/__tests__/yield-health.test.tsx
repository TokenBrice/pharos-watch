// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { YieldHealthCard } from "@/components/status/yield-health";
import type { YieldHealthSummary } from "@shared/types";

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
    },
    sourceRiskCoverage: {
      totalRows: 120,
      bestRows: 100,
      altRows: 20,
      rowsWithSourceRisk: 80,
      fields: {} as YieldHealthSummary["sourceRiskCoverage"]["fields"],
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
});
