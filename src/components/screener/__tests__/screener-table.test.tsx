// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScreenerTable } from "@/components/screener/screener-table";
import { cleanupFrontendTest } from "@/test-utils/frontend";
import type { ScreenerRow, ScreenerSortKey } from "@/app/screener/screener-filters";
import type { DataTableSortControls } from "@/components/data-table-shell";

const row: ScreenerRow = {
  id: "usdt-tether",
  name: "Tether",
  symbol: "USDT",
  lifecycle: "active",
  mechanism: null,
  type: "centralized",
  peg: "USD",
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
  mintAuthorityScore: 42,
  mintAuthorityScoreBand: "concentrated",
  mintAuthorityScoreLabel: "42/100",
  mintAuthorityScoreBandLabel: "Concentrated",
  mintAuthorityScoreBadgeClassName: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400",
  mintAuthorityScoreDetail: "Mint Authority Score: 42/100 (Concentrated).",
};

const rowWithSeries: ScreenerRow = {
  ...row,
  pegDeviationSeries: [0, 3, -2, 1],
  supplySeries: [98_000_000, 99_000_000, 100_000_000],
};

function installViewportMatchMedia(width: number) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const maxWidth = /max-width:\s*(\d+)px/.exec(query)?.[1];
      return {
        matches: maxWidth ? width <= Number(maxWidth) : false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}

function makeSort(
  overrides: Partial<DataTableSortControls<ScreenerSortKey>> = {},
): DataTableSortControls<ScreenerSortKey> {
  return {
    sortKey: "safetyScore",
    sortDirection: "desc",
    toggleSort: vi.fn(),
    getAriaSortValue: () => "none",
    ...overrides,
  };
}

afterEach(() => {
  cleanupFrontendTest();
});

describe("ScreenerTable mobile cards", () => {
  it("server-renders a cheap pending branch before viewport hydration", () => {
    const html = renderToStaticMarkup(
      <ScreenerTable rows={[rowWithSeries]} isLoading={false} hasActiveFilters={false} sort={makeSort()} />,
    );

    expect(html).toContain("stablecoin-screener-layout-pending");
    expect(html).not.toContain("stablecoin-screener-table");
    expect(html).not.toContain("<svg");
  });

  it("renders the mobile card path with compact score facts and mobile sort controls", async () => {
    const toggleSort = vi.fn();
    installViewportMatchMedia(500);

    render(<ScreenerTable rows={[row]} isLoading={false} hasActiveFilters={false} sort={makeSort({ toggleSort })} />);

    await waitFor(() => {
      expect(screen.getAllByText("USDT").length).toBeGreaterThan(0);
    });
    expect(screen.getByText("Sort Results")).toBeTruthy();
    expect(screen.getAllByText(/Peg/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/DEWS/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Liq/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("42/100").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Supply" }));

    expect(toggleSort).toHaveBeenCalledWith("supply");
    expect(screen.queryByTestId("stablecoin-screener-table")).toBeNull();
  });
});

describe("ScreenerTable desktop table", () => {
  it("renders only the desktop table branch on desktop viewports", async () => {
    installViewportMatchMedia(1400);

    render(<ScreenerTable rows={[row]} isLoading={false} hasActiveFilters={false} sort={makeSort()} />);

    await waitFor(() => {
      expect(screen.getByTestId("stablecoin-screener-table")).toBeTruthy();
    });
    expect(screen.queryByText("Sort Results")).toBeNull();
    expect(screen.getByText("Mint Score")).toBeTruthy();
    expect(screen.getByText("42/100")).toBeTruthy();
  });

  it("skips xl-only sparkline SVGs below the xl breakpoint", async () => {
    installViewportMatchMedia(900);

    render(<ScreenerTable rows={[rowWithSeries]} isLoading={false} hasActiveFilters={false} sort={makeSort()} />);

    await waitFor(() => {
      expect(screen.getByTestId("stablecoin-screener-table")).toBeTruthy();
    });
    expect(screen.queryByRole("img", { name: /30-day peg deviation for USDT/i })).toBeNull();
    expect(screen.queryByRole("img", { name: /30-day supply trajectory for USDT/i })).toBeNull();
  });

  it("renders sparkline SVGs on xl desktop viewports", async () => {
    installViewportMatchMedia(1400);

    render(<ScreenerTable rows={[rowWithSeries]} isLoading={false} hasActiveFilters={false} sort={makeSort()} />);

    await waitFor(() => {
      expect(screen.getByRole("img", { name: /30-day peg deviation for USDT/i })).toBeTruthy();
      expect(screen.getByRole("img", { name: /30-day supply trajectory for USDT/i })).toBeTruthy();
    });
  });
});
