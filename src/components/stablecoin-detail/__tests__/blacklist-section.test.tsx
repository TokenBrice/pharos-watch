// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
import { BlacklistSection } from "@/components/stablecoin-detail/blacklist-section";
import { useBlacklistSummary } from "@/hooks/use-blacklist-events";

function summaryStub(overrides: {
  perCoinTotalEvents?: Record<string, number>;
  perCoinFrozenAddressCount?: Record<string, number>;
  perCoinFrozenTotal?: Record<string, number>;
  perCoinDestroyedTotal?: Record<string, number>;
  perCoinQuarterlyEventTypes?: Record<string, Array<{ quarter: string; blacklist: number; unblacklist: number; destroy: number }>>;
} = {}) {
  return {
    data: {
      stats: {
        perCoinTotalEvents: overrides.perCoinTotalEvents ?? { USDC: 5 },
        perCoinFrozenAddressCount: overrides.perCoinFrozenAddressCount ?? { USDC: 3 },
        perCoinFrozenTotal: overrides.perCoinFrozenTotal ?? { USDC: 1000 },
        perCoinDestroyedTotal: overrides.perCoinDestroyedTotal ?? { USDC: 0 },
        perCoinQuarterlyEventTypes:
          overrides.perCoinQuarterlyEventTypes ?? {
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
    const { container } = render(
      <BlacklistSection stablecoinId="makerdao-dai" symbol={"DAI" as "USDC"} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("returns null for a supported coin with zero events", () => {
    vi.mocked(useBlacklistSummary).mockReturnValue(
      summaryStub({ perCoinTotalEvents: { USDC: 0 } }),
    );
    const { container } = render(<BlacklistSection stablecoinId="usdc-circle" symbol="USDC" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the Blacklist Activity heading and all three stat titles on the happy path", () => {
    vi.mocked(useBlacklistSummary).mockReturnValue(summaryStub());
    const { getByText, getAllByText } = render(
      <BlacklistSection stablecoinId="usdc-circle" symbol="USDC" />,
    );
    expect(getByText(/Blacklist Activity/i)).toBeTruthy();
    expect(getByText(/Frozen addresses/i)).toBeTruthy();
    expect(getByText(/Frozen total/i)).toBeTruthy();
    // Chart legend also contains "Destroy" (event-type series). The stat card
    // label "Destroyed" is specifically the past-tense form, so match exactly.
    expect(getAllByText(/Destroyed/).length).toBeGreaterThan(0);
    expect(getByText(/Recent Blacklist Events/i)).toBeTruthy();
  });

  it("returns null when the summary errors (silent failure)", () => {
    vi.mocked(useBlacklistSummary).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useBlacklistSummary>);
    const { container } = render(<BlacklistSection stablecoinId="usdc-circle" symbol="USDC" />);
    expect(container.firstChild).toBeNull();
  });
});
