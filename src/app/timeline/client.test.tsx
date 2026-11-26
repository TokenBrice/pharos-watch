// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { TapeEvent } from "@shared/types/tape-event";
import { renderToString } from "react-dom/server";
import { makeTapeEvent } from "@shared/test-utils/tape-event";
import { ApiFetchError, type ApiMeta } from "@/lib/api";
import type { DepegEvent } from "@shared/types/peg";

type UseEventsResult = {
  data: { events: TapeEvent[]; nextCursor: string | null };
  pages: Array<{ data: { events: TapeEvent[]; nextCursor: string | null; droppedRows: number; total: number | null }; meta: null }> | undefined;
  isLoading: boolean; error: Error | null; meta: ApiMeta | null; dataUpdatedAt: number;
  refetch: () => Promise<unknown>; fetchNextPage: () => Promise<unknown>;
  hasNextPage: boolean; isFetchingNextPage: boolean; total: number | null; droppedRows: number;
};

type LatestEventsResult = {
  data: { events: TapeEvent[]; nextCursor: string | null; total: number | null; totalExact: boolean } | undefined;
  isLoading: boolean; error: Error | null; meta: null;
};

interface ActiveEventsResult {
  data: { events: DepegEvent[]; total: number; totalExact: boolean; nextCursor: string | null; pending: [] } | undefined;
  isLoading: boolean; error: Error | null; isFullyLoaded: boolean; isAutoLoadCapped: boolean;
  failureCount?: number; hasNextPage?: boolean; isFetchingNextPage?: boolean;
  meta: ApiMeta | null; dataUpdatedAt: number; refetch: () => Promise<unknown>;
}

const useEventsMock = vi.fn<(...args: Parameters<typeof import("@/hooks/use-events").useEvents>) => UseEventsResult>();
const useLatestEventsMock = vi.fn<() => LatestEventsResult>();
const useActiveDepegEventsMock = vi.fn<() => ActiveEventsResult>();

vi.mock("@/hooks/use-depeg-events", () => ({ useActiveDepegEvents: () => useActiveDepegEventsMock() }));
vi.mock("@/hooks/use-events", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/use-events")>("@/hooks/use-events");
  return { ...actual, useEvents: (...args: Parameters<typeof actual.useEvents>) => useEventsMock(...args), useLatestEvents: () => useLatestEventsMock() };
});
vi.mock("@/lib/logos", () => ({ logosById: {}, getLogoSrc: () => undefined }));

import { TimelineClient, buildTimelineFeedController, buildTimelineFilterSignature, buildTimelineResetParams } from "@/app/timeline/client";

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

beforeEach(() => {
  useEventsMock.mockReset();
  useLatestEventsMock.mockReset();
  useActiveDepegEventsMock.mockReset();
  mockActiveEvents([]);
  window.history.replaceState(null, "", "/timeline/");
  mockLatest([]);
});

function mockLatest(events: TapeEvent[] | undefined, error: Error | null = null) {
  useLatestEventsMock.mockReturnValue({
    data: events ? { events, nextCursor: null, total: events.length || null, totalExact: events.length > 0 } : undefined,
    isLoading: false, error, meta: null,
  });
}

function mockEvents(events: TapeEvent[], overrides: Partial<UseEventsResult> = {}) {
  const nextCursor = overrides.data?.nextCursor ?? null;
  const total = overrides.total ?? events.length;
  useEventsMock.mockReturnValue({
    data: { events, nextCursor },
    pages: [{ data: { events, nextCursor, droppedRows: overrides.droppedRows ?? 0, total }, meta: null }],
    isLoading: false, error: null, meta: null, dataUpdatedAt: Date.now(),
    refetch: vi.fn().mockResolvedValue(undefined), fetchNextPage: vi.fn().mockResolvedValue(undefined),
    hasNextPage: false, isFetchingNextPage: false, total, droppedRows: 0, ...overrides,
  });
}

function renderTimeline(events: TapeEvent[] = [], overrides: Partial<UseEventsResult> = {}) {
  mockEvents(events, overrides);
  return render(<TimelineClient />);
}

function activeEvent(overrides: Partial<DepegEvent> = {}): DepegEvent {
  return {
    id: 200, stablecoinId: "eurs-stasis", symbol: "EURS", pegType: "peggedEUR",
    direction: "above", peakDeviationBps: 589, startedAt: Math.floor(Date.now() / 1000) - 60,
    endedAt: null, startPrice: 1.2, peakPrice: 1.25, recoveryPrice: null,
    pegReference: 1.17, source: "live", provenance: null, closeReason: null,
    confirmationSources: null, pendingReason: null, ...overrides,
  };
}

function mockActiveEvents(events: DepegEvent[], overrides: Partial<ActiveEventsResult> = {}) {
  useActiveDepegEventsMock.mockReturnValue({
    data: { events, total: events.length, totalExact: true, nextCursor: null, pending: [] },
    isLoading: false, error: null, isFullyLoaded: true, isAutoLoadCapped: false,
    meta: null, dataUpdatedAt: Date.now(), refetch: vi.fn().mockResolvedValue(undefined), ...overrides,
  });
}

