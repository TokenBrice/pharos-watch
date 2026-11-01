// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  useQueriesMock,
  useBluechipRatingsMock,
  useDexLiquidityMock,
  usePegSummaryMock,
  useRedemptionBackstopsMock,
  useReportCardsV9Mock,
  useStressSignalsMock,
  useYieldRankingsMock,
  useStablecoinsMock,
  useMintBurnFlowsMock,
  supplyHistoryQueryOptionsMock,
  mintBurnFlowsCoinQueryOptionsMock,
} = vi.hoisted(() => ({
  useQueriesMock: vi.fn(),
  useBluechipRatingsMock: vi.fn(),
  useDexLiquidityMock: vi.fn(),
  usePegSummaryMock: vi.fn(),
  useRedemptionBackstopsMock: vi.fn(),
  useReportCardsV9Mock: vi.fn(),
  useStressSignalsMock: vi.fn(),
  useYieldRankingsMock: vi.fn(),
  useStablecoinsMock: vi.fn(),
  useMintBurnFlowsMock: vi.fn(),
  supplyHistoryQueryOptionsMock: vi.fn(),
  mintBurnFlowsCoinQueryOptionsMock: vi.fn(),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQueries: useQueriesMock,
  };
});

vi.mock("../api-hooks", () => ({
  useBluechipRatings: useBluechipRatingsMock,
  useDexLiquidity: useDexLiquidityMock,
  usePegSummary: usePegSummaryMock,
  useRedemptionBackstops: useRedemptionBackstopsMock,
  useReportCardsV9: useReportCardsV9Mock,
  useStressSignals: useStressSignalsMock,
  useYieldRankings: useYieldRankingsMock,
}));

vi.mock("../use-stablecoins", () => ({
  useStablecoins: useStablecoinsMock,
  supplyHistoryQueryOptions: supplyHistoryQueryOptionsMock,
}));

vi.mock("../use-mint-burn-flows", () => ({
  useMintBurnFlows: useMintBurnFlowsMock,
  mintBurnFlowsCoinQueryOptions: mintBurnFlowsCoinQueryOptionsMock,
}));

import { useCompareDataModel } from "../use-compare-data-model";
import { COMPARE_COLORS } from "@/lib/compare-config";
import { STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS } from "@/lib/api-query-descriptors";
import type { TimeRangeOption } from "@/lib/chart-time-range";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { makeUnreportedBluechipRating } from "@shared/test-utils/bluechip.test-support";

function makeQueryResult(overrides: Record<string, unknown> = {}) {
  return {
    data: undefined,
    dataUpdatedAt: 0,
    error: null,
    meta: null,
    refetch: vi.fn().mockResolvedValue({ status: "success", error: null }),
    ...overrides,
  };
}

