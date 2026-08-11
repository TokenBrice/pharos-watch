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
    supplyHistoryQueryOptionsMock.mockReturnValue({});
    mintBurnFlowsCoinQueryOptionsMock.mockReturnValue({});
  });

  it("includes aggregate flow refetches in handleRetry", async () => {
    const refetchFlows = vi.fn().mockResolvedValue({ status: "success", error: null });
    useMintBurnFlowsMock.mockReturnValue({
      data: { coins: [] },
      refetch: refetchFlows,
    });

    const { result } = renderHook(() => useCompareDataModel({
      selectedIds: [],
      flowHours: 24,
    }));

    await act(async () => {
      await result.current.handleRetry();
    });

    expect(refetchFlows).toHaveBeenCalledTimes(1);
  });
});
