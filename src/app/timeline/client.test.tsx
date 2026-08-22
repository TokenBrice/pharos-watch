// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { TapeEvent } from "@shared/types/tape-event";

type UseEventsResult = {
  data: { events: TapeEvent[]; nextCursor: string | null };
  pages: Array<{ data: { events: TapeEvent[]; nextCursor: string | null; total: number | null }; meta: null }> | undefined;
  isLoading: boolean;
  error: Error | null;
  meta: null;
  dataUpdatedAt: number;
  refetch: () => Promise<unknown>;
  fetchNextPage: () => Promise<unknown>;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  total: number | null;
};

type LatestEventsResult = {
  data: { events: TapeEvent[]; nextCursor: string | null; total: number | null; totalExact: boolean } | undefined;
  isLoading: boolean;
  error: Error | null;
  meta: null;
};

const useEventsMock = vi.fn<(...args: Parameters<typeof import("@/hooks/use-events").useEvents>) => UseEventsResult>();
const useLatestEventsMock = vi.fn<() => LatestEventsResult>();

vi.mock("@/hooks/use-events", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/use-events")>("@/hooks/use-events");
  return {
    ...actual,
    useEvents: (...args: Parameters<typeof actual.useEvents>) => useEventsMock(...args),
    useLatestEvents: () => useLatestEventsMock(),
  };
});

vi.mock("@/hooks/use-logos", () => ({
  useLogos: () => ({ data: {} }),
}));

import {
  TimelineClient,
  buildTimelineFeedController,
  buildTimelineFilterSignature,
  buildTimelineResetParams,
  TIMELINE_URL_SCHEMA,
} from "@/app/timeline/client";
import { decodeState } from "@/lib/url-state";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
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
  const nextCursor = overrides.data?.nextCursor ?? null;
  const total = overrides.total ?? events.length;
  useEventsMock.mockReturnValue({
    data: { events, nextCursor },
    pages: [{ data: { events, nextCursor, total }, meta: null }],
    isLoading: false,
    error: null,
    meta: null,
    dataUpdatedAt: Date.now(),
    refetch: vi.fn().mockResolvedValue(undefined),
    fetchNextPage: vi.fn().mockResolvedValue(undefined),
    hasNextPage: false,
    isFetchingNextPage: false,
    total,
    ...overrides,
  });
}

