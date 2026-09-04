// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DepegClient } from "@/app/depeg/client";
import type { ReactNode } from "react";

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

vi.mock("@/components/depeg-outlook-hero", () => ({
  DepegOutlookHero: (props: {
    logos?: Record<string, string>;
    activeDepegIds?: ReadonlySet<string>;
    pendingCount?: number;
    dewsAlertCount?: number;
    footer?: ReactNode;
    alertQueue?: ReactNode;
  }) => (
    <div
      data-testid="depeg-hero"
      data-has-logos={String(Boolean(props.logos && Object.keys(props.logos).length > 0))}
      data-active-ids={[...(props.activeDepegIds ?? [])].join(",")}
      data-pending={String(props.pendingCount)}
      data-alerts={String(props.dewsAlertCount)}
      data-has-footer={String(props.footer != null)}
    >
      {props.alertQueue}
    </div>
  ),
}));

vi.mock("@/components/dews-alert-feed", () => ({
  DEWSAlertFeed: () => <div data-testid="dews-alert-feed" />,
}));

vi.mock("@/components/depeg-control-board", () => ({
  DepegControlBoard: ({ rows }: { rows: Array<{ pendingIncident?: unknown }> }) => (
    <div data-testid="depeg-control-board">
      <span>Leaderboard controls</span>
      pending rows {rows.filter((row) => row.pendingIncident).length}
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
  vi.clearAllMocks();
});

function makeCoin(id: string, symbol: string) {
  return {
    id,
    symbol,
    name: symbol,
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "centralized",
    currentDeviationBps: 0,
    pegScore: 100,
    pegPct: 100,
    severityScore: 0,
    spreadPenalty: 0,
    eventCount: 0,
    worstDeviationBps: null,
    activeDepeg: false,
    lastEventAt: null,
    trackingSpanDays: 90,
    methodologyVersion: "v1",
  };
}

describe("DepegClient", () => {
  it("keeps filters scoped to the control board without rendering standalone active or pending feeds", () => {
    mocks.usePegSummary.mockReturnValue({
      data: {
        coins: [makeCoin("coin-a", "A"), { ...makeCoin("coin-b", "B"), activeDepeg: true }],
        summary: { activeDepegCount: 1, medianDeviationBps: 0, worstCurrent: null, coinsAtPeg: 2, totalTracked: 2, depegEventsToday: 0, depegEventsYesterday: 0 },
      },
      isLoading: false,
      error: null,
      dataUpdatedAt: 0,
      meta: null,
      refetch: vi.fn(),
    });
    mocks.useStressSignals.mockReturnValue({
      data: { signals: {}, updatedAt: 1_700_000_000, methodology: {} },
      error: null,
      dataUpdatedAt: 0,
      meta: null,
      refetch: vi.fn(),
    });
    mocks.useInfiniteDepegEvents.mockReturnValue({
      data: {
        events: [
          { id: 1, stablecoinId: "coin-a", symbol: "A", endedAt: null },
          { id: 2, stablecoinId: "coin-b", symbol: "B", endedAt: 1_700_000_100 },
        ],
        pending: [{ stablecoinId: "coin-b", symbol: "B", direction: "below", firstSeenAt: 1_700_000_000 }],
      },
      error: null,
      dataUpdatedAt: 0,
      meta: null,
      refetch: vi.fn(),
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    });
    mocks.useDepegResolverSurfaces.mockReturnValue({
      resolverEnabled: true,
      resolverReviewerEnabled: true,
      resolver: {
        data: {
          _meta: {
            dataAsOf: 0,
            modelAsOf: 0,
            computedAt: 0,
            expiresAt: 0,
            degraded: false,
            degradedReason: null,
            publicWarning: "",
            resolutionRubricVersion: "v1",
            durationModelVersion: "v1",
            incidentGroupingVersion: "v1",
            supportRulesVersion: "v1",
            lineage: null,
          },
          rows: [],
          methodology: {},
        },
        error: null,
        dataUpdatedAt: 0,
        meta: null,
        refetch: vi.fn(),
      },
      resolverReview: {
        data: {
          _meta: {
            computedAt: 0,
            expiresAt: 0,
            degraded: false,
            degradedReason: null,
            reviewerVersion: "ddr-reviewer-v1",
            publicWarning: "",
            assessedEventCount: 0,
            reviewedEventCount: 0,
            pendingEventCount: 0,
            durationScoredCount: 0,
            verdictScoredCount: 0,
            methodologyVersions: [],
          },
          summary: {},
          rows: [],
          methodology: {},
        },
        error: null,
        dataUpdatedAt: 0,
        meta: null,
        refetch: vi.fn(),
      },
    });
    mocks.useUrlFilters.mockReturnValue({
      getParam: (_key: string, fallback = "") => fallback,
      setParam: vi.fn(),
      setParams: vi.fn(),
    });

    render(<DepegClient />);

    expect(mocks.useInfiniteDepegEvents).toHaveBeenCalledWith({ includePending: true });
    expect(mocks.useDepegResolverSurfaces).toHaveBeenCalled();
    expect(screen.getByText("Leaderboard controls")).toBeTruthy();
    expect(screen.getByTestId("depeg-control-board").textContent).toContain("pending rows 1");
    expect(screen.queryByTestId("feed-Active Incidents")).toBeNull();
    expect(screen.getByTestId("feed-Recent resolved detections").textContent).toBe("1");
    expect(screen.queryByTestId("pending-incidents")).toBeNull();
    expect(screen.getByTestId("depeg-resolver")).toBeTruthy();
    expect(screen.getByTestId("freshness-notices").textContent).toContain("Depeg Resolver");

    // The hero is the route's only owner of these figures, so the client has to
    // hand it the logo map (the radar draws coin marks from it), the active-depeg
    // id set behind the halos, and both scoped counts. A dropped prop here is
    // invisible on the page until a mark or a number silently disappears.
    const hero = screen.getByTestId("depeg-hero");
    expect(hero.dataset.hasLogos).toBe("true");
    expect(hero.dataset.activeIds).toBe("coin-b");
    expect(hero.dataset.pending).toBe("1");
    expect(hero.dataset.alerts).toBe("0");

    // The reviewer's ledger is disclosure-gated for DOM weight, while its
    // headline accuracy is a hero figure, so the query stays eager and its
    // freshness entry is always present.
    expect(screen.queryByTestId("depeg-resolver-reviewer")).toBeNull();
    expect(screen.getByTestId("freshness-notices").textContent).toContain("DDR Reviewer");

    fireEvent.click(screen.getByRole("button", { name: "Show forecast grading · DDRR" }));

    expect(screen.getByTestId("depeg-resolver-reviewer")).toBeTruthy();
  });

  it("does not fetch or render DDR freshness when the rollback flag is disabled", () => {
    const refetchPeg = vi.fn();
    const refetchDews = vi.fn();
    const refetchEvents = vi.fn();
    const refetchResolver = vi.fn();
    const refetchResolverReview = vi.fn();
    mocks.usePegSummary.mockReturnValue({
      data: {
        coins: [makeCoin("coin-a", "A")],
        summary: { activeDepegCount: 0, medianDeviationBps: 0, worstCurrent: null, coinsAtPeg: 1, totalTracked: 1, depegEventsToday: 0, depegEventsYesterday: 0 },
      },
      isLoading: false,
      error: null,
      dataUpdatedAt: 0,
      meta: null,
      refetch: refetchPeg,
    });
    mocks.useStressSignals.mockReturnValue({
      data: { signals: {}, updatedAt: 1_700_000_000, methodology: {} },
      error: null,
      dataUpdatedAt: 0,
      meta: null,
      refetch: refetchDews,
    });
    mocks.useInfiniteDepegEvents.mockReturnValue({
      data: { events: [], pending: [] },
      error: null,
      dataUpdatedAt: 0,
      meta: null,
      refetch: refetchEvents,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    });
    mocks.useDepegResolverSurfaces.mockReturnValue({
      resolverEnabled: false,
      resolverReviewerEnabled: false,
      resolver: {
        data: undefined,
        error: new Error("disabled path should not surface"),
        dataUpdatedAt: 0,
        meta: null,
        refetch: refetchResolver,
      },
      resolverReview: {
        data: undefined,
        error: new Error("disabled path should not surface"),
        dataUpdatedAt: 0,
        meta: null,
        refetch: refetchResolverReview,
      },
    });
    mocks.useUrlFilters.mockReturnValue({
      getParam: (_key: string, fallback = "") => fallback,
      setParam: vi.fn(),
      setParams: vi.fn(),
    });

    render(<DepegClient />);

    expect(mocks.useDepegResolverSurfaces).toHaveBeenCalled();
    expect(screen.queryByTestId("depeg-resolver")).toBeNull();
    expect(screen.queryByTestId("depeg-resolver-reviewer")).toBeNull();
    expect(screen.getByTestId("freshness-notices").textContent).not.toContain("Depeg Resolver");
    expect(screen.getByTestId("freshness-notices").textContent).not.toContain("DDR Reviewer");

    void mocks.QueryFreshnessNotices.mock.calls[0][0].onRetry();
    expect(refetchPeg).toHaveBeenCalled();
    expect(refetchDews).toHaveBeenCalled();
    expect(refetchEvents).toHaveBeenCalled();
    expect(refetchResolver).not.toHaveBeenCalled();
    expect(refetchResolverReview).not.toHaveBeenCalled();
  });
});
