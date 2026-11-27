// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { makePendingIncident } from "@/components/__tests__/depeg.test-support";
import { DDR_TEST_META, makeDdrSourceRow, makeFrozenDdrV2Row } from "@/components/depeg-resolver-test-support";
import type { DdrResponse } from "@shared/types/depeg-resolver";
import { StaleDataBanner, type StaleQuery } from "@/components/stale-data-banner";
import type { ApiMeta } from "@/lib/api";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "@/lib/request-lifecycle";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { DepegClient } from "./client";
import { makeCoin, makeEventsResult, makePegSummaryResult, makeResolverSurfaces, makeStressSignalsResult, makeUrlFilters } from "./client.test-support";

const mocks = vi.hoisted(() => ({
  usePegSummary: vi.fn(), useStressSignals: vi.fn(), useDepegResolverSurfaces: vi.fn(),
  useInfiniteDepegEvents: vi.fn(), useActiveDepegEvents: vi.fn(), useUrlFilters: vi.fn(), QueryFreshnessNotices: vi.fn(),
}));
const sourceHooks = { peg: mocks.usePegSummary, dews: mocks.useStressSignals, events: mocks.useInfiniteDepegEvents };

vi.mock("@/hooks/use-stablecoins", () => ({ useStablecoins: vi.fn(() => ({ data: undefined, error: null })) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/api-hooks", () => ({ usePegSummary: mocks.usePegSummary, useStressSignals: mocks.useStressSignals }));
vi.mock("@/hooks/use-depeg-events", () => ({
  useInfiniteDepegEvents: mocks.useInfiniteDepegEvents,
  useActiveDepegEvents: (...args: unknown[]) => mocks.useActiveDepegEvents(...args) ?? { data: undefined },
}));
vi.mock("@/hooks/use-depeg-resolver-surfaces", () => ({ useDepegResolverSurfaces: mocks.useDepegResolverSurfaces }));
vi.mock("@/hooks/use-url-filters", () => ({ useUrlFilters: mocks.useUrlFilters }));
vi.mock("@/components/query-freshness-notices", () => ({
  QueryFreshnessNotices: (props: { onRetry: () => Promise<unknown>; queries: readonly StaleQuery[] }) => {
    mocks.QueryFreshnessNotices(props);
    const labels: Record<string, string> = { depegResolver: "Depeg Resolver", depegResolverReview: "DDR Reviewer" };
    return <div data-testid="freshness-notices">{props.queries.map((q) => q.label ?? (q.preset ? labels[q.preset] ?? q.preset : "")).join(",")}</div>;
  },
}));
vi.mock("@/components/section-error-boundary", () => ({ SectionErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/depeg/depeg-outlook-hero", () => ({
  DepegOutlookHero: (p: Parameters<typeof import("@/components/depeg/depeg-outlook-hero").DepegOutlookHero>[0]) => (
    <div
      data-testid="depeg-hero"
      data-loading={Object.entries(p.pendingSources ?? {}).filter(([, v]) => v).map(([k]) => k).join(",")}
      data-active-ids={[...(p.activeDepegIds ?? [])].join(",")}
      data-pending={String(p.pendingCount)}
      data-alerts={String(p.dewsAlertCount)}
      data-open-incidents={p.openIncidents?.map((r) => r.id).join(",")}
      data-open-ev={p.openIncidents?.map((r) => `${r.id}:${r.evidence}`).join(",")}
      data-map={p.openIncidentMap ? Object.keys(p.openIncidentMap).join(",") : ""}
      data-footer={p.footer == null ? "none" : "present"}
    >{p.alertQueue?.(false)}</div>
  ),
}));
vi.mock("@/components/dews/dews-alert-feed", () => ({ DEWSAlertFeed: () => <div data-testid="dews-alert-feed" /> }));
vi.mock("@/components/depeg/depeg-control-board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/depeg/depeg-control-board")>()),
  DepegControlBoard: ({ rows, statusFilter }: { rows: import("@/lib/depeg-sort").DepegTrackerRow[]; statusFilter?: string }) => (
    <div
      data-testid="depeg-control-board"
      data-row-ids={rows.map((r) => r.coin.id).join(",")}
      data-evidence={rows.map((r) => `${r.coin.id}:${r.openIncidentEvidence ?? "none"}`).join(",")}
      data-tiers={rows.map((r) => `${r.coin.id}:${r.openIncidentTier ?? "none"}`).join(",")}
      data-started-at={rows.map((r) => `${r.coin.id}:${r.openIncidentStartedAt ?? "none"}`).join(",")}
      data-pending-rows={String(rows.filter((r) => r.pendingIncident).length)}
      data-caps={rows.map((r) => `${r.coin.id}:${r.marketCapUsd}`).join(",")}
      data-status-filter={statusFilter ?? "all"}
    ><span>Leaderboard controls</span></div>
  ),
}));
vi.mock("@/components/depeg/depeg-feed", () => ({
  DepegFeed: ({ title = "Recent depeg events", events }: { title?: string; events: unknown[] }) => <div data-testid={`feed-${title}`}>{events.length}</div>,
}));
vi.mock("@/components/depeg/depeg-resolver-module", async () => {
  const summary = await vi.importActual<typeof import("@/components/depeg/depeg-resolver-book-summary")>("@/components/depeg/depeg-resolver-book-summary");
  return {
    DepegResolverModule: (p: Parameters<typeof import("@/components/depeg/depeg-resolver-module").DepegResolverModule>[0]) => (
      <div
        data-testid="depeg-resolver"
        data-resolver-total={summary.isResolverBookAvailable(p.data) && p.data ? String(summary.summarizeResolverBook(p.data.rows).total) : "unavailable"}
        data-loading={[p.resolverPending ? "resolver" : null, p.reviewPending ? "review" : null].filter(Boolean).join(",")}
        data-map={p.openIncidents ? Object.keys(p.openIncidents).join(",") : ""}
        data-review={p.review ? "present" : "none"}
      />
    ),
  };
});
vi.mock("@/components/depeg/depeg-resolver-reviewer-module", () => ({
  DepegResolverReviewerModule: () => <div data-testid="depeg-resolver-reviewer" />,
}));

