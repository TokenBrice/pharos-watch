// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

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

});
