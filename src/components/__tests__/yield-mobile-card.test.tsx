// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { YieldMobileCard } from "@/components/yield-leaderboard";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { YieldViewModelRow } from "@/lib/yield-view-model";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

vi.mock("@/components/yield-history-chart", () => ({
  YieldHistoryChart: () => <div data-testid="yield-history-chart" />,
}));

const row = {
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
  benchmarkLabel: "USD short rate",
  benchmarkCurrency: "USD",
  benchmarkRate: 3.7,
  benchmarkIsFallback: false,
  benchmarkSelectionMode: "native",
  yieldStability: 0.9,
  apyVariance30d: 0.1,
  apyMin30d: 4,
  apyMax30d: 4.5,
  warningSignals: ["thin-source-depth"],
  altSources: [{ sourceKey: "morpho", yieldSource: "Morpho", apy30d: 4.1, sourceTvlUsd: 10_000_000 }],
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

describe("YieldMobileCard", () => {
  it("exposes mobile history and source-sheet controls", () => {
    const onToggleExpanded = vi.fn();
    const onOpenSourceSheet = vi.fn();

    render(
      <TooltipProvider>
        <YieldMobileCard
          row={row}
          riskFreeRate={3.5}
          medianApy={4}
          expanded={false}
          onToggleExpanded={onToggleExpanded}
          onOpenSourceSheet={onOpenSourceSheet}
        />
      </TooltipProvider>,
    );

    const historyButton = screen.getByRole("button", { name: "Show history" });
    expect(historyButton.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(historyButton);
    fireEvent.click(screen.getByRole("button", { name: "2 sources" }));

    expect(onToggleExpanded).toHaveBeenCalledWith("usdt-tether");
    expect(onOpenSourceSheet).toHaveBeenCalledWith("usdt-tether");
    expect(screen.getByText("Depth: Moderate")).toBeTruthy();
  });

  it("renders confidence pill, deep-dive link, and watchlist star", () => {
    render(
      <TooltipProvider>
        <YieldMobileCard
          row={row}
          riskFreeRate={3.5}
          medianApy={4}
          expanded={false}
          onToggleExpanded={vi.fn()}
          onOpenSourceSheet={vi.fn()}
        />
      </TooltipProvider>,
    );

    expect(screen.getByText("Curated")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open full yield analysis for USDT" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /USDT.*watchlist/i })).toBeTruthy();
  });

  it("falls back to bare em-dash when PYS is null without a reason", () => {
    const fallbackRow = { ...row, pharosYieldScore: null } as YieldViewModelRow;
    render(
      <TooltipProvider>
        <YieldMobileCard
          row={fallbackRow}
          riskFreeRate={3.5}
          medianApy={4}
          expanded={false}
          onToggleExpanded={vi.fn()}
          onOpenSourceSheet={vi.fn()}
        />
      </TooltipProvider>,
    );

    expect(screen.getByText("PYS —")).toBeTruthy();
  });

  it("renders the Why this PYS strip when expanded with a non-null PYS", () => {
    render(
      <TooltipProvider>
        <YieldMobileCard
          row={row}
          riskFreeRate={3.5}
          medianApy={4}
          expanded={true}
          onToggleExpanded={vi.fn()}
          onOpenSourceSheet={vi.fn()}
        />
      </TooltipProvider>,
    );

    const strip = screen.getByRole("group", { name: "Why this PYS" });
    expect(strip.textContent).toContain("Bench spread");
    expect(strip.textContent).toContain("Stability");
    expect(strip.textContent).toContain("Safety");
    expect(strip.textContent).toContain("Source risk");
    expect(strip.textContent).toContain("B+");
    expect(strip.textContent).toContain("1.00×");
    expect(strip.textContent).toContain("Neutral");
  });

  it("hides the Why this PYS strip when expanded with a null PYS", () => {
    const noPysRow = { ...row, pharosYieldScore: null } as YieldViewModelRow;
    render(
      <TooltipProvider>
        <YieldMobileCard
          row={noPysRow}
          riskFreeRate={3.5}
          medianApy={4}
          expanded={true}
          onToggleExpanded={vi.fn()}
          onOpenSourceSheet={vi.fn()}
        />
      </TooltipProvider>,
    );

    expect(screen.queryByRole("group", { name: "Why this PYS" })).toBeNull();
  });
});
