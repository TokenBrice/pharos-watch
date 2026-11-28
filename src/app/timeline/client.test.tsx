// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { TapeEvent } from "@shared/types/tape-event";
import { renderToString } from "react-dom/server";
import { makeTapeEvent as tape } from "@shared/test-utils/tape-event";
import { ApiFetchError, type ApiMeta } from "@/lib/api";
import type { DepegEvent } from "@shared/types/peg";

type EventsRes = {
  data: { events: TapeEvent[]; nextCursor: string | null };
  pages: Array<{ data: { events: TapeEvent[]; nextCursor: string | null; droppedRows: number; total: number | null }; meta: null }> | undefined;
  isLoading: boolean; error: Error | null; meta: ApiMeta | null; dataUpdatedAt: number;
  refetch: () => Promise<unknown>; fetchNextPage: () => Promise<unknown>;
  hasNextPage: boolean; isFetchingNextPage: boolean; total: number | null; droppedRows: number;
};
type LatestRes = { data: { events: TapeEvent[]; nextCursor: string | null; total: number | null; totalExact: boolean } | undefined; isLoading: boolean; error: Error | null; meta: null };
type ActiveRes = {
  data: { events: DepegEvent[]; total: number; totalExact: boolean; nextCursor: string | null; pending: [] } | undefined;
  isLoading: boolean; error: Error | null; isFullyLoaded: boolean; isAutoLoadCapped: boolean;
  failureCount?: number; hasNextPage?: boolean; isFetchingNextPage?: boolean;
  meta: ApiMeta | null; dataUpdatedAt: number; refetch: () => Promise<unknown>;
};

const useEventsMock = vi.fn<(...args: Parameters<typeof import("@/hooks/use-events").useEvents>) => EventsRes>();
const useLatestMock = vi.fn<() => LatestRes>();
const useActiveMock = vi.fn<() => ActiveRes>();

vi.mock("@/hooks/use-depeg-events", () => ({ useActiveDepegEvents: () => useActiveMock() }));
vi.mock("@/hooks/use-events", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/use-events")>("@/hooks/use-events");
  return { ...actual, useEvents: (...a: Parameters<typeof actual.useEvents>) => useEventsMock(...a), useLatestEvents: () => useLatestMock() };
});
vi.mock("@/lib/logos", () => ({ logosById: {}, getLogoSrc: () => undefined }));

import { TimelineClient, buildTimelineFeedController, buildTimelineFilterSignature, buildTimelineResetParams } from "@/app/timeline/client";

const T0 = 1_700_000_000, nowSec = () => Math.floor(Date.now() / 1000);
const L_OPEN_LAST = "Open at last observation", L_ACT_STAT = "Active incident status", L_OLDER = "Showing an older snapshot";
const L_EMPTY = /no events match these filters/i, L_CUR = /Currently open/, L_BOTH = /Currently open|Open at last observation/;
const setUrl = (u: string) => window.history.replaceState(null, "", u);
const freeze = (ms: number) => { vi.useFakeTimers(); vi.setSystemTime(ms); };
const step = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const reg = (name: string | RegExp) => screen.getByRole("region", { name });
const noReg = (name: string | RegExp) => expect(screen.queryByRole("region", { name })).toBeNull();
const hasT = (t: string | RegExp) => expect(screen.getByText(t)).toBeTruthy();
const noT = (t: string | RegExp) => expect(screen.queryByText(t)).toBeNull();
const btn = (name: string | RegExp) => screen.getByRole("button", { name });
const q = (s: string) => document.querySelector(s);
const evtEl = (id?: string) => q(id ? `[data-event-id="${id}"]` : "[data-event-id]");
const peak = (ov: Parameters<typeof tape>[0] = {}) => tape({ type: "depeg.peak_worsened", ...ov });
const actErr = (msg = "active refresh failed") => ({ error: new Error(msg), isFullyLoaded: false });
const noPages = { pages: undefined, dataUpdatedAt: 0 } as const;
const metaOf = (status: ApiMeta["status"], extra: Record<string, unknown> = {}): ApiMeta =>
  (status === "unknown" ? { updatedAt: null, ageSeconds: null, status, ...extra } : { updatedAt: T0, ageSeconds: 0, status, ...extra }) as ApiMeta;

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });
beforeEach(() => { useEventsMock.mockReset(); useLatestMock.mockReset(); useActiveMock.mockReset(); setActive([]); setUrl("/timeline/"); setLatest([]); });

