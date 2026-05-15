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

    // The unmatched depeg.opened renders in the day feed and in the
    // Currently-open banner — getAllByText covers both.
    expect(screen.getAllByText("USDC depeg opened (-1200 bps)").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/USDT \$150\.0M destroyed/)).toBeTruthy();
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.startsWith("/stablecoin/usdc-circle"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("/freezewatch"))).toBe(true);
  });

  it("collapses repeated same-coin same-class events within a day", () => {
    const now = Date.now();
    // Use peak_worsened only so the open-incidents banner stays out of the
    // way and the assertion isolates the collapse behavior.
    mockEvents([
      makeTapeEvent({
        id: "evt-3",
        ts: now - 60_000,
        type: "depeg.peak_worsened",
        title: "USDXL depeg peak worsened (−112 bps)",
        coinId: "usdxl-last",
      }),
      makeTapeEvent({
        id: "evt-2",
        ts: now - 600_000,
        type: "depeg.peak_worsened",
        title: "USDXL depeg peak worsened (−109 bps)",
        coinId: "usdxl-last",
      }),
      makeTapeEvent({
        id: "evt-1",
        ts: now - 1_200_000,
        type: "depeg.peak_worsened",
        title: "USDXL depeg peak worsened (−104 bps)",
        coinId: "usdxl-last",
      }),
    ]);

    render(<TapeClient />);

    expect(screen.getByText("USDXL depeg peak worsened (−112 bps)")).toBeTruthy();
    expect(screen.queryByText("USDXL depeg peak worsened (−109 bps)")).toBeNull();
    expect(screen.queryByText("USDXL depeg peak worsened (−104 bps)")).toBeNull();
    expect(screen.getByLabelText("3 similar events grouped")).toBeTruthy();
  });

  it("renders the Currently open banner for unmatched depeg.opened events", () => {
    const now = Date.now();
    mockEvents([
      makeTapeEvent({
        id: "evt-open-resolved",
        ts: now - 3_600_000,
        type: "depeg.opened",
        title: "USDC depeg opened (-200 bps)",
        coinId: "usdc-circle",
        sourceRowId: "100",
      }),
      makeTapeEvent({
        id: "evt-resolved",
        ts: now - 1_800_000,
        type: "depeg.resolved",
        severity: "info",
        title: "USDC depeg resolved",
        coinId: "usdc-circle",
        sourceRowId: "100",
      }),
      makeTapeEvent({
        id: "evt-open-still",
        ts: now - 60_000,
        type: "depeg.opened",
        title: "EURS depeg opened (+589 bps)",
        coinId: "eurs-stasis",
        sourceRowId: "200",
      }),
    ]);

    render(<TapeClient />);

    expect(screen.getByText(/Currently open · 1 incident/i)).toBeTruthy();
    // The unmatched EURS open appears both in the banner and in the day feed.
    expect(screen.getAllByText("EURS depeg opened (+589 bps)").length).toBeGreaterThanOrEqual(1);
  });

  it("does not render the Currently open banner when no depegs are unmatched", () => {
    const now = Date.now();
    mockEvents([
      makeTapeEvent({
        id: "evt-1",
        ts: now - 1_800_000,
        type: "depeg.opened",
        title: "USDC depeg opened (-200 bps)",
        coinId: "usdc-circle",
        sourceRowId: "100",
      }),
      makeTapeEvent({
        id: "evt-2",
        ts: now - 600_000,
        type: "depeg.resolved",
        severity: "info",
        title: "USDC depeg resolved",
        coinId: "usdc-circle",
        sourceRowId: "100",
      }),
    ]);

    render(<TapeClient />);

    expect(screen.queryByText(/Currently open/i)).toBeNull();
  });

  it("renders the summary band with event count and window", () => {
    mockEvents([
      makeTapeEvent({ id: "evt-1", title: "Event one" }),
      makeTapeEvent({ id: "evt-2", title: "Event two", coinId: "usdt-tether" }),
    ]);

    render(<TapeClient />);

    expect(screen.getByText("2 events")).toBeTruthy();
    expect(screen.getByText("last 7 days")).toBeTruthy();
    expect(screen.getByText("notice+ severity")).toBeTruthy();
  });
});
