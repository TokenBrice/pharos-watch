// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

import type { YieldViewModelRow } from "@/lib/yield-view-model";
import { REGISTRY_WITH_EUR, makeYieldViewModelRow, renderYieldMobileCard } from "./yield-test-support";

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

  it("renders confidence and watchlist controls", () => {
    renderYieldMobileCard(row);

    expect(screen.getByText("Curated")).toBeTruthy();
    expect(screen.getByRole("button", { name: /USDT.*watchlist/i })).toBeTruthy();
  });

  it("falls back to bare em-dash when PYS is null without a reason", () => {
    const fallbackRow = { ...row, pharosYieldScore: null } as YieldViewModelRow;
    renderYieldMobileCard(fallbackRow);

    expect(screen.getByText("PYS —")).toBeTruthy();
  });

  it("threads the payload scaling factor through the row display (E7)", () => {
    // scalingFactor has no visible strip output today; the card must accept
    // the payload value (live 8) and render the expanded PYS strip unchanged.
    renderYieldMobileCard(row, { scalingFactor: 8, expanded: true });
    expect(screen.getByRole("group", { name: "Why this PYS" })).toBeTruthy();
  });
});

// The chip must resolve a missing row rate from the registry EUR entry (the
// row's own benchmark) instead of the chart-wide USD risk-free frame.
describe("YieldMobileCard — zone chip benchmark resolution", () => {
  const eurRowWithoutRate = {
    ...row,
    benchmarkKey: "EUR",
    benchmarkLabel: "EUR 3M compounded €STR",
    benchmarkRate: undefined,
    apy30d: 2.0,
    safetyScore: 82,
  } as YieldViewModelRow;

  it("resolves a missing row rate from the registry EUR entry, not the USD frame", () => {
    // 2.0% APY beats the EUR benchmark (1.94) but not the USD frame (3.5):
    // a Sweet Spot chip proves the EUR rate was used.
    renderYieldMobileCard(eurRowWithoutRate, { benchmarks: REGISTRY_WITH_EUR });
    expect(screen.getByText("Sweet Spot")).toBeTruthy();
  });

  it("still falls back to the risk-free frame when no registry is provided", () => {
    renderYieldMobileCard(eurRowWithoutRate);
    expect(screen.getByText("Play It Safe")).toBeTruthy();
  });
});
