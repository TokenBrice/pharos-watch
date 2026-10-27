// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { makePendingIncident } from "@/components/__tests__/depeg.test-support";
import { DDR_TEST_META, makeDdrSourceRow, makeFrozenDdrV2Row } from "@/components/depeg-resolver-test-support";
import type { DdrResponse } from "@shared/types/depeg-resolver";
import type { ResolverBookSummary } from "@/components/depeg-resolver-book-summary";
import { StaleDataBanner, type StaleQuery } from "@/components/stale-data-banner";

import { DepegClient } from "./client";
import {
  makeCoin,
  makeEventsResult,
  makePegSummaryResult,
  makeResolverSurfaces,
  makeStressSignalsResult,
  makeUrlFilters,
} from "./client.test-support";

const mocks = vi.hoisted(() => ({
  usePegSummary: vi.fn(),
  useStressSignals: vi.fn(),
  useDepegResolverSurfaces: vi.fn(),
  useInfiniteDepegEvents: vi.fn(),
  useActiveDepegEvents: vi.fn(),
  useUrlFilters: vi.fn(),
  QueryFreshnessNotices: vi.fn(),
}));

vi.mock("@/hooks/use-stablecoins", () => ({ useStablecoins: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/hooks/api-hooks", () => ({
  usePegSummary: mocks.usePegSummary,
  useStressSignals: mocks.useStressSignals,
}));

vi.mock("@/hooks/use-depeg-events", () => ({
  useInfiniteDepegEvents: mocks.useInfiniteDepegEvents,
  useActiveDepegEvents: (...args: unknown[]) => mocks.useActiveDepegEvents(...args) ?? { data: undefined },
}));

vi.mock("@/hooks/use-depeg-resolver-surfaces", () => ({
  useDepegResolverSurfaces: mocks.useDepegResolverSurfaces,
}));

vi.mock("@/hooks/use-url-filters", () => ({
  useUrlFilters: mocks.useUrlFilters,
}));

vi.mock("@/components/query-freshness-notices", () => ({
  QueryFreshnessNotices: (props: { onRetry: () => Promise<unknown>; queries: Array<{ label?: string; preset?: string }> }) => {
    mocks.QueryFreshnessNotices(props);
    const presetLabels: Record<string, string> = {
      depegResolver: "Depeg Resolver",
      depegResolverReview: "DDR Reviewer",
    };
    return (
      <div data-testid="freshness-notices">
        {props.queries.map((q) => q.label ?? (q.preset ? presetLabels[q.preset] ?? q.preset : "")).join(",")}
      </div>
    );
  },
}));

