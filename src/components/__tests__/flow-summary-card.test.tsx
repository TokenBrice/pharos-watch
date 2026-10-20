// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FlowSummaryCard } from "@/components/flow-summary-card";
import { makeMintBurnCoinValuation, makeMintBurnFlowCoin } from "@/test-utils/mint-burn-fixtures";

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
