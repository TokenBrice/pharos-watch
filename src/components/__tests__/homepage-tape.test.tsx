// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { TapeEvent } from "@shared/types/tape-event";

type LatestEventsResult = {
  data: { events: TapeEvent[]; nextCursor: string | null; total: number | null; totalExact: boolean } | undefined;
  isLoading: boolean;
  error: Error | null;
  meta: null;
};

const useLatestEventsMock = vi.fn<() => LatestEventsResult>();

vi.mock("@/hooks/use-events", () => ({
  useLatestEvents: () => useLatestEventsMock(),
}));

vi.mock("@/hooks/use-logos", () => ({
  useLogos: () => ({ data: {} }),
}));

import { HomepageTape } from "@/components/homepage-tape";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  useLatestEventsMock.mockReset();
  mockLatestEvents();
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

function mockLatestEvents(overrides: Partial<LatestEventsResult> = {}) {
  useLatestEventsMock.mockReturnValue({
    data: { events: [], nextCursor: null, total: null, totalExact: false },
    isLoading: false,
    error: null,
    meta: null,
    ...overrides,
  });
}

describe("HomepageTape", () => {
  it("renders nothing when there are no events", () => {
    const { container } = render(<HomepageTape />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing on endpoint error", () => {
    mockLatestEvents({
      data: undefined,
      isLoading: false,
      error: new Error("fetch failed"),
    });
    const { container } = render(<HomepageTape />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a loading state when the hook is loading", () => {
    mockLatestEvents({
      data: undefined,
      isLoading: true,
      error: null,
    });
    render(<HomepageTape />);
    expect(screen.getByText(/loading recent events/i)).toBeTruthy();
  });

  it("renders depeg, freeze, and score events with links and stablecoin logos", () => {
    mockLatestEvents({
      data: {
        events: [
          makeTapeEvent({
            id: "1747200000000-depeg-aaa11111",
            type: "depeg.opened",
            severity: "severe",
            title: "USDC depeg opened (-1200 bps)",
            sourceUrl: "/stablecoin/usdc-circle/#peg-history",
            coinId: "usdc-circle",
          }),
          makeTapeEvent({
            id: "1747200000000-freeze-bbb22222",
            type: "freeze.funds.destroyed",
            severity: "critical",
            ts: Date.now() - 3_600_000,
            coinId: "usdt-tether",
            chain: "ethereum",
            title: "USDT $150.0M destroyed · Ethereum",
            sourceUrl: "/freezewatch/",
          }),
          makeTapeEvent({
            id: "1747200000000-score-ccc33333",
            type: "score.grade.downgraded",
            severity: "warning",
            ts: Date.now() - 7_200_000,
            coinId: "usdt-tether",
            title: "USDT grade A -> B+",
            sourceUrl: "/stablecoin/usdt-tether/#report-card",
          }),
        ],
        nextCursor: null,
        total: null,
        totalExact: false,
      },
    });

    render(<HomepageTape />);

    // Items are duplicated for the scrolling loop; expect 2 occurrences per event.
    expect(screen.getAllByText("USDC depeg opened (-1200 bps)")).toHaveLength(2);
    expect(screen.getAllByText(/USDT \$150\.0M destroyed/)).toHaveLength(2);
    expect(screen.getAllByText("USDT grade A -> B+")).toHaveLength(2);
    // Events use stablecoin logos when `coinId` is set. Logos resolve to a
    // letter-fallback (aria-label) when no image src is provided by the
    // mocked useLogos hook.
    expect(screen.getAllByLabelText("usdc-circle logo")).toHaveLength(2);
    expect(screen.getAllByLabelText("usdt-tether logo")).toHaveLength(4);
    // Source links are present.
    const links = screen.getAllByRole("link");
    const hrefs = links.map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.startsWith("/stablecoin/usdc-circle"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("/freezewatch"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("/stablecoin/usdt-tether"))).toBe(true);
  });

  it("keeps a severity dot fallback when an event is not tied to a stablecoin", () => {
    mockLatestEvents({
      data: {
        events: [
          makeTapeEvent({
            coinId: null,
            severity: "notice",
            title: "General market event",
            sourceUrl: "/",
          }),
        ],
        nextCursor: null,
        total: null,
        totalExact: false,
      },
    });

    render(<HomepageTape />);

    expect(screen.getAllByLabelText("Notice")).toHaveLength(2);
  });

  it("labels the strip as Events", () => {
    mockLatestEvents({
      data: { events: [makeTapeEvent()], nextCursor: null, total: null, totalExact: false },
    });

    render(<HomepageTape />);

    expect(screen.getByText("Events")).toBeTruthy();
    expect(screen.queryByText("Live Tape")).toBeNull();
  });

  it("applies the pause-on-hover shell class on the outer wrapper", () => {
    mockLatestEvents({
      data: { events: [makeTapeEvent()], nextCursor: null, total: null, totalExact: false },
    });

    const { container } = render(<HomepageTape />);
    const root = container.querySelector(".pharos-tape-shell");
    expect(root).toBeTruthy();
    expect(container.querySelector(".pharos-tape-track")).toBeTruthy();
  });

  it("can render as the full-width top strip", () => {
    mockLatestEvents({
      data: { events: [makeTapeEvent()], nextCursor: null, total: null, totalExact: false },
    });

    const { container } = render(<HomepageTape placement="top" />);
    const root = container.querySelector(".pharos-tape-shell");
    expect(root?.className).toContain("w-full");
    expect(root?.className).toContain("border-b");
    expect(root?.className).toContain("md:ml-[var(--pharos-homepage-tape-offset)]");
    expect(root?.className).not.toContain("-mx-3");
  });

  it("collapses repeated same-coin same-class events into one cell with a count badge", () => {
    mockLatestEvents({
      data: {
        events: [
          makeTapeEvent({
            id: "evt-3",
            ts: Date.now() - 60_000,
            type: "depeg.peak_worsened",
            title: "USDXL depeg peak worsened (−112 bps)",
            coinId: "usdxl-last",
          }),
          makeTapeEvent({
            id: "evt-2",
            ts: Date.now() - 600_000,
            type: "depeg.opened",
            title: "USDXL depeg opened (−109 bps)",
            coinId: "usdxl-last",
          }),
          makeTapeEvent({
            id: "evt-1",
            ts: Date.now() - 1_200_000,
            type: "depeg.resolved",
            title: "USDXL depeg resolved",
            coinId: "usdxl-last",
          }),
        ],
        nextCursor: null,
        total: null,
        totalExact: false,
      },
    });

    render(<HomepageTape />);

    // The most recent event's title is kept; the two older same-(coin,class)
    // events are collapsed into the single cell.
    expect(screen.getAllByText("USDXL depeg peak worsened (−112 bps)")).toHaveLength(2);
    expect(screen.queryByText("USDXL depeg opened (−109 bps)")).toBeNull();
    expect(screen.queryByText("USDXL depeg resolved")).toBeNull();
    // ×N badge reflects the total event count in the collapsed group, doubled
    // by the marquee loop.
    expect(screen.getAllByText("×3")).toHaveLength(2);
    expect(screen.getAllByLabelText("3 similar events")).toHaveLength(2);
  });

  it("does not collapse different-class events for the same coin", () => {
    mockLatestEvents({
      data: {
        events: [
          makeTapeEvent({
            id: "evt-d",
            type: "depeg.opened",
            title: "USDT depeg opened (−110 bps)",
            coinId: "usdt-tether",
          }),
          makeTapeEvent({
            id: "evt-s",
            type: "score.downgraded",
            title: "USDT grade A → B+",
            coinId: "usdt-tether",
          }),
        ],
        nextCursor: null,
        total: null,
        totalExact: false,
      },
    });

    render(<HomepageTape />);

    expect(screen.getAllByText("USDT depeg opened (−110 bps)")).toHaveLength(2);
    expect(screen.getAllByText("USDT grade A → B+")).toHaveLength(2);
    expect(screen.queryByText(/×\d/)).toBeNull();
  });

  it("appends a single non-duplicated 'View all events' terminator linking to /timeline/", () => {
    mockLatestEvents({
      data: {
        events: [
          makeTapeEvent({ id: "1747200000000-depeg-eee55555", title: "USDC depeg opened (-500 bps)" }),
          makeTapeEvent({
            id: "1747200000000-freeze-fff66666",
            type: "freeze.address.blocked",
            title: "USDT freeze blocked",
          }),
        ],
        nextCursor: null,
        total: null,
        totalExact: false,
      },
    });

    render(<HomepageTape />);

    // Terminator renders once even though items are duplicated.
    expect(screen.getAllByText("View all events")).toHaveLength(1);
    const tapeLink = screen.getByText("View all events").closest("a");
    // Next.js Link may normalize trailing slash; accept either.
    expect(tapeLink?.getAttribute("href")).toMatch(/^\/timeline\/?$/);
  });
});