// Hydrate synchronously so the banner ages captured queries against fake Date/setTimeout.
beforeEach(() => { vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });

const NOW_SEC = 1_700_000_000;
const advanceTime = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const fakeClock = (offset = 0) => vi.useFakeTimers({ now: NOW_SEC * 1000 + offset, toFake: ["setTimeout", "clearTimeout", "Date"] });
const byId = (id: string) => screen.getByTestId(id);
const qId = (id: string) => screen.queryByTestId(id);
const heroEl = () => byId("depeg-hero");
const boardEl = () => byId("depeg-control-board");
const resolverEl = () => byId("depeg-resolver");
const lastQueries = () => (mocks.QueryFreshnessNotices.mock.calls.at(-1)![0] as { queries: StaleQuery[] }).queries;
const healthOf = (banner: () => Element | null) => banner()?.getAttribute("data-health-state");

function renderCapturedNotices(presets: readonly string[]) {
  const { container } = render(<StaleDataBanner queries={lastQueries().filter((q) => q.preset != null && presets.includes(q.preset))} />);
  return () => container.querySelector("[data-health-state]");
}

function mountDepegRoute(opts: {
  coins?: Parameters<typeof makePegSummaryResult>[0]["coins"];
  openIncidents?: Parameters<typeof makePegSummaryResult>[0]["openIncidents"];
  openIncidentsAsOfSec?: number;
  signals?: Parameters<typeof makeStressSignalsResult>[0];
  events?: Parameters<typeof makeEventsResult>[0];
  surfaces?: Parameters<typeof makeResolverSurfaces>[0];
  resolverData?: DdrResponse;
  params?: Record<string, string>;
} = {}) {
  const peg = makePegSummaryResult({ coins: opts.coins ?? [makeCoin("coin-a", "A")], openIncidents: opts.openIncidents, openIncidentsAsOfSec: opts.openIncidentsAsOfSec });
  const dews = makeStressSignalsResult(opts.signals ?? {});
  const events = makeEventsResult(opts.events ?? {});
  const surfaces = makeResolverSurfaces(opts.surfaces ?? {});
  mocks.usePegSummary.mockReturnValue(peg);
  mocks.useStressSignals.mockReturnValue(dews);
  mocks.useInfiniteDepegEvents.mockReturnValue(events);
  mocks.useDepegResolverSurfaces.mockReturnValue(opts.resolverData ? { ...surfaces, resolver: { ...surfaces.resolver, data: opts.resolverData } } : surfaces);
  mocks.useUrlFilters.mockReturnValue(makeUrlFilters(opts.params));
  return { ...render(<DepegClient />), peg, dews, events, surfaces };
}

