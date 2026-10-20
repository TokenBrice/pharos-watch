// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlowSummaryCard } from "@/components/flow-summary-card";
import { makeMintBurnCoinValuation, makeMintBurnFlowCoin } from "@/test-utils/mint-burn-fixtures";
import type { ApiMeta } from "@/lib/api";

afterEach(() => vi.useRealTimers());
vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));

const useMintBurnFlowsMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-mint-burn-flows", () => ({
  useMintBurnFlows: useMintBurnFlowsMock,
}));

describe("FlowSummaryCard", () => {
  it("qualifies an incomplete 30-day window as partial", () => {
    useMintBurnFlowsMock.mockReturnValue({
      data: {
        coins: [
          makeMintBurnFlowCoin({
            coverage: {
              startBlock: 1,
              lastSyncedBlock: 2,
              lagBlocks: 0,
              historyStartAt: 1_700_000_000,
              has24hWindow: true,
              has30dWindow: false,
              has90dWindow: true,
              isPartial: true,
              status: "partial-history",
            },
          }),
        ],
      },
      dataUpdatedAt: 1_700_000_000_000,
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    });

    render(<FlowSummaryCard stablecoinId="usdc-circle" />);

    expect(screen.getByText("partial")).toBeTruthy();
    expect(
      screen.getByTitle("30-day window is incomplete; value reflects the covered portion only."),
    ).toBeTruthy();
    expect(screen.queryByTitle(/90-day window is incomplete/)).toBeNull();
  });

  it("renders a partial 24h window as unavailable instead of a burning net and pressure reading", () => {
    useMintBurnFlowsMock.mockReturnValue({
      data: {
        coins: [
          makeMintBurnFlowCoin({
            valuation: makeMintBurnCoinValuation(
              { completeness: "partial", mintCompleteness: "partial", unpricedMintEventCount: 4 },
              { baseline: "partial" },
            ),
          }),
        ],
      },
      dataUpdatedAt: 1_700_000_000_000,
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    });

    const { container } = render(<FlowSummaryCard stablecoinId="usdc-circle" />);

    // Unpriced mints could lift the -$3M known net above zero: it renders only as a floor, and "burning" is not claimed.
    expect(container.textContent).toContain("≥ -$3.00M");
    expect(container.textContent?.replaceAll("≥ -$3.00M", "")).not.toContain("-$3.00M");
    expect(screen.queryByText("Burning")).toBeNull();
    expect(screen.queryByText("Flat")).toBeNull();
    expect(screen.getByText("Direction unavailable")).toBeTruthy();
    expect(screen.getAllByText(/Lower bound: 4 mint \/ 0 burn events unpriced; unpriced mints can only raise the net/).length)
      .toBeGreaterThan(0);
    expect(container.textContent).not.toContain("-42");
    expect(screen.getByText(/pressure shift unavailable/i)).toBeTruthy();
    // Baseline average daily net is withheld when the baseline valuation is partial.
    expect(container.textContent).not.toContain("+$1.00M");
    // v6.27: a balance of lower-bound volumes is NR with its reason, never a dial reading.
    expect(screen.getByText("Minting pressure not rated")).toBeTruthy();
    expect(screen.getByText(/4 mint \/ 0 burn events unpriced, so the volumes are lower bounds/i)).toBeTruthy();
    expect(container.querySelector('[data-reason-codes="valuation-partial"]')).toBeTruthy();
    expect(screen.queryByRole("img", { name: /Minting pressure gauge at/ })).toBeNull();
    // Complete 7d window keeps its value.
    expect(container.textContent).toContain("-$5.00M");
  });

  it.each([null, true])("withholds a literal dial for an unavailable scan window (activity=%s)", (has24hActivity) => {
    useMintBurnFlowsMock.mockReturnValue({
      data: {
        coins: [makeMintBurnFlowCoin({
          has24hActivity,
          netFlowDirection24h: null,
          pressureShiftScore: null,
          pressureShiftState: "nr",
          netFlow24hUsd: null,
          netFlow7dUsd: null,
          netFlow30dUsd: null,
          netFlow90dUsd: null,
          mintVolume24hUsd: 100,
          burnVolume24hUsd: 50,
          mintCount24h: 0,
          burnCount24h: 0,
          valuation: makeMintBurnCoinValuation({ completeness: "partial", mintCompleteness: "partial", unpricedMintEventCount: 1 }),
          coverage: { startBlock: 1, lastSyncedBlock: 2, lagBlocks: 0, historyStartAt: null,
            has24hWindow: false, has30dWindow: false, has90dWindow: false, isPartial: true, status: "unknown",
            windows: {
              window24h: { complete: false, unavailableReason: "scan-coverage-incomplete" },
              window7d: { complete: false, unavailableReason: "scan-coverage-incomplete" },
              window30d: { complete: false, unavailableReason: "scan-coverage-incomplete" },
              window90d: { complete: false, unavailableReason: "scan-coverage-incomplete" },
            } },
        })],
      },
      dataUpdatedAt: 1_700_000_000_000,
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    });
    const { container } = render(<FlowSummaryCard stablecoinId="usdc-circle" />);
    expect(screen.getByText("Direction unavailable")).toBeTruthy();
    expect(container.querySelector('[data-reason-codes="window-unavailable"]')).toBeTruthy();
    expect(screen.queryByRole("img", { name: /Minting pressure gauge at/ })).toBeNull();
    expect(screen.queryByText("No 24h mint or burn volume")).toBeNull();
    expect(container.textContent).not.toContain("-$3.00M");
    expect(container.textContent).not.toContain("-$5.00M");
  });
});