describe("TimelineClient", () => {
  it("server-renders the reserved loading shell without reading the clock or querying", () => {
    const clock = vi.spyOn(Date, "now");
    try {
      const html = renderToString(<TimelineClient />);
      for (const slot of ["summary", "last-event", "feed"]) expect(html).toContain(`data-timeline-slot="${slot}"`);
      expect(html).toContain('id="data"');
      expect(html).toContain("Filter by event type");
      expect(html).not.toMatch(/\d+ events?|Updated|Last event/);
      expect(clock).not.toHaveBeenCalled();
      expect(useEventsMock).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it("threads the page clock through digest, pinned and source-direct incident rows", () => {
    vi.useFakeTimers();
    const nowMs = Date.UTC(2026, 9, 20, 12);
    vi.setSystemTime(nowMs);
    mockLatest([makeTapeEvent({ id: "clock-pinned", ts: nowMs - 60_000 })]);
    mockActiveEvents([activeEvent({ startedAt: (nowMs - 60_000) / 1000 })]);
    window.history.replaceState(null, "", "/timeline/?event=clock-pinned");
    renderTimeline([makeTapeEvent({ id: "clock-feed", type: "depeg.peak_worsened", ts: nowMs - 60_000 })]);

    const feedRow = document.querySelector('[data-event-id="clock-feed"]')!;
    const pinnedRow = document.querySelector('[data-event-id="clock-pinned"]')!;
    expect(feedRow.textContent).toContain("1m ago");
    expect(pinnedRow.textContent).toContain("1m ago");
    expect(screen.getByRole("region", { name: /Currently open/ }).textContent).toContain("OPEN 1m ago");
    const querySince = useEventsMock.mock.calls[0][0]?.since;

    act(() => { vi.advanceTimersByTime(60_000); });
    expect(feedRow.textContent).toContain("2m ago");
    expect(pinnedRow.textContent).toContain("2m ago");
    expect(screen.getByRole("region", { name: /Currently open/ }).textContent).toContain("OPEN 2m ago");
    expect(feedRow.querySelector("time")?.dateTime).toBe("2026-10-20T11:59:00.000Z");
    for (const [params] of useEventsMock.mock.calls) expect(params?.since).toBe(querySince);
  });

  it("keeps the same reserved slots across pending, empty, partial, success and error states", () => {
    const html = renderToString(<TimelineClient />);
    const shell = document.createElement("div");
    shell.innerHTML = html;
    const shellFilters = shell.querySelector('[aria-label="Filter by event type"]')!.outerHTML;
    const states: Array<[string, () => void]> = [
      ["pending", () => mockEvents([], { isLoading: true, pages: undefined, dataUpdatedAt: 0 })],
      ["empty", () => mockEvents([])],
      ["partial", () => mockEvents([makeTapeEvent()], { total: 12_345, hasNextPage: true })],
      ["success", () => mockEvents([makeTapeEvent()])],
      ["error", () => mockEvents([], { error: new Error("fetch failed"), pages: undefined, dataUpdatedAt: 0 })],
    ];
    let reference: string[] | null = null;
    for (const [label, arrange] of states) {
      arrange();
      render(<TimelineClient />);
      const classes = ["summary", "last-event", "feed"].map((s) => `${s}:${document.querySelector(`[data-timeline-slot="${s}"]`)!.className}`);
      if (reference) expect(classes, label).toEqual(reference);
      reference = classes;
      expect(document.querySelector('[aria-label="Filter by event type"]')!.outerHTML, label).toBe(shellFilters);
      if (label === "partial") {
        expect(screen.getByText("Showing 1 event")).toBeTruthy();
        expect(screen.queryByText(/of 12,345 events/)).toBeNull();
      }
      if (label === "success") expect(screen.getByText("1 event")).toBeTruthy();
      if (label === "empty") expect(screen.getByText("0 events")).toBeTruthy();
      cleanup();
    }
  });

  it("appends arriving open incidents after the stable summary slots and paints once census first attempt fails", () => {
    mockActiveEvents([], { isLoading: true, data: undefined, isFullyLoaded: false });
    const { rerender, unmount } = renderTimeline([makeTapeEvent({ type: "depeg.peak_worsened" })]);
    const row = () => screen.getByText("1 event").closest("p")!;
    const before = row().textContent!;
    expect(document.querySelector("[data-event-id]")).toBeNull();
    mockActiveEvents([activeEvent()]);
    rerender(<TimelineClient />);
    expect(row().textContent!.startsWith(before)).toBe(true);
    expect(row().textContent).toContain("1 open incident");
    expect(document.querySelector("[data-event-id]")).not.toBeNull();
    unmount();

    mockActiveEvents([], { isLoading: true, data: undefined, isFullyLoaded: false, failureCount: 1 });
    renderTimeline([makeTapeEvent({ type: "depeg.peak_worsened" })]);
    expect(document.querySelector("[data-event-id]")).not.toBeNull();
  });

  it("keeps pagination manual, admits fresh empty pages, and recovers from initial read errors", async () => {
    const refetch = vi.fn(async () => { mockEvents([]); });
    const { rerender } = renderTimeline([], { error: new Error("fetch failed"), refetch, pages: undefined, dataUpdatedAt: 0 });
    expect(useEventsMock).toHaveBeenCalledWith(expect.objectContaining({ severityFloor: "notice" }), { autoLoadAll: false });
    expect(screen.queryByText("▌")).toBeNull();
    expect(screen.queryByText(/no events match these filters/i)).toBeNull();

    const notice = screen.getByText("fetch failed").closest('[role="status"]') as HTMLElement;
    await act(async () => { fireEvent.click(within(notice).getByRole("button", { name: "Retry" })); });
    expect(refetch).toHaveBeenCalledOnce();
    rerender(<TimelineClient />);
    expect(screen.queryByText("fetch failed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByText(/no events match these filters/i)).toBeTruthy();
    expect(screen.queryByText("Waiting for initial data")).toBeNull();
  });

  it.each<[string, Partial<UseEventsResult>]>([
    ["pending", { isLoading: true, pages: undefined, dataUpdatedAt: 0 }],
    ["failed", { error: new Error("fetch failed"), pages: undefined, dataUpdatedAt: 0 }],
  ])("withholds the event count until a response page is admitted: %s", (_label, overrides) => {
    renderTimeline([], overrides);
    const summary = document.querySelector('[data-timeline-slot="summary"]')!;
    expect(summary.textContent).not.toMatch(/\d+\s+events?/);
    expect(summary.textContent).toContain("last 7 days");
    expect(summary.textContent).toContain("Notice+ severity");
  });

  it("handles retained-error, stale, and unknown-clock empty generations accurately", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { rerender } = renderTimeline([], { error: new Error("refresh failed") });
    expect(screen.getByText(/no events match these filters/i)).toBeTruthy();
    expect(screen.queryByText(/refresh failed|Waiting for initial data|Refresh failed|Showing an older snapshot/)).toBeNull();

    mockEvents([], { meta: { updatedAt: 1_700_000_000 - 86_400, ageSeconds: 86_400, status: "stale", freshBudgetSec: 600, degradedBudgetSec: 1200 } });
    rerender(<TimelineClient />);
    expect(screen.getByText("Showing an older snapshot")).toBeTruthy();
    expect(screen.getByText(/no events match these filters/i)).toBeTruthy();

    mockEvents([], { meta: { updatedAt: null, ageSeconds: null, status: "unknown", reason: "snapshot-producer-timestamp-unavailable" } });
    rerender(<TimelineClient />);
    expect(screen.queryByText("▌")).toBeNull();
    expect(screen.getByText("Waiting for initial data")).toBeTruthy();
  });

  it("renders events with titles and source links", () => {
    renderTimeline([
      makeTapeEvent({ id: "1747200000000-depeg-aaa11111", type: "depeg.opened", severity: "severe", title: "USDC depeg opened (-1200 bps)", sourceUrl: "/stablecoin/usdc-circle/#peg-history" }),
      makeTapeEvent({ id: "1747200000000-freeze-bbb22222", type: "freeze.funds.destroyed", severity: "critical", coinId: "usdt-tether", title: "USDT $150.0M destroyed · Ethereum", sourceUrl: "/freezewatch/" }),
    ]);
    expect(screen.getAllByRole("link", { name: /USDC.*depeg opened.*severity Severe/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("link", { name: /USDT.*freeze funds destroyed.*severity Critical/i })).toBeTruthy();
    expect(screen.getAllByText("depeg.opened").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("freeze.funds.destroyed")).toBeTruthy();
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.startsWith("/stablecoin/usdc-circle"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("/freezewatch"))).toBe(true);
  });

  it("collapses repeated same-coin same-type events within a day", () => {
    const now = Date.UTC(2026, 0, 15, 12);
    renderTimeline([
      makeTapeEvent({ id: "evt-3", ts: now - 60_000, type: "depeg.peak_worsened", title: "USDXL depeg peak worsened (−112 bps)", coinId: "usdxl-last" }),
      makeTapeEvent({ id: "evt-2", ts: now - 600_000, type: "depeg.peak_worsened", title: "USDXL depeg peak worsened (−109 bps)", coinId: "usdxl-last" }),
      makeTapeEvent({ id: "evt-1", ts: now - 1_200_000, type: "depeg.peak_worsened", title: "USDXL depeg peak worsened (−104 bps)", coinId: "usdxl-last" }),
    ]);
    expect(document.querySelector("[data-event-id='evt-3']")).not.toBeNull();
    expect(document.querySelector("[data-event-id='evt-2']")).toBeNull();
    expect(document.querySelector("[data-event-id='evt-1']")).toBeNull();
    expect(screen.getByText("depeg.peak_worsened")).toBeTruthy();
    expect(screen.getByText("3 similar events grouped")).toBeTruthy();
  });

  it("renders the Currently open banner from explicit active authority", () => {
    const now = Date.now();
    mockActiveEvents([activeEvent()]);
    renderTimeline([
      makeTapeEvent({ id: "evt-open-resolved", ts: now - 3_600_000, type: "depeg.opened", title: "USDC depeg opened (-200 bps)", coinId: "usdc-circle", sourceRowId: "100" }),
      makeTapeEvent({ id: "evt-resolved", ts: now - 1_800_000, type: "depeg.resolved", severity: "info", title: "USDC depeg resolved", coinId: "usdc-circle", sourceRowId: "100" }),
      makeTapeEvent({ id: "evt-open-still", ts: now - 60_000, type: "depeg.opened", title: "EURS depeg opened (+589 bps)", coinId: "eurs-stasis", sourceRowId: "200" }),
    ]);
    expect(screen.getByText(/Currently open · 1 incident/i)).toBeTruthy();
    const banner = screen.getByRole("region", { name: /Currently open/ });
    expect(within(banner).getByRole("link", { name: /EURS active depeg incident 200/ })).toBeTruthy();
    expect(within(banner).queryByRole("link", { name: /USDC/ })).toBeNull();
  });

  it.each([
    ["notice+", "/timeline/"], ["opened-only", "/timeline/?type=depeg.opened"], ["search mismatch", "/timeline/?q=unrelated"],
    ["superseded closure", "/timeline/?severity=warning"],
  ])("does not infer current incidents from unmatched historical openings: %s", (_label, url) => {
    window.history.replaceState(null, "", url);
    renderTimeline([makeTapeEvent({ type: "depeg.opened", sourceRowId: "100" })], { hasNextPage: true });
    expect(screen.queryByRole("region", { name: /Currently open/ })).toBeNull();
    expect(screen.queryByText(/1 open incident/)).toBeNull();
  });

  it("renders canonical same-coin episodes without a matching tape opening or guessed constituent IDs", () => {
    window.history.replaceState(null, "", "/timeline/?type=freeze.blocked&q=unrelated");
    mockActiveEvents([activeEvent({ id: 201, constituentEventCount: 3 }), activeEvent({ id: 202, startedAt: Math.floor(Date.now() / 1000) - 120 })]);
    renderTimeline([makeTapeEvent({ sourceRowId: "100" })], { hasNextPage: true });
    const banner = screen.getByRole("region", { name: /Currently open/ });
    const links = within(banner).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("data-depeg-event-id"))).toEqual(["201", "202"]);
    expect(links[0].getAttribute("href")).toBe("/stablecoin/eurs-stasis#peg-history");
    expect(within(banner).getByText("3 threshold crossings")).toBeTruthy();
    expect(banner.querySelector("[data-event-id]")).toBeNull();
  });

  it("lists the census newest first, collapses past three, and handles inactive-coin-only records", () => {
    const now = Math.floor(Date.now() / 1000);
    mockActiveEvents([
      activeEvent({ id: 400, stablecoinId: "retired-coin", symbol: "OLD" }),
      ...Array.from({ length: 6 }, (_, i) => activeEvent({ id: 305 - i, startedAt: now - 600 * (6 - i) })),
    ]);
    const { unmount } = renderTimeline([makeTapeEvent()]);
    const classRow = document.querySelector('[aria-label="Filter by event type"]') as HTMLElement;
    expect(within(classRow).getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");

    const banner = screen.getByRole("region", { name: "Currently open · 6 incidents" });
    const census = () => [...banner.querySelectorAll(":scope > div > a")].map((l) => l.getAttribute("data-depeg-event-id"));
    expect(census()).toEqual(["300", "301", "302"]);
    fireEvent.click(within(banner).getByRole("button", { name: "Show all 6" }));
    expect(census()).toEqual(["300", "301", "302", "303", "304", "305"]);
    expect(within(banner).getByRole("button", { name: "Show the 3 newest" })).toBeTruthy();
    expect(banner.querySelector("details summary")?.textContent).toContain("+1 on frozen or retired coins");
    screen.getByText("6 open incidents");
    unmount();

    mockActiveEvents([activeEvent({ id: 400, stablecoinId: "retired-coin", symbol: "OLD" })]);
    renderTimeline([makeTapeEvent()]);
    expect(screen.queryByRole("region", { name: /Currently open/ })).toBeNull();
    expect(screen.getByRole("region", { name: "1 open on frozen or retired coins" }).querySelector("details a")?.getAttribute("data-depeg-event-id")).toBe("400");
  });

  it.each([
    { label: "failed first read", error: new Error("active read failed"), isFullyLoaded: false, isLoading: false, isAutoLoadCapped: false, data: undefined },
    { label: "failed partial refresh", error: new Error("active read failed"), isFullyLoaded: false, isLoading: false, isAutoLoadCapped: false, hasNextPage: true },
    { label: "incomplete traversal", error: null, isFullyLoaded: false, isLoading: false, isAutoLoadCapped: false, isFetchingNextPage: true },
    { label: "capped traversal", error: null, isFullyLoaded: false, isLoading: false, isAutoLoadCapped: true },
    { label: "loading", error: null, isFullyLoaded: false, isLoading: true, isAutoLoadCapped: false },
  ])("withholds OPEN claims for $label even with retained source records", ({ label, ...overrides }) => {
    mockActiveEvents([activeEvent()], overrides);
    renderTimeline([makeTapeEvent()]);
    expect(screen.queryByRole("region", { name: /Currently open|Open at last observation/ })).toBeNull();
    expect(screen.queryByText(/1 open incident/)).toBeNull();
    if (label.includes("traversal")) expect(screen.queryByRole("region", { name: "Active incident status" })).toBeNull();
    else expect(screen.getByRole("region", { name: "Active incident status" }).textContent).toMatch(label === "loading" ? /Loading/ : /unavailable/);
  });

  it("ages the active producer independently of a fresh tape publication", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-20T12:00:00Z"));
    mockActiveEvents([activeEvent()], { meta: { updatedAt: Date.now() / 1000, ageSeconds: 0, status: "fresh", freshBudgetSec: 30, degradedBudgetSec: 60 } });
    renderTimeline([makeTapeEvent()]);
    expect(screen.getByRole("region", { name: /Currently open/ })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.queryByRole("region", { name: /Currently open/ })).toBeNull();
    expect(screen.getByRole("region", { name: "Open at last observation" })).toBeTruthy();
  });

  it.each([
    { label: "degraded", meta: { updatedAt: 0, ageSeconds: 0, status: "degraded" } satisfies ApiMeta, error: null, isFullyLoaded: true },
    { label: "error", meta: null, error: new Error("active refresh failed"), isFullyLoaded: false },
    { label: "stale", meta: { updatedAt: 0, ageSeconds: 0, status: "stale" } satisfies ApiMeta, error: null, isFullyLoaded: true },
  ])("retains a complete $label cohort as a dated observation", ({ label, meta, ...overrides }) => {
    vi.useFakeTimers();
    const observedAt = Date.UTC(2026, 9, 26);
    vi.setSystemTime(observedAt);
    const startedAt = observedAt / 1000 - 3600;
    mockActiveEvents([activeEvent({ id: 123, symbol: "USDC", startedAt })], { ...overrides, dataUpdatedAt: observedAt, meta: meta ? { ...meta, updatedAt: observedAt / 1000 } : null });
    renderTimeline([makeTapeEvent({ type: "depeg.peak_worsened" })]);
    const region = screen.getByRole("region", { name: "Open at last observation" });
    expect(region.textContent).toContain("Incidents open at last observation, newest first · independent of feed filters");
    expect(region.textContent).toContain("Observed open for 1h as of 2026-10-26 00:00 UTC");
    expect(region.textContent).not.toMatch(/OPEN|Currently open|active/);
    expect(within(region).getByRole("link", { name: "USDC depeg incident 123, open at last observation" })).toBeTruthy();
    expect(region.querySelector("time")?.dateTime).toBe(new Date(startedAt * 1000).toISOString());
    expect(screen.queryByText(/open incident/)).toBeNull();
    expect(screen.queryByText("Showing an older snapshot") != null).toBe(label === "stale");
  });

  it("freezes a retained duration while source age advances, stays quiet on empty, and recovers on fresh read", () => {
    vi.useFakeTimers();
    const observedAt = Date.UTC(2026, 9, 26);
    vi.setSystemTime(observedAt);
    mockActiveEvents([activeEvent({ startedAt: observedAt / 1000 - 3600 })], { error: new Error("active refresh failed"), isFullyLoaded: false, dataUpdatedAt: observedAt });
    const { rerender, unmount } = renderTimeline([makeTapeEvent({ type: "depeg.peak_worsened" })]);
    const region = () => screen.getByRole("region", { name: "Open at last observation" });
    expect(region().textContent).toContain("Updated just now");
    act(() => { vi.advanceTimersByTime(86_400_000); });
    expect(region().textContent).toContain("Observed open for 1h as of 2026-10-26 00:00 UTC");
    expect(region().textContent).toContain("Updated 1d ago");
    expect(within(region()).getByText("Showing an older snapshot")).toBeTruthy();

    mockActiveEvents([activeEvent()]);
    rerender(<TimelineClient />);
    expect(screen.getByRole("region", { name: /Currently open · 1 incident/ }).textContent).toContain("OPEN");
    expect(screen.getByText("1 open incident")).toBeTruthy();
    unmount();

    mockActiveEvents([], { error: new Error("active refresh failed"), isFullyLoaded: false });
    renderTimeline([makeTapeEvent({ type: "depeg.peak_worsened" })]);
    expect(screen.queryByRole("region", { name: /Currently open|Open at last observation|Active incident status/ })).toBeNull();
    expect(screen.queryByText(/open incident|Showing an older snapshot/)).toBeNull();
  });

  it.each([
    { label: "missing census", data: undefined, error: new Error("active read failed"), isFullyLoaded: false },
    { label: "unknown clock", meta: { updatedAt: null, ageSeconds: null, status: "unknown" } as ApiMeta, error: new Error("active refresh failed"), isFullyLoaded: false },
    { label: "unadmitted receipt", dataUpdatedAt: 0, error: new Error("active refresh failed"), isFullyLoaded: false },
    { label: "partial census", error: new Error("active refresh failed"), isFullyLoaded: false, data: { events: [activeEvent()], total: 2, totalExact: true, nextCursor: null, pending: [] as [] } },
  ])("fails closed for a $label instead of retaining it", ({ label: _label, ...overrides }) => {
    mockActiveEvents([activeEvent()], overrides);
    const { rerender } = renderTimeline([makeTapeEvent({ type: "depeg.peak_worsened" })]);
    expect(screen.queryByRole("region", { name: /Currently open|Open at last observation/ })).toBeNull();
    expect(document.querySelector("[data-event-id]")).not.toBeNull();
    expect(screen.getByRole("region", { name: "Active incident status" }).textContent).toMatch(/unavailable/);
    mockActiveEvents([], { data: undefined, error: null, isLoading: true, isFullyLoaded: false });
    rerender(<TimelineClient />);
    expect(document.querySelector("[data-event-id]")).not.toBeNull();
  });

  it("renders summary band, withholds raw server totals mid-traversal, and excludes rejected rows", () => {
    const two = [makeTapeEvent({ id: "evt-1", title: "Event one" }), makeTapeEvent({ id: "evt-2", title: "Event two", coinId: "usdt-tether" })];
    const { rerender } = renderTimeline(two, { total: 1247, hasNextPage: true });
    expect(screen.queryByText(/of 1,247 events|remaining/)).toBeNull();
    expect(screen.getByText("Showing 2 events")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();

    mockEvents(two, { total: 5, droppedRows: 3 });
    rerender(<TimelineClient />);
    expect(screen.getByText("2 events")).toBeTruthy();
    expect(screen.getByText("last 7 days")).toBeTruthy();
    expect(screen.getByText("Notice+ severity")).toBeTruthy();
    expect(screen.queryByText(/Showing 2 of 5 events|rows rejected/)).toBeNull();
  });

  describe("operational yield advisories", () => {
    const warning = (id: string, newSignals: string[]) => makeTapeEvent({
      id, type: "yield.warning_emitted", coinId: "usde-ethena", severity: "warning",
      title: `USDe yield warning: ${newSignals.join(", ")}`,
      summary: `New yield warning signal (${newSignals.join(", ")}) detected on selected source.`,
      payload: { newSignals },
    });

    it("hides them, keeps Load More on filtered-empty pages, and publishes visible total only after traversal", () => {
      const hidden = [warning("w1", ["aging"]), warning("w2", ["data-stale"])];
      const { rerender, unmount } = renderTimeline(hidden, { total: 40, hasNextPage: true, data: { events: hidden, nextCursor: "cursor-2" } });
      expect(screen.queryByText(/Aging observation|Data stale|of 40 events|remaining/)).toBeNull();
      expect(screen.getByRole("button", { name: /Load more/ })).toBeTruthy();

      mockEvents([warning("w1", ["aging"]), makeTapeEvent({ id: "d1", title: "Depeg one" })], { total: 2 });
      rerender(<TimelineClient />);
      expect(screen.getByText(/^1 events?$/)).toBeTruthy();
      unmount();

      const firstPageEvents = [makeTapeEvent({ id: "d1", title: "Depeg one" }), makeTapeEvent({ id: "d2", title: "Depeg two", coinId: "usdt-tether" })];
      const firstPage = { data: { events: firstPageEvents, nextCursor: "cursor-2", droppedRows: 0, total: 1000 }, meta: null };
      const view = renderTimeline(firstPageEvents, { data: { events: firstPageEvents, nextCursor: "cursor-2" }, total: 1000, hasNextPage: true, pages: [firstPage] });
      expect(screen.queryByText(/of 1,000 events|remaining/)).toBeNull();

      const page2Hidden = [warning("w1", ["aging"])];
      const all = [...firstPageEvents, ...page2Hidden];
      mockEvents(all, { data: { events: all, nextCursor: null }, total: 1000, hasNextPage: false, pages: [firstPage, { data: { events: page2Hidden, nextCursor: null, droppedRows: 0, total: null }, meta: null }] });
      view.rerender(<TimelineClient />);
      expect(screen.getByText("2 events")).toBeTruthy();
      expect(screen.queryByText(/of 1,000 events/)).toBeNull();
    });
  });

  it("ages producer freshness and UTC labels without moving the query anchor", () => {
    vi.useFakeTimers();
    const mountedAt = Date.parse("2026-10-09T23:59:30Z");
    vi.setSystemTime(mountedAt);
    const { rerender } = renderTimeline([], { dataUpdatedAt: 0 });
    const querySince = useEventsMock.mock.calls[0][0]?.since;

    vi.advanceTimersByTime(1_000);
    const receivedAt = Date.now();
    mockEvents([makeTapeEvent({ type: "depeg.peak_worsened", ts: mountedAt - 120_000 })], {
      dataUpdatedAt: receivedAt, meta: { updatedAt: receivedAt / 1000, ageSeconds: 0, status: "fresh", freshBudgetSec: 600, degradedBudgetSec: 1200 },
    });
    rerender(<TimelineClient />);
    expect(screen.getByText("▌")).toBeTruthy();
    expect(screen.getByText("Today")).toBeTruthy();
    const lastEventBefore = screen.getByText(/Last event:/).textContent;

    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.queryByText("Today")).toBeNull();
    expect(screen.getByText("Yesterday")).toBeTruthy();
    expect(screen.getByText(/Last event:/).textContent).not.toBe(lastEventBefore);

    act(() => { vi.advanceTimersByTime(10 * 60_000); });
    expect(screen.queryByText("▌")).toBeNull();
    expect(screen.getByText(/Updated/).textContent).not.toContain("just now");
    for (const [params] of useEventsMock.mock.calls) expect(params?.since).toBe(querySince);
  });

  it.each<[string, ApiMeta]>([
    ["old producer", { updatedAt: 1_700_000_000 - 3600, ageSeconds: 3600, status: "fresh", freshBudgetSec: 600, degradedBudgetSec: 1200 }],
    ["degraded producer", { updatedAt: 1_700_000_000, ageSeconds: 0, status: "degraded" }],
    ["unknown producer", { updatedAt: null, ageSeconds: null, status: "unknown", reason: "snapshot-producer-timestamp-unavailable" }],
  ])("does not publish a fresh indicator for %s with a new receipt", (_label, meta) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    renderTimeline([makeTapeEvent()], { meta });
    expect(screen.queryByText("▌")).toBeNull();
  });

  it.each<[string, Partial<Omit<UseEventsResult, "meta">> & { meta?: Extract<ApiMeta, { updatedAt: number }> }]>([
    ["fresh", {}],
    ["source-degraded", { meta: { updatedAt: 1_700_000_000, ageSeconds: 0, status: "degraded", warning: '199 - "source delayed"' } }],
    ["retained-error", { error: new Error("refresh failed") }],
  ])("keeps the %s Updated tooltip to the source timestamp", (label, overrides) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { rerender } = renderTimeline([makeTapeEvent({ type: "depeg.peak_worsened" })], overrides);
    const updated = () => screen.getByText(/^Updated /).parentElement!;
    expect(updated().title).toBe("Nov 14, 10:13 PM UTC");
    if (label === "retained-error") expect(screen.queryByText("▌")).toBeNull();

    mockEvents([makeTapeEvent({ type: "depeg.peak_worsened" })], {
      ...overrides, dataUpdatedAt: 1_700_000_100_000, meta: { status: "fresh", ...overrides.meta, updatedAt: 1_700_000_000, ageSeconds: 0 },
    });
    rerender(<TimelineClient />);
    expect(updated().title).toBe("Nov 14, 10:13 PM UTC");
  });

  it("explains stale Updated tooltip and drops fresh indicator on failed refresh while retaining events", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const event = makeTapeEvent({ type: "depeg.peak_worsened" });
    const { rerender } = renderTimeline([event], { meta: { updatedAt: 1_700_000_000 - 86_400, ageSeconds: 86_400, status: "stale" } });
    expect(screen.getByText(/^Updated /).parentElement!.title).toBe("Data is stale.");

    mockEvents([event]);
    rerender(<TimelineClient />);
    expect(screen.getByText("▌")).toBeTruthy();
    mockEvents([event], { error: new Error("refresh failed") });
    rerender(<TimelineClient />);
    expect(screen.queryByText("▌")).toBeNull();
    expect(document.querySelector(`[data-event-id="${event.id}"]`)).toBeTruthy();
  });

  it("collapses dense yesterday classes into digest rows and quiet days into a <details> row", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T12:00:00.000Z"));
    const yesterday = Date.now() - 86_400_000;
    const { unmount } = renderTimeline(Array.from({ length: 5 }, (_, i) => makeTapeEvent({
      id: `evt-freeze-${i}`, ts: yesterday - i * 60_000, type: "freeze.blocked", severity: "notice",
      coinId: null, chain: "ethereum", title: `USDT freeze ${i}`, summary: `Freeze body ${i}`,
      payload: { stablecoin: "USDT", chainId: "ethereum", chainName: "Ethereum", amountUsdAtEvent: 100_000 }, sourceRowId: `f-${i}`,
    })));
    expect(screen.getAllByText(/^Freezes$/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/5 events/).length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector("[data-event-id='evt-freeze-0']")).not.toBeNull();
    expect(document.querySelector("[data-event-id='evt-freeze-1']")).toBeNull();
    expect(screen.getByText("5 similar events grouped")).toBeTruthy();
    expect(document.querySelector("details")).not.toBeNull();
    unmount();

    renderTimeline([
      makeTapeEvent({ id: "evt-1", ts: yesterday, type: "psi.shifted_up", coinId: "usdt-tether", title: "PSI band up" }),
      makeTapeEvent({ id: "evt-2", ts: yesterday - 60_000, type: "score.upgraded", coinId: "dai-makerdao", title: "DAI upgraded" }),
    ]);
    const summaryText = (document.querySelector("details > summary")?.textContent ?? "").toLowerCase();
    expect(summaryText).toContain("psi");
    expect(summaryText).toContain("score");
  });

  it.each([
    { body: '{"reason":"flow-claim-retracted"}', retracted: true },
    { body: '{"reason":"freeze-claim-retracted"}', retracted: true },
    { body: '{"reason":"depeg-claim-retracted"}', retracted: true },
    { body: '{"reason":"event-not-found"}', retracted: false },
    { body: '{"reason":"unknown"}', retracted: false },
    { body: "null", retracted: false },
    { body: "invalid JSON", retracted: false },
    { body: null, retracted: false },
    { body: null, retracted: false, status: 0 },
    { body: '{"reason":"flow-claim-retracted"}', retracted: false, status: 500 },
  ])("renders the permalink notice for body $body and status $status", ({ body, retracted, status = 404 }) => {
    mockLatest(undefined, status ? new ApiFetchError("/api/events?event=evt-missing", status, body) : null);
    window.history.replaceState(null, "", "/timeline?event=evt-missing");
    renderTimeline([]);
    const notice = document.querySelector('[title="evt-missing"]');
    if (retracted) {
      expect(notice?.textContent).toBe("⚠ Retracted after its source data changed.");
      expect(screen.queryByText(/Linked event:/)).toBeNull();
    } else if (status === 0) {
      expect(notice?.textContent).toBe("⚠ The linked event isn't in this view. Try widening the filters or removing the time window.");
    } else expect(notice).toBeNull();
  });

  it("keeps a retracted depeg out of the exact buffer and cached feed", () => {
    const event = makeTapeEvent({ id: "evt-withdrawn" });
    const other = makeTapeEvent({ id: "evt-other", coinId: "usdt-tether" });
    const path = "/api/events?event=evt-withdrawn";
    const eventCard = () => document.querySelector('[data-event-id="evt-withdrawn"]');
    const notice = () => screen.queryByText(/Retracted after its source data changed/);
    window.history.replaceState(null, "", "/timeline/?event=evt-withdrawn");
    mockLatest([event]);
    const { rerender } = renderTimeline([]);
    expect(eventCard()?.textContent).toContain("-500 bps");

    const transientError = new ApiFetchError(path, 503, null);
    mockLatest([event], transientError);
    rerender(<TimelineClient />);
    expect(eventCard()).not.toBeNull();
    expect(notice()).toBeNull();

    mockLatest([event], new ApiFetchError(path, 404, '{"reason":"depeg-claim-retracted"}'));
    rerender(<TimelineClient />);
    expect(eventCard()).toBeNull();
    expect(notice()).not.toBeNull();

    mockEvents([event, other]);
    mockLatest([event], transientError);
    rerender(<TimelineClient />);
    expect(eventCard()).toBeNull();
    expect(notice()).not.toBeNull();
    expect(document.querySelector('[data-event-id="evt-other"]')).not.toBeNull();
  });

  it.each([false, true])("renders and focuses a PINNED permalink when the filtered feed is empty: %s", (emptyFeed) => {
    vi.useFakeTimers();
    mockLatest([makeTapeEvent({ id: "evt-pinned", title: "Linked event title", summary: "Linked summary" })]);
    window.history.replaceState(null, "", `/timeline?event=${encodeURIComponent("evt-pinned")}&coin=usdt-tether`);
    renderTimeline(emptyFeed ? [] : [makeTapeEvent({ id: "evt-other", title: "Other event" })]);

    expect(screen.queryByText(/You followed a link|linked event isn't in this view/i)).toBeNull();
    expect(screen.getAllByText(/PINNED/).length).toBeGreaterThanOrEqual(1);
    if (emptyFeed) expect(screen.getByText(/No events match these filters/i)).toBeTruthy();
    const target = document.getElementById("tape-event-card-evt-pinned");
    expect(document.getElementById("tape-feed")?.contains(target)).toBe(true);
    act(() => { vi.advanceTimersByTime(20); });
    expect(document.activeElement).toBe(target);
  });
});

describe("timeline feed controller", () => {
  it("builds pagination reset signatures and normalizes query/reset params", () => {
    const base = { typeRaw: "", type: [] as string[], severity: "notice", coin: "", peg: "all", chain: "all", window: "7d", q: "" } as const;
    expect(buildTimelineFilterSignature(base)).not.toBe(buildTimelineFilterSignature({ ...base, window: "24h" }));
    expect(buildTimelineFilterSignature(base)).not.toBe(buildTimelineFilterSignature({ ...base, typeRaw: "depeg.*", type: ["depeg.*"] }));

    const controller = buildTimelineFeedController({ typeRaw: "depeg.*", type: ["depeg.*"], severity: "warning", coin: "usdc-circle", peg: "USD", chain: "ethereum", window: "24h", q: "basis" }, 123);
    expect(controller.queryParams).toEqual({ type: ["depeg.*"], coin: "usdc-circle", pegCurrency: "USD", chain: "ethereum", severityFloor: "warning", since: 123, q: "basis" });
    expect(controller.hasActiveFilters).toBe(true);
    expect(controller.windowShort).toBe("24H");
    expect(buildTimelineResetParams()).toEqual({ type: "", severity: "", coin: "", peg: "all", chain: "all", window: "7d", q: "" });
  });
});
