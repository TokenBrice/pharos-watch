// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { useStablecoinDetailViewModel } from "../use-stablecoin-detail-view-model";
import { StablecoinDetailSnapshotHydrator } from "@/app/stablecoin/[id]/client";
import { seedStablecoinDetailQueryCache, type StablecoinDetailSnapshot } from "@/lib/api";

function detailSnapshot(generatedAt: number): StablecoinDetailSnapshot {
  return {
    version: 1,
    stablecoinId: "usdt-tether",
    generatedAt,
    lanes: {
      liveSummary: {
        price: 1,
        priceSource: null,
        priceConfidence: null,
        priceUpdatedAt: null,
        priceObservedAt: null,
        supplyObservedAt: Math.floor(generatedAt / 1000),
        circulating: { peggedUSD: 100 },
        circulatingPrevDay: {},
        circulatingPrevWeek: {},
        circulatingPrevMonth: {},
      },
      supplyHistory: [],
    },
  };
}

describe("stablecoin detail request budget", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hydrates only coin-scoped keys and never writes partial global responses", () => {
    const queryClient = new QueryClient();
    const snapshot = detailSnapshot(Date.now());

    seedStablecoinDetailQueryCache(queryClient, snapshot);

    expect(queryClient.getQueryState(["stablecoins"])).toBeUndefined();
    expect(queryClient.getQueryState(["peg-summary"])).toBeUndefined();
    expect(queryClient.getQueryState(["stablecoin-detail", "usdt-tether"])).toBeUndefined();
    expect(queryClient.getQueryData(["stablecoin-live-summary", "usdt-tether"])).toEqual(
      snapshot.lanes.liveSummary,
    );
    expect(queryClient.getQueryData(["supply-history", "usdt-tether", 90])).toEqual([]);
  });

  it("starts at three eager requests and arms a below-fold lane on viewport entry", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      requests.push(String(input));
      return new Promise<Response>(() => {});
    }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const { rerender } = renderHook(
      ({ yieldNear }) => useStablecoinDetailViewModel({
        id: coin.id,
        coin,
        summary: null,
        supplementalQueryControls: {
          liquidity: false,
          reportCards: false,
          redemption: false,
          yield: yieldNear,
          stress: false,
          flows: false,
          blacklist: false,
          reserves: false,
        },
      }),
      { initialProps: { yieldNear: false }, wrapper },
    );

    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests).toEqual(expect.arrayContaining([
      expect.stringContaining("/api/stablecoin/usdt-tether"),
      expect.stringContaining("/api/peg-summary"),
      expect.stringContaining("/api/supply-history?stablecoin=usdt-tether&days=90"),
    ]));

    rerender({ yieldNear: true });

    await waitFor(() => expect(requests).toHaveLength(4));
    expect(requests[3]).toContain("/api/yield-rankings");
    queryClient.clear();
  });

  it("hydrates fresh eager lanes before observers mount and refetches an expired snapshot", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      requests.push(String(input));
      return new Promise<Response>(() => {});
    }));
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const renderWithSnapshot = (snapshot: StablecoinDetailSnapshot) => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <StablecoinDetailSnapshotHydrator snapshot={snapshot}>{children}</StablecoinDetailSnapshotHydrator>
        </QueryClientProvider>
      );
      const rendered = renderHook(() => useStablecoinDetailViewModel({
        id: coin.id,
        coin,
        summary: null,
        supplementalQueryControls: {
          liquidity: false,
          reportCards: false,
          redemption: false,
          yield: false,
          stress: false,
          flows: false,
          blacklist: false,
          reserves: false,
        },
      }), { wrapper });
      return { queryClient, ...rendered };
    };

    const fresh = renderWithSnapshot(detailSnapshot(Date.now()));
    await waitFor(() => expect(fresh.result.current.status).toBe("ready"));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toContain("/api/peg-summary");
    expect(fresh.queryClient.getQueryState(["stablecoins"])).toBeUndefined();
    expect(fresh.queryClient.getQueryState(["peg-summary"])).toBeDefined();
    expect(fresh.queryClient.getQueryData(["stablecoin-live-summary", "usdt-tether"])).toBeDefined();
    fresh.unmount();
    fresh.queryClient.clear();
    requests.length = 0;

    const expired = renderWithSnapshot(detailSnapshot(Date.now() - 25 * 60 * 60 * 1000));
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests).toEqual(expect.arrayContaining([
      expect.stringContaining("/api/stablecoin/usdt-tether"),
      expect.stringContaining("/api/peg-summary"),
      expect.stringContaining("/api/supply-history?stablecoin=usdt-tether&days=90"),
    ]));
    expired.unmount();
    expired.queryClient.clear();
  });
});