function setLatest(events: TapeEvent[] | undefined, error: Error | null = null) {
  useLatestMock.mockReturnValue({ data: events ? { events, nextCursor: null, total: events.length || null, totalExact: events.length > 0 } : undefined, isLoading: false, error, meta: null });
}

function setEvents(events: TapeEvent[], ov: Partial<EventsRes> = {}) {
  const nextCursor = ov.data?.nextCursor ?? null, total = ov.total ?? events.length;
  useEventsMock.mockReturnValue({
    data: { events, nextCursor }, pages: [{ data: { events, nextCursor, droppedRows: ov.droppedRows ?? 0, total }, meta: null }],
    isLoading: false, error: null, meta: null, dataUpdatedAt: Date.now(), refetch: vi.fn().mockResolvedValue(undefined),
    fetchNextPage: vi.fn().mockResolvedValue(undefined), hasNextPage: false, isFetchingNextPage: false, total, droppedRows: 0, ...ov,
  });
}

function mount(events: TapeEvent[] = [], ov: Partial<EventsRes> = {}) {
  setEvents(events, ov);
  const view = render(<TimelineClient />);
  return { ...view, refresh: () => view.rerender(<TimelineClient />) };
}

const activeEvt = (ov: Partial<DepegEvent> = {}): DepegEvent => ({
  id: 200, stablecoinId: "eurs-stasis", symbol: "EURS", pegType: "peggedEUR", direction: "above", peakDeviationBps: 589,
  startedAt: nowSec() - 60, endedAt: null, startPrice: 1.2, peakPrice: 1.25, recoveryPrice: null,
  pegReference: 1.17, source: "live", provenance: null, closeReason: null, confirmationSources: null, pendingReason: null, ...ov,
});

function setActive(events: DepegEvent[], ov: Partial<ActiveRes> = {}) {
  useActiveMock.mockReturnValue({
    data: { events, total: events.length, totalExact: true, nextCursor: null, pending: [] },
    isLoading: false, error: null, isFullyLoaded: true, isAutoLoadCapped: false,
    meta: null, dataUpdatedAt: Date.now(), refetch: vi.fn().mockResolvedValue(undefined), ...ov,
  });
}

