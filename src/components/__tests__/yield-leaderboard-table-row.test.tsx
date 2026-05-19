// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { YieldLeaderboardTableRow } from "@/components/yield-leaderboard-table-row";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Table, TableBody } from "@/components/ui/table";
import type { YieldViewModelRow } from "@/lib/yield-view-model";

vi.mock("@/components/yield-history-chart", () => ({
  YieldHistoryChart: () => <div data-testid="yield-history-chart" />,
}));

const baseRow = {
  id: "usdt-tether",
  symbol: "USDT",
  name: "Tether",
  currentApy: 4.2,
  apy7d: 4.1,
  apy30d: 4.3,
  apyBase: 3.9,
  apyReward: 0.4,
  yieldSource: "Aave",
  yieldSourceUrl: "https://example.com/yield",
  yieldType: "lending-vault",
  dataSource: "fixture",
  sourceTvlUsd: 25_000_000,
  pharosYieldScore: 76,
  safetyScore: 82,
  safetyGrade: "B+",
  yieldToRisk: 1.1,
  excessYield: 0.6,
  benchmarkKey: "USD",
  benchmarkLabel: "USD short rate",
  benchmarkCurrency: "USD",
  benchmarkRate: 3.7,
  benchmarkIsFallback: false,
  benchmarkSelectionMode: "native",
  yieldStability: 0.9,
  apyVariance30d: 0.1,
  apyMin30d: 4,
  apyMax30d: 4.5,
  warningSignals: [],
  altSources: [],
  provenance: {
    sourceKey: "aave",
    confidenceTier: "curated",
    sourceObservedAt: 0,
    sourceAgeSeconds: 60,
    selectionMethod: "confidence-weighted",
    selectionReason: "best source",
    sourceSwitch: false,
    previousBestSourceKey: null,
    usedLegacyHistory: false,
    usedDefaultSafety: false,
    benchmarkRecordDate: null,
    benchmarkIsFallback: false,
    benchmarkFallbackMode: null,
    anomalies: [],
  },
  sourceRisk: { sourceRiskScore: 70, sourceRiskPenalty: 1.02, sourceAgeSeconds: 60 },
  peg: "USD",
  viewRank: 1,
  rankWithinSet: 1,
  rankLabel: "#1",
  comparableSetLabel: "USD lending",
  opportunity: "holder-yield",
  sourceDepthLens: "moderate",
} as unknown as YieldViewModelRow;

function renderRow(row: YieldViewModelRow) {
  return render(
    <TooltipProvider>
      <Table>
        <TableBody>
          <YieldLeaderboardTableRow
            row={row}
            logos={{}}
            riskFreeRate={3.5}
            medianApy={4}
            columnCount={11}
            expanded={false}
            onPrefetch={vi.fn()}
            onToggleExpanded={vi.fn()}
            onOpenSourceSheet={vi.fn()}
          />
        </TableBody>
      </Table>
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("YieldLeaderboardTableRow", () => {
  it("renders the rank-attribution chip when pys delta is material", () => {
    const row = {
      ...baseRow,
      rankChangeAttribution: {
        rankDelta: -3,
        pysDelta: 2.4,
        primaryDriver: "apy",
      },
    } as YieldViewModelRow;

    renderRow(row);

    expect(screen.getByLabelText("Rank change: +3, driver APY")).toBeTruthy();
  });

  it("omits the rank chip when pys delta is below threshold", () => {
    const row = {
      ...baseRow,
      rankChangeAttribution: {
        rankDelta: -1,
        pysDelta: 0.3,
        primaryDriver: "apy",
      },
    } as YieldViewModelRow;

    renderRow(row);

    expect(screen.queryByLabelText(/Rank change/)).toBeNull();
  });

  it("renders a null PYS reason tooltip when pysNullReason is set", () => {
    const row = {
      ...baseRow,
      pharosYieldScore: null,
      pysNullReason: "missing-inputs",
    } as YieldViewModelRow;

    renderRow(row);

    // Find the em-dash trigger inside a span with cursor-help class (tooltip-wrapped).
    const dashes = screen.getAllByText("—");
    const cursorHelpDash = dashes.find((el) => el.className.includes("cursor-help"));
    expect(cursorHelpDash).toBeTruthy();
  });

  it("renders the Deep dive link with proper href", () => {
    renderRow(baseRow);

    const link = screen.getByRole("link", { name: "Open full yield analysis for USDT" });
    expect(link.getAttribute("href")).toBe("/stablecoin/usdt-tether/yield");
  });
});
