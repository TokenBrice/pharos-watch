// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  DepegControlBoard,
  getDeviationBarWidthPercent,
} from "@/components/depeg-control-board";
import { cleanupFrontendTest } from "@/test-utils/frontend";
import type { DepegTrackerRow } from "@/lib/depeg-sort";
import type { PegSummaryCoin, StressSignalEntry } from "@shared/types";

vi.mock("@/hooks/use-prefetch-stablecoin", () => ({
  usePrefetchStablecoin: () => vi.fn(),
}));

afterEach(() => {
  cleanupFrontendTest();
});

function makeCoin(overrides: Partial<PegSummaryCoin> = {}): PegSummaryCoin {
  return {
    id: "coin-a",
    symbol: "SUSD",
    name: "Synthetic USD",
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "decentralized",
    currentDeviationBps: -6899,
    pegScore: 0,
    pegPct: 62.1,
    severityScore: 0,
    spreadPenalty: 0,
    eventCount: 607,
    worstDeviationBps: -6988,
    activeDepeg: true,
    lastEventAt: 1_700_000_000,
    trackingSpanDays: 700,
    methodologyVersion: "v1",
    dexPriceCheck: { agrees: false, dexPrice: 0.31, dexDeviationBps: -6900, sourcePools: 2, sourceTvl: 1_740_000 },
    ...overrides,
  };
}

function makeDews(overrides: Partial<StressSignalEntry> = {}): StressSignalEntry {
  return {
    score: 43,
    band: "ALERT",
    signals: {},
    computedAt: 1_700_000_000,
    methodologyVersion: "v1",
    ...overrides,
  };
}

function makeRow(
  coinOverrides: Partial<PegSummaryCoin> = {},
  dews: StressSignalEntry | null = makeDews(),
): DepegTrackerRow {
  return {
    coin: makeCoin(coinOverrides),
    dews,
  };
}

function renderBoard(
  rows: DepegTrackerRow[],
  overrides: Partial<ComponentProps<typeof DepegControlBoard>> = {},
) {
  return render(
    <DepegControlBoard
      rows={rows}
      logos={{}}
      pegFilter="all"
      typeFilter="all"
      searchQuery=""
      onPegFilterChange={vi.fn()}
      onTypeFilterChange={vi.fn()}
      onSearchChange={vi.fn()}
      onClearFilters={vi.fn()}
      onRowClick={vi.fn()}
      nowSeconds={1_700_100_000}
      {...overrides}
    />,
  );
}

describe("getDeviationBarWidthPercent", () => {
  it("uses a tiered scale so extreme deviations do not collapse with 500 bps moves", () => {
    expect(getDeviationBarWidthPercent(0)).toBe(0);
    expect(getDeviationBarWidthPercent(200)).toBeCloseTo(35);
    expect(getDeviationBarWidthPercent(500)).toBeCloseTo(60);
    expect(getDeviationBarWidthPercent(6899)).toBeGreaterThan(getDeviationBarWidthPercent(500));
    expect(getDeviationBarWidthPercent(6899)).toBeLessThanOrEqual(95);
  });
});

describe("DepegControlBoard", () => {
  it("renders full-row severity without side-stripe classes and keeps units explicit", () => {
    renderBoard([makeRow()]);

    const row = screen.getByRole("button", { name: /open susd depeg detail/i });
    expect(row.className).not.toContain("border-l-2");
    expect(row.className).toContain("bg-red-500");
    expect(screen.getByText("worst -6988 bps")).toBeTruthy();
    expect(screen.getAllByText("Peg health").length).toBeGreaterThan(0);
    expect(screen.queryByText("Peg score")).toBeNull();
    expect(screen.getAllByText("DEX check").length).toBeGreaterThan(0);
  });

  it("shows truthful sort direction and reverses attention ordering", () => {
    renderBoard([
      makeRow({ id: "active", symbol: "LIVE", name: "Live Asset", activeDepeg: true }),
      makeRow({ id: "clear", symbol: "CLEAR", name: "Clear Asset", currentDeviationBps: 0, activeDepeg: false, eventCount: 0, pegScore: 100, pegPct: 100 }, makeDews({ score: 0, band: "CALM" })),
    ]);

    expect(screen.getByRole("button", { name: /Attention sort, desc/i })).toBeTruthy();
    let rows = screen.getAllByRole("button", { name: /open .* depeg detail/i });
    expect(within(rows[0]).getByText("LIVE")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Attention sort, desc/i }));

    expect(screen.getByRole("button", { name: /Attention sort, asc/i })).toBeTruthy();
    rows = screen.getAllByRole("button", { name: /open .* depeg detail/i });
    expect(within(rows[0]).getByText("CLEAR")).toBeTruthy();
  });

  it("offers a clear-filter recovery action in the empty filtered state", () => {
    const onClearFilters = vi.fn();
    renderBoard([], {
      pegFilter: "USD",
      searchQuery: "nope",
      onClearFilters,
    });

    expect(screen.getByText("No stablecoins match these filters.")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /clear filters/i })[0]);
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it("renders human-readable one-based pagination", () => {
    renderBoard(
      Array.from({ length: 13 }, (_, index) => makeRow({
        id: `coin-${index}`,
        symbol: `C${index}`,
        name: `Coin ${index}`,
        currentDeviationBps: index,
        activeDepeg: false,
      })),
    );

    expect(screen.getByText("page 1 / 2")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
