// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));
vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});
vi.mock("@/hooks/use-blacklist-events", () => ({ useBlacklistEventsPage: vi.fn() }));

import { BlacklistDetailEventFeed } from "@/components/stablecoin-detail/blacklist-detail-event-feed";
import { useBlacklistEventsPage } from "@/hooks/use-blacklist-events";
import type { BlacklistEvent } from "@shared/types";

type EventsPageResult = ReturnType<typeof useBlacklistEventsPage>;

const NOW_MS = Date.parse("2026-10-26T00:00:00Z");
const EVENT: BlacklistEvent = {
  id: "evt-1",
  stablecoin: "USDT",
  chainId: "ethereum",
  chainName: "Ethereum",
  eventType: "blacklist",
  address: "0x0000000000000000000000000000000000000001",
  amountNative: 0,
  amountUsdAtEvent: null,
  amountSource: "historical",
  amountStatus: "resolved",
  txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
  blockNumber: 1,
  timestamp: NOW_MS - 86_400_000,
  methodologyVersion: "5.91",
  contractAddress: null,
  configKey: null,
  eventSignature: null,
  eventTopic0: null,
  explorerTxUrl: "https://etherscan.io/tx/0x0",
  explorerAddressUrl: "https://etherscan.io/address/0x0",
};

function page(overrides: Partial<Record<string, unknown>>) {
  vi.mocked(useBlacklistEventsPage).mockReturnValue({
    data: { events: [EVENT], total: 1 },
    isLoading: false,
    isError: false,
    error: null,
    meta: { updatedAt: NOW_MS / 1000 - 600, ageSeconds: 600, status: "fresh" },
    dataUpdatedAt: NOW_MS,
    ...overrides,
  } as unknown as EventsPageResult);
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
});

describe("BlacklistDetailEventFeed retention", () => {
  it("keeps retained rows through a failed refetch without a reader notice", () => {
    page({ isError: true, error: new Error("refetch failed") });
    render(<BlacklistDetailEventFeed symbol="USDT" />);
    expect(screen.getByTestId("stablecoin-blacklist-events-table")).toBeTruthy();
    expect(screen.getByText(/Latest events/)).toBeTruthy();
    expect(screen.queryByText(/Unable to load blacklist events/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps a retained empty page known-empty through a failed refetch", () => {
    page({ data: { events: [], total: 0 }, isError: true, error: new Error("refetch failed") });
    render(<BlacklistDetailEventFeed symbol="USDT" />);
    expect(screen.queryByText(/Unable to load blacklist events/)).toBeNull();
    expect(screen.queryByTestId("stablecoin-blacklist-events-table")).toBeNull();
  });

  it("replaces rows only when the exact page was never read", () => {
    page({ data: undefined, isError: true, error: new Error("down"), meta: null, dataUpdatedAt: 0 });
    render(<BlacklistDetailEventFeed symbol="USDT" />);
    expect(screen.getByText(/Unable to load blacklist events/)).toBeTruthy();
  });

  it("keeps null and zero amounts distinct in retained rows", () => {
    page({
      data: { events: [EVENT, { ...EVENT, id: "evt-2", amountNative: null, amountStatus: "permanently_unavailable", amountSource: "unavailable" }], total: 2 },
      error: new Error("refetch failed"),
    });
    render(<BlacklistDetailEventFeed symbol="USDT" />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).not.toBe(rows[1].textContent);
  });

  it("warns past the blacklist public band, with its own preset label", () => {
    page({ meta: { updatedAt: NOW_MS / 1000 - 30 * 86_400, ageSeconds: 30 * 86_400, status: "stale" } });
    render(<BlacklistDetailEventFeed symbol="USDT" />);
    expect(screen.getByRole("status").textContent).toContain("Blacklist");
    expect(screen.getByTestId("stablecoin-blacklist-events-table")).toBeTruthy();
  });
});
