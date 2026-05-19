// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  benchmarkKey: "usd-short",
  benchmarkLabel: "USD 3M T-Bill",
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
  provenance: { sourceKey: "aave", confidenceTier: "curated" },
  sourceRisk: null,
  peg: "peggedUSD",
  viewRank: 1,
  rankWithinSet: 1,
  rankLabel: "#1",
  comparableSetLabel: "USD lending",
  opportunity: "holder-yield",
  sourceDepthLens: "moderate",
} as YieldViewModelRow;

function renderRow(row: YieldViewModelRow, expanded: boolean) {
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
            expanded={expanded}
            onPrefetch={vi.fn()}
            onToggleExpanded={vi.fn()}
            onOpenSourceSheet={vi.fn()}
          />
        </TableBody>
      </Table>
    </TooltipProvider>,
  );
}

afterEach(cleanup);

describe("YieldLeaderboardTableRow — Why this PYS strip", () => {
  it("renders the strip with all four factor cells when expanded with a non-null PYS", () => {
    renderRow(baseRow, true);

    const strip = screen.getByRole("group", { name: "Why this PYS" });
    expect(strip).toBeTruthy();
    expect(strip.textContent).toContain("Bench spread");
    expect(strip.textContent).toContain("vs USD 3M T-Bill");
    expect(strip.textContent).toContain("Stability");
    expect(strip.textContent).toContain("90%");
    expect(strip.textContent).toContain("30d APY variance");
    expect(strip.textContent).toContain("Safety");
    expect(strip.textContent).toContain("B+");
    expect(strip.textContent).toContain("Source risk");
    expect(strip.textContent).toContain("1.00×");
    expect(strip.textContent).toContain("Neutral");
  });

  it("hides the strip when expanded with a null PYS but still renders the chart", () => {
    const row = { ...baseRow, pharosYieldScore: null } as YieldViewModelRow;
    renderRow(row, true);

    expect(screen.queryByRole("group", { name: "Why this PYS" })).toBeNull();
    expect(screen.getByTestId("yield-history-chart")).toBeTruthy();
  });

  it("does not render the strip when the row is collapsed", () => {
    renderRow(baseRow, false);
    expect(screen.queryByRole("group", { name: "Why this PYS" })).toBeNull();
  });
});