it.each([
  { meta: { updatedAt: Math.floor(Date.now() / 1000) - 86_400, status: "fresh" }, state: "stale" },
  { meta: { updatedAt: null, status: "unknown", ageSeconds: null }, state: "unavailable" },
  { meta: { updatedAt: Math.floor(Date.now() / 1000), status: "fresh", warning: "Flow source incomplete" }, state: "degraded" },
] as { meta: ApiMeta; state: string }[])("retains the admitted flow generation across receipts and errors ($state)", ({ meta, state }) => {
  const receipt = Date.now();
  const query = {
    data: { coins: [makeMintBurnFlowCoin()] },
    meta, dataUpdatedAt: receipt, error: null, isLoading: false, refetch: vi.fn(),
  };
  useMintBurnFlowsMock.mockReturnValue(query);
  const { container, rerender } = render(<FlowSummaryCard stablecoinId="usdc-circle" />);
  const producerTime = meta.updatedAt != null ? new Date(meta.updatedAt * 1000).toISOString() : null;
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe(producerTime);
  expect(container.querySelector(`[data-health-state="${state}"]`)).toBeTruthy();
  useMintBurnFlowsMock.mockReturnValue({ ...query, dataUpdatedAt: receipt + 30_000 });
  rerender(<FlowSummaryCard stablecoinId="usdc-circle" />);
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe(producerTime);
  useMintBurnFlowsMock.mockReturnValue({ ...query, error: new Error("refresh failed") });
  rerender(<FlowSummaryCard stablecoinId="usdc-circle" />);
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe(producerTime);
  expect(screen.getByText(/refresh failed; showing the last available data/)).toBeTruthy();
});

it("does not attribute the aggregate FTQ dependency to coin flow totals", () => {
  const receipt = Date.now();
  useMintBurnFlowsMock.mockReturnValue({
    data: { coins: [makeMintBurnFlowCoin()], sync: { classificationWarning: "FTQ classification unavailable" } },
    meta: {
      updatedAt: Math.floor(receipt / 1000), status: "fresh",
      warning: '199 - "FTQ classification unavailable"',
      dependencies: { flightToQuality: { status: "unavailable", reason: "ratings-old" } },
    },
    dataUpdatedAt: receipt, error: null, isLoading: false, refetch: vi.fn(),
  });
  const { container } = render(<FlowSummaryCard stablecoinId="usdc-circle" />);
  expect(container.querySelector("[data-health-state]")).toBeNull();
  expect(container.querySelector("time")?.getAttribute("datetime"))
    .toBe(new Date(Math.floor(receipt / 1000) * 1000).toISOString());
});

it("ages saved flow metadata through both health boundaries without refetching", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  const receipt = Date.now();
  useMintBurnFlowsMock.mockReturnValue({
    data: { coins: [makeMintBurnFlowCoin()] }, dataUpdatedAt: receipt, error: null, isLoading: false,
    meta: { updatedAt: receipt / 1000, status: "fresh", freshBudgetSec: 60, degradedBudgetSec: 120 },
    refetch: vi.fn(),
  });
  const { container } = render(<FlowSummaryCard stablecoinId="usdc-circle" />);
  expect(container.querySelector("[data-health-state]")).toBeNull();
  act(() => vi.advanceTimersByTime(50));
  act(() => vi.advanceTimersByTime(60_001));
  expect(container.querySelector('[data-health-state="degraded"]')).toBeTruthy();
  act(() => vi.advanceTimersByTime(60_000));
  expect(container.querySelector('[data-health-state="stale"]')).toBeTruthy();
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe(new Date(receipt).toISOString());
});
