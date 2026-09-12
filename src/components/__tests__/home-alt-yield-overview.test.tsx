// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const useYieldRankingsSummaryMock = vi.fn();
const useYieldRankingsMock = vi.fn();

vi.mock("@/hooks/api-hooks", () => ({
  useYieldRankingsSummary: () => useYieldRankingsSummaryMock(),
  useYieldRankings: () => useYieldRankingsMock(),
}));

vi.mock("@/lib/logos", () => ({ logosById: {} }));

import { HomeAltYieldOverview } from "@/components/home-alt-yield-overview";
import type { YieldRankingsSummaryResponse } from "@shared/types/yield-summary";

function makeSummaryRow(id: string, symbol: string, apy30d: number, pys: number | null) {
  return {
    id,
    symbol,
    name: `${symbol} Stablecoin`,
    currentApy: apy30d,
    apy30d,
    yieldSource: "Compound V3",
    yieldType: "lending-opportunity" as const,
    dataSource: "protocol-api",
    sourceTvlUsd: 1_000_000,
    pharosYieldScore: pys,
    pysNullReason: null,
    safetyScore: 80,
    safetyGrade: "B+" as const,
    benchmarkKey: "USD" as const,
    benchmarkLabel: "USD 3M T-Bill",
    benchmarkRate: 4,
    yieldStability: 0.9,
    apyMin30d: 3,
    apyMax30d: 6,
    warningSignals: [],
    alternateSourceCount: 0,
    altSources: [],
  };
}

function makeSummaryPayload(
  safetySnapshot: { coveredCount: number; trackedCount: number } | null,
): YieldRankingsSummaryResponse {
  return {
    projection: "summary",
    rankings: [makeSummaryRow("usdc-circle", "USDC", 4.2, 61), makeSummaryRow("usdt-tether", "USDT", 3.1, 55)],
    riskFreeRate: 4,
    benchmarks: {},
    scalingFactor: 8,
    medianApy: 3.65,
    updatedAt: 1_783_632_600,
    provenance: {
      safetySnapshot,
    },
  } as unknown as YieldRankingsSummaryResponse;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("HomeAltYieldOverview", () => {
  it("reads the compact summary payload instead of the detail rankings payload", () => {
    useYieldRankingsSummaryMock.mockReturnValue({
      data: makeSummaryPayload({ coveredCount: 2, trackedCount: 3 }),
      isLoading: false,
    });
    useYieldRankingsMock.mockReturnValue({ data: undefined, isLoading: false });

    render(<HomeAltYieldOverview />);

    expect(useYieldRankingsSummaryMock).toHaveBeenCalled();
    expect(useYieldRankingsMock).not.toHaveBeenCalled();
    expect(screen.getAllByText("USDC").length).toBeGreaterThan(0);
    expect(screen.getByText("/3")).toBeDefined();
  });

  it("reports coverage as unknown when the payload carries no safety snapshot", () => {
    useYieldRankingsSummaryMock.mockReturnValue({
      data: makeSummaryPayload(null),
      isLoading: false,
    });

    render(<HomeAltYieldOverview />);

    // A degraded payload used to fall back to `rankings.length` and render
    // "2/2 covered" — the exact case where nothing was covered.
    expect(screen.queryByText(/^\/\d+$/)).toBeNull();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
