// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { useStablecoinDetailViewModel } from "../use-stablecoin-detail-view-model";
import { DISABLED_DETAIL_QUERY_CONTROLS } from "./use-stablecoin-detail-view-model.test-support";
import { StablecoinDetailSnapshotHydrator } from "@/app/stablecoin/[id]/client";
import { seedStablecoinDetailQueryCache, type StablecoinDetailSnapshot } from "@/lib/api";
import { deriveDataHealth } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";

function detailSnapshot(generatedAt: number): StablecoinDetailSnapshot {
  return {
    version: 1,
    stablecoinId: "usdt-tether",
    generatedAt,
    updatedAt: { liveSummary: generatedAt, supplyHistory: generatedAt },
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
        nativeSupply: { current: null, prevWeek: null, prevMonth: null },
      },
      supplyHistory: [],
    },
  };
}

describe("stablecoin detail request budget", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("hydrates only coin-scoped keys and never writes partial global responses", () => {
    const queryClient = new QueryClient();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const snapshot = detailSnapshot(now - 30_000);

    seedStablecoinDetailQueryCache(queryClient, snapshot);

    expect(queryClient.getQueryState(["stablecoins"])).toBeUndefined();
    expect(queryClient.getQueryState(["peg-summary"])).toBeUndefined();
    expect(queryClient.getQueryState(["stablecoin-detail", "usdt-tether"])).toBeUndefined();
    expect(queryClient.getQueryData(["stablecoin-live-summary", "usdt-tether"])).toMatchObject({
      data: snapshot.lanes.liveSummary,
      meta: { updatedAt: snapshot.updatedAt.liveSummary! / 1000, ageSeconds: 30, status: "fresh" },
    });
    expect(queryClient.getQueryData(["supply-history", "usdt-tether", 90])).toMatchObject({
      data: [],
      meta: { updatedAt: snapshot.updatedAt.supplyHistory! / 1000, ageSeconds: 30, status: "fresh" },
    });
    queryClient.clear();
  });

  it("preserves independent producer clocks and cannot replace newer live data with a later build", () => {
    const queryClient = new QueryClient();
    const snapshot = detailSnapshot(1_700_000_900_000);
    snapshot.updatedAt = { liveSummary: 1_700_000_100_000, supplyHistory: 1_699_900_000_000 };
    seedStablecoinDetailQueryCache(queryClient, snapshot);
    const liveKey = ["stablecoin-live-summary", "usdt-tether"];
    const historyKey = ["supply-history", "usdt-tether", 90];
    expect(queryClient.getQueryState(liveKey)?.dataUpdatedAt).toBe(snapshot.updatedAt.liveSummary);
    expect(queryClient.getQueryState(historyKey)?.dataUpdatedAt).toBe(snapshot.updatedAt.supplyHistory);
    const live = {
      data: { ...snapshot.lanes.liveSummary!, price: 1.01 },
      meta: { updatedAt: 1_700_000_500, ageSeconds: 0, status: "fresh" },
    };
    queryClient.setQueryData(liveKey, live, { updatedAt: Date.now() });
    seedStablecoinDetailQueryCache(queryClient, snapshot);
    expect(queryClient.getQueryData(liveKey)).toEqual(live);
    queryClient.clear();
  });

  it("hydrates missing producer clocks as unknown rather than using generatedAt", () => {
    const queryClient = new QueryClient();
    const snapshot = detailSnapshot(Date.now());
    snapshot.updatedAt = {};
    seedStablecoinDetailQueryCache(queryClient, snapshot);
    for (const key of [["stablecoin-live-summary", snapshot.stablecoinId], ["supply-history", snapshot.stablecoinId, 90]]) {
      expect(queryClient.getQueryState(key)?.dataUpdatedAt).toBe(0);
      expect(queryClient.getQueryData(key)).toMatchObject({
        meta: { updatedAt: null, ageSeconds: null, status: "unknown" },
      });
    }
    queryClient.clear();
  });

  it.each(["stale", "unknown"] as const)("keeps HTTP-200 %s producer metadata through registered queries and the dossier", async (mode) => {
    const now = Date.now();
    const sourceUpdatedAtSec = Math.floor(now / 1000) - 7200;
    const headers: Record<string, string> = mode === "stale" ? {
      "X-Data-Updated-At": String(sourceUpdatedAtSec),
      "X-Data-Age": "7200",
      "X-Data-Freshness": "stale",
      Warning: '110 - "Response is stale"',
    } : {
      "X-Data-Age": "unavailable",
      "X-Data-Freshness": "unknown",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/stablecoin/usdt-tether")) {
        return Response.json(detailSnapshot(sourceUpdatedAtSec * 1000).lanes.liveSummary, { headers });
      }
      if (url.includes("/supply-history")) {
        return Response.json([{ date: sourceUpdatedAtSec, circulatingUsd: 100, price: 1 }], { headers });
      }
      return new Promise<Response>(() => {});
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const { result, unmount } = renderHook(() => useStablecoinDetailViewModel({
      id: coin.id, coin, summary: null, supplementalQueryControls: DISABLED_DETAIL_QUERY_CONTROLS,
    }), { wrapper });
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
      expect(queryClient.getQueryState(["supply-history", coin.id, 90])?.status).toBe("success");
    });
    await queryClient.refetchQueries({ queryKey: ["stablecoin-live-summary", coin.id] });
    await queryClient.refetchQueries({ queryKey: ["supply-history", coin.id, 90] });
    expect(queryClient.getQueryState(["stablecoin-live-summary", coin.id])?.dataUpdatedAt).toBeGreaterThan(sourceUpdatedAtSec * 1000);
    if (result.current.status !== "ready") throw new Error("Expected a ready dossier");
    const priceQuery = result.current.staleQueries.find((query) => query.preset === "stablecoins")!;
    const supplyQuery = result.current.staleQueries.find((query) => query.label === "Supply History")!;
    for (const query of [priceQuery, supplyQuery]) {
      const health = deriveDataHealth({
        ...(query.preset ? DATA_HEALTH_PRESETS[query.preset] : { label: query.label!, staleTime: query.staleTime! }),
        ...query,
      }, now);
      expect(health.state).toBe(mode === "stale" ? "stale" : "unavailable");
      expect(health.dataUpdatedAt).toBe(mode === "stale" ? sourceUpdatedAtSec * 1000 : 0);
      expect(query.meta?.updatedAt).toBe(mode === "stale" ? sourceUpdatedAtSec : null);
    }
    expect(result.current.supplyUpdatedAt).toBe(mode === "stale" ? sourceUpdatedAtSec * 1000 : 0);
    unmount();
    queryClient.clear();
  });

  it("loads all hero metrics while leaving offscreen-only lanes gated", async () => {
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
      ({ flowsNear }) => useStablecoinDetailViewModel({
        id: coin.id,
        coin,
        summary: null,
        supplementalQueryControls: {
          liquidity: true,
          reportCards: true,
          redemption: false,
          yield: true,
          stress: true,
          flows: flowsNear,
          blacklist: false,
          reserves: false,
        },
      }),
      { initialProps: { flowsNear: false }, wrapper },
    );

    await waitFor(() => expect(requests).toHaveLength(7));
    expect(requests).toEqual(expect.arrayContaining([
      expect.stringContaining("/api/stablecoin/usdt-tether"),
      expect.stringContaining("/api/peg-summary"),
      expect.stringContaining("/api/supply-history?stablecoin=usdt-tether&days=90"),
      expect.stringContaining("/api/yield-rankings"),
      expect.stringContaining("/api/dex-liquidity"),
      expect.stringContaining("/api/report-cards/v9"),
      expect.stringContaining("/api/stress-signals"),
    ]));

    rerender({ flowsNear: true });

    await waitFor(() => expect(requests).toHaveLength(8));
    expect(requests[7]).toContain("/api/mint-burn-flows");
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
        supplementalQueryControls: DISABLED_DETAIL_QUERY_CONTROLS,
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
