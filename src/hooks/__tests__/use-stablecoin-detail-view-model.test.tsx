// @vitest-environment jsdom

import { renderHook as renderHookWithProvider } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { seedStablecoinDetailQueryCache } from "@/lib/api";
import type { StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { FROZEN_SNAPSHOTS_BY_ID } from "@shared/lib/stablecoins/frozen-snapshots";
import { projectFrozenSnapshotLiveSummary } from "@/lib/frozen-snapshot-live-summary";
import { DISABLED_DETAIL_QUERY_CONTROLS, queryResult } from "./use-stablecoin-detail-view-model.test-support";
import type * as DetailViewModelModule from "@/lib/stablecoin-detail-view-model";

const mocks = vi.hoisted(() => ({
  buildStablecoinDetailViewModel: vi.fn(),
  trackFreshDataReady: vi.fn(),
  useSupplyHistory: vi.fn(),
  usePegSummary: vi.fn(),
  useDexLiquidity: vi.fn(),
  useReportCardsV9: vi.fn(),
  useRegisteredApiQuery: vi.fn(),
  useYieldRankings: vi.fn(),
  useStressSignals: vi.fn(),
  useMintBurnFlows: vi.fn(),
  useBlacklistSummary: vi.fn(),
  useStablecoinReserves: vi.fn(),
  refetchSupply: vi.fn(),
  refetchList: vi.fn(),
  refetchPeg: vi.fn(),
  refetchLiquidity: vi.fn(),
  refetchReportCards: vi.fn(),
  refetchRedemptionBackstops: vi.fn(),
  refetchYieldRankings: vi.fn(),
  refetchStressSignals: vi.fn(),
  refetchFlows: vi.fn(),
  refetchBlacklist: vi.fn(),
  refetchReserves: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({ trackFreshDataReady: mocks.trackFreshDataReady }));

let queryClient: QueryClient;
function renderHook<T>(callback: () => T) {
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return renderHookWithProvider(callback, { wrapper });
}

vi.mock("@/lib/stablecoin-detail-view-model", () => ({
  buildStablecoinDetailViewModel: mocks.buildStablecoinDetailViewModel,
}));

vi.mock("../use-stablecoins", () => ({
  useSupplyHistory: mocks.useSupplyHistory,
}));

vi.mock("../api-hooks", () => ({
  useDexLiquidityCoin: mocks.useDexLiquidity,
  usePegSummary: mocks.usePegSummary,
  useRegisteredApiQuery: mocks.useRegisteredApiQuery,
  useReportCardsV9Detail: mocks.useReportCardsV9,
  useStressSignals: mocks.useStressSignals,
  useYieldRankingsCoin: mocks.useYieldRankings,
  useRedemptionBackstopCoin: () => queryResult({ refetch: mocks.refetchRedemptionBackstops }),
}));

vi.mock("../use-mint-burn-flows", () => ({
  useMintBurnFlows: mocks.useMintBurnFlows,
}));

vi.mock("../use-blacklist-events", () => ({
  useBlacklistSummary: mocks.useBlacklistSummary,
}));

vi.mock("../use-stablecoin-reserves", () => ({
  useStablecoinReserves: mocks.useStablecoinReserves,
}));

import { useStablecoinDetailViewModel } from "../use-stablecoin-detail-view-model";

function resetRefetchMocks() {
  for (const refetch of [
    mocks.refetchSupply,
    mocks.refetchList,
    mocks.refetchPeg,
    mocks.refetchLiquidity,
    mocks.refetchReportCards,
    mocks.refetchRedemptionBackstops,
    mocks.refetchYieldRankings,
    mocks.refetchStressSignals,
    mocks.refetchFlows,
    mocks.refetchBlacklist,
    mocks.refetchReserves,
  ]) {
    refetch.mockReset();
    refetch.mockResolvedValue({ status: "success" });
  }
}

function installQueryMocks() {
  mocks.useSupplyHistory.mockReturnValue(queryResult({ data: [], refetch: mocks.refetchSupply }));
  mocks.usePegSummary.mockReturnValue(queryResult({ refetch: mocks.refetchPeg }));
  mocks.useDexLiquidity.mockReturnValue(queryResult({ refetch: mocks.refetchLiquidity }));
  mocks.useReportCardsV9.mockReturnValue(queryResult({ refetch: mocks.refetchReportCards }));
  mocks.useRegisteredApiQuery.mockImplementation((descriptor: { queryKey: readonly unknown[] }) =>
    queryResult({
      refetch: descriptor.queryKey[0] === "stablecoin-live-summary"
        ? mocks.refetchList
        : mocks.refetchRedemptionBackstops,
    }));
  mocks.useYieldRankings.mockReturnValue({
    ...queryResult({ data: { rankings: [] }, refetch: mocks.refetchYieldRankings }),
    dataUpdatedAt: 1,
  });
  mocks.useStressSignals.mockReturnValue({
    ...queryResult({ data: { signals: {} }, refetch: mocks.refetchStressSignals }),
    dataUpdatedAt: 1,
  });
  mocks.useMintBurnFlows.mockReturnValue(queryResult({ refetch: mocks.refetchFlows }));
  mocks.useBlacklistSummary.mockReturnValue(queryResult({ refetch: mocks.refetchBlacklist }));
  mocks.useStablecoinReserves.mockReturnValue(queryResult({
    reserveResult: null,
    isFetching: false,
    refetch: mocks.refetchReserves,
  }));
  mocks.buildStablecoinDetailViewModel.mockImplementation((params) => ({
    status: "loading",
    handleRetryAll: params.core.handleRetryAll,
  }));
}

describe("useStablecoinDetailViewModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient();
    resetRefetchMocks();
    installQueryMocks();
  });
  afterEach(() => queryClient.clear());

  it("retains the ready projection across parent renders until query data changes", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    mocks.buildStablecoinDetailViewModel.mockImplementation(() => ({ status: "ready" }));
    const { result, rerender } = renderHook(() => useStablecoinDetailViewModel({
      id: coin.id, coin, summary: null, supplementalQueryControls: DISABLED_DETAIL_QUERY_CONTROLS,
    }));
    const initial = result.current;
    const builds = mocks.buildStablecoinDetailViewModel.mock.calls.length;
    rerender();
    expect(mocks.buildStablecoinDetailViewModel).toHaveBeenCalledTimes(builds);
    expect(result.current).toBe(initial);
    mocks.usePegSummary.mockReturnValue(queryResult({ data: {}, refetch: mocks.refetchPeg }));
    rerender();
    expect(result.current).not.toBe(initial);
  });

  it.each(["live", "prefetched", "seed", "stale", "failed", "missing-clock", "fetching"])(
    "reports fresh readiness only for admitted fresh live summary (%s)",
    (state) => {
      const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
      const updatedAt = Date.now() / 1000;
      const data = {
        price: 1, circulating: { peggedUSD: 100 }, circulatingPrevDay: {}, circulatingPrevWeek: {}, circulatingPrevMonth: {},
        nativeSupply: { current: 100, prevWeek: 100, prevMonth: 100 },
      } as StablecoinLiveSummary;
      if (state === "seed") seedStablecoinDetailQueryCache(queryClient, {
        version: 1, stablecoinId: coin.id, generatedAt: Date.now(),
        updatedAt: { liveSummary: updatedAt * 1000 }, lanes: { liveSummary: data },
      });
      mocks.useRegisteredApiQuery.mockImplementation((descriptor: { queryKey: readonly unknown[] }) =>
        descriptor.queryKey[0] === "stablecoin-live-summary"
          ? { ...queryResult({ data, error: state === "failed" ? new Error("refresh failed") : null,
            isFetching: state === "fetching",
            meta: { updatedAt: state === "missing-clock" ? null : updatedAt,
              ageSeconds: 0, status: state === "stale" ? "stale" : "fresh" } }),
            isFetchedAfterMount: state !== "prefetched" }
          : queryResult());
      renderHook(() => useStablecoinDetailViewModel({
        id: coin.id, coin, summary: null, supplementalQueryControls: DISABLED_DETAIL_QUERY_CONTROLS,
      }));
      expect(mocks.trackFreshDataReady).toHaveBeenCalledTimes(["live", "prefetched"].includes(state) ? 1 : 0);
    },
  );
  it("resolves the hero annual USD metric from an independent annual observation without expanding the chart", async () => {
    const { buildStablecoinDetailViewModel } = await vi.importActual<typeof DetailViewModelModule>(
      "@/lib/stablecoin-detail-view-model",
    );
    const coin = TRACKED_META_BY_ID.get("eurc-circle")!;
    const nowMs = 1_800_000_000_000;
    const now = nowMs / 1000;
    const initial = [{ date: now - 30 * 86400, circulatingUsd: 100, price: 1.1 }];
    let annual = queryResult({ data: [], isLoading: true, refetch: mocks.refetchSupply });
    mocks.useSupplyHistory.mockImplementation((_id: string, days: number) =>
      days === 90 ? queryResult({ data: initial, refetch: mocks.refetchSupply }) : annual);
    mocks.useRegisteredApiQuery.mockImplementation((descriptor: { queryKey: readonly unknown[] }) =>
      descriptor.queryKey[0] === "stablecoin-live-summary"
        ? queryResult({ data: {
          price: 1.2, priceSource: "coingecko", priceConfidence: "single-source",
          circulating: { peggedEUR: 100 }, circulatingPrevDay: {}, circulatingPrevWeek: {}, circulatingPrevMonth: {},
          nativeSupply: { current: 100, prevWeek: 100, prevMonth: 100 },
        }, refetch: mocks.refetchList })
        : queryResult({ refetch: mocks.refetchRedemptionBackstops }));
    mocks.buildStablecoinDetailViewModel.mockImplementation((params) =>
      buildStablecoinDetailViewModel({ ...params, supplemental: { ...params.supplemental, nowMs } }));
    const { result, rerender } = renderHook(() => useStablecoinDetailViewModel({
      id: coin.id, coin, summary: null, supplementalQueryControls: DISABLED_DETAIL_QUERY_CONTROLS,
    }));
    expect(mocks.useSupplyHistory).toHaveBeenCalledWith(coin.id, 380, { enabled: true });
    expect(result.current.status).toBe("ready");
    if (result.current.status !== "ready") throw new Error("Expected ready dossier");
    expect(result.current.performanceVsUsd1y).toBeNull();
    annual = queryResult({
      data: [{ date: now - 365 * 86400, circulatingUsd: 100, price: 1 }, ...initial],
      refetch: mocks.refetchSupply,
    });
    rerender();
    if (result.current.status !== "ready") throw new Error("Expected ready dossier");
    expect(result.current.performanceVsUsd1y).toBeCloseTo(20);
    expect(result.current.hero.tertiaryMetrics.find((metric) => metric.key === "performance-vs-usd")).toBeDefined();
    expect(result.current.supplyHistory).toEqual(initial);
  });

  it.each([true, false])("projects restored supply provenance into the hero coin data (%s)", (restored) => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    mocks.useRegisteredApiQuery.mockImplementation((descriptor: { queryKey: readonly unknown[] }) =>
      descriptor.queryKey[0] === "stablecoin-live-summary"
        ? queryResult({ data: {
          price: null, priceSource: null, priceConfidence: null, priceUpdatedAt: null, priceObservedAt: null,
          supplyObservedAt: 1_790_793_000, supplyRestored: restored,
          circulating: { peggedUSD: 100 }, circulatingPrevDay: {}, circulatingPrevWeek: {}, circulatingPrevMonth: {},
          nativeSupply: { current: null, prevWeek: null, prevMonth: null },
        }, refetch: mocks.refetchList })
        : queryResult({ refetch: mocks.refetchRedemptionBackstops }));
    renderHook(() => useStablecoinDetailViewModel({
      id: coin.id, coin, summary: null, supplementalQueryControls: DISABLED_DETAIL_QUERY_CONTROLS,
    }));
    const coinData = mocks.buildStablecoinDetailViewModel.mock.calls.at(-1)![0].queries.stablecoinList.data.peggedAssets[0];
    expect(coinData.supplyRestored === true).toBe(restored);
    expect(coinData.supplyObservedAt).toBe(1_790_793_000);
  });

  it("masks cached supplemental data while controls are disabled", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    mocks.useMintBurnFlows.mockReturnValue(queryResult({
      data: {
        gauge: { score: 0 },
        coins: [{ stablecoinId: coin.id }],
        hourly: [],
      },
      isLoading: true,
      refetch: mocks.refetchFlows,
    }));
    mocks.useBlacklistSummary.mockReturnValue(queryResult({
      data: {
        stats: {
          perCoinTotalEvents: { USDT: 1 },
        },
      },
      isLoading: true,
      refetch: mocks.refetchBlacklist,
    }));
    mocks.useStablecoinReserves.mockReturnValue(queryResult({
      reserveResult: { mode: "live", reserves: [] },
      error: new Error("cached reserve error"),
      isFetching: true,
      refetch: mocks.refetchReserves,
    }));

    renderHook(() =>
      useStablecoinDetailViewModel({
        id: coin.id,
        coin,
        summary: null,
        supplementalQueryControls: {
          flows: false,
          blacklist: false,
          reserves: false,
        },
      }),
    );

    expect(mocks.buildStablecoinDetailViewModel).toHaveBeenCalledWith(
      expect.objectContaining({
        supplemental: expect.objectContaining({
          flows: expect.objectContaining({
            data: undefined,
            isLoading: false,
            enabled: false,
          }),
          blacklist: expect.objectContaining({
            summary: undefined,
            isLoading: false,
            enabled: false,
          }),
          reserves: expect.objectContaining({
            live: null,
            error: null,
            enabled: false,
          }),
        }),
      }),
    );
  });

  it("retries only failed enabled lanes", async () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    mocks.usePegSummary.mockReturnValue(queryResult({
      error: new Error("peg failed"),
      refetch: mocks.refetchPeg,
    }));
    mocks.useReportCardsV9.mockReturnValue(queryResult({
      error: new Error("report cards failed"),
      refetch: mocks.refetchReportCards,
    }));
    const { result } = renderHook(() =>
      useStablecoinDetailViewModel({
        id: coin.id,
        coin,
        summary: null,
        supplementalQueryControls: {
          reportCards: false,
          flows: false,
          blacklist: false,
          reserves: false,
        },
      }),
    );

    await result.current.handleRetryAll();

    expect(mocks.refetchSupply).not.toHaveBeenCalled();
    expect(mocks.refetchList).not.toHaveBeenCalled();
    expect(mocks.refetchPeg).toHaveBeenCalled();
    expect(mocks.refetchLiquidity).not.toHaveBeenCalled();
    expect(mocks.refetchReportCards).not.toHaveBeenCalled();
    expect(mocks.refetchRedemptionBackstops).not.toHaveBeenCalled();
    expect(mocks.refetchYieldRankings).not.toHaveBeenCalled();
    expect(mocks.refetchStressSignals).not.toHaveBeenCalled();
    expect(mocks.refetchFlows).not.toHaveBeenCalled();
    expect(mocks.refetchBlacklist).not.toHaveBeenCalled();
    expect(mocks.refetchReserves).not.toHaveBeenCalled();
  });

  it("includes enabled supplemental queries in retry-all", async () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    mocks.useMintBurnFlows.mockReturnValue(queryResult({
      error: new Error("flows failed"),
      refetch: mocks.refetchFlows,
    }));
    mocks.useBlacklistSummary.mockReturnValue(queryResult({
      error: new Error("blacklist failed"),
      refetch: mocks.refetchBlacklist,
    }));
    mocks.useStablecoinReserves.mockReturnValue(queryResult({
      error: new Error("reserves failed"),
      refetch: mocks.refetchReserves,
    }));
    const { result } = renderHook(() =>
      useStablecoinDetailViewModel({
        id: coin.id,
        coin,
        summary: null,
        supplementalQueryControls: {
          flows: true,
          blacklist: true,
          reserves: true,
        },
      }),
    );

    await result.current.handleRetryAll();

    expect(mocks.refetchFlows).toHaveBeenCalled();
    expect(mocks.refetchBlacklist).toHaveBeenCalled();
    expect(mocks.refetchReserves).toHaveBeenCalled();
  });

  describe("frozen archive fallback", () => {
    const coin = TRACKED_META_BY_ID.get("usnd-nerite")!;
    const archived = projectFrozenSnapshotLiveSummary(FROZEN_SNAPSHOTS_BY_ID.get(coin.id)!)!;

    function mockLiveSummary(overrides: Parameters<typeof queryResult>[0]) {
      mocks.useRegisteredApiQuery.mockImplementation((descriptor: { queryKey: readonly unknown[] }) =>
        descriptor.queryKey[0] === "stablecoin-live-summary"
          ? queryResult({ ...overrides, refetch: mocks.refetchList })
          : queryResult({ refetch: mocks.refetchRedemptionBackstops }));
    }

    function renderedStablecoinList() {
      renderHook(() =>
        useStablecoinDetailViewModel({
          id: coin.id,
          coin,
          summary: null,
          archivedLiveSummary: archived,
          supplementalQueryControls: DISABLED_DETAIL_QUERY_CONTROLS,
        }),
      );
      return mocks.buildStablecoinDetailViewModel.mock.calls.at(-1)![0].queries.stablecoinList;
    }

    it("backs the page with the archived row when the live detail row is gone", () => {
      mockLiveSummary({ isError: true, error: new Error("HTTP 404") });

      const list = renderedStablecoinList();

      expect(list).toMatchObject({ isError: false, isLoading: false, error: null, enabled: false, dataUpdatedAt: 0, meta: null });
      expect(list.data.peggedAssets[0]).toMatchObject({
        id: coin.id,
        price: archived.price,
        circulating: archived.circulating,
        supplyObservedAt: archived.supplyObservedAt,
      });
    });

    it("prefers the live detail row over the archive when it exists", () => {
      mockLiveSummary({
        data: { ...archived, price: 0.42 }, dataUpdatedAt: 100,
        meta: { updatedAt: 0.005, ageSeconds: 0, status: "fresh" },
      } as Parameters<typeof queryResult>[0]);

      const list = renderedStablecoinList();

      expect(list).toMatchObject({ isError: false, enabled: true, dataUpdatedAt: 100, meta: { updatedAt: 0.005 } });
      expect(list.data.peggedAssets[0].price).toBe(0.42);
    });
  });
});