vi.mock("@/components/section-error-boundary", () => ({
  SectionErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// Heavyweight leaf: the hero's own rendering is covered by its suite. This stand-in
// exposes the figures the client derives and renders the real caveat footer.
vi.mock("@/components/depeg-outlook-hero", () => ({
  DepegOutlookHero: (props: {
    activeDepegIds?: ReadonlySet<string>;
    pendingCount?: number | null;
    dewsAlertCount?: number | null;
    footer?: ReactNode;
    alertQueue?: ReactNode;
    book?: ResolverBookSummary | null;
  }) => (
    <div
      data-testid="depeg-hero"
      data-active-ids={[...(props.activeDepegIds ?? [])].join(",")}
      data-pending={String(props.pendingCount)}
      data-alerts={String(props.dewsAlertCount)}
      data-resolver-total={props.book?.total ?? "unavailable"}
    >
      {props.alertQueue}
      {props.footer}
    </div>
  ),
}));

vi.mock("@/components/dews-alert-feed", () => ({
  DEWSAlertFeed: () => <div data-testid="dews-alert-feed" />,
}));

vi.mock("@/components/depeg-control-board", () => ({
  DepegControlBoard: ({ rows }: { rows: Array<{ coin: { id: string }; pendingIncident?: unknown; openIncidentEvidence?: string | null }> }) => (
    <div
      data-testid="depeg-control-board"
      data-row-ids={rows.map((row) => row.coin.id).join(",")}
      data-evidence={rows.map((row) => `${row.coin.id}:${row.openIncidentEvidence ?? "none"}`).join(",")}
      data-pending-rows={String(rows.filter((row) => row.pendingIncident).length)}
    >
      <span>Leaderboard controls</span>
    </div>
  ),
}));

vi.mock("@/components/depeg-feed", () => ({
  DepegFeed: ({ title = "Recent depeg events", events }: { title?: string; events: unknown[] }) => (
    <div data-testid={`feed-${title}`}>{events.length}</div>
  ),
}));

vi.mock("@/components/depeg-resolver-module", () => ({
  DepegResolverModule: () => <div data-testid="depeg-resolver" />,
}));

vi.mock("@/components/depeg-resolver-reviewer-module", () => ({
  DepegResolverReviewerModule: () => <div data-testid="depeg-resolver-reviewer" />,
}));

// Hydrate synchronously so the real banner ages captured queries against the fake wall clock;
// fake timers here fake only setTimeout and Date, so they never capture this stub.
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Unconditional: a failing assertion mid-case must not leak fake timers.
  vi.useRealTimers();
  vi.clearAllMocks();
});

const NOW_SEC = 1_700_000_000;

/** Renders the real shared banner over the route's captured freshness queries for the given presets. */
function renderCapturedNotices(presets: readonly string[]) {
  const { queries } = mocks.QueryFreshnessNotices.mock.calls.at(-1)![0] as { queries: StaleQuery[] };
  const { container } = render(
    <StaleDataBanner queries={queries.filter((query) => query.preset != null && presets.includes(query.preset))} />,
  );
  return () => container.querySelector("[data-health-state]");
}

function mountDepegRoute(options: {
  coins?: Parameters<typeof makePegSummaryResult>[0]["coins"];
  signals?: Parameters<typeof makeStressSignalsResult>[0];
  events?: Parameters<typeof makeEventsResult>[0];
  surfaces?: Parameters<typeof makeResolverSurfaces>[0];
  resolverData?: DdrResponse;
  params?: Record<string, string>;
} = {}) {
  const peg = makePegSummaryResult({ coins: options.coins ?? [makeCoin("coin-a", "A")] });
  const dews = makeStressSignalsResult(options.signals ?? {});
  const events = makeEventsResult(options.events ?? {});
  const surfaces = makeResolverSurfaces(options.surfaces ?? {});
  mocks.usePegSummary.mockReturnValue(peg);
  mocks.useStressSignals.mockReturnValue(dews);
  mocks.useInfiniteDepegEvents.mockReturnValue(events);
  mocks.useDepegResolverSurfaces.mockReturnValue(options.resolverData
    ? { ...surfaces, resolver: { ...surfaces.resolver, data: options.resolverData } }
    : surfaces);
  mocks.useUrlFilters.mockReturnValue(makeUrlFilters(options.params));
  render(<DepegClient />);
  return { peg, dews, events, surfaces };
}

describe("DepegClient", () => {
  it.each([
    [false, null, "1"],
    [true, "stale-cache", "1"],
    [true, "secondary-overlay-unavailable", "unavailable"],
    [true, "manifest-fallback:missing-cache", "unavailable"],
    [true, "unknown-failure", "unavailable"],
  ] as const)("gates hero recovery totals with forecast availability (%s, %s)", (degraded, degradedReason, expected) => {
    mountDepegRoute({ resolverData: {
      _meta: { ...DDR_TEST_META, degraded, degradedReason },
      rows: [makeFrozenDdrV2Row(makeDdrSourceRow())],
      methodology: {
        version: "4.6", versionLabel: "v4.6", currentVersion: "4.6", currentVersionLabel: "v4.6",
        changelogPath: "/methodology/depeg-resolver-changelog/", asOf: 1, isCurrent: true,
      },
    } });
    expect(screen.getByTestId("depeg-hero").dataset.resolverTotal).toBe(expected);
  });

  it.each(["events", "dews", "peg"] as const)("does not manufacture headline counts when %s query settles without data", (missing) => {
    const peg = makePegSummaryResult({ coins: [makeCoin("coin-a", "A")] });
    const dews = makeStressSignalsResult({ signals: { "coin-a": { band: "ALERT" } } });
    const events = makeEventsResult();
    const absent = { data: undefined, error: new Error("source unavailable"), isLoading: false, dataUpdatedAt: 0, meta: null, refetch: vi.fn() };
    mocks.usePegSummary.mockReturnValue(missing === "peg" ? absent : peg);
    mocks.useStressSignals.mockReturnValue(missing === "dews" ? absent : dews);
    mocks.useInfiniteDepegEvents.mockReturnValue(missing === "events" ? absent : events);
    mocks.useDepegResolverSurfaces.mockReturnValue(makeResolverSurfaces());
    mocks.useUrlFilters.mockReturnValue(makeUrlFilters());
    render(<DepegClient />);
    const hero = screen.getByTestId("depeg-hero");
    expect(hero.dataset.pending).toBe(missing === "events" ? "null" : "0");
    expect(hero.dataset.alerts).toBe(missing === "dews" || missing === "peg" ? "null" : "1");
  });

  it("labels open incidents from their unique event's latest trusted observation, without touching the census", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const coverage = (kind: "trusted-off-peg" | "trusted-at-par", at: number) => ({
      intervals: kind === "trusted-off-peg" ? [[at - 600, at]] : [],
      atParIntervals: kind === "trusted-at-par" ? [[at - 600, at]] : [],
      lastObservationKind: kind,
      lastTrustedObservationAt: at,
      gapStartedAt: kind === "trusted-at-par" ? at - 600 : null,
    });
    mocks.useActiveDepegEvents.mockReturnValue({ data: { events: [
      { id: 1, stablecoinId: "off", endedAt: null, priceCoverage: coverage("trusted-off-peg", NOW_SEC - 60) },
      { id: 2, stablecoinId: "par", endedAt: null, priceCoverage: coverage("trusted-at-par", NOW_SEC - 1_200) },
      { id: 3, stablecoinId: "dup", endedAt: null, priceCoverage: coverage("trusted-off-peg", NOW_SEC - 60) },
      { id: 4, stablecoinId: "dup", endedAt: null, priceCoverage: coverage("trusted-off-peg", NOW_SEC - 60) },
    ] } });
    mountDepegRoute({ coins: [
      makeCoin("off", "OFF", { activeDepeg: true, currentDeviationBps: 0 }),
      makeCoin("par", "PAR", { activeDepeg: true }),
      makeCoin("dup", "DUP", { activeDepeg: true }),
      makeCoin("blind", "BLIND", { activeDepeg: true }),
      makeCoin("calm", "CALM"),
    ] });
    // Spot zero does not override a current off-peg observation; missing or
    // ambiguous detail stays unconfirmed; non-incident rows carry no label.
    expect(screen.getByTestId("depeg-control-board").dataset.evidence)
      .toBe("off:outside,par:inside,dup:unconfirmed,blind:unconfirmed,calm:none");
    expect(screen.getByTestId("depeg-hero").dataset.activeIds).toBe("off,par,dup,blind");

    // The page minute clock expires the at-par reading past the 1,200-second limit.
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByTestId("depeg-control-board").dataset.evidence)
      .toBe("off:outside,par:unconfirmed,dup:unconfirmed,blind:unconfirmed,calm:none");
  });

  it("preserves observed zero pending and DEWS counts from successful empty sources", () => {
    mountDepegRoute();
    expect(screen.getByTestId("depeg-hero").dataset.pending).toBe("0");
    expect(screen.getByTestId("depeg-hero").dataset.alerts).toBe("0");
  });
  it("scopes board filters to the board while global figures stay route-wide", () => {
    mountDepegRoute({
      coins: [
        makeCoin("coin-a", "A"),
        makeCoin("coin-b", "B", { activeDepeg: true }),
        makeCoin("coin-e", "E", { pegCurrency: "EUR" }),
      ],
      signals: { signals: { "coin-a": { band: "ALERT" } } },
      events: {
        events: [
          { id: 1, stablecoinId: "coin-a", symbol: "A", endedAt: null },
          { id: 2, stablecoinId: "coin-b", symbol: "B", endedAt: NOW_SEC + 100 },
        ],
        pending: [makePendingIncident({ stablecoinId: "coin-b", symbol: "B", firstSeenAt: NOW_SEC })],
      },
      params: { peg: "EUR" },
    });

    const board = screen.getByTestId("depeg-control-board");
    const hero = screen.getByTestId("depeg-hero");

    // Only the EUR asset survives the board filter…
    expect(board.dataset.rowIds).toBe("coin-e");
    // …while the hero keeps counting the whole tracked universe.
    expect(hero.dataset.activeIds).toBe("coin-b");
    expect(hero.dataset.pending).toBe("1");
    expect(hero.dataset.alerts).toBe("1");
    // History is route-wide too: the resolved event of a filtered-out coin stays.
    expect(screen.getByTestId("feed-Recent resolved detections").textContent).toBe("1");
    expect(screen.queryByTestId("feed-Active Incidents")).toBeNull();
  });

  it("attaches pending incidents to their own board row", () => {
    mountDepegRoute({
      coins: [makeCoin("coin-a", "A"), makeCoin("coin-b", "B")],
      events: {
        pending: [makePendingIncident({ stablecoinId: "coin-b", symbol: "B", firstSeenAt: NOW_SEC })],
      },
    });

    const board = screen.getByTestId("depeg-control-board");
    expect(board.dataset.rowIds).toBe("coin-a,coin-b");
    expect(board.dataset.pendingRows).toBe("1");
    expect(screen.getByTestId("depeg-hero").dataset.pending).toBe("1");
  });

  it("counts DEWS alerts only for tracked coins in a valid ALERT-or-worse band", () => {
    mountDepegRoute({
      coins: [makeCoin("coin-a", "A"), makeCoin("coin-b", "B"), makeCoin("coin-c", "C")],
      signals: {
        signals: {
          "coin-a": { band: "ALERT" },
          "coin-b": { band: "WATCH" },
          "coin-c": { band: "DANGER" },
          "untracked-coin": { band: "WARNING" },
          "coin-bogus": { band: "SEVERE" },
        },
      },
    });

    expect(screen.getByTestId("depeg-hero").dataset.alerts).toBe("2");
  });

  it("raises the DEWS staleness caveat only once the signal passes the stale window", () => {
    vi.useFakeTimers({ now: NOW_SEC * 1000 });
    mountDepegRoute({
      // Exactly one hour old: the threshold is exclusive, so no caveat yet.
      signals: { signals: { "coin-a": { band: "CALM" } }, oldestComputedAt: NOW_SEC - 60 * 60 },
    });

    expect(screen.queryByText(/oldest DEWS signal/)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(screen.getByText(/oldest DEWS signal/)).toBeTruthy();
    expect(screen.getByText(/Coverage caveats/)).toBeTruthy();
  });

  it("reports malformed DEWS rows as a caveat with singular and plural wording", () => {
    mountDepegRoute({ signals: { malformedRows: 1 } });
    expect(screen.getByText(/1 malformed DEWS row/)).toBeTruthy();

    cleanup();
    mountDepegRoute({ signals: { malformedRows: 3 } });
    expect(screen.getByText(/3 malformed DEWS rows/)).toBeTruthy();
  });

  it("routes retained DDR and DDRR ages through the shared public stale band", () => {
    vi.useFakeTimers({ now: NOW_SEC * 1000 + 901_000, toFake: ["setTimeout", "clearTimeout", "Date"] });
    const surfaces = makeResolverSurfaces();
    const meta = { updatedAt: NOW_SEC, ageSeconds: 0, status: "fresh" as const };
    surfaces.resolver.data!._meta = { ...surfaces.resolver.data!._meta, degraded: true, degradedReason: "stale-cache" };
    mocks.usePegSummary.mockReturnValue(makePegSummaryResult({ coins: [makeCoin("coin-a", "A")] }));
    mocks.useStressSignals.mockReturnValue(makeStressSignalsResult());
    mocks.useInfiniteDepegEvents.mockReturnValue(makeEventsResult());
    mocks.useUrlFilters.mockReturnValue(makeUrlFilters());
    mocks.useDepegResolverSurfaces.mockReturnValue({
      ...surfaces,
      resolver: { ...surfaces.resolver, dataUpdatedAt: NOW_SEC * 1000, meta },
      resolverReview: { ...surfaces.resolverReview, dataUpdatedAt: NOW_SEC * 1000, meta, error: new Error("HTTP 503") },
    });
    render(<DepegClient />);
    const banner = renderCapturedNotices(["depegResolver", "depegResolverReview"]);
    act(() => vi.advanceTimersByTime(0));
    expect(banner()).toBeNull();
    // Exactly 12 x 900 s is still inside the degraded band.
    act(() => vi.advanceTimersByTime(10_800_000 - 901_000));
    expect(banner()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(banner()?.getAttribute("data-health-state")).toBe("stale");
    expect(surfaces.resolver.refetch).not.toHaveBeenCalled();
    expect(surfaces.resolverReview.refetch).not.toHaveBeenCalled();
  });

  it("excludes disabled DDR surfaces from rendering, freshness, and retry", async () => {
    const { peg, dews, events, surfaces } = mountDepegRoute({
      surfaces: {
        resolverEnabled: false,
        resolverReviewerEnabled: false,
        withData: false,
        resolverError: new Error("disabled path should not surface"),
        reviewError: new Error("disabled path should not surface"),
      },
    });

    expect(screen.queryByTestId("depeg-resolver")).toBeNull();
    expect(screen.queryByTestId("depeg-resolver-reviewer")).toBeNull();
    expect(screen.getByTestId("freshness-notices").textContent).not.toContain("Depeg Resolver");
    expect(screen.getByTestId("freshness-notices").textContent).not.toContain("DDR Reviewer");

    await act(async () => {
      await mocks.QueryFreshnessNotices.mock.calls[0]![0].onRetry();
    });

    expect(peg.refetch).toHaveBeenCalledTimes(1);
    expect(dews.refetch).toHaveBeenCalledTimes(1);
    expect(events.refetch).toHaveBeenCalledTimes(1);
    expect(surfaces.resolver.refetch).not.toHaveBeenCalled();
    expect(surfaces.resolverReview.refetch).not.toHaveBeenCalled();
  });

});
