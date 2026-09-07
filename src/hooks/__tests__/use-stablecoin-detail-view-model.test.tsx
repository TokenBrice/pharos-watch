// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { DISABLED_DETAIL_QUERY_CONTROLS } from "./use-stablecoin-detail-view-model.test-support";

const mocks = vi.hoisted(() => ({
  buildStablecoinDetailViewModel: vi.fn(),
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

vi.mock("@/lib/stablecoin-detail-view-model", () => ({
  buildStablecoinDetailViewModel: mocks.buildStablecoinDetailViewModel,
}));

vi.mock("../use-stablecoins", () => ({
  useSupplyHistory: mocks.useSupplyHistory,
}));

vi.mock("../api-hooks", () => ({
  useDexLiquidity: mocks.useDexLiquidity,
  usePegSummary: mocks.usePegSummary,
  useRegisteredApiQuery: mocks.useRegisteredApiQuery,
  useReportCardsV9: mocks.useReportCardsV9,
  useStressSignals: mocks.useStressSignals,
  useYieldRankings: mocks.useYieldRankings,
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
  mocks.useSupplyHistory.mockReturnValue({
    data: [],
    isLoading: false,
    error: null,
    refetch: mocks.refetchSupply,
  });
  mocks.usePegSummary.mockReturnValue({
    data: undefined,
    dataUpdatedAt: 0,
    error: null,
    refetch: mocks.refetchPeg,
    meta: null,
  });
  mocks.useDexLiquidity.mockReturnValue({
    data: undefined,
    dataUpdatedAt: 0,
    error: null,
    refetch: mocks.refetchLiquidity,
    meta: null,
  });
  mocks.useReportCardsV9.mockReturnValue({
    data: undefined,
    dataUpdatedAt: 0,
    error: null,
    refetch: mocks.refetchReportCards,
    meta: null,
  });
  mocks.useRegisteredApiQuery.mockImplementation((descriptor: { queryKey: readonly unknown[] }) => ({
    data: undefined,
    isLoading: false,
    isError: false,
    dataUpdatedAt: 0,
    error: null,
    refetch: descriptor.queryKey[0] === "stablecoin-live-summary"
      ? mocks.refetchList
      : mocks.refetchRedemptionBackstops,
    meta: null,
  }));
  mocks.useYieldRankings.mockReturnValue({
    data: { rankings: [] },
    isLoading: false,
    error: null,
    dataUpdatedAt: 1,
    meta: null,
    refetch: mocks.refetchYieldRankings,
  });
  mocks.useStressSignals.mockReturnValue({
    data: { signals: {} },
    isLoading: false,
    error: null,
    dataUpdatedAt: 1,
    meta: null,
    refetch: mocks.refetchStressSignals,
  });
  mocks.useMintBurnFlows.mockReturnValue({
    data: undefined,
    isLoading: false,
    refetch: mocks.refetchFlows,
  });
  mocks.useBlacklistSummary.mockReturnValue({
    data: undefined,
    isLoading: false,
    refetch: mocks.refetchBlacklist,
  });
  mocks.useStablecoinReserves.mockReturnValue({
    reserveResult: null,
    error: null,
    refetch: mocks.refetchReserves,
    isFetching: false,
  });
  mocks.buildStablecoinDetailViewModel.mockImplementation((params) => ({
    status: "loading",
    handleRetryAll: params.core.handleRetryAll,
  }));
}

describe("useStablecoinDetailViewModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRefetchMocks();
    installQueryMocks();
  });

  it("keeps only price, peg, and supply eager while disabling below-fold queries", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;

    renderHook(() =>
      useStablecoinDetailViewModel({
        id: coin.id,
        coin,
        summary: null,
        supplementalQueryControls: DISABLED_DETAIL_QUERY_CONTROLS,
      }),
    );

    expect(mocks.useSupplyHistory).toHaveBeenCalledWith(coin.id, 90);
    expect(mocks.useRegisteredApiQuery).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["stablecoin-live-summary", coin.id] }),
    );
    expect(mocks.usePegSummary).toHaveBeenCalled();
    expect(mocks.useDexLiquidity).toHaveBeenCalledWith({ enabled: false });
    expect(mocks.useReportCardsV9).toHaveBeenCalledWith({ enabled: false });
    expect(mocks.useRegisteredApiQuery).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["redemption-backstops"] }),
      { enabled: false },
    );
    expect(mocks.useYieldRankings).toHaveBeenCalledWith({ enabled: false });
    expect(mocks.useStressSignals).toHaveBeenCalledWith({ enabled: false });
    expect(mocks.useMintBurnFlows).toHaveBeenCalledWith(24, { enabled: false });
    expect(mocks.useBlacklistSummary).toHaveBeenCalledWith({ enabled: false });
    expect(mocks.useStablecoinReserves).toHaveBeenCalledWith(coin.id, false);
    const { queries } = mocks.buildStablecoinDetailViewModel.mock.calls.at(-1)![0];
    expect(queries.dexLiquidity.enabled).toBe(false);
    expect(queries.reportCards.enabled).toBe(false);
    expect(queries.redemptionBackstops.enabled).toBe(false);
  });

  it("reuses the built view model when inputs have not changed", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const supplementalQueryControls = {
      flows: true,
      blacklist: true,
      reserves: true,
    };
    const { rerender } = renderHook(
      ({ controls }) =>
        useStablecoinDetailViewModel({
          id: coin.id,
          coin,
          summary: null,
          supplementalQueryControls: controls,
        }),
      { initialProps: { controls: supplementalQueryControls } },
    );

    expect(mocks.buildStablecoinDetailViewModel).toHaveBeenCalledTimes(1);

    rerender({ controls: supplementalQueryControls });

    expect(mocks.buildStablecoinDetailViewModel).toHaveBeenCalledTimes(1);
  });

  it("masks cached supplemental data while controls are disabled", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    mocks.useMintBurnFlows.mockReturnValue({
      data: {
        gauge: { score: 0 },
        coins: [{ stablecoinId: coin.id }],
        hourly: [],
      },
      isLoading: true,
      refetch: mocks.refetchFlows,
    });
    mocks.useBlacklistSummary.mockReturnValue({
      data: {
        stats: {
          perCoinTotalEvents: { USDT: 1 },
        },
      },
      isLoading: true,
      refetch: mocks.refetchBlacklist,
    });
    mocks.useStablecoinReserves.mockReturnValue({
      reserveResult: { mode: "live", reserves: [] },
      error: new Error("cached reserve error"),
      refetch: mocks.refetchReserves,
      isFetching: true,
    });

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

  it("enables supplemental queries when controls and capability allow them", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;

    renderHook(() =>
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

    expect(mocks.useMintBurnFlows).toHaveBeenCalledWith(24, { enabled: true });
    expect(mocks.useBlacklistSummary).toHaveBeenCalledWith({ enabled: true });
    expect(mocks.useStablecoinReserves).toHaveBeenCalledWith(coin.id, true);
  });

  it("keeps blacklist disabled for unsupported symbols even when the visibility gate is open", () => {
    const baseCoin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const coin = { ...baseCoin, symbol: "NOPE" };

    renderHook(() =>
      useStablecoinDetailViewModel({
        id: coin.id,
        coin,
        summary: null,
        supplementalQueryControls: {
          blacklist: true,
        },
      }),
    );

    expect(mocks.useBlacklistSummary).toHaveBeenCalledWith({ enabled: false });
  });

  it("retries only failed enabled lanes", async () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    mocks.usePegSummary.mockReturnValue({
      data: undefined,
      dataUpdatedAt: 0,
      error: new Error("peg failed"),
      refetch: mocks.refetchPeg,
      meta: null,
    });
    mocks.useReportCardsV9.mockReturnValue({
      data: undefined,
      dataUpdatedAt: 0,
      error: new Error("report cards failed"),
      refetch: mocks.refetchReportCards,
      meta: null,
    });
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
    mocks.useMintBurnFlows.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("flows failed"),
      refetch: mocks.refetchFlows,
    });
    mocks.useBlacklistSummary.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("blacklist failed"),
      refetch: mocks.refetchBlacklist,
    });
    mocks.useStablecoinReserves.mockReturnValue({
      reserveResult: null,
      error: new Error("reserves failed"),
      refetch: mocks.refetchReserves,
      isFetching: false,
    });
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
});
