// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DepegClient } from "@/app/depeg/client";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  usePegSummary: vi.fn(),
  useStressSignals: vi.fn(),
  useInfiniteDepegEvents: vi.fn(),
  useLogos: vi.fn(),
  useUrlFilters: vi.fn(),
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

vi.mock("@/hooks/use-logos", () => ({
  useLogos: mocks.useLogos,
}));

vi.mock("@/hooks/use-url-filters", () => ({
  useUrlFilters: mocks.useUrlFilters,
}));

vi.mock("@/components/query-freshness-notices", () => ({
  QueryFreshnessNotices: () => null,
}));

vi.mock("@/components/section-error-boundary", () => ({
  SectionErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/dews-summary", () => ({
  DEWSSummary: () => <div data-testid="dews-summary" />,
}));

vi.mock("@/components/depeg-tracker-stats", () => ({
  DepegTrackerStats: () => <div data-testid="depeg-stats" />,
}));

vi.mock("@/components/dews-alert-feed", () => ({
  DEWSAlertFeed: () => <div data-testid="dews-alert-feed" />,
}));

vi.mock("@/components/depeg-tracker-table", () => ({
  DepegTrackerTable: ({ rows }: { rows: Array<{ pendingIncident?: unknown }> }) => (
    <div data-testid="depeg-table">pending rows {rows.filter((row) => row.pendingIncident).length}</div>
  ),
}));

vi.mock("@/components/depeg-feed", () => ({
  DepegFeed: ({ title = "Recent Depeg Events", events }: { title?: string; events: unknown[] }) => (
    <div data-testid={`feed-${title}`}>{events.length}</div>
  ),
}));

vi.mock("@/components/depeg-pending-incidents", () => ({
  DepegPendingIncidents: ({ incidents }: { incidents: unknown[] }) => (
    <div data-testid="pending-incidents">{incidents.length}</div>
  ),
}));

vi.mock("@/components/peg-heatmap", () => ({
  PegHeatmap: () => <div data-testid="peg-heatmap" />,
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
  it("keeps filters scoped to the leaderboard/heatmap and wires active/pending lanes", () => {
    mocks.usePegSummary.mockReturnValue({
      data: {
        coins: [makeCoin("coin-a", "A"), makeCoin("coin-b", "B")],
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
    mocks.useLogos.mockReturnValue({ data: {} });
    mocks.useUrlFilters.mockReturnValue({
      getParam: (_key: string, fallback = "") => fallback,
      setParam: vi.fn(),
    });

    render(<DepegClient />);

    expect(mocks.useInfiniteDepegEvents).toHaveBeenCalledWith({ includePending: true });
    expect(screen.getByText("Leaderboard and heatmap filters")).toBeTruthy();
    expect(screen.getByTestId("depeg-table").textContent).toContain("pending rows 1");
    expect(screen.getByTestId("feed-Active Incidents").textContent).toBe("1");
    expect(screen.getByTestId("feed-Recent Depeg Events").textContent).toBe("1");
    expect(screen.getByTestId("pending-incidents").textContent).toBe("1");
  });
});
