// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { YieldMobileCard } from "@/components/yield-leaderboard";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { YieldViewModelRow } from "@/lib/yield-view-model";
import { makeYieldViewModelRow, renderYieldMobileCard } from "./yield-test-support";

vi.mock("@/components/yield-history-chart", () => ({
  YieldHistoryChart: () => <div data-testid="yield-history-chart" />,
}));

const row = makeYieldViewModelRow({
  altSources: [{
    sourceKey: "morpho",
    yieldSource: "Morpho",
    yieldType: "lending-vault",
    currentApy: 4.15,
    apy30d: 4.1,
    sourceTvlUsd: 10_000_000,
    dataSource: "fixture",
  }],
});

describe("YieldMobileCard", () => {
  it("exposes mobile history and source-sheet controls", () => {
    const onToggleExpanded = vi.fn();
    const onOpenSourceSheet = vi.fn();

    renderYieldMobileCard(row, { onToggleExpanded, onOpenSourceSheet });

    const historyButton = screen.getByRole("button", { name: "Show history" });
    expect(historyButton.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(historyButton);
    fireEvent.click(screen.getByRole("button", { name: "2 sources" }));

    expect(onToggleExpanded).toHaveBeenCalledWith("usdt-tether");
    expect(onOpenSourceSheet).toHaveBeenCalledWith("usdt-tether");
    expect(screen.getByText("Depth: Moderate")).toBeTruthy();
  });

  it("renders confidence pill, deep-dive link, and watchlist star", () => {
    renderYieldMobileCard(row);

    expect(screen.getByText("Curated")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open full yield analysis for USDT" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /USDT.*watchlist/i })).toBeTruthy();
  });

  it("renders a labeled source-risk summary when the source penalty is material", () => {
    const riskRow = {
      ...row,
      sourceRisk: { sourceRiskScore: 42, sourceRiskPenalty: 1.32, sourceAgeSeconds: 60 },
    } as YieldViewModelRow;

    renderYieldMobileCard(riskRow);

    expect(screen.getByText("Source risk 42/100 | 1.32x")).toBeTruthy();
  });

  it("falls back to bare em-dash when PYS is null without a reason", () => {
    const fallbackRow = { ...row, pharosYieldScore: null } as YieldViewModelRow;
    renderYieldMobileCard(fallbackRow);

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
          isCompared={false}
          compareDisabled={false}
          onToggleExpanded={vi.fn()}
          onOpenSourceSheet={vi.fn()}
          onToggleCompare={vi.fn()}
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
          isCompared={false}
          compareDisabled={false}
          onToggleExpanded={vi.fn()}
          onOpenSourceSheet={vi.fn()}
          onToggleCompare={vi.fn()}
        />
      </TooltipProvider>,
    );

    expect(screen.queryByRole("group", { name: "Why this PYS" })).toBeNull();
  });

  it("renders the cohort percentile chip when cohortPercentile has a numeric value", () => {
    const cohortRow = {
      ...row,
      cohortPercentile: { value: 64, cohortSize: 18, cohortKey: "USD:lending-vault" },
    } as YieldViewModelRow;

    render(
      <TooltipProvider>
        <YieldMobileCard
          row={cohortRow}
          riskFreeRate={3.5}
          medianApy={4}
          expanded={false}
          isCompared={false}
          compareDisabled={false}
          onToggleExpanded={vi.fn()}
          onOpenSourceSheet={vi.fn()}
          onToggleCompare={vi.fn()}
        />
      </TooltipProvider>,
    );

    expect(screen.getByText("p64 of 18")).toBeTruthy();
  });

  it("renders the small-peer-set chip when cohortPercentile.value is null", () => {
    const cohortRow = {
      ...row,
      cohortPercentile: { value: null, cohortSize: 4, cohortKey: "EUR:lending-vault" },
    } as YieldViewModelRow;

    render(
      <TooltipProvider>
        <YieldMobileCard
          row={cohortRow}
          riskFreeRate={3.5}
          medianApy={4}
          expanded={false}
          isCompared={false}
          compareDisabled={false}
          onToggleExpanded={vi.fn()}
          onOpenSourceSheet={vi.fn()}
          onToggleCompare={vi.fn()}
        />
      </TooltipProvider>,
    );

    expect(screen.getByText("small peer set")).toBeTruthy();
  });

  it("renders nothing in place of the cohort chip when cohortPercentile is null", () => {
    render(
      <TooltipProvider>
        <YieldMobileCard
          row={row}
          riskFreeRate={3.5}
          medianApy={4}
          expanded={false}
          isCompared={false}
          compareDisabled={false}
          onToggleExpanded={vi.fn()}
          onOpenSourceSheet={vi.fn()}
          onToggleCompare={vi.fn()}
        />
      </TooltipProvider>,
    );

    expect(screen.queryByText(/^p\d+ of \d+/)).toBeNull();
    expect(screen.queryByText("small peer set")).toBeNull();
  });

  it("invokes onToggleCompare with the row id when the compare checkbox is clicked", () => {
    const onToggleCompare = vi.fn();
    render(
      <TooltipProvider>
        <YieldMobileCard
          row={row}
          riskFreeRate={3.5}
          medianApy={4}
          expanded={false}
          isCompared={false}
          compareDisabled={false}
          onToggleExpanded={vi.fn()}
          onOpenSourceSheet={vi.fn()}
          onToggleCompare={onToggleCompare}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByLabelText("Add USDT to compare"));

    expect(onToggleCompare).toHaveBeenCalledWith("usdt-tether");
  });
});