describe("TimelineClient", () => {
  it("server-renders the reserved loading shell without reading the clock or querying", () => {
    const clock = vi.spyOn(Date, "now");
    try {
      const html = renderToString(<TimelineClient />);
      for (const s of ["summary", "last-event", "feed"]) expect(html).toContain(`data-timeline-slot="${s}"`);
      expect(html).toContain('id="data"');
      expect(html).toContain("Filter by event type");
      expect(html).not.toMatch(/\d+ events?|Updated|Last event/);
      expect([clock.mock.calls.length, useEventsMock.mock.calls.length]).toEqual([0, 0]);
    } finally { clock.mockRestore(); }
  });

  it("threads the page clock through digest, pinned and source-direct incident rows", () => {
    const nowMs = Date.UTC(2026, 9, 20, 12);
    freeze(nowMs);
    setLatest([tape({ id: "clock-pinned", ts: nowMs - 60_000 })]);
    setActive([activeEvt({ startedAt: (nowMs - 60_000) / 1000 })]);
    setUrl("/timeline/?event=clock-pinned");
    mount([peak({ id: "clock-feed", ts: nowMs - 60_000 })]);

    const [feedRow, pinnedRow] = [evtEl("clock-feed")!, evtEl("clock-pinned")!];
    const checkAges = (m: string) => { for (const [el, tok] of [[feedRow, m], [pinnedRow, m], [reg(L_CUR), `OPEN ${m}`]] as const) expect(el.textContent).toContain(tok); };
    checkAges("1m ago");
    const since = useEventsMock.mock.calls[0][0]?.since;
    step(60_000);
    checkAges("2m ago");
    expect(feedRow.querySelector("time")?.dateTime).toBe("2026-10-20T11:59:00.000Z");
    for (const [p] of useEventsMock.mock.calls) expect(p?.since).toBe(since);
  });

  it("keeps the same reserved slots across pending, empty, partial, success and error states", () => {
    const shell = document.createElement("div");
    shell.innerHTML = renderToString(<TimelineClient />);
    const shellFilters = shell.querySelector('[aria-label="Filter by event type"]')!.outerHTML;
    let ref: string[] | null = null;
    for (const [label, arrange] of [
      ["pending", () => setEvents([], { isLoading: true, ...noPages })],
      ["empty", () => setEvents([])],
      ["partial", () => setEvents([tape()], { total: 12_345, hasNextPage: true })],
      ["success", () => setEvents([tape()])],
      ["error", () => setEvents([], { error: new Error("fetch failed"), ...noPages })],
    ] as const) {
      arrange();
      render(<TimelineClient />);
      const classes = ["summary", "last-event", "feed"].map((s) => `${s}:${q(`[data-timeline-slot="${s}"]`)!.className}`);
      if (ref) expect(classes, label).toEqual(ref);
      ref = classes;
      expect(q('[aria-label="Filter by event type"]')!.outerHTML, label).toBe(shellFilters);
      if (label === "partial") { hasT("Showing 1 event"); noT(/of 12,345 events/); }
      if (label === "success") hasT("1 event");
      if (label === "empty") hasT("0 events");
      cleanup();
    }
  });

  it("appends arriving open incidents after the stable summary slots and paints once census first attempt fails", () => {
    setActive([], { isLoading: true, data: undefined, isFullyLoaded: false });
    const { refresh, unmount } = mount([peak()]);
    const row = () => screen.getByText("1 event").closest("p")!, before = row().textContent!;
    expect(evtEl()).toBeNull();
    setActive([activeEvt()]);
    refresh();
    expect([row().textContent!.startsWith(before), row().textContent!.includes("1 open incident"), evtEl() !== null]).toEqual([true, true, true]);
    unmount();

    setActive([], { isLoading: true, data: undefined, isFullyLoaded: false, failureCount: 1 });
    mount([peak()]);
    expect(evtEl()).not.toBeNull();
  });

  it("keeps pagination manual, admits fresh empty pages, and recovers from initial read errors", async () => {
    const refetch = vi.fn(async () => { setEvents([]); });
    const { refresh } = mount([], { error: new Error("fetch failed"), refetch, ...noPages });
    expect(useEventsMock).toHaveBeenCalledWith(expect.objectContaining({ severityFloor: "notice" }), { autoLoadAll: false });
    noT("▌");
    noT(L_EMPTY);

    const notice = screen.getByText("fetch failed").closest('[role="status"]') as HTMLElement;
    await act(async () => { fireEvent.click(within(notice).getByRole("button", { name: "Retry" })); });
    expect(refetch).toHaveBeenCalledOnce();
    refresh();
    noT("fetch failed");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    hasT(L_EMPTY);
    noT("Waiting for initial data");
  });

  it.each<[string, Partial<EventsRes>]>([
    ["pending", { isLoading: true, ...noPages }],
    ["failed", { error: new Error("fetch failed"), ...noPages }],
  ])("withholds the event count until a response page is admitted: %s", (_l, ov) => {
    mount([], ov);
    const txt = q('[data-timeline-slot="summary"]')!.textContent ?? "";
    expect(txt).not.toMatch(/\d+\s+events?/);
    expect([txt.includes("last 7 days"), txt.includes("Notice+ severity")]).toEqual([true, true]);
  });

  it("handles retained-error, stale, and unknown-clock empty generations accurately", () => {
    freeze(T0 * 1000);
    const { refresh } = mount([], { error: new Error("refresh failed") });
    hasT(L_EMPTY);
    noT(/refresh failed|Waiting for initial data|Refresh failed|Showing an older snapshot/);

    setEvents([], { meta: metaOf("stale", { updatedAt: T0 - 86_400, ageSeconds: 86_400, freshBudgetSec: 600, degradedBudgetSec: 1200 }) });
    refresh();
    hasT(L_OLDER);
    hasT(L_EMPTY);

    setEvents([], { meta: metaOf("unknown", { reason: "snapshot-producer-timestamp-unavailable" }) });
    refresh();
    noT("▌");
    hasT("Waiting for initial data");
  });

  it("renders events with titles and source links", () => {
    mount([
      tape({ id: "1747200000000-depeg-aaa11111", type: "depeg.opened", severity: "severe", title: "USDC depeg opened (-1200 bps)", sourceUrl: "/stablecoin/usdc-circle/#peg-history" }),
      tape({ id: "1747200000000-freeze-bbb22222", type: "freeze.funds.destroyed", severity: "critical", coinId: "usdt-tether", title: "USDT $150.0M destroyed · Ethereum", sourceUrl: "/freezewatch/" }),
    ]);
    expect(screen.getAllByRole("link", { name: /USDC.*depeg opened.*severity Severe/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("link", { name: /USDT.*freeze funds destroyed.*severity Critical/i })).toBeTruthy();
    expect(screen.getAllByText("depeg.opened").length).toBeGreaterThanOrEqual(1);
    hasT("freeze.funds.destroyed");
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href") ?? "");
    expect([hrefs.some((h) => h.startsWith("/stablecoin/usdc-circle")), hrefs.some((h) => h.startsWith("/freezewatch"))]).toEqual([true, true]);
  });

  it("collapses repeated same-coin same-type events within a day", () => {
    const now = Date.UTC(2026, 0, 15, 12);
    mount([[3, 60_000, 112], [2, 600_000, 109], [1, 1_200_000, 104]].map(([n, dt, bps]) =>
      peak({ id: `evt-${n}`, ts: now - dt, title: `USDXL depeg peak worsened (−${bps} bps)`, coinId: "usdxl-last" })));
    expect([evtEl("evt-3") !== null, evtEl("evt-2"), evtEl("evt-1")]).toEqual([true, null, null]);
    hasT("depeg.peak_worsened");
    hasT("3 similar events grouped");
  });

  it("renders the Currently open banner from explicit active authority", () => {
    const now = Date.now();
    setActive([activeEvt()]);
    mount([
      tape({ id: "evt-open-resolved", ts: now - 3_600_000, type: "depeg.opened", title: "USDC depeg opened (-200 bps)", coinId: "usdc-circle", sourceRowId: "100" }),
      tape({ id: "evt-resolved", ts: now - 1_800_000, type: "depeg.resolved", severity: "info", title: "USDC depeg resolved", coinId: "usdc-circle", sourceRowId: "100" }),
      tape({ id: "evt-open-still", ts: now - 60_000, type: "depeg.opened", title: "EURS depeg opened (+589 bps)", coinId: "eurs-stasis", sourceRowId: "200" }),
    ]);
    hasT(/Currently open · 1 incident/i);
    const w = within(reg(L_CUR));
    expect(w.getByRole("link", { name: /EURS active depeg incident 200/ })).toBeTruthy();
    expect(w.queryByRole("link", { name: /USDC/ })).toBeNull();
  });

  it.each([
    ["notice+", "/timeline/"], ["opened-only", "/timeline/?type=depeg.opened"],
    ["search mismatch", "/timeline/?q=unrelated"], ["superseded closure", "/timeline/?severity=warning"],
  ])("does not infer current incidents from unmatched historical openings: %s", (_l, url) => {
    setUrl(url);
    mount([tape({ type: "depeg.opened", sourceRowId: "100" })], { hasNextPage: true });
    noReg(L_CUR);
    noT(/1 open incident/);
  });

  it("renders canonical same-coin episodes without a matching tape opening or guessed constituent IDs", () => {
    setUrl("/timeline/?type=freeze.blocked&q=unrelated");
    setActive([activeEvt({ id: 201, constituentEventCount: 3 }), activeEvt({ id: 202, startedAt: nowSec() - 120 })]);
    mount([tape({ sourceRowId: "100" })], { hasNextPage: true });
    const banner = reg(L_CUR), links = within(banner).getAllByRole("link");
    expect([links.map((l) => l.getAttribute("data-depeg-event-id")), links[0].getAttribute("href"), banner.querySelector("[data-event-id]")]).toEqual([["201", "202"], "/stablecoin/eurs-stasis#peg-history", null]);
    expect(within(banner).getByText("3 threshold crossings")).toBeTruthy();
  });

  it("lists the census newest first, collapses past three, and handles inactive-coin-only records", () => {
    const now = nowSec(), retired = activeEvt({ id: 400, stablecoinId: "retired-coin", symbol: "OLD" });
    setActive([retired, ...Array.from({ length: 6 }, (_, i) => activeEvt({ id: 305 - i, startedAt: now - 600 * (6 - i) }))]);
    const { unmount } = mount([tape()]);
    expect(within(q('[aria-label="Filter by event type"]') as HTMLElement).getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");

    const banner = reg("Currently open · 6 incidents");
    const census = () => [...banner.querySelectorAll(":scope > div > a")].map((l) => l.getAttribute("data-depeg-event-id"));
    expect(census()).toEqual(["300", "301", "302"]);
    fireEvent.click(within(banner).getByRole("button", { name: "Show all 6" }));
    expect(census()).toEqual(["300", "301", "302", "303", "304", "305"]);
    expect(within(banner).getByRole("button", { name: "Show the 3 newest" })).toBeTruthy();
    expect(banner.querySelector("details summary")?.textContent).toContain("+1 on frozen or retired coins");
    hasT("6 open incidents");
    unmount();

    setActive([retired]);
    mount([tape()]);
    noReg(L_CUR);
    expect(reg("1 open on frozen or retired coins").querySelector("details a")?.getAttribute("data-depeg-event-id")).toBe("400");
  });

  it.each<[string, Partial<ActiveRes>]>([
    ["failed first read", { ...actErr("active read failed"), data: undefined }],
    ["failed partial refresh", { ...actErr("active read failed"), hasNextPage: true }],
    ["incomplete traversal", { isFullyLoaded: false, isFetchingNextPage: true }],
    ["capped traversal", { isFullyLoaded: false, isAutoLoadCapped: true }],
    ["loading", { isFullyLoaded: false, isLoading: true }],
  ])("withholds OPEN claims for %s even with retained source records", (label, ov) => {
    setActive([activeEvt()], ov);
    mount([tape()]);
    noReg(L_BOTH);
    noT(/1 open incident/);
    if (label.includes("traversal")) noReg(L_ACT_STAT);
    else expect(reg(L_ACT_STAT).textContent).toMatch(label === "loading" ? /Loading/ : /unavailable/);
  });

  it("ages the active producer independently of a fresh tape publication", () => {
    freeze(Date.parse("2026-10-20T12:00:00Z"));
    setActive([activeEvt()], { meta: metaOf("fresh", { updatedAt: Date.now() / 1000, freshBudgetSec: 30, degradedBudgetSec: 60 }) });
    mount([tape()]);
    expect(reg(L_CUR)).toBeTruthy();
    step(60_000);
    noReg(L_CUR);
    expect(reg(L_OPEN_LAST)).toBeTruthy();
  });

  it.each<[string, ApiMeta["status"] | null, Partial<ActiveRes>]>([
    ["degraded", "degraded", {}], ["error", null, actErr()], ["stale", "stale", {}],
  ])("retains a complete %s cohort as a dated observation", (label, status, ov) => {
    const obs = Date.UTC(2026, 9, 26), startedAt = obs / 1000 - 3600;
    freeze(obs);
    setActive([activeEvt({ id: 123, symbol: "USDC", startedAt })], { ...ov, dataUpdatedAt: obs, meta: status ? metaOf(status, { updatedAt: obs / 1000 }) : null });
    mount([peak()]);
    const r = reg(L_OPEN_LAST);
    for (const s of ["Incidents open at last observation, newest first · independent of feed filters", "Observed open for 1h as of 2026-10-26 00:00 UTC"]) expect(r.textContent).toContain(s);
    expect(r.textContent).not.toMatch(/OPEN|Currently open|active/);
    expect(within(r).getByRole("link", { name: "USDC depeg incident 123, open at last observation" })).toBeTruthy();
    expect(r.querySelector("time")?.dateTime).toBe(new Date(startedAt * 1000).toISOString());
    noT(/open incident/);
    expect(screen.queryByText(L_OLDER) != null).toBe(label === "stale");
  });

  it("freezes a retained duration while source age advances, stays quiet on empty, and recovers on fresh read", () => {
    const obs = Date.UTC(2026, 9, 26);
    freeze(obs);
    setActive([activeEvt({ startedAt: obs / 1000 - 3600 })], { ...actErr(), dataUpdatedAt: obs });
    const { refresh, unmount } = mount([peak()]);
    const r = () => reg(L_OPEN_LAST);
    expect(r().textContent).toContain("Updated just now");
    step(86_400_000);
    expect([r().textContent!.includes("Observed open for 1h as of 2026-10-26 00:00 UTC"), r().textContent!.includes("Updated 1d ago")]).toEqual([true, true]);
    expect(within(r()).getByText(L_OLDER)).toBeTruthy();

    setActive([activeEvt()]);
    refresh();
    expect(reg(/Currently open · 1 incident/).textContent).toContain("OPEN");
    hasT("1 open incident");
    unmount();

    setActive([], actErr());
    mount([peak()]);
    noReg(/Currently open|Open at last observation|Active incident status/);
    noT(/open incident|Showing an older snapshot/);
  });

  it.each<[string, Partial<ActiveRes>]>([
    ["missing census", { data: undefined, ...actErr("active read failed") }],
    ["unknown clock", { meta: metaOf("unknown"), ...actErr() }],
    ["unadmitted receipt", { dataUpdatedAt: 0, ...actErr() }],
    ["partial census", { ...actErr(), data: { events: [activeEvt()], total: 2, totalExact: true, nextCursor: null, pending: [] } }],
  ])("fails closed for a %s instead of retaining it", (_l, ov) => {
    setActive([activeEvt()], ov);
    const { refresh } = mount([peak()]);
    noReg(L_BOTH);
    expect(evtEl()).not.toBeNull();
    expect(reg(L_ACT_STAT).textContent).toMatch(/unavailable/);
    setActive([], { data: undefined, error: null, isLoading: true, isFullyLoaded: false });
    refresh();
    expect(evtEl()).not.toBeNull();
  });

  it("renders summary band, withholds raw server totals mid-traversal, and excludes rejected rows", () => {
    const two = [tape({ id: "evt-1", title: "Event one" }), tape({ id: "evt-2", title: "Event two", coinId: "usdt-tether" })];
    const { refresh } = mount(two, { total: 1247, hasNextPage: true });
    noT(/of 1,247 events|remaining/);
    hasT("Showing 2 events");
    expect(btn("Load more")).toBeTruthy();

    setEvents(two, { total: 5, droppedRows: 3 });
    refresh();
    for (const t of ["2 events", "last 7 days", "Notice+ severity"]) hasT(t);
    noT(/Showing 2 of 5 events|rows rejected/);
  });

  it("hides operational yield advisories, keeps Load More on filtered-empty pages, and publishes visible total only after traversal", () => {
    const warn = (id: string, newSignals: string[]) => tape({
      id, type: "yield.warning_emitted", coinId: "usde-ethena", severity: "warning",
      title: `USDe yield warning: ${newSignals.join(", ")}`, summary: `New yield warning signal (${newSignals.join(", ")}) detected on selected source.`, payload: { newSignals },
    });
    const hidden = [warn("w1", ["aging"]), warn("w2", ["data-stale"])];
    const { refresh, unmount } = mount(hidden, { total: 40, hasNextPage: true, data: { events: hidden, nextCursor: "cursor-2" } });
    noT(/Aging observation|Data stale|of 40 events|remaining/);
    expect(btn(/Load more/)).toBeTruthy();

    setEvents([warn("w1", ["aging"]), tape({ id: "d1", title: "Depeg one" })], { total: 2 });
    refresh();
    hasT(/^1 events?$/);
    unmount();

    const p1Evts = [tape({ id: "d1", title: "Depeg one" }), tape({ id: "d2", title: "Depeg two", coinId: "usdt-tether" })];
    const p1 = { data: { events: p1Evts, nextCursor: "cursor-2", droppedRows: 0, total: 1000 }, meta: null };
    const view = mount(p1Evts, { data: { events: p1Evts, nextCursor: "cursor-2" }, total: 1000, hasNextPage: true, pages: [p1] });
    noT(/of 1,000 events|remaining/);

    const p2Hidden = [warn("w1", ["aging"])], all = [...p1Evts, ...p2Hidden];
    setEvents(all, { data: { events: all, nextCursor: null }, total: 1000, hasNextPage: false, pages: [p1, { data: { events: p2Hidden, nextCursor: null, droppedRows: 0, total: null }, meta: null }] });
    view.refresh();
    hasT("2 events");
    noT(/of 1,000 events/);
  });

  it("ages producer freshness and UTC labels without moving the query anchor", () => {
    const mountedAt = Date.parse("2026-10-09T23:59:30Z");
    freeze(mountedAt);
    const { refresh } = mount([], { dataUpdatedAt: 0 }), since = useEventsMock.mock.calls[0][0]?.since;

    vi.advanceTimersByTime(1_000);
    const rx = Date.now();
    setEvents([peak({ ts: mountedAt - 120_000 })], { dataUpdatedAt: rx, meta: metaOf("fresh", { updatedAt: rx / 1000, freshBudgetSec: 600, degradedBudgetSec: 1200 }) });
    refresh();
    hasT("▌");
    hasT("Today");
    const before = screen.getByText(/Last event:/).textContent;

    step(60_000);
    noT("Today");
    hasT("Yesterday");
    expect(screen.getByText(/Last event:/).textContent).not.toBe(before);

    step(10 * 60_000);
    noT("▌");
    expect(screen.getByText(/Updated/).textContent).not.toContain("just now");
    for (const [p] of useEventsMock.mock.calls) expect(p?.since).toBe(since);
  });

  it.each<[string, ApiMeta]>([
    ["old producer", metaOf("fresh", { updatedAt: T0 - 3600, ageSeconds: 3600, freshBudgetSec: 600, degradedBudgetSec: 1200 })],
    ["degraded producer", metaOf("degraded")],
    ["unknown producer", metaOf("unknown", { reason: "snapshot-producer-timestamp-unavailable" })],
  ])("does not publish a fresh indicator for %s with a new receipt", (_l, meta) => {
    freeze(T0 * 1000);
    mount([tape()], { meta });
    noT("▌");
  });

  it.each<[string, Partial<Omit<EventsRes, "meta">> & { meta?: Extract<ApiMeta, { updatedAt: number }> }]>([
    ["fresh", {}],
    ["source-degraded", { meta: { updatedAt: T0, ageSeconds: 0, status: "degraded", warning: '199 - "source delayed"' } }],
    ["retained-error", { error: new Error("refresh failed") }],
  ])("keeps the %s Updated tooltip to the source timestamp", (label, ov) => {
    freeze(T0 * 1000);
    const { refresh } = mount([peak()], ov), title = () => screen.getByText(/^Updated /).parentElement!.title;
    expect(title()).toBe("Nov 14, 10:13 PM UTC");
    if (label === "retained-error") noT("▌");

    setEvents([peak()], { ...ov, dataUpdatedAt: T0 * 1000 + 100_000, meta: { status: "fresh", ...ov.meta, updatedAt: T0, ageSeconds: 0 } });
    refresh();
    expect(title()).toBe("Nov 14, 10:13 PM UTC");
  });

  it("explains stale Updated tooltip and drops fresh indicator on failed refresh while retaining events", () => {
    freeze(T0 * 1000);
    const ev = peak(), { refresh } = mount([ev], { meta: metaOf("stale", { updatedAt: T0 - 86_400, ageSeconds: 86_400 }) });
    expect(screen.getByText(/^Updated /).parentElement!.title).toBe("Data is stale.");
    setEvents([ev]);
    refresh();
    hasT("▌");
    setEvents([ev], { error: new Error("refresh failed") });
    refresh();
    noT("▌");
    expect(evtEl(ev.id)).toBeTruthy();
  });

  it("collapses dense yesterday classes into digest rows and quiet days into a <details> row", () => {
    freeze(Date.parse("2026-05-22T12:00:00.000Z"));
    const yest = Date.now() - 86_400_000;
    const { unmount } = mount(Array.from({ length: 5 }, (_, i) => tape({
      id: `evt-freeze-${i}`, ts: yest - i * 60_000, type: "freeze.blocked", severity: "notice", coinId: null, chain: "ethereum",
      title: `USDT freeze ${i}`, summary: `Freeze body ${i}`, payload: { stablecoin: "USDT", chainId: "ethereum", chainName: "Ethereum", amountUsdAtEvent: 100_000 }, sourceRowId: `f-${i}`,
    })));
    expect(screen.getAllByText(/^Freezes$/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/5 events/).length).toBeGreaterThanOrEqual(1);
    expect([evtEl("evt-freeze-0") !== null, evtEl("evt-freeze-1"), q("details") !== null]).toEqual([true, null, true]);
    hasT("5 similar events grouped");
    unmount();

    mount([
      tape({ id: "evt-1", ts: yest, type: "psi.shifted_up", coinId: "usdt-tether", title: "PSI band up" }),
      tape({ id: "evt-2", ts: yest - 60_000, type: "score.upgraded", coinId: "dai-makerdao", title: "DAI upgraded" }),
    ]);
    const txt = (q("details > summary")?.textContent ?? "").toLowerCase();
    expect([txt.includes("psi"), txt.includes("score")]).toEqual([true, true]);
  });

  it.each([
    ['{"reason":"flow-claim-retracted"}', true, 404], ['{"reason":"freeze-claim-retracted"}', true, 404],
    ['{"reason":"depeg-claim-retracted"}', true, 404], ['{"reason":"event-not-found"}', false, 404],
    ['{"reason":"unknown"}', false, 404], ["null", false, 404], ["invalid JSON", false, 404],
    [null, false, 404], [null, false, 0], ['{"reason":"flow-claim-retracted"}', false, 500],
  ] as const)("renders the permalink notice for body %s and status %s", (body, retracted, status) => {
    setLatest(undefined, status ? new ApiFetchError("/api/events?event=evt-missing", status, body) : null);
    setUrl("/timeline?event=evt-missing");
    mount([]);
    const notice = q('[title="evt-missing"]');
    if (retracted) { expect(notice?.textContent).toBe("⚠ Retracted after its source data changed."); noT(/Linked event:/); }
    else if (status === 0) expect(notice?.textContent).toBe("⚠ The linked event isn't in this view. Try widening the filters or removing the time window.");
    else expect(notice).toBeNull();
  });

  it("keeps a retracted depeg out of the exact buffer and cached feed", () => {
    const [ev, other] = [tape({ id: "evt-withdrawn" }), tape({ id: "evt-other", coinId: "usdt-tether" })];
    const path = "/api/events?event=evt-withdrawn", card = () => evtEl("evt-withdrawn"), notice = () => screen.queryByText(/Retracted after its source data changed/);
    setUrl("/timeline/?event=evt-withdrawn");
    setLatest([ev]);
    const { refresh } = mount([]);
    expect(card()?.textContent).toContain("-500 bps");

    const err503 = new ApiFetchError(path, 503, null);
    setLatest([ev], err503);
    refresh();
    expect([card() !== null, notice()]).toEqual([true, null]);

    setLatest([ev], new ApiFetchError(path, 404, '{"reason":"depeg-claim-retracted"}'));
    refresh();
    expect([card(), notice() !== null]).toEqual([null, true]);

    setEvents([ev, other]);
    setLatest([ev], err503);
    refresh();
    expect([card(), notice() !== null, evtEl("evt-other") !== null]).toEqual([null, true, true]);
  });

  it.each([false, true])("renders and focuses a PINNED permalink when the filtered feed is empty: %s", (emptyFeed) => {
    vi.useFakeTimers();
    setLatest([tape({ id: "evt-pinned", title: "Linked event title", summary: "Linked summary" })]);
    setUrl(`/timeline?event=${encodeURIComponent("evt-pinned")}&coin=usdt-tether`);
    mount(emptyFeed ? [] : [tape({ id: "evt-other", title: "Other event" })]);
    noT(/You followed a link|linked event isn't in this view/i);
    expect(screen.getAllByText(/PINNED/).length).toBeGreaterThanOrEqual(1);
    if (emptyFeed) hasT(L_EMPTY);
    const target = document.getElementById("tape-event-card-evt-pinned");
    expect(document.getElementById("tape-feed")?.contains(target)).toBe(true);
    step(20);
    expect(document.activeElement).toBe(target);
  });
});

describe("timeline feed controller", () => {
  it("builds pagination reset signatures and normalizes query/reset params", () => {
    const base = { typeRaw: "", type: [] as string[], severity: "notice", coin: "", peg: "all", chain: "all", window: "7d", q: "" } as const;
    expect(buildTimelineFilterSignature(base)).not.toBe(buildTimelineFilterSignature({ ...base, window: "24h" }));
    expect(buildTimelineFilterSignature(base)).not.toBe(buildTimelineFilterSignature({ ...base, typeRaw: "depeg.*", type: ["depeg.*"] }));
    const ctrl = buildTimelineFeedController({ typeRaw: "depeg.*", type: ["depeg.*"], severity: "warning", coin: "usdc-circle", peg: "USD", chain: "ethereum", window: "24h", q: "basis" }, 123);
    expect(ctrl.queryParams).toEqual({ type: ["depeg.*"], coin: "usdc-circle", pegCurrency: "USD", chain: "ethereum", severityFloor: "warning", since: 123, q: "basis" });
    expect([ctrl.hasActiveFilters, ctrl.windowShort, buildTimelineResetParams()]).toEqual([true, "24H", { type: "", severity: "", coin: "", peg: "all", chain: "all", window: "7d", q: "" }]);
  });
});
