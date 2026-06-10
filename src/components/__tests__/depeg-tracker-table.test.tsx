// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DepegTrackerTable } from "@/components/depeg-tracker-table";
import type { DepegTrackerRow } from "@/lib/depeg-sort";
import type { PegSummaryCoin, StressSignalEntry } from "@shared/types";

vi.mock("@/hooks/use-prefetch-stablecoin", () => ({
  usePrefetchStablecoin: () => vi.fn(),
}));

afterEach(cleanup);

function makeCoin(overrides: Partial<PegSummaryCoin> = {}): PegSummaryCoin {
  return {
    id: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "centralized",
    currentDeviationBps: 0,
    depegEventCoverageLimited: false,
    pegScore: 100,
    pegPct: 100,
    severityScore: 0,
    spreadPenalty: 0,
    eventCount: 0,
    worstDeviationBps: null,
    activeDepeg: false,
    lastEventAt: null,
    trackingSpanDays: 90,
    methodologyVersion: "v1",
    dexPriceCheck: null,
    ...overrides,
  };
}

function makeDews(overrides: Partial<StressSignalEntry> = {}): StressSignalEntry {
  return {
    score: 65,
    band: "WARNING",
    signals: {
      supply: { value: 80, available: true },
      diverg: { value: 60, available: true },
    },
    amplifiers: { psi: 1.12, contagion: 1 },
    computedAt: Math.floor(Date.now() / 1000) - 3 * 3600,
    methodologyVersion: "v1",
    ...overrides,
  };
}

describe("DepegTrackerTable", () => {
  it("renders live, pending, coverage-limited, stale DEWS, and amplifier markers", () => {
    const rows: DepegTrackerRow[] = [
      { coin: makeCoin({ id: "live", symbol: "LIVE", activeDepeg: true }), dews: makeDews() },
      {
        coin: makeCoin({ id: "pending", symbol: "PEND" }),
        dews: makeDews({ score: 10, band: "CALM" }),
        pendingIncident: {
          stablecoinId: "pending",
          symbol: "PEND",
          direction: "below",
          firstSeenAt: 1_700_000_000,
        },
      },
      {
        coin: makeCoin({ id: "limited", symbol: "LIM", depegEventCoverageLimited: true }),
        dews: null,
      },
    ];

    render(<DepegTrackerTable rows={rows} logos={undefined} onRowClick={vi.fn()} />);

    expect(screen.getAllByText("LIVE").length).toBeGreaterThan(0);
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("Coverage-limited")).toBeTruthy();
    expect(screen.getAllByText(/Supply Velocity/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/PSI 1.12x/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/stale/i).length).toBeGreaterThan(0);
  });

  it("renders the explicit ref n/a affordance when the peg reference is unavailable", () => {
    const rows: DepegTrackerRow[] = [
      {
        coin: makeCoin({
          id: "refna",
          symbol: "REFNA",
          currentDeviationBps: null,
          pegReferenceUnavailable: true,
          dexPriceCheck: null,
        }),
        dews: null,
      },
    ];

    render(<DepegTrackerTable rows={rows} logos={undefined} onRowClick={vi.fn()} />);

    const cell = screen.getByText("ref n/a");
    expect(cell.getAttribute("title")).toBe(
      "Peg reference unavailable: the FX reference is offline and this coin's peer group is too thin to verify deviation.",
    );
  });

  it("uses filter empty-state copy", () => {
    render(<DepegTrackerTable rows={[]} logos={undefined} onRowClick={vi.fn()} />);

    expect(screen.getByText("No stablecoins match these filters.")).toBeTruthy();
  });
});
