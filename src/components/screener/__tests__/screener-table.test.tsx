// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ScreenerTable } from "@/components/screener/screener-table";
import type { ScreenerRow, ScreenerSortKey } from "@/app/screener/screener-filters";
import type { DataTableSortControls } from "@/components/data-table-shell";

const row: ScreenerRow = {
  id: "usdt-tether",
  name: "Tether",
  symbol: "USDT",
  lifecycle: "active",
  mechanism: null,
  type: "centralized",
  peg: "peggedUSD",
  supplyUsd: 100_000_000,
  pegScore: 98,
  dewsScore: 12,
  liquidityScore: 86,
  safetyGrade: "B+",
  safetyScore: 82,
  safetyPegStabilityScore: 98,
  safetyLiquidityScore: 86,
  safetyResilienceScore: 78,
  safetyDecentralizationScore: 42,
  safetyDependencyRiskScore: 70,
  blacklistable: "yes",
  mintAuthority: "issuer-or-backend-mint",
};

function makeSort(overrides: Partial<DataTableSortControls<ScreenerSortKey>> = {}): DataTableSortControls<ScreenerSortKey> {
  return {
    sortKey: "safetyScore",
    sortDirection: "desc",
    toggleSort: vi.fn(),
    getAriaSortValue: () => "none",
    ...overrides,
  };
}

describe("ScreenerTable mobile cards", () => {
  it("renders the mobile card path with compact score facts and mobile sort controls", () => {
    const toggleSort = vi.fn();

    render(
      <ScreenerTable
        rows={[row]}
        isLoading={false}
        hasActiveFilters={false}
        sort={makeSort({ toggleSort })}
      />,
    );

    expect(screen.getByText("Sort Results")).toBeTruthy();
    expect(screen.getAllByText("USDT").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Peg/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/DEWS/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Liq/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Supply" }));

    expect(toggleSort).toHaveBeenCalledWith("supply");
  });
});