describe("useCompareDataModel", () => {
  beforeEach(() => {
    useQueriesMock.mockReset();
    useBluechipRatingsMock.mockReset();
    useDexLiquidityMock.mockReset();
    usePegSummaryMock.mockReset();
    useRedemptionBackstopsMock.mockReset();
    useReportCardsV9Mock.mockReset();
    useStressSignalsMock.mockReset();
    useYieldRankingsMock.mockReset();
    useStablecoinsMock.mockReset();
    useMintBurnFlowsMock.mockReset();
    supplyHistoryQueryOptionsMock.mockReset();
    mintBurnFlowsCoinQueryOptionsMock.mockReset();

    useQueriesMock.mockReturnValue([]);
    useStablecoinsMock.mockReturnValue(makeQueryResult({
      data: { peggedAssets: [], fxFallbackRates: {} },
    }));
    usePegSummaryMock.mockReturnValue(makeQueryResult({
      data: { coins: [] },
    }));
    useBluechipRatingsMock.mockReturnValue(makeQueryResult());
    useDexLiquidityMock.mockReturnValue(makeQueryResult({
      data: {},
    }));
    useReportCardsV9Mock.mockReturnValue(makeQueryResult({
      data: { cards: [] },
    }));
    useRedemptionBackstopsMock.mockReturnValue(makeQueryResult({
      data: { coins: {} },
    }));
    useStressSignalsMock.mockReturnValue(makeQueryResult({
      data: { signals: {} },
    }));
    useYieldRankingsMock.mockReturnValue(makeQueryResult({
      data: { rankings: [] },
    }));
    useMintBurnFlowsMock.mockReturnValue(makeQueryResult({ data: { coins: [] } }));
    supplyHistoryQueryOptionsMock.mockReturnValue({});
    mintBurnFlowsCoinQueryOptionsMock.mockReturnValue({});
  });
  it("keeps only the selector list active until comparisons are selected", () => {
    const { result, rerender } = renderHook(
      ({ selectedIds }) => useCompareDataModel({ selectedIds, flowHours: 24, radarCohort: "peg", range: "all" }),
      { initialProps: { selectedIds: [] as string[] } },
    );
    const metricHooks = [
      usePegSummaryMock, useBluechipRatingsMock, useDexLiquidityMock, useReportCardsV9Mock,
      useRedemptionBackstopsMock, useYieldRankingsMock, useStressSignalsMock,
    ];
    for (const hook of metricHooks) expect(hook).toHaveBeenLastCalledWith({ enabled: false });
    expect(useMintBurnFlowsMock).toHaveBeenLastCalledWith(24, { enabled: false });
    expect(result.current.freshnessQueries.map((query) => query.preset)).toEqual(["stablecoins"]);
    expect(useQueriesMock).toHaveBeenCalledWith({ queries: [] });

    rerender({ selectedIds: ["usdc-circle"] });
    for (const hook of metricHooks) expect(hook).toHaveBeenLastCalledWith({ enabled: true });
    expect(useMintBurnFlowsMock).toHaveBeenLastCalledWith(24, { enabled: true });
  });

  it("enables metrics immediately for an initial URL-provided selection", () => {
    renderHook(() => useCompareDataModel({ selectedIds: ["usdc-circle"], flowHours: 24, radarCohort: "peg", range: "all" }));
    expect(useReportCardsV9Mock).toHaveBeenCalledWith({ enabled: true });
    expect(usePegSummaryMock).toHaveBeenCalledWith({ enabled: true });
  });


  it.each(["pending", "failed", "empty", "matching", "retained"] as const)(
    "preserves %s Bluechip publication state without gating the stablecoin list",
    (state) => {
      const rating = { ...makeUnreportedBluechipRating(), observationState: state === "retained" ? "retained" as const : "current" as const,
        observationReason: state === "retained" ? "http-500" : null, lastObservedAt: 1_790_000_000 };
      const error = state === "failed" || state === "retained" ? new Error("Bluechip unavailable") : null;
      const data = state === "empty" ? {} : state === "matching" || state === "retained" ? { "usdc-circle": rating } : undefined;
      useStablecoinsMock.mockReturnValue(makeQueryResult({
        data: { peggedAssets: [makeStablecoin({ id: "usdc-circle" })], fxFallbackRates: {} },
      }));
      useBluechipRatingsMock.mockReturnValue(makeQueryResult({
        data, error, isLoading: state === "pending", isError: error != null,
        dataUpdatedAt: data ? 1_790_000_010_000 : 0,
      }));
      const { result } = renderHook(() => useCompareDataModel({
        selectedIds: ["usdc-circle"], flowHours: 24, radarCohort: "peg", range: "all",
      }));
      expect(result.current.hasPrimaryData).toBe(true);
      expect(result.current.comparisonCoins).toHaveLength(1);
      expect(result.current.comparisonCoins[0]).toMatchObject({
        bluechipPublicationAvailable: data != null,
        bluechipRating: state === "matching" || state === "retained" ? rating : null,
      });
      expect(result.current.globalError).toBe(error);
      expect(result.current.freshnessQueries.find((query) => query.preset === "bluechip")).toMatchObject({
        hasData: data != null, error, dataUpdatedAt: data ? 1_790_000_010_000 : 0,
      });
    },
  );

  it("returns partial-failure freshness and symbol-bearing radar presentation models", () => {
    const stablecoinsMeta = { source: "stablecoins-fixture" };
    const dexError = new Error("liquidity unavailable");
    const reportCards = makeReportCardsV9Response({
      cards: [
        makeV9Card({ id: "usdc-circle" }),
        makeV9Card({ id: "usdt-tether" }),
      ],
    });
    useStablecoinsMock.mockReturnValue(makeQueryResult({
      data: { peggedAssets: [], fxFallbackRates: {} },
      dataUpdatedAt: 101,
      meta: stablecoinsMeta,
    }));
    useDexLiquidityMock.mockReturnValue(makeQueryResult({
      data: {},
      error: dexError,
    }));
    useReportCardsV9Mock.mockReturnValue(makeQueryResult({
      data: reportCards,
      dataUpdatedAt: 202,
    }));

    const { result } = renderHook(() => useCompareDataModel({
      selectedIds: ["usdc-circle", "usdt-tether"],
      flowHours: 24,
      radarCohort: "peg",
      range: "all",
    }));

    expect(result.current.freshnessQueries.map((query) => query.preset)).toEqual([
      "stablecoins",
      "pegSummary",
      "dexLiquidity",
      "reportCards",
      "bluechip",
      "redemptionBackstops",
      "yieldRankings",
      "stressSignals",
      "mintBurnFlows",
    ]);
    expect(result.current.freshnessQueries[0]).toMatchObject({
      dataUpdatedAt: 101,
      hasData: false,
      meta: stablecoinsMeta,
    });
    expect(result.current.hasPrimaryData).toBe(false);
    expect(result.current.globalError).toBe(dexError);
    expect(result.current.freshnessQueries[2]).toMatchObject({
      error: dexError,
      hasData: true,
    });
    expect(result.current.radarCards).toEqual([
      {
        card: reportCards.cards[0],
        identity: reportCards.safetyScoreIdentity,
        color: COMPARE_COLORS[0],
        symbol: "USDC",
      },
      {
        card: reportCards.cards[1],
        identity: reportCards.safetyScoreIdentity,
        color: COMPARE_COLORS[1],
        symbol: "USDT",
      },
    ]);
  });

  it("unwraps metadata-aware supply history before deriving comparison chart series", () => {
    useQueriesMock
      .mockReturnValueOnce([makeQueryResult({
        data: {
          data: [{ date: 1_700_000_000, circulatingUsd: 123 }],
          meta: { updatedAt: 1_700_000_000, ageSeconds: 0, status: "fresh" },
        },
      })])
      .mockReturnValueOnce([]);
    const { result } = renderHook(() => useCompareDataModel({
      selectedIds: ["usdc-circle"], flowHours: 24, radarCohort: "peg", range: "all",
    }));
    expect(result.current.supplySeries).toEqual([
      expect.objectContaining({ id: "usdc-circle", data: [{ ts: 1_700_000_000_000, value: 123 }] }),
    ]);
  });

  it("requests a supply-history window that covers the chart range, including unbounded All", () => {
    const { rerender } = renderHook(
      ({ range }: { range: TimeRangeOption }) => useCompareDataModel({
        selectedIds: ["usdt-tether"], flowHours: 24, radarCohort: "peg", range,
      }),
      { initialProps: { range: "all" as TimeRangeOption } },
    );
    expect(supplyHistoryQueryOptionsMock).toHaveBeenLastCalledWith("usdt-tether", "all");

    rerender({ range: "1y" });
    expect(supplyHistoryQueryOptionsMock).toHaveBeenLastCalledWith("usdt-tether", 365);

    rerender({ range: "90d" });
    expect(supplyHistoryQueryOptionsMock).toHaveBeenLastCalledWith(
      "usdt-tether",
      STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS,
    );
  });

  it("returns only the flow-error retry controls needed by the client", () => {
    const flowError = new Error("flow unavailable");
    const refetchFlowCoin = vi.fn().mockResolvedValue({ status: "success", error: null });
    useQueriesMock
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{
        data: undefined,
        error: flowError,
        isError: true,
        refetch: refetchFlowCoin,
      }]);

    const { result } = renderHook(() => useCompareDataModel({
      selectedIds: ["usdc-circle"],
      flowHours: 24,
      radarCohort: "peg",
      range: "all",
    }));

    expect(result.current.flowErrorNotice).toMatchObject({
      error: flowError,
      hasData: false,
    });
    act(() => result.current.flowErrorNotice?.onRetry());
    expect(refetchFlowCoin).toHaveBeenCalledTimes(1);
  });

  it("keeps aggregate flow failure unavailable despite successful per-coin histories", () => {
    const error = new Error("aggregate unavailable");
    useMintBurnFlowsMock.mockReturnValue(makeQueryResult({ error, isError: true }));
    const histories = ["usdc-circle", "usdt-tether"].map(() => makeQueryResult({
      data: { data: { hourly: [{ hourTs: 1_700_000_000, netFlowUsd: 100, valuation: "complete" }] } },
    }));
    useQueriesMock.mockImplementation(({ queries }: { queries: unknown[] }) =>
      queries[0] === "flow" ? histories : []);
    mintBurnFlowsCoinQueryOptionsMock.mockReturnValue("flow");
    const { result } = renderHook(() => useCompareDataModel({
      selectedIds: ["usdc-circle", "usdt-tether"], flowHours: 24, radarCohort: "peg", range: "all",
    }));
    expect(result.current.flowSeries).toHaveLength(2);
    expect(result.current.globalError).toBe(error);
    expect(result.current.flowCoverageCount).toBeNull();
    expect(result.current.freshnessQueries.find((query) => query.preset === "mintBurnFlows"))
      .toMatchObject({ error, hasData: false, dataUpdatedAt: 0 });
  });

  it("discloses a failed aggregate refresh with retained flow data and its producer metadata", () => {
    const error = new Error("aggregate refresh failed");
    const meta = { updatedAt: 1_700_000_000, status: "fresh" };
    useMintBurnFlowsMock.mockReturnValue(makeQueryResult({
      data: { coins: [] }, dataUpdatedAt: 1_700_000_010_000, meta, error, isError: true,
    }));
    const { result } = renderHook(() => useCompareDataModel({
      selectedIds: ["usdc-circle", "usdt-tether"], flowHours: 24, radarCohort: "peg", range: "all",
    }));
    expect(result.current.globalError).toBe(error);
    expect(result.current.flowCoverageCount).toBeNull();
    expect(result.current.freshnessQueries.find((query) => query.preset === "mintBurnFlows"))
      .toMatchObject({ error, hasData: true, dataUpdatedAt: 1_700_000_010_000, meta });
  });

  it("stamps the flow generation from the producer meta, not the newest bucket start", () => {
    useMintBurnFlowsMock.mockReturnValue(makeQueryResult({
      data: { coins: [], updatedAt: 1_699_990_000 },
      meta: { updatedAt: 1_699_997_000, ageSeconds: 10, status: "fresh" },
    }));
    const { result } = renderHook(() => useCompareDataModel({
      selectedIds: ["usdc-circle", "usdt-tether"], flowHours: 24, radarCohort: "peg", range: "all",
    }));
    expect(result.current.flowUpdatedAt).toBe(1_699_997_000);
  });

  it("reports one failed flow history while preserving another history and retrying both", () => {
    const error = new Error("USDC history failed");
    const histories = [
      makeQueryResult({ error, isError: true }),
      makeQueryResult({ data: { data: { hourly: [{ hourTs: 1_700_000_000, netFlowUsd: 100 }] } } }),
    ];
    useQueriesMock.mockImplementation(({ queries }: { queries: unknown[] }) =>
      queries[0] === "flow" ? histories : []);
    mintBurnFlowsCoinQueryOptionsMock.mockReturnValue("flow");
    const { result } = renderHook(() => useCompareDataModel({
      selectedIds: ["usdc-circle", "usdt-tether"], flowHours: 24, radarCohort: "peg", range: "all",
    }));
    expect(result.current.flowSeries).toHaveLength(1);
    expect(result.current.flowErrorNotice).toMatchObject({ error, hasData: true });
    act(() => result.current.flowErrorNotice?.onRetry());
    for (const history of histories) expect(history.refetch).toHaveBeenCalledTimes(1);
  });

});
