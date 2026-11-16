// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FlowEventFeed } from "@/components/mint-burn/flow-event-feed";
import type { MintBurnEvent } from "@shared/types/mint-burn";

const { useMintBurnEventsMock } = vi.hoisted(() => ({
  useMintBurnEventsMock: vi.fn(),
}));

vi.mock("@/hooks/use-mint-burn-flows", () => ({
  useMintBurnEvents: useMintBurnEventsMock,
}));

afterEach(() => {
  useMintBurnEventsMock.mockReset();
});

function makeEvent(index: number): MintBurnEvent {
  return {
    id: `evt-${index}`,
    stablecoinId: "dai-makerdao",
    symbol: "DAI",
    chainId: "ethereum",
    direction: index % 2 === 0 ? "mint" : "burn",
    flowType: "standard",
    burnType: null,
    burnReviewReason: null,
    amount: 1_000 * (index + 1),
    amountUsd: 1_000 * (index + 1),
    priceUsed: 1,
    priceTimestamp: 1_700_000_000,
    priceSource: "test",
    counterparty: null,
    txHash: `0x${String(index).padStart(64, "0")}`,
    blockNumber: 21_000_000 + index,
    timestamp: 1_700_000_000 - index * 3_600,
    explorerTxUrl: `https://etherscan.io/tx/0x${index}`,
  };
}

function mockEvents(count: number, total = count) {
  useMintBurnEventsMock.mockReturnValue({
    data: { events: Array.from({ length: count }, (_, i) => makeEvent(i)), total },
    isLoading: false,
    isError: false,
  });
}

function tableRowCount(): number {
  return screen.getByTestId("mint-burn-event-feed-table").querySelectorAll("tbody tr").length;
}

describe("FlowEventFeed row fold", () => {
  it("opens truncated to six rows and hides pagination while folded", () => {
    mockEvents(10, 240);

    render(<FlowEventFeed stablecoinId="dai-makerdao" limit={10} scope="counted" />);

    expect(tableRowCount()).toBe(6);
    expect(screen.getByRole("button", { name: "Show all 240 events" })).toBeTruthy();
    expect(screen.queryByLabelText("Go to next page")).toBeNull();
  });

  it("reveals the rest of the fetched page and its pagination when opened", () => {
    mockEvents(10, 240);

    render(<FlowEventFeed stablecoinId="dai-makerdao" limit={10} scope="counted" />);
    fireEvent.click(screen.getByRole("button", { name: "Show all 240 events" }));

    expect(tableRowCount()).toBe(10);
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
    expect(screen.getAllByLabelText("Go to next page").length).toBeGreaterThan(0);
  });

  it("renders neutral type chips with signed amounts in one table at every width", () => {
    mockEvents(2);

    const { container } = render(<FlowEventFeed stablecoinId="dai-makerdao" limit={10} scope="counted" />);

    const rows = screen.getByTestId("mint-burn-event-feed-table").querySelectorAll("tbody tr");
    expect(rows[0].textContent).toContain("Mint");
    expect(rows[0].textContent).toContain("+$1.00K");
    expect(rows[1].textContent).toContain("Burn");
    expect(rows[1].textContent).toContain("−$2.00K");
    expect(container.querySelector("[class*='emerald'], [class*='red-'], [class*='rose-']")).toBeNull();
    expect(container.querySelector("ol")).toBeNull();
  });

  it("explains an empty ledger without contradicting longer-window nets", () => {
    mockEvents(0);

    render(<FlowEventFeed stablecoinId="xaut-tether" limit={10} scope="counted" />);

    expect(screen.getByText(/No counted mint or burn events in the recent event ledger/)).toBeTruthy();
    expect(screen.getByText(/30- and 90-day nets come from longer-kept hourly totals/)).toBeTruthy();
    expect(screen.queryByText(/recorded yet/)).toBeNull();
  });

  it("keeps short feeds unfolded", () => {
    mockEvents(4);

    render(<FlowEventFeed stablecoinId="dai-makerdao" limit={10} scope="counted" />);

    expect(tableRowCount()).toBe(4);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });
});
