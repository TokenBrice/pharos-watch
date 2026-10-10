// @vitest-environment jsdom

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { MarketDataSection } from "@/components/stablecoin-detail/market-data-section";
import { usePrefetchStablecoin } from "../use-prefetch-stablecoin";
import { useStablecoinDetailViewModel } from "../use-stablecoin-detail-view-model";
import { DISABLED_DETAIL_QUERY_CONTROLS } from "./use-stablecoin-detail-view-model.test-support";
import { useSupplyHistory } from "../use-stablecoins";
import { STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS, STABLECOIN_DETAIL_FULL_SUPPLY_HISTORY_DAYS } from "@/lib/api-query-descriptors";

vi.mock("@/components/lazy-section", () => ({ LazySection: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/mcap-chart", () => ({ McapChart: () => <div /> }));
vi.mock("@/components/peg-deviation-chart", () => ({ PegDeviationChart: () => <div /> }));
class ResizeObserverStub { observe() {} disconnect() {} }

function CachedMarketData() {
  const history = useSupplyHistory("usdt-tether", STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS);
  return <MarketDataSection stablecoinId="usdt-tether" supplyHistory={history.data} pegCurrency="USD" updatedAtMs={history.dataUpdatedAt} />;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("usePrefetchStablecoin", () => {
  it.each(["1Y", "All"])("warms the first-paint key and leaves %s expansion separate", async (range) => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const requests: string[] = [];
    const history = [
      { date: 1_700_000_000, circulatingUsd: 100, price: 1 },
      { date: 1_707_000_000, circulatingUsd: 110, price: 1 },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/supply-history")) return Response.json(history);
      return new Promise<Response>(() => {});
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const prefetch = renderHook(() => usePrefetchStablecoin(), { wrapper });
    act(() => prefetch.result.current("usdt-tether"));
    const firstPaintKey = ["supply-history", "usdt-tether", STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS];
    const expandedKey = ["supply-history", "usdt-tether", STABLECOIN_DETAIL_FULL_SUPPLY_HISTORY_DAYS];
    await waitFor(() => expect(client.getQueryState(firstPaintKey)?.status).toBe("success"));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("/api/supply-history?stablecoin=usdt-tether&days=90");
    expect(client.getQueryState(expandedKey)).toBeUndefined();
    const prefetched = client.getQueryData(firstPaintKey);

    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const detail = renderHook(() => useStablecoinDetailViewModel({
      id: coin.id, coin, summary: null, supplementalQueryControls: DISABLED_DETAIL_QUERY_CONTROLS,
    }), { wrapper });
    expect(client.getQueryCache().find({ queryKey: firstPaintKey })?.getObserversCount()).toBe(1);
    const chart = render(<CachedMarketData />, { wrapper });
    expect(client.getQueryData(firstPaintKey)).toBe(prefetched);
    expect(requests.filter((url) => url.includes("/supply-history"))).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: range }));
    await waitFor(() => expect(client.getQueryState(expandedKey)?.status).toBe("success"));
    expect(requests.filter((url) => url.includes("/supply-history"))).toEqual([
      expect.stringContaining("days=90"), expect.stringContaining("days=1825"),
    ]);
    expect(client.getQueryData(firstPaintKey)).toBe(prefetched);
    chart.unmount();
    detail.unmount();
    prefetch.unmount();
    client.clear();
  });
});