describe("TimelineClient", () => {
  it("keeps timeline pagination manual on initial page load", () => {
    mockEvents([]);

    render(<TimelineClient />);

    expect(useEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({ severityFloor: "notice" }),
      { autoLoadAll: false },
    );
  });

  it("renders the empty state when there are no events", () => {
    mockEvents([]);
    render(<TimelineClient />);
    expect(screen.getByText(/no events match these filters/i)).toBeTruthy();
  });

  it("renders an error notice when the hook errors", () => {
    mockEvents([], {
      error: new Error("fetch failed"),
    });
    const { container } = render(<TimelineClient />);
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

    render(<TimelineClient />);

    // Coin rows use the structured wire format visually and expose a concise
    // accessible name instead of repeating the full event title.
    expect(screen.getAllByRole("link", { name: /USDC.*depeg opened.*severity Severe/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("link", { name: /USDT.*freeze funds destroyed.*severity Critical/i })).toBeTruthy();
    expect(screen.getAllByText("depeg.opened").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("freeze.funds.destroyed")).toBeTruthy();
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.startsWith("/stablecoin/usdc-circle"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("/freezewatch"))).toBe(true);
  });

  it("collapses repeated same-coin same-type events within a day", () => {
    const now = Date.UTC(2026, 0, 15, 12, 0, 0);
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

    render(<TimelineClient />);

    expect(document.querySelector("[data-event-id='evt-3']")).not.toBeNull();
    expect(document.querySelector("[data-event-id='evt-2']")).toBeNull();
    expect(document.querySelector("[data-event-id='evt-1']")).toBeNull();
    expect(screen.getByText("depeg.peak_worsened")).toBeTruthy();
    expect(screen.getByText("3 similar events grouped")).toBeTruthy();
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

    render(<TimelineClient />);

    expect(screen.getByText(/Currently open · 1 incident/i)).toBeTruthy();
    // The unmatched EURS open appears both in the banner and in the day feed.
    expect(screen.getAllByRole("link", { name: /EURS.*depeg opened.*severity Warning/i }).length).toBeGreaterThanOrEqual(1);
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

    render(<TimelineClient />);

    expect(screen.queryByText(/Currently open/i)).toBeNull();
  });

  it("renders the summary band with event count and window", () => {
    mockEvents([
      makeTapeEvent({ id: "evt-1", title: "Event one" }),
      makeTapeEvent({ id: "evt-2", title: "Event two", coinId: "usdt-tether" }),
    ]);

    render(<TimelineClient />);

    expect(screen.getByText("2 events")).toBeTruthy();
    expect(screen.getByText("last 7 days")).toBeTruthy();
    expect(screen.getByText("Notice+ severity")).toBeTruthy();
  });

  it("summary band shows partial-load count when total exceeds loaded events", () => {
    mockEvents(
      [
        makeTapeEvent({ id: "evt-1", title: "Event one" }),
        makeTapeEvent({ id: "evt-2", title: "Event two", coinId: "usdt-tether" }),
      ],
      { total: 1247, hasNextPage: true },
    );

    render(<TimelineClient />);

    expect(screen.getByText("Showing 2 of 1,247 events")).toBeTruthy();
    expect(screen.getByText(/Load more \(1,245 remaining\)/)).toBeTruthy();
  });

  it("collapses a dense yesterday class into a digest row", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T12:00:00.000Z"));
    const yesterday = Date.now() - 86_400_000;
    const events: TapeEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(
        makeTapeEvent({
          id: `evt-freeze-${i}`,
          ts: yesterday - i * 60_000,
          type: "freeze.blocked",
          severity: "notice",
          coinId: null,
          chain: "ethereum",
          title: `USDT freeze ${i}`,
          summary: `Freeze body ${i}`,
          payload: { stablecoin: "USDT", chainId: "ethereum", chainName: "Ethereum", amountUsdAtEvent: 100_000 },
          sourceRowId: `f-${i}`,
        }),
      );
    }
    mockEvents(events);

    render(<TimelineClient />);

    // Class digest row carries the recap text; individual rows are hidden
    // inside the collapsed <details>. "Freezes" appears both as the filter
    // chip and as the digest-row class label — assert both occur.
    expect(screen.getAllByText(/^Freezes$/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/5 events/).length).toBeGreaterThanOrEqual(1);
    // The collapsed class still keeps the leading grouped row in the DOM.
    expect(document.querySelector("[data-event-id='evt-freeze-0']")).not.toBeNull();
    expect(document.querySelector("[data-event-id='evt-freeze-1']")).toBeNull();
    expect(screen.getByText("5 similar events grouped")).toBeTruthy();
    // The collapsed <details> wrapper is in the document.
    const details = document.querySelector("details");
    expect(details).not.toBeNull();
  });

  it("renders the status-line footer with EVT count, window, severity floor, cursor and last file", () => {
    mockEvents([
      makeTapeEvent({ id: "evt-1", title: "Event one" }),
      makeTapeEvent({ id: "evt-2", title: "Event two", coinId: "usdt-tether" }),
    ]);

    render(<TimelineClient />);

    const footer = screen.getByText(/END OF TAPE/);
    const footerText = footer.textContent ?? "";
    expect(footerText).toMatch(/END OF TAPE/);
    expect(footerText).toMatch(/2 EVT/);
    expect(footerText).toMatch(/WINDOW 7D/);
    expect(footerText).toMatch(/NOTICE\+/);
    expect(footerText).toMatch(/CURSOR: NULL/);
    expect(footerText).toMatch(/LAST FILE:/);
  });

  it("renders the [OPEN] textual prefix inside the Currently open region", () => {
    const now = Date.now();
    mockEvents([
      makeTapeEvent({
        id: "evt-open-still",
        ts: now - 60_000,
        type: "depeg.opened",
        title: "EURS depeg opened (+589 bps)",
        coinId: "eurs-stasis",
        sourceRowId: "200",
      }),
    ]);

    const { container } = render(<TimelineClient />);

    const region = container.querySelector("[aria-labelledby='tape-open-incidents-heading']");
    expect(region).not.toBeNull();
    expect(region?.getAttribute("role")).toBe("region");
    expect(screen.getAllByText(/\[OPEN\]/).length).toBeGreaterThanOrEqual(1);
  });

  it("collapses quiet days (<=3 events) into a single <details> row", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T12:00:00.000Z"));
    const yesterday = Date.now() - 86_400_000;
    mockEvents([
      makeTapeEvent({
        id: "evt-1",
        ts: yesterday,
        type: "psi.shifted_up",
        coinId: "usdt-tether",
        title: "PSI band up",
      }),
      makeTapeEvent({
        id: "evt-2",
        ts: yesterday - 60_000,
        type: "score.upgraded",
        coinId: "dai-makerdao",
        title: "DAI upgraded",
      }),
    ]);

    render(<TimelineClient />);

    // The day section is wrapped in a <details> with a summary listing the
    // class slugs and tickers.
    const summary = document.querySelector("details > summary");
    expect(summary).not.toBeNull();
    const summaryText = summary?.textContent ?? "";
    expect(summaryText.toLowerCase()).toContain("psi");
    expect(summaryText.toLowerCase()).toContain("score");
  });

  it("renders linked-event as a PINNED inline row instead of a separate section", () => {
    const pinned: TapeEvent = makeTapeEvent({
      id: "evt-pinned",
      title: "Linked event title",
      summary: "Linked summary",
    });
    useLatestEventsMock.mockReturnValue({
      data: { events: [pinned], nextCursor: null, total: 1, totalExact: true },
      isLoading: false,
      error: null,
      meta: null,
    });
    mockEvents([makeTapeEvent({ id: "evt-other", title: "Other event" })]);
    // Force the permalink lookup branch by setting ?event= in the URL.
    window.history.replaceState(null, "", `/timeline?event=${encodeURIComponent("evt-pinned")}`);

    render(<TimelineClient />);

    expect(screen.queryByText(/You followed a link/i)).toBeNull();
    expect(screen.getAllByText(/PINNED/).length).toBeGreaterThanOrEqual(1);
    window.history.replaceState(null, "", "/timeline");
  });

  it("labels empty-state clear-filter chips with a 'Clear filter:' aria-label", () => {
    mockEvents([]);
    window.history.replaceState(null, "", "/timeline?window=24h");

    render(<TimelineClient />);

    const button = screen.getByRole("button", { name: /Clear filter:/i });
    expect(button).toBeTruthy();
    window.history.replaceState(null, "", "/timeline");
  });
});