describe("DepegClient", () => {
  it.each([
    [false, null, "1"], [true, "stale-cache", "1"], [true, "secondary-overlay-unavailable", "unavailable"],
    [true, "manifest-fallback:missing-cache", "unavailable"], [true, "unknown-failure", "unavailable"],
  ] as const)("gates resolver recovery totals with forecast availability (%s, %s)", (degraded, degradedReason, expected) => {
    mountDepegRoute({ resolverData: {
      _meta: { ...DDR_TEST_META, degraded, degradedReason }, rows: [makeFrozenDdrV2Row(makeDdrSourceRow())],
      methodology: { version: "4.6", versionLabel: "v4.6", currentVersion: "4.6", currentVersionLabel: "v4.6", changelogPath: "/methodology/depeg-resolver-changelog/", asOf: 1, isCurrent: true },
    } });
    expect(resolverEl().dataset.resolverTotal).toBe(expected);
  });

  it("renders the 4-stage pipeline jump strip anchored to route sections and syncs status URL filter", () => {
    mountDepegRoute({ params: { status: "active_pending" } });
    const nav = screen.getByRole("navigation", { name: "Depeg monitoring pipeline" });
    expect([...nav.querySelectorAll("a")].map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["1. Early Stress (DEWS)", "#dews-radar"], ["2. Live Incidents", "#live-outlook"],
      ["3. Recovery Forecast (DDR)", "#recovery-forecast"], ["4. Peg History", "#peg-history"],
    ]);
    expect(boardEl().dataset.statusFilter).toBe("active_pending");
  });

  it.each(["events", "dews", "peg"] as const)("does not manufacture headline counts when %s query settles without data", (missing) => {
    mountDepegRoute({ signals: { signals: { "coin-a": { band: "ALERT" } } } }).unmount();
    sourceHooks[missing].mockReturnValue({ data: undefined, error: new Error("source unavailable"), isLoading: false, dataUpdatedAt: 0, meta: null, refetch: vi.fn() });
    render(<DepegClient />);
    const hero = heroEl();
    expect(hero.dataset.pending).toBe(missing === "events" ? "null" : "0");
    expect(hero.dataset.alerts).toBe(missing === "dews" || missing === "peg" ? "null" : "1");
    if (missing === "events") expect(qId("feed-Recent resolved detections")).toBeNull();
    if (missing === "peg") { expect(qId("depeg-control-board")).toBeNull(); expect(hero.dataset.alerts).toBe("null"); }
  });

  it.each(["peg", "dews", "events", "resolver", "resolverReview"] as const)("bounds the first %s read and never re-gates retained data", (source) => {
    vi.useFakeTimers();
    const { unmount, peg, dews, events, surfaces } = mountDepegRoute();
    unmount();
    const result = { peg, dews, events, ...surfaces }[source];
    const waiting = { ...result, data: undefined, error: null };
    const publish = (value: typeof waiting | typeof result) => {
      if (source === "resolver" || source === "resolverReview") mocks.useDepegResolverSurfaces.mockReturnValue({ ...surfaces, [source]: value });
      else sourceHooks[source].mockReturnValue(value);
    };
    publish(waiting);
    const view = render(<DepegClient />);
    expect(qId("depeg-hero")).toBeNull();
    advanceTime(DEFAULT_REQUEST_TIMEOUT_MS - 1);
    expect(qId("depeg-hero")).toBeNull();
    advanceTime(1);
    const hero = heroEl(), res = resolverEl();
    if (source === "resolver" || source === "resolverReview") expect(res.dataset.loading).toContain(source === "resolverReview" ? "review" : "resolver");
    else expect(hero.dataset.loading).toContain(source);
    if (source === "dews") expect(byId("dews-alert-feed")).not.toBeNull();
    publish({ ...waiting, error: new Error("first read failed") });
    view.rerender(<DepegClient />);
    expect(hero.dataset.loading).toBe("");
    expect(res.dataset.loading).toBe("");
    if (source === "dews") expect(qId("dews-alert-feed")).toBeNull();
    publish(result);
    view.rerender(<DepegClient />);
    expect(heroEl()).toBe(hero);
    expect(hero.dataset.loading).toBe("");
    expect(res.dataset.loading).toBe("");
    if (source === "dews") expect(byId("dews-alert-feed")).not.toBeNull();
    publish({ ...result, error: new Error("refresh failed") });
    view.rerender(<DepegClient />);
    expect(heroEl()).toBe(hero);
    view.unmount();
    publish(waiting);
    const retry = render(<DepegClient />);
    advanceTime(DEFAULT_REQUEST_TIMEOUT_MS - 1);
    publish({ ...waiting, error: new Error("first read failed") });
    retry.rerender(<DepegClient />);
    const released = heroEl();
    publish(waiting);
    retry.rerender(<DepegClient />);
    expect(heroEl()).toBe(released);
    advanceTime(1);
    expect(heroEl()).toBe(released);
    publish(result);
    retry.rerender(<DepegClient />);
    expect(heroEl().dataset.loading).toBe("");
    retry.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a DEWS payload with no readable current rows as unavailable", () => {
    mountDepegRoute({ signals: { signals: {}, updatedAt: 0, meta: { status: "degraded", warning: '199 - "DEWS current rows unavailable"' } } });
    expect(heroEl().dataset.alerts).toBe("null");
    expect(lastQueries().find((e) => e.preset === "stressSignals")!.hasData).toBe(false);
    expect(qId("dews-alert-feed")).toBeNull();
  });

  it("labels open incidents from their unique event's latest trusted observation, without touching the census", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const cov = (kind: "trusted-off-peg" | "trusted-at-par", at: number) => ({
      intervals: kind === "trusted-off-peg" ? [[at - 600, at]] : [], atParIntervals: kind === "trusted-at-par" ? [[at - 600, at]] : [],
      lastObservationKind: kind, lastTrustedObservationAt: at, gapStartedAt: kind === "trusted-at-par" ? at - 600 : null,
    });
    const ev = (id: number, stablecoinId: string, kind: "trusted-off-peg" | "trusted-at-par", at: number) => ({ id, stablecoinId, endedAt: null, priceCoverage: cov(kind, at) });
    mocks.useActiveDepegEvents.mockReturnValue({ data: { events: [ev(1, "off", "trusted-off-peg", NOW_SEC - 60), ev(2, "par", "trusted-at-par", NOW_SEC - 1_200), ev(3, "dup", "trusted-off-peg", NOW_SEC - 60), ev(4, "dup", "trusted-off-peg", NOW_SEC - 60)] } });
    mountDepegRoute({ coins: [makeCoin("off", "OFF", { activeDepeg: true, currentDeviationBps: 0 }), makeCoin("par", "PAR", { activeDepeg: true }), makeCoin("dup", "DUP", { activeDepeg: true }), makeCoin("blind", "BLIND", { activeDepeg: true }), makeCoin("calm", "CALM")] });
    expect(mocks.useActiveDepegEvents).toHaveBeenCalledWith({ enabled: true });
    expect(boardEl().dataset.evidence).toBe("off:outside,par:inside,dup:unconfirmed,blind:unconfirmed,calm:none");
    expect(heroEl().dataset.openEv).toMatch(/off:outside.*par:inside/);
    expect(heroEl().dataset.activeIds).toBe("off,par,dup,blind");
    advanceTime(60_000);
    expect(boardEl().dataset.evidence).toBe("off:outside,par:unconfirmed,dup:unconfirmed,blind:unconfirmed,calm:none");
  });

  it("feeds stablecoin-list caps to the hero ranking and board rows", () => {
    vi.mocked(useStablecoins).mockReturnValue({ data: { peggedAssets: [{ id: "small", circulating: { peggedUSD: 49e6 } }, { id: "big", circulating: { peggedUSD: 1.5e9 } }] }, error: null } as never);
    try {
      mountDepegRoute({ coins: [makeCoin("big", "BIG", { activeDepeg: true, currentDeviationBps: -14 }), makeCoin("small", "SMALL", { activeDepeg: true, currentDeviationBps: -4_500 }), makeCoin("calm", "CALM")] });
      expect(heroEl().dataset.openIncidents).toBe("small,big");
      expect(boardEl().dataset.caps).toBe("big:1500000000,small:49000000,calm:null");
    } finally {
      vi.mocked(useStablecoins).mockImplementation(() => ({ data: undefined, error: null }) as never);
    }
  });

  it("preserves observed zero pending and DEWS counts from successful empty sources", () => {
    mountDepegRoute();
    expect(heroEl().dataset.pending).toBe("0");
    expect(heroEl().dataset.alerts).toBe("0");
  });

  it("scopes board filters to the board while global figures stay route-wide", () => {
    mountDepegRoute({
      coins: [makeCoin("coin-a", "A"), makeCoin("coin-b", "B", { activeDepeg: true }), makeCoin("coin-e", "E", { pegCurrency: "EUR" })],
      signals: { signals: { "coin-a": { band: "ALERT" } } },
      events: {
        events: [{ id: 1, stablecoinId: "coin-a", symbol: "A", endedAt: null }, { id: 2, stablecoinId: "coin-b", symbol: "B", endedAt: NOW_SEC + 100 }],
        pending: [makePendingIncident({ stablecoinId: "coin-b", symbol: "B", firstSeenAt: NOW_SEC })],
      },
      params: { peg: "EUR" },
    });
    const hero = heroEl();
    expect(boardEl().dataset.rowIds).toBe("coin-e");
    expect(hero.dataset.activeIds).toBe("coin-b");
    expect(hero.dataset.pending).toBe("1");
    expect(hero.dataset.alerts).toBe("1");
    expect(byId("feed-Recent resolved detections").textContent).toBe("1");
    expect(qId("feed-Active Incidents")).toBeNull();
  });

  it("attaches pending incidents to their own board row", () => {
    mountDepegRoute({ coins: [makeCoin("coin-a", "A"), makeCoin("coin-b", "B")], events: { pending: [makePendingIncident({ stablecoinId: "coin-b", symbol: "B", firstSeenAt: NOW_SEC })] } });
    const board = boardEl();
    expect(board.dataset.rowIds).toBe("coin-a,coin-b");
    expect(board.dataset.pendingRows).toBe("1");
    expect(heroEl().dataset.pending).toBe("1");
  });

  it("counts DEWS alerts only for tracked coins in a valid ALERT-or-worse band", () => {
    mountDepegRoute({
      coins: [makeCoin("coin-a", "A"), makeCoin("coin-b", "B"), makeCoin("coin-c", "C")],
      signals: { signals: { "coin-a": { band: "ALERT" }, "coin-b": { band: "WATCH" }, "coin-c": { band: "DANGER" }, "untracked-coin": { band: "WARNING" }, "coin-bogus": { band: "SEVERE" } } },
    });
    expect(heroEl().dataset.alerts).toBe("2");
  });

  describe("DEWS hero and shared notice", () => {
    const TWELVE_H = 43_200_000;
    const transport = (updatedAt: number): ApiMeta => ({ updatedAt, ageSeconds: 0, status: "fresh" });
    const usable = { "coin-a": { band: "CALM" } };

    it("ages the oldest signal generation against the shared twelve-hour band, not a private hour", () => {
      fakeClock();
      const { dews } = mountDepegRoute({ signals: { signals: usable, oldestComputedAt: NOW_SEC - 2 * 3600, updatedAt: NOW_SEC, meta: transport(NOW_SEC) } });
      const banner = renderCapturedNotices(["stressSignals"]);
      advanceTime(0);
      expect(banner()).toBeNull();
      expect(screen.queryByText(/oldest DEWS signal|Coverage caveats/)).toBeNull();
      advanceTime(TWELVE_H - 2 * 3_600_000);
      expect(banner()).toBeNull();
      advanceTime(1);
      expect(healthOf(banner)).toBe("stale");
      expect(dews.refetch).not.toHaveBeenCalled();
    });

    it("keeps the transported verdict, budgets and age offset while selecting the oldest clock", () => {
      const meta: ApiMeta = { updatedAt: NOW_SEC, ageSeconds: 60, status: "degraded", warning: '199 - "partial"', freshBudgetSec: 3600, degradedBudgetSec: 43_200 };
      mountDepegRoute({ signals: { signals: usable, oldestComputedAt: NOW_SEC - 600, meta } });
      const q = lastQueries().find((e) => e.preset === "stressSignals")!;
      expect(q.meta).toEqual({ ...meta, updatedAt: NOW_SEC - 600, ageSeconds: 660 });
      expect(q.dataUpdatedAt).toBe((NOW_SEC - 600) * 1000);
    });

    it("retains usable signals through a refresh error and malformed rows without a hero caveat", () => {
      fakeClock();
      mountDepegRoute({ signals: { signals: usable, oldestComputedAt: NOW_SEC - 3 * 3600, malformedRows: 1, meta: transport(NOW_SEC), error: new Error("HTTP 503") } });
      const banner = renderCapturedNotices(["stressSignals"]);
      advanceTime(0);
      expect(banner()).toBeNull();
      expect(screen.queryByText(/malformed DEWS|Coverage caveats/)).toBeNull();
      expect(heroEl().dataset.footer).toBe("none");
      expect(heroEl().dataset.alerts).toBe("0");
    });

    it("keeps an explicit-null transport clock unknown even when the body names an oldest signal", () => {
      mountDepegRoute({ signals: { signals: usable, oldestComputedAt: NOW_SEC, meta: { updatedAt: null, ageSeconds: null, status: "unknown", reason: "DEWS current rows unavailable" }, dataUpdatedAt: NOW_SEC * 1000 } });
      expect(healthOf(renderCapturedNotices(["stressSignals"]))).toBe("unavailable");
    });

    it("falls back to the body producer clock for legacy bodies, never receipt time", () => {
      fakeClock();
      mountDepegRoute({ signals: { signals: usable, updatedAt: NOW_SEC - TWELVE_H / 1000, dataUpdatedAt: NOW_SEC * 1000 } });
      const banner = renderCapturedNotices(["stressSignals"]);
      advanceTime(0);
      expect(banner()).toBeNull();
      advanceTime(1);
      expect(healthOf(banner)).toBe("stale");
    });
  });

  it("routes retained DDR and DDRR ages through the shared public stale band", () => {
    fakeClock(901_000);
    const { surfaces, rerender } = mountDepegRoute();
    const meta = { updatedAt: NOW_SEC, ageSeconds: 0, status: "fresh" as const };
    mocks.useDepegResolverSurfaces.mockReturnValue({
      ...surfaces,
      resolver: { ...surfaces.resolver, data: { ...surfaces.resolver.data, _meta: { ...surfaces.resolver.data!._meta, degraded: true, degradedReason: "stale-cache" } }, dataUpdatedAt: NOW_SEC * 1000, meta },
      resolverReview: { ...surfaces.resolverReview, dataUpdatedAt: NOW_SEC * 1000, meta, error: new Error("HTTP 503") },
    });
    rerender(<DepegClient />);
    const banner = renderCapturedNotices(["depegResolver", "depegResolverReview"]);
    advanceTime(0);
    expect(banner()).toBeNull();
    advanceTime(10_800_000 - 901_000);
    expect(banner()).toBeNull();
    advanceTime(1);
    expect(healthOf(banner)).toBe("stale");
    expect(surfaces.resolver.refetch).not.toHaveBeenCalled();
    expect(surfaces.resolverReview.refetch).not.toHaveBeenCalled();
  });

  it("excludes disabled DDR surfaces from rendering, freshness, and retry", async () => {
    const err = new Error("disabled path should not surface");
    const { peg, dews, events, surfaces } = mountDepegRoute({ surfaces: { resolverEnabled: false, resolverReviewerEnabled: false, withData: false, resolverError: err, reviewError: err } });
    expect(qId("depeg-resolver")).toBeNull();
    expect(qId("depeg-resolver-reviewer")).toBeNull();
    expect(byId("freshness-notices").textContent).not.toContain("Depeg Resolver");
    expect(byId("freshness-notices").textContent).not.toContain("DDR Reviewer");
    await act(async () => { await mocks.QueryFreshnessNotices.mock.calls[0]![0].onRetry(); });
    expect(peg.refetch).toHaveBeenCalledTimes(1);
    expect(dews.refetch).toHaveBeenCalledTimes(1);
    expect(events.refetch).toHaveBeenCalledTimes(1);
    expect(surfaces.resolver.refetch).not.toHaveBeenCalled();
    expect(surfaces.resolverReview.refetch).not.toHaveBeenCalled();
  });

  it("uses openIncidents sidecar, gates active-events off, and validates ?status", () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW_SEC * 1000); const D = 86_400;
    const cov = (k: "trusted-off-peg" | "trusted-at-par") => ({ lastObservationKind: k, lastTrustedObservationAt: NOW_SEC - 120, gapStartedAt: k === "trusted-at-par" ? NOW_SEC - 300 : null });
    const v = mountDepegRoute({
      coins: [makeCoin("f", "F", { activeDepeg: true }), makeCoin("e", "E", { activeDepeg: true }), makeCoin("o", "O", { activeDepeg: true })],
      openIncidents: { f: { eventId: 1, startedAt: NOW_SEC - 2 * D, escalatedAt: null, coverage: cov("trusted-off-peg") }, e: { eventId: 2, startedAt: NOW_SEC - 45 * D, escalatedAt: NOW_SEC - 2 * D, coverage: cov("trusted-at-par") }, o: { eventId: 3, startedAt: NOW_SEC - 60 * D, escalatedAt: null, coverage: null } },
      openIncidentsAsOfSec: NOW_SEC, params: { status: "long_running" },
    });
    expect(mocks.useActiveDepegEvents).toHaveBeenCalledWith({ enabled: false });
    const bd = boardEl().dataset;
    expect([bd.evidence, bd.tiers, bd.startedAt, bd.statusFilter, heroEl().dataset.map, resolverEl().dataset.map])
      .toEqual(["f:outside,e:inside,o:unconfirmed", "f:recent,e:escalating,o:long_running", `f:${NOW_SEC - 2 * D},e:${NOW_SEC - 45 * D},o:${NOW_SEC - 60 * D}`, "long_running", "f,e,o", "f,e,o"]);
    v.unmount(); mountDepegRoute({ params: { status: "bogus" } });
    expect(boardEl().dataset.statusFilter).toBe("all");
  });
});
