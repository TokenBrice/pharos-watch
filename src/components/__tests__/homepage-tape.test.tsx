// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { BlacklistEvent, DepegEvent } from "@shared/types";

type UseInfiniteDepegEventsResult = {
  data: { events: DepegEvent[] };
  isLoading: boolean;
  isSuccess: boolean;
  error: Error | null;
};

type UseBlacklistEventsPageResult = {
  data: { events: BlacklistEvent[]; total: number } | undefined;
  isLoading: boolean;
  isSuccess: boolean;
  error: Error | null;
};

const useInfiniteDepegEventsMock = vi.fn<() => UseInfiniteDepegEventsResult>();
const useBlacklistEventsPageMock = vi.fn<() => UseBlacklistEventsPageResult>();

vi.mock("@/hooks/use-depeg-events", () => ({
  useInfiniteDepegEvents: () => useInfiniteDepegEventsMock(),
}));

vi.mock("@/hooks/use-blacklist-events", () => ({
  useBlacklistEventsPage: () => useBlacklistEventsPageMock(),
}));

import { HomepageTape } from "@/components/homepage-tape";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  useInfiniteDepegEventsMock.mockReset();
  useBlacklistEventsPageMock.mockReset();
  mockDepegs();
  mockFreezes();
});

function makeDepegEvent(overrides: Partial<DepegEvent> = {}): DepegEvent {
  return {
    id: 1,
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    pegType: "peggedUSD",
    direction: "below",
    peakDeviationBps: -500,
    startedAt: Math.floor(Date.now() / 1000) - 120,
    endedAt: null,
    startPrice: 0.95,
    peakPrice: 0.95,
    recoveryPrice: null,
    pegReference: 1,
    source: "live",
    confirmationSources: null,
    pendingReason: null,
    provenance: null,
    ...overrides,
  };
}

function makeFreezeEvent(overrides: Partial<BlacklistEvent> = {}): BlacklistEvent {
  return {
    id: "eth-0xabc",
    stablecoin: "USDT",
    chainId: "ethereum",
    chainName: "Ethereum",
    eventType: "destroy",
    address: "0x0000000000000000000000000000000000000001",
    amountNative: 15_000_000,
    amountUsdAtEvent: 15_000_000,
    amountSource: "event",
    amountStatus: "resolved",
    txHash: "0xabc",
    blockNumber: 1,
    timestamp: Math.floor(Date.now() / 1000) - 3600,
    methodologyVersion: "3.0",
    contractAddress: null,
    configKey: null,
    eventSignature: null,
    eventTopic0: null,
    suppressionReason: null,
    explorerTxUrl: "https://etherscan.io/tx/0xabc",
    explorerAddressUrl: "https://etherscan.io/address/0x1",
    ...overrides,
  };
}

function mockDepegs(overrides: Partial<UseInfiniteDepegEventsResult> = {}) {
  useInfiniteDepegEventsMock.mockReturnValue({
    data: { events: [] },
    isLoading: false,
    isSuccess: true,
    error: null,
    ...overrides,
  });
}

function mockFreezes(overrides: Partial<UseBlacklistEventsPageResult> = {}) {
  useBlacklistEventsPageMock.mockReturnValue({
    data: { events: [], total: 0 },
    isLoading: false,
    isSuccess: true,
    error: null,
    ...overrides,
  });
}

describe("HomepageTape", () => {
  it("renders nothing when there are no events", () => {
    const { container } = render(<HomepageTape />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when every source errors", () => {
    mockDepegs({
      isSuccess: false,
      isLoading: false,
      error: new Error("fetch failed"),
    });
    mockFreezes({
      data: undefined,
      isSuccess: false,
      isLoading: false,
      error: new Error("fetch failed"),
    });
    const { container } = render(<HomepageTape />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a loading state when the hook is loading", () => {
    mockDepegs({
      isSuccess: false,
      isLoading: true,
      error: null,
    });
    mockFreezes({
      data: undefined,
      isSuccess: false,
      isLoading: true,
      error: null,
    });
    render(<HomepageTape />);
    expect(screen.getByText(/loading recent events/i)).toBeTruthy();
  });

  it("renders depeg and freeze events with links to their source surfaces and severity labels", () => {
    mockDepegs({ data: { events: [makeDepegEvent({ peakDeviationBps: -1200 })] } });
    mockFreezes({
      data: {
        events: [makeFreezeEvent({ amountNative: 150_000_000, amountUsdAtEvent: 150_000_000 })],
        total: 1,
      },
    });

    render(<HomepageTape />);

    // Items are duplicated for the scrolling loop; expect 2 occurrences per event.
    expect(screen.getAllByText("USDC depeg opened (−1200 bps)")).toHaveLength(2);
    expect(screen.getAllByText(/USDT \$150\.0M destroyed/)).toHaveLength(2);
    // Severity dots carry an accessible label for each tier.
    expect(screen.getAllByLabelText("Severe").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Critical").length).toBeGreaterThan(0);
    // Source links are present.
    const links = screen.getAllByRole("link");
    const hrefs = links.map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.startsWith("/stablecoin/usdc-circle"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("/freezewatch"))).toBe(true);
  });

  it("renders available events when one source errors", () => {
    mockDepegs({
      isSuccess: false,
      error: new Error("depegs failed"),
    });
    mockFreezes({ data: { events: [makeFreezeEvent({ eventType: "blacklist", amountUsdAtEvent: 40_000 })], total: 1 } });

    render(<HomepageTape />);

    expect(screen.getAllByText(/USDT freeze \$40k · Ethereum/)).toHaveLength(2);
  });

  it("applies the pause-on-hover shell class on the outer wrapper", () => {
    mockDepegs({ data: { events: [makeDepegEvent()] } });

    const { container } = render(<HomepageTape />);
    const root = container.querySelector(".pharos-tape-shell");
    expect(root).toBeTruthy();
    expect(container.querySelector(".pharos-tape-track")).toBeTruthy();
  });
});