describe("timeline feed controller", () => {
  it("decodes the legacy all-time token through the URL schema", () => {
    expect(decodeState("window=alltime&severity=bogus", TIMELINE_URL_SCHEMA)).toMatchObject({
      window: "all",
      severity: "notice",
    });
  });

  it("builds a new pagination reset signature when filters change", () => {
    const base = {
      typeRaw: "",
      type: [] as string[],
      severity: "notice",
      coin: "",
      peg: "all",
      chain: "all",
      window: "7d",
      q: "",
    } as const;

    expect(buildTimelineFilterSignature(base)).not.toBe(
      buildTimelineFilterSignature({ ...base, window: "24h" }),
    );
    expect(buildTimelineFilterSignature(base)).not.toBe(
      buildTimelineFilterSignature({ ...base, typeRaw: "depeg.*", type: ["depeg.*"] }),
    );
  });

  it("normalizes event query params and reset params for filter changes", () => {
    const controller = buildTimelineFeedController(
      {
        typeRaw: "depeg.*",
        type: ["depeg.*"],
        severity: "warning",
        coin: "usdc-circle",
        peg: "USD",
        chain: "ethereum",
        window: "24h",
        q: "basis",
      },
      123,
    );

    expect(controller.queryParams).toEqual({
      type: ["depeg.*"],
      coin: "usdc-circle",
      pegCurrency: "USD",
      chain: "ethereum",
      severityFloor: "warning",
      since: 123,
      q: "basis",
    });
    expect(controller.hasActiveFilters).toBe(true);
    expect(controller.windowShort).toBe("24H");
    expect(buildTimelineResetParams()).toEqual({
      type: "",
      severity: "",
      coin: "",
      peg: "all",
      chain: "all",
      window: "7d",
      q: "",
    });
  });
});
