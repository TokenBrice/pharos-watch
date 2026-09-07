// @vitest-environment jsdom

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketDataSection } from "@/components/stablecoin-detail/market-data-section";
import { useSupplyHistory } from "@/hooks/use-stablecoins";
import {
  FRONTEND_API_QUERY_DESCRIPTORS,
  STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS,
} from "@/lib/api-query-descriptors";

const { setBrushedRange } = vi.hoisted(() => ({ setBrushedRange: vi.fn() }));

vi.mock("@/components/lazy-section", () => ({
  LazySection: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/mcap-chart", () => ({
  McapChart: ({ data }: { data: Array<{ date: number }> }) => (
    <output data-testid="market-cap-domain">
      {data.length > 0 ? `${data[0].date}-${data[data.length - 1].date}` : "empty"}
    </output>
  ),
}));

vi.mock("@/components/peg-deviation-chart", () => ({
  PegDeviationChart: () => <div />,
}));

vi.mock("@/components/chart-primitives/annotations", () => ({
  ChartAnnotationLegend: () => null,
}));

vi.mock("@/components/chart-primitives/sync", () => ({
  ChartBrush: ({ domain }: { domain: readonly [number, number] }) => (
    <output data-testid="brush-domain">{`${domain[0]}-${domain[1]}`}</output>
  ),
  MarketDataChartSyncProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useMarketDataChartSync: () => ({ brushedRange: null, setBrushedRange }),
}));

vi.mock("@/hooks/use-chart-annotations", () => ({
  useChartAnnotations: () => ({ data: [] }),
}));

function SeededMarketDataSection() {
  const history = useSupplyHistory("usdt-tether", STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS);
  return (
    <MarketDataSection
      stablecoinId="usdt-tether"
      supplyHistory={history.data}
      pegCurrency="USD"
      updatedAtMs={history.dataUpdatedAt}
    />
  );
}

describe("MarketDataSection history expansion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fetches the distinct full-history query when All is selected after a fresh 90-day seed", async () => {
    const day = 86_400;
    const eagerHistory = Array.from({ length: 90 }, (_, index) => ({
      date: 1_700_000_000 + index * day,
      circulatingUsd: 100 + index,
      price: 1,
    }));
    const fullHistory = [
      { date: 1_500_000_000, circulatingUsd: 10, price: 1 },
      ...eagerHistory,
    ];
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify(fullHistory)));
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      FRONTEND_API_QUERY_DESCRIPTORS
        .supplyHistory("usdt-tether", STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS)
        .queryKey,
      eagerHistory,
      { updatedAt: Date.now() },
    );

    render(
      <QueryClientProvider client={queryClient}>
        <SeededMarketDataSection />
      </QueryClientProvider>,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("market-cap-domain").textContent).toBe(
      `${eagerHistory[0].date}-${eagerHistory[eagerHistory.length - 1].date}`,
    );

    fireEvent.click(screen.getByRole("button", { name: "All" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("days=1825");
    await waitFor(() => {
      expect(screen.getByTestId("market-cap-domain").textContent).toBe(
        `${fullHistory[0].date}-${fullHistory[fullHistory.length - 1].date}`,
      );
      expect(screen.getByTestId("brush-domain").textContent).toBe(
        `${fullHistory[0].date * 1000}-${fullHistory[fullHistory.length - 1].date * 1000}`,
      );
    });
  });
});
