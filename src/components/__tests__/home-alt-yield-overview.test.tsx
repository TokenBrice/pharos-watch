// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const useYieldRankingsSummaryMock = vi.fn();
const useYieldRankingsMock = vi.fn();
const refetchMock = vi.fn();
const NOW = Date.parse("2026-10-10T12:00:00Z");

vi.mock("@/hooks/api-hooks", () => ({
  useYieldRankingsSummary: () => ({
    error: null, meta: null, dataUpdatedAt: NOW, refetch: refetchMock,
    ...useYieldRankingsSummaryMock(),
  }),
  useYieldRankings: () => useYieldRankingsMock(),
}));

vi.mock("@/lib/logos", () => ({ logosById: {}, getLogoSrc: () => undefined }));

import { HomeAltYieldOverview } from "@/components/home-alt-yield-overview";
import type { YieldRankingsSummaryResponse } from "@shared/types/yield-summary";
import { makeYieldProvenance } from "@shared/test-utils/yield-ranking-fixtures";
import { YIELD_OPPORTUNITY_SAFETY_DESCRIPTION } from "@shared/lib/yield-opportunity-provenance";
import { formatDataHealthTimestamp } from "@/lib/data-health";

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("HomeAltYieldOverview", () => {
  it("marks opportunity safety while preserving live and default safety provenance", () => {
    const data = makeSummaryPayload(null);
    data.rankings = [
      { ...makeSummaryRow("usdc-circle", "USDC", 5, 60), provenance: makeYieldProvenance({ safetyProvenance: "opportunity-safety" }) },
      { ...makeSummaryRow("usdt-tether", "USDT", 4, 50), provenance: makeYieldProvenance({ safetyProvenance: "live-report-card" }) },
      { ...makeSummaryRow("dai-makerdao", "DAI", 3, 40), provenance: makeYieldProvenance({ safetyProvenance: "default-safety", usedDefaultSafety: true }) },
    ];
    useYieldRankingsSummaryMock.mockReturnValue({ data, isLoading: false });
    render(<HomeAltYieldOverview />);
    const opportunity = screen.getByLabelText(`Yield safety B+ — ${YIELD_OPPORTUNITY_SAFETY_DESCRIPTION}`);
    expect(opportunity.textContent).toContain("†");
    expect(opportunity.getAttribute("title")).toContain(YIELD_OPPORTUNITY_SAFETY_DESCRIPTION);
    expect(screen.getByLabelText("Yield safety B+").textContent).not.toContain("†");
    expect(screen.getByLabelText("Yield safety B+ (default safety)").textContent).not.toContain("†");
  });
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

  it("preserves retained yield values and offers retry after a failed refresh", () => {
    useYieldRankingsSummaryMock.mockReturnValue({
      data: makeSummaryPayload({ coveredCount: 2, trackedCount: 3 }),
      isLoading: false, error: new Error("refresh failed"),
    });
    render(<HomeAltYieldOverview />);
    expect(screen.getAllByText("USDC").length).toBeGreaterThan(0);
    expect(screen.getByText("3.65%")).toBeDefined();
    expect(screen.getAllByRole("status").some((notice) => /saved data/i.test(notice.textContent ?? ""))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetchMock).toHaveBeenCalledOnce();
  });

  it("qualifies stale producer metadata using the actual publication rather than the recent query fetch", () => {
    const publishedAt = NOW / 1000 - 15_000;
    useYieldRankingsSummaryMock.mockReturnValue({
      data: makeSummaryPayload({ coveredCount: 2, trackedCount: 3 }),
      isLoading: false, dataUpdatedAt: NOW,
      meta: { updatedAt: publishedAt, ageSeconds: 15_000, status: "stale",
        assessedAt: NOW / 1000, freshBudgetSec: 7_200, degradedBudgetSec: 14_400 },
    });
    render(<HomeAltYieldOverview />);
    expect(screen.getByText("3.65%")).toBeDefined();
    const notice = screen.getByRole("status");
    expect(notice.textContent).toMatch(/older snapshot/i);
    expect(notice.textContent).toContain(formatDataHealthTimestamp(publishedAt * 1000, "en-US", "UTC"));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps values visible while exposing published API quality warnings", () => {
    const data = makeSummaryPayload({ coveredCount: 2, trackedCount: 3 });
    const warning = { code: "benchmark-unavailable", message: "USD reference evidence unavailable", reasons: ["reference-source-missing"] };
    data.warnings = [warning];
    useYieldRankingsSummaryMock.mockReturnValue({ data, isLoading: false });
    render(<HomeAltYieldOverview />);
    expect(screen.getByText("3.65%")).toBeDefined();
    const warnings = screen.getByLabelText("Yield API warnings");
    expect(warnings.textContent).toContain(warning.message);
    expect(warnings.textContent).toContain(warning.reasons[0]);
  });

  it("offers retry when initial rankings are unavailable", () => {
    useYieldRankingsSummaryMock.mockReturnValue({
      data: undefined, isLoading: false, dataUpdatedAt: 0, error: new Error("unavailable"),
    });
    render(<HomeAltYieldOverview />);
    expect(screen.queryByText("3.65%")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetchMock).toHaveBeenCalledOnce();
  });
});
