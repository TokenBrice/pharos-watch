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

    // Unpriced mints could lift the -$3M known net above zero, so neither the net nor "burning" is claimed.
    expect(container.textContent).not.toContain("-$3.00M");
    expect(screen.queryByText("Burning")).toBeNull();
    expect(screen.queryByText("Flat")).toBeNull();
    expect(screen.getByText("Direction unavailable")).toBeTruthy();
    expect(screen.getByText("Partial valuation: 4 mint / 0 burn events unpriced; signed net unavailable")).toBeTruthy();
    expect(container.textContent).not.toContain("-42");
    expect(screen.getByText(/pressure shift unavailable/i)).toBeTruthy();
    // Baseline average daily net is withheld when the baseline valuation is partial.
    expect(container.textContent).not.toContain("+$1.00M");
    expect(screen.getByText(/Lower-bound volumes: 4 mint \/ 0 burn events unpriced/i)).toBeTruthy();
    // Complete 7d window keeps its value.
    expect(container.textContent).toContain("-$5.00M");
  });
});
