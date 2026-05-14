// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { TapeEvent } from "@shared/types/tape-event";

type UseEventsResult = {
  data: { events: TapeEvent[]; nextCursor: string | null };
  isLoading: boolean;
  error: Error | null;
  meta: null;
  dataUpdatedAt: number;
  refetch: () => Promise<unknown>;
  fetchNextPage: () => Promise<unknown>;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
};

type LatestEventsResult = {
  data: { events: TapeEvent[]; nextCursor: string | null; total: number | null; totalExact: boolean } | undefined;
  isLoading: boolean;
  error: Error | null;
  meta: null;
};

const useEventsMock = vi.fn<() => UseEventsResult>();
const useLatestEventsMock = vi.fn<() => LatestEventsResult>();

vi.mock("@/hooks/use-events", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/use-events")>("@/hooks/use-events");
  return {
    ...actual,
    useEvents: () => useEventsMock(),
    useLatestEvents: () => useLatestEventsMock(),
  };
});

vi.mock("@/hooks/use-logos", () => ({
  useLogos: () => ({ data: {} }),
}));

vi.mock("@/components/tape/tape-kpi-strip", () => ({
  TapeKpiStrip: () => <div data-testid="tape-kpi-strip" />,
}));

import { TapeClient } from "@/app/tape/client";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  useEventsMock.mockReset();
  useLatestEventsMock.mockReset();
  useLatestEventsMock.mockReturnValue({
    data: { events: [], nextCursor: null, total: null, totalExact: false },
    isLoading: false,
    error: null,
    meta: null,
  });
});

function makeTapeEvent(overrides: Partial<TapeEvent> = {}): TapeEvent {
  return {
    id: "1747200000000-depeg-abc12345",
    type: "depeg.opened",
    severity: "warning",
    ts: Date.now() - 120_000,
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

function mockEvents(events: TapeEvent[], overrides: Partial<UseEventsResult> = {}) {
  useEventsMock.mockReturnValue({
    data: { events, nextCursor: null },
    isLoading: false,
    error: null,
    meta: null,
    dataUpdatedAt: Date.now(),
    refetch: vi.fn().mockResolvedValue(undefined),
    fetchNextPage: vi.fn().mockResolvedValue(undefined),
    hasNextPage: false,
    isFetchingNextPage: false,
    ...overrides,
  });
}

describe("TapeClient", () => {
  it("renders the empty state when there are no events", () => {
    mockEvents([]);
    render(<TapeClient />);
    expect(screen.getByText(/no events match these filters/i)).toBeTruthy();
  });

  it("renders an error notice when the hook errors", () => {
    mockEvents([], {
      error: new Error("fetch failed"),
    });
    const { container } = render(<TapeClient />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders events with titles and source links", () => {
    mockEvents([
      makeTapeEvent({
        id: "1747200000000-depeg-aaa11111",
        type: "depeg.opened",
        severity: "severe",
        title: "USDC depeg opened (-1200 bps)",
        sourceUrl: "/stablecoin/usdc-circle/#peg-history",
      }),
      makeTapeEvent({
        id: "1747200000000-freeze-bbb22222",
        type: "freeze.funds.destroyed",
        severity: "critical",
        coinId: "usdt-tether",
        title: "USDT $150.0M destroyed · Ethereum",
        sourceUrl: "/freezewatch/",
      }),
    ]);

    render(<TapeClient />);

    expect(screen.getByText("USDC depeg opened (-1200 bps)")).toBeTruthy();
    expect(screen.getByText(/USDT \$150\.0M destroyed/)).toBeTruthy();
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.startsWith("/stablecoin/usdc-circle"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("/freezewatch"))).toBe(true);
  });
});
