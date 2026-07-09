// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
});

vi.mock("@/hooks/use-blacklist-events", () => ({
  useBlacklistSummary: vi.fn(),
  useBlacklistEventsPage: vi.fn(() => ({ data: { events: [], total: 0 }, isLoading: false, isError: false })),
}));

vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: () => ({ ref: { current: null }, ready: false, width: 0, height: 0 }),
}));

// BlacklistSection renders after the mocks are defined so the vi.mock hoists apply.
import { BlacklistHistorySection, BlacklistSection } from "@/components/stablecoin-detail/blacklist-section";
import { useBlacklistEventsPage, useBlacklistSummary } from "@/hooks/use-blacklist-events";
import type { BlacklistEvent } from "@shared/types";

function summaryStub(
  overrides: {
    perCoinTotalEvents?: Record<string, number>;
    perCoinFrozenAddressCount?: Record<string, number>;
    perCoinFrozenTotal?: Record<string, number>;
    perCoinDestroyedTotal?: Record<string, number>;
    perCoinQuarterlyEventTypes?: Record<
      string,
      Array<{ quarter: string; blacklist: number; unblacklist: number; destroy: number }>
    >;
  } = {},
) {
  return {
    data: {
      stats: {
        perCoinTotalEvents: overrides.perCoinTotalEvents ?? { USDC: 5 },
        perCoinFrozenAddressCount: overrides.perCoinFrozenAddressCount ?? { USDC: 3 },
        perCoinFrozenTotal: overrides.perCoinFrozenTotal ?? { USDC: 1000 },
        perCoinDestroyedTotal: overrides.perCoinDestroyedTotal ?? { USDC: 0 },
        perCoinQuarterlyEventTypes: overrides.perCoinQuarterlyEventTypes ?? {
          USDC: [{ quarter: "Q1 '26", blacklist: 5, unblacklist: 0, destroy: 0 }],
        },
      },
    },
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useBlacklistSummary>;
}

describe("BlacklistSection", () => {
  it("returns null for a coin not in BLACKLIST_STABLECOINS", () => {
    vi.mocked(useBlacklistSummary).mockReturnValue(summaryStub());
    const { container } = render(<BlacklistSection stablecoinId="makerdao-dai" symbol={"DAI" as "USDC"} />);
    expect(container.firstChild).toBeNull();
  });

  it("returns null for a supported coin with zero events", () => {
    vi.mocked(useBlacklistSummary).mockReturnValue(summaryStub({ perCoinTotalEvents: { USDC: 0 } }));
    const { container } = render(<BlacklistSection stablecoinId="usdc-circle" symbol="USDC" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the Blacklist Activity heading and all three stat titles on the happy path", () => {
    vi.mocked(useBlacklistSummary).mockReturnValue(summaryStub());
    const { getByText, getAllByText } = render(<BlacklistSection stablecoinId="usdc-circle" symbol="USDC" />);
    expect(getByText(/Blacklist Activity/i)).toBeTruthy();
    expect(getByText(/Frozen addresses/i)).toBeTruthy();
    expect(getByText(/Frozen total/i)).toBeTruthy();
    // Chart legend also contains "Destroy" (event-type series). The stat card
    // label "Destroyed" is specifically the past-tense form, so match exactly.
    expect(getAllByText(/Destroyed/).length).toBeGreaterThan(0);
  });

  it("renders Recent Blacklist Events from BlacklistHistorySection on the happy path", () => {
    vi.mocked(useBlacklistSummary).mockReturnValue(summaryStub());
    const { getByText } = render(<BlacklistHistorySection stablecoinId="usdc-circle" symbol="USDC" />);
    expect(getByText(/Recent Blacklist Events/i)).toBeTruthy();
  });

  it("links the full event feed through the canonical Freezewatch URL", () => {
    const event: BlacklistEvent = {
      id: "evt-1",
      stablecoin: "USDC",
      chainId: "ethereum",
      chainName: "Ethereum",
      eventType: "blacklist",
      address: "0x0000000000000000000000000000000000000001",
      amountNative: null,
      amountUsdAtEvent: null,
      amountSource: "unavailable",
      amountStatus: "permanently_unavailable",
      txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      blockNumber: 1,
      timestamp: Date.parse("2026-05-30T00:00:00Z"),
      methodologyVersion: "5.91",
      contractAddress: null,
      configKey: null,
      eventSignature: null,
      eventTopic0: null,
      explorerTxUrl: "https://etherscan.io/tx/0x0",
      explorerAddressUrl: "https://etherscan.io/address/0x0",
    };
    vi.mocked(useBlacklistSummary).mockReturnValue(summaryStub());
    vi.mocked(useBlacklistEventsPage).mockReturnValueOnce({
      data: { events: [event], total: 1 },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useBlacklistEventsPage>);

    const { getByRole, getByTestId } = render(<BlacklistHistorySection stablecoinId="usdc-circle" symbol="USDC" />);

    expect(getByTestId("stablecoin-blacklist-events-table").getAttribute("data-table-id")).toBe(
      "stablecoin-blacklist-events",
    );
    expect(getByRole("link", { name: "See all events →" }).getAttribute("href")).toBe("/freezewatch/?stablecoin=USDC");
  });

  it("BlacklistHistorySection returns null for a supported coin with zero events", () => {
    vi.mocked(useBlacklistSummary).mockReturnValue(summaryStub({ perCoinTotalEvents: { USDC: 0 } }));
    const { container } = render(<BlacklistHistorySection stablecoinId="usdc-circle" symbol="USDC" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders an explicit unavailable state when the summary errors", () => {
    vi.mocked(useBlacklistSummary).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("summary failed"),
      dataUpdatedAt: 0,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useBlacklistSummary>);
    render(<BlacklistSection stablecoinId="usdc-circle" symbol="USDC" />);
    expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
  });
});
