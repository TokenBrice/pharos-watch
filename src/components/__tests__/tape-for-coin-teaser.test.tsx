// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { TapeEvent } from "@shared/types/tape-event";

type LatestEventsResult = {
  data: { events: TapeEvent[]; nextCursor: string | null; total: number | null; totalExact: boolean } | undefined;
  dataUpdatedAt: number;
  isLoading: boolean;
  error: Error | null;
  meta: null;
};

const useLatestEventsMock = vi.fn<() => LatestEventsResult>();

vi.mock("@/hooks/use-events", () => ({
  useLatestEvents: () => useLatestEventsMock(),
}));

import { TapeForCoinTeaser } from "@/components/tape-for-coin-teaser";

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  useLatestEventsMock.mockReset();
  mockLatestEvents();
});

function makeTapeEvent(overrides: Partial<TapeEvent> = {}): TapeEvent {
  return {
    id: "2026-07-08-depeg-opened",
    type: "depeg.opened",
    severity: "warning",
    ts: Date.parse("2026-07-08T12:00:00Z"),
    endsAt: null,
    coinId: "usdc-circle",
    issuerId: null,
    pegCurrency: "USD",
    chain: null,
    title: "USDC depeg opened (-500 bps)",
    summary: "USDC drifted to -500 bps versus its USD peg.",
    payload: {},
    sourceTable: "depeg_events",
    sourceRowId: "1",
    transition: "opened",
    sourceUrl: "/stablecoin/usdc-circle/#peg-history",
    methodologyVersion: null,
    ...overrides,
  };
}

function mockLatestEvents(overrides: Partial<LatestEventsResult> = {}) {
  useLatestEventsMock.mockReturnValue({
    data: { events: [], nextCursor: null, total: null, totalExact: false },
    dataUpdatedAt: 0,
    isLoading: false,
    error: null,
    meta: null,
    ...overrides,
  });
}

describe("TapeForCoinTeaser", () => {
  it("refreshes date labels when polling updates event data after UTC midnight", async () => {
    const event = makeTapeEvent();

    mockLatestEvents({
      data: { events: [event], nextCursor: null, total: null, totalExact: false },
      dataUpdatedAt: Date.parse("2026-07-08T23:50:00Z"),
    });

    const { rerender } = render(<TapeForCoinTeaser coinId="usdc-circle" />);
    await waitFor(() => {
      expect(screen.getByText("Today")).toBeTruthy();
    });

    mockLatestEvents({
      data: { events: [event], nextCursor: null, total: null, totalExact: false },
      dataUpdatedAt: Date.parse("2026-07-09T00:10:00Z"),
    });

    rerender(<TapeForCoinTeaser coinId="usdc-circle" />);

    await waitFor(() => {
      expect(screen.getByText("Yesterday")).toBeTruthy();
    });
    expect(screen.queryByText("Today")).toBeNull();
  });
});
