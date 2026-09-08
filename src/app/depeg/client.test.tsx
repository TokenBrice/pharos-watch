// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

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
  useUrlFilters: vi.fn(),
  QueryFreshnessNotices: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/hooks/api-hooks", () => ({
  usePegSummary: mocks.usePegSummary,
  useStressSignals: mocks.useStressSignals,
}));

vi.mock("@/hooks/use-depeg-events", () => ({
  useInfiniteDepegEvents: mocks.useInfiniteDepegEvents,
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
    pendingCount?: number;
    dewsAlertCount?: number;
    footer?: ReactNode;
    alertQueue?: ReactNode;
  }) => (
    <div
      data-testid="depeg-hero"
      data-active-ids={[...(props.activeDepegIds ?? [])].join(",")}
      data-pending={String(props.pendingCount)}
      data-alerts={String(props.dewsAlertCount)}
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
  DepegControlBoard: ({ rows }: { rows: Array<{ coin: { id: string }; pendingIncident?: unknown }> }) => (
    <div
      data-testid="depeg-control-board"
      data-row-ids={rows.map((row) => row.coin.id).join(",")}
      data-pending-rows={String(rows.filter((row) => row.pendingIncident).length)}
    >
      <span>Leaderboard controls</span>
    </div>
  ),
}));

vi.mock("@/components/depeg-feed", () => ({
  DepegFeed: ({ title = "Recent Depeg Events", events }: { title?: string; events: unknown[] }) => (
    <div data-testid={`feed-${title}`}>{events.length}</div>
  ),
}));

vi.mock("@/components/depeg-resolver-module", () => ({
  DepegResolverModule: () => <div data-testid="depeg-resolver" />,
}));

vi.mock("@/components/depeg-resolver-reviewer-module", () => ({
  DepegResolverReviewerModule: () => <div data-testid="depeg-resolver-reviewer" />,
}));

afterEach(() => {
  cleanup();
  // Unconditional: a failing assertion mid-case must not leak fake timers.
  vi.useRealTimers();
  vi.clearAllMocks();
});

const NOW_SEC = 1_700_000_000;

function mountDepegRoute(options: {
  coins?: Parameters<typeof makePegSummaryResult>[0]["coins"];
  signals?: Parameters<typeof makeStressSignalsResult>[0];
  events?: Parameters<typeof makeEventsResult>[0];
  surfaces?: Parameters<typeof makeResolverSurfaces>[0];
  params?: Record<string, string>;
} = {}) {
  const peg = makePegSummaryResult({ coins: options.coins ?? [makeCoin("coin-a", "A")] });
  const dews = makeStressSignalsResult(options.signals ?? {});
  const events = makeEventsResult(options.events ?? {});
  const surfaces = makeResolverSurfaces(options.surfaces ?? {});
  mocks.usePegSummary.mockReturnValue(peg);
  mocks.useStressSignals.mockReturnValue(dews);
  mocks.useInfiniteDepegEvents.mockReturnValue(events);
  mocks.useDepegResolverSurfaces.mockReturnValue(surfaces);
  mocks.useUrlFilters.mockReturnValue(makeUrlFilters(options.params));
  render(<DepegClient />);
  return { peg, dews, events, surfaces };
}

describe("DepegClient", () => {
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
        pending: [{ stablecoinId: "coin-b", symbol: "B", direction: "below", firstSeenAt: NOW_SEC }],
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
        pending: [{ stablecoinId: "coin-b", symbol: "B", direction: "below", firstSeenAt: NOW_SEC }],
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

  it("renders the resolver and grading surfaces, and collapses grading on demand", () => {
    mountDepegRoute();

    expect(screen.getByTestId("depeg-resolver")).toBeTruthy();
    expect(screen.getByTestId("depeg-resolver-reviewer")).toBeTruthy();
    expect(screen.getByTestId("freshness-notices").textContent).toContain("Depeg Resolver");
    expect(screen.getByTestId("freshness-notices").textContent).toContain("DDR Reviewer");

    fireEvent.click(screen.getByRole("button", { name: "Hide forecast grading · DDRR" }));

    expect(screen.queryByTestId("depeg-resolver-reviewer")).toBeNull();
    // Collapsing hides the ledger only; the query stays on the freshness list.
    expect(screen.getByTestId("freshness-notices").textContent).toContain("DDR Reviewer");

    fireEvent.click(screen.getByRole("button", { name: "Show forecast grading · DDRR" }));
    expect(screen.getByTestId("depeg-resolver-reviewer")).toBeTruthy();
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

  it("retries the enabled DDR surfaces alongside the route queries", async () => {
    const { peg, surfaces } = mountDepegRoute();

    await act(async () => {
      await mocks.QueryFreshnessNotices.mock.calls[0]![0].onRetry();
    });

    expect(peg.refetch).toHaveBeenCalledTimes(1);
    expect(surfaces.resolver.refetch).toHaveBeenCalledTimes(1);
    expect(surfaces.resolverReview.refetch).toHaveBeenCalledTimes(1);
  });
});
