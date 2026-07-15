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

  it("renders depeg and freeze events with links and stablecoin logos, dropping score events", () => {
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
    // Score grade changes are intentionally hidden from the homepage strip.
    expect(screen.queryByText("USDT grade A -> B+")).toBeNull();
    expect(screen.getAllByLabelText("usdc-circle logo")).toHaveLength(2);
    expect(screen.getAllByLabelText("usdt-tether logo")).toHaveLength(2);
    const links = screen.getAllByRole("link");
    const hrefs = links.map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.startsWith("/stablecoin/usdc-circle"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("/freezewatch"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("/stablecoin/usdt-tether/#report-card"))).toBe(false);
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
    expect(root?.className).not.toContain("-mx-3");

    for (const label of ["Core", "Variants", "Pegs", "Chains"]) {
      const chips = screen.getAllByText(label).map((node) => node.parentElement);
      expect(chips).toHaveLength(2);
      for (const chip of chips) {
        expect(chip?.className).toContain("rounded-md");
        expect(chip?.className).toContain("border");
        expect(chip?.className).toContain("h-6");
      }
    }
  });

  it("collapses repeated same-coin same-type events into one cell with a count badge", () => {
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
            type: "depeg.peak_worsened",
            title: "USDXL depeg peak worsened (−109 bps)",
            coinId: "usdxl-last",
          }),
          makeTapeEvent({
            id: "evt-1",
            ts: Date.now() - 1_200_000,
            type: "depeg.peak_worsened",
            title: "USDXL depeg peak worsened (−104 bps)",
            coinId: "usdxl-last",
          }),
        ],
        nextCursor: null,
        total: null,
        totalExact: false,
      },
    });

    render(<HomepageTape />);

    // The most recent event's title is kept; the two older same-(coin,type)
    // events are collapsed into the single cell.
    expect(screen.getAllByText("USDXL depeg peak worsened (−112 bps)")).toHaveLength(2);
    expect(screen.queryByText("USDXL depeg peak worsened (−109 bps)")).toBeNull();
    expect(screen.queryByText("USDXL depeg peak worsened (−104 bps)")).toBeNull();
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
            id: "evt-f",
            type: "freeze.address.blocked",
            title: "USDT freeze blocked",
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
    expect(screen.getAllByText("USDT freeze blocked")).toHaveLength(2);
    expect(screen.queryByText(/×\d/)).toBeNull();
  });

  it("consolidates DEWS band changes across coins into one cell with stacked logos", () => {
    mockLatestEvents({
      data: {
        events: [
          makeTapeEvent({
            id: "evt-sdx",
            type: "dews.escalated",
            severity: "notice",
            ts: Date.now() - 60_000,
            coinId: "sdx-stable",
            title: "SDX DEWS CALM → WATCH",
            payload: { prevBand: "CALM", newBand: "WATCH" },
            sourceUrl: "/depeg/",
          }),
          makeTapeEvent({
            id: "evt-usdm",
            type: "dews.escalated",
            severity: "notice",
            ts: Date.now() - 65_000,
            coinId: "usdm-mountain",
            title: "USDM DEWS CALM → WATCH",
            payload: { prevBand: "CALM", newBand: "WATCH" },
            sourceUrl: "/depeg/",
          }),
          makeTapeEvent({
            id: "evt-usdgo",
            type: "dews.escalated",
            severity: "notice",
            ts: Date.now() - 70_000,
            coinId: "usdgo-goldfinch",
            title: "USDGO DEWS CALM → WATCH",
            payload: { prevBand: "CALM", newBand: "WATCH" },
            sourceUrl: "/depeg/",
          }),
        ],
        nextCursor: null,
        total: null,
        totalExact: false,
      },
    });

    render(<HomepageTape />);

    // Three per-coin chips collapse into one consolidated "DEWS CALM → WATCH".
    expect(screen.getAllByText("DEWS CALM → WATCH")).toHaveLength(2);
    expect(screen.queryByText("SDX DEWS CALM → WATCH")).toBeNull();
    expect(screen.queryByText("USDM DEWS CALM → WATCH")).toBeNull();
    expect(screen.queryByText("USDGO DEWS CALM → WATCH")).toBeNull();
    // Badge reflects the coin count, not the literal event count.
    expect(screen.getAllByText("×3")).toHaveLength(2);
    expect(screen.getAllByLabelText("3 coins")).toHaveLength(4); // stack + badge × marquee dup
  });

  it("keeps DEWS escalations separate from de-escalations across the same coins", () => {
    mockLatestEvents({
      data: {
        events: [
          makeTapeEvent({
            id: "evt-sdx-up",
            type: "dews.escalated",
            severity: "notice",
            coinId: "sdx-stable",
            title: "SDX DEWS CALM → WATCH",
            payload: { prevBand: "CALM", newBand: "WATCH" },
          }),
          makeTapeEvent({
            id: "evt-usdm-down",
            type: "dews.deescalated",
            severity: "info",
            coinId: "usdm-mountain",
            title: "USDM DEWS WATCH → CALM",
            payload: { prevBand: "WATCH", newBand: "CALM" },
          }),
        ],
        nextCursor: null,
        total: null,
        totalExact: false,
      },
    });

    render(<HomepageTape />);

    // Single-coin DEWS entries keep their original symbol-prefixed title.
    expect(screen.getAllByText("SDX DEWS CALM → WATCH")).toHaveLength(2);
    expect(screen.getAllByText("USDM DEWS WATCH → CALM")).toHaveLength(2);
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
