// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DepegControlBoard } from "@/components/depeg-control-board";
import { getDeviationBarWidthPercent } from "@/components/depeg-board-model";
import { cleanupFrontendTest } from "@/test-utils/frontend";
import type { DepegTrackerRow } from "@/lib/depeg-sort";
import type { PegSummaryCoin, StressSignalEntry } from "@shared/types";
import { makePegSummaryCoin } from "@/test-utils/peg-summary-fixtures";
import { makeDews } from "./depeg.test-support";

vi.mock("@/hooks/use-prefetch-stablecoin", () => ({
  usePrefetchStablecoin: () => vi.fn(),
}));

afterEach(() => {
  cleanupFrontendTest();
});

function makeCoin(overrides: Partial<PegSummaryCoin> = {}): PegSummaryCoin {
  return makePegSummaryCoin({
    id: "coin-a",
    symbol: "SUSD",
    name: "Synthetic USD",
    governance: "decentralized",
    currentDeviationBps: -6899,
    pegScore: 0,
    pegPct: 62.1,
    eventCount: 607,
    worstDeviationBps: -6988,
    activeDepeg: true,
    lastEventAt: 1_700_000_000,
    trackingSpanDays: 700,
    dexPriceCheck: { agrees: false, dexPrice: 0.31, dexDeviationBps: -6900, sourcePools: 2, sourceTvl: 1_740_000 },
    ...overrides,
  });
}


function makeRow(
  coinOverrides: Partial<PegSummaryCoin> = {},
  dews: StressSignalEntry | null = makeDews({ score: 43, band: "ALERT", computedAt: 1_700_000_000 }),
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
  it.each([
    { currentDeviationBps: null, dews: null },
    { currentDeviationBps: null, dews: makeDews({ score: 0, band: "CALM" }) },
    { currentDeviationBps: 0, dews: null },
  ])("does not claim clear health with incomplete live observations: %j", ({ currentDeviationBps, dews }) => {
    renderBoard([makeRow({ activeDepeg: false, currentDeviationBps, pegScore: null }, dews)]);
    const row = screen.getByRole("button", { name: /open susd depeg detail/i });
    const status = within(row).getByText("unknown");
    expect(status.className).toContain("text-muted-foreground");
    expect(within(row).queryByText("clear")).toBeNull();
  });

  it("distinguishes observed zero readings from unknown health", () => {
    renderBoard([makeRow({ activeDepeg: false, currentDeviationBps: 0 }, makeDews({ score: 0, band: "CALM" }))]);
    const row = screen.getByRole("button", { name: /open susd depeg detail/i });
    expect(within(row).getByText("clear")).toBeTruthy();
    expect(within(row).queryByText("unknown")).toBeNull();
  });

  it.each(["live", "pending", "floor", "warning", "danger"] as const)(
    "preserves the known %s status ahead of unknown observations",
    (status) => {
      const row = makeRow({
        activeDepeg: status === "live",
        depegEventCoverageLimited: status === "floor",
        currentDeviationBps: null,
        pegScore: null,
      }, status === "warning" || status === "danger"
        ? makeDews({ band: status === "warning" ? "WARNING" : "DANGER" })
        : null);
      if (status === "pending") {
        row.pendingIncident = {
          stablecoinId: row.coin.id,
          symbol: row.coin.symbol,
          direction: "below",
          firstSeenAt: 1_700_000_000,
        };
      }
      renderBoard([row]);
      const renderedRow = screen.getByRole("button", { name: /open susd depeg detail/i });
      expect(within(renderedRow).getByText(status)).toBeTruthy();
      expect(within(renderedRow).queryByText("unknown")).toBeNull();
    },
  );

  it.each([1, 2])("labels %s DEX check observations as price sources", (sourcePools) => {
    renderBoard([makeRow({
      dexPriceCheck: { agrees: true, dexPrice: 1, dexDeviationBps: 0, sourcePools, sourceTvl: 1_740_000 },
    })]);
    const row = screen.getByRole("button", { name: /open susd depeg detail/i });
    const label = `${sourcePools} price ${sourcePools === 1 ? "source" : "sources"} · $1.74M`;
    expect(within(row).getByText(label)).toBeTruthy();
    expect(within(row).queryByText(/\b\d+ pools?\b/)).toBeNull();
  });

  it("renders unknown peg occupancy as unavailable rather than zero or perfect stability", () => {
    renderBoard([makeRow({ pegScore: null, pegPct: null })]);
    const row = screen.getByRole("button", { name: /open susd depeg detail/i });
    expect(within(row).getByText("- at peg")).toBeTruthy();
    expect(within(row).queryByText("0.0% at peg")).toBeNull();
    expect(within(row).queryByText("100.0% at peg")).toBeNull();
  });
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
