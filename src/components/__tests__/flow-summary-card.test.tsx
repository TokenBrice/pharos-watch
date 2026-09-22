// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FlowSummaryCard } from "@/components/flow-summary-card";
import { makeMintBurnFlowCoin } from "@/test-utils/mint-burn-fixtures";

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
});
