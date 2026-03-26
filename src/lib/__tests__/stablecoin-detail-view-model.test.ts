import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { buildStablecoinDetailViewModel } from "../stablecoin-detail-view-model";

describe("stablecoin detail view-model builder", () => {
  it("builds a ready view model from fetched inputs", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether");
    expect(coin).toBeDefined();

    const viewModel = buildStablecoinDetailViewModel({
      id: "usdt-tether",
      coin: coin!,
      summary: null,
      handleRetryAll: () => {},
      supplyData: [{ date: 1_700_000_000, circulatingUsd: 100, price: null }],
      supplyLoading: false,
      supplyError: null,
      listData: {
        peggedAssets: [
          {
            id: "usdt-tether",
            name: "Tether",
            symbol: "USDT",
            pegType: "peggedUSD",
            price: 1,
            circulating: { peggedUSD: 100 },
            circulatingPrevDay: { peggedUSD: 90 },
            circulatingPrevWeek: { peggedUSD: 80 },
            circulatingPrevMonth: { peggedUSD: 70 },
          },
        ],
        fxFallbackRates: {},
      } as never,
      listLoading: false,
      listError: null,
      isListError: false,
      listUpdatedAt: 1,
      pegSummaryData: {
        summary: {} as never,
        coins: [{ id: "usdt-tether", pegScore: 99 }],
      } as never,
      pegUpdatedAt: 1,
      pegError: null,
      liquidityMap: {
        "usdt-tether": { liquidityScore: 88 },
      } as never,
      liqUpdatedAt: 1,
      liquidityError: null,
      reportCardsData: {
        cards: [{ id: "usdt-tether", overallScore: 90, dimensions: {} }],
        dependencyGraph: { nodes: [], edges: [] },
      } as never,
      rcUpdatedAt: 1,
      reportCardsError: null,
      flowsData: {
        gauge: { score: 0, band: "neutral" },
        coins: [{ stablecoinId: "usdt-tether" }],
        hourly: [],
      } as never,
      isFlowsLoading: false,
      nowMs: 1_700_000_000_000,
    });

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;

    expect(viewModel.id).toBe("usdt-tether");
    expect(viewModel.mcap).toBe(100);
    expect(viewModel.prevDay).toBe(90);
    expect(viewModel.performanceVsUsd1y).toBeNull();
    expect(viewModel.hasFlows).toBe(true);
    expect(viewModel.pegScoreResult?.pegScore).toBe(99);
  });

  it("derives 1Y vs USD performance for eligible non-USD pegs", () => {
    const coin = TRACKED_META_BY_ID.get("zchf-frankencoin");
    expect(coin).toBeDefined();

    const nowSec = 1_720_000_000;
    const anchorSec = nowSec - 365 * 24 * 60 * 60;

    const viewModel = buildStablecoinDetailViewModel({
      id: "zchf-frankencoin",
      coin: coin!,
      summary: null,
      handleRetryAll: () => {},
      supplyData: [
        { date: anchorSec, circulatingUsd: 98, price: 0.98 },
        { date: nowSec - 7 * 24 * 60 * 60, circulatingUsd: 110, price: 1.1 },
      ],
      supplyLoading: false,
      supplyError: null,
      listData: {
        peggedAssets: [
          {
            id: "zchf-frankencoin",
            name: "Frankencoin",
            symbol: "ZCHF",
            pegType: "peggedCHF",
            price: 1.12,
            circulating: { peggedCHF: 100 },
            circulatingPrevDay: { peggedCHF: 99 },
            circulatingPrevWeek: { peggedCHF: 97 },
            circulatingPrevMonth: { peggedCHF: 95 },
          },
        ],
        fxFallbackRates: { peggedCHF: 1.12 },
      } as never,
      listLoading: false,
      listError: null,
      isListError: false,
      listUpdatedAt: 1,
      pegSummaryData: undefined,
      pegUpdatedAt: 0,
      pegError: null,
      liquidityMap: undefined,
      liqUpdatedAt: 0,
      liquidityError: null,
      reportCardsData: undefined,
      rcUpdatedAt: 0,
      reportCardsError: null,
      flowsData: undefined,
      isFlowsLoading: false,
      nowMs: nowSec * 1000,
    });

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;

    expect(viewModel.performanceVsUsd1y).toBeCloseTo(((1.12 / 0.98) - 1) * 100, 6);
  });

  it("does not derive 1Y vs USD performance for NAV tokens", () => {
    const coin = TRACKED_META_BY_ID.get("cetes-etherfuse");
    expect(coin).toBeDefined();

    const nowSec = 1_720_000_000;
    const anchorSec = nowSec - 365 * 24 * 60 * 60;

    const viewModel = buildStablecoinDetailViewModel({
      id: "cetes-etherfuse",
      coin: coin!,
      summary: null,
      handleRetryAll: () => {},
      supplyData: [
        { date: anchorSec, circulatingUsd: 100, price: 0.05 },
        { date: nowSec - 7 * 24 * 60 * 60, circulatingUsd: 120, price: 0.06 },
      ],
      supplyLoading: false,
      supplyError: null,
      listData: {
        peggedAssets: [
          {
            id: "cetes-etherfuse",
            name: "Etherfuse CETES",
            symbol: "CETES",
            pegType: "peggedMXN",
            price: 0.061,
            circulating: { peggedMXN: 100 },
            circulatingPrevDay: { peggedMXN: 99 },
            circulatingPrevWeek: { peggedMXN: 97 },
            circulatingPrevMonth: { peggedMXN: 95 },
          },
        ],
        fxFallbackRates: { peggedMXN: 0.061 },
      } as never,
      listLoading: false,
      listError: null,
      isListError: false,
      listUpdatedAt: 1,
      pegSummaryData: undefined,
      pegUpdatedAt: 0,
      pegError: null,
      liquidityMap: undefined,
      liqUpdatedAt: 0,
      liquidityError: null,
      reportCardsData: undefined,
      rcUpdatedAt: 0,
      reportCardsError: null,
      flowsData: undefined,
      isFlowsLoading: false,
      nowMs: nowSec * 1000,
    });

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;

    expect(viewModel.performanceVsUsd1y).toBeNull();
  });

  it("returns not-found when the stablecoin is absent from the list payload", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether");
    expect(coin).toBeDefined();

    const viewModel = buildStablecoinDetailViewModel({
      id: "usdt-tether",
      coin: coin!,
      summary: null,
      handleRetryAll: () => {},
      supplyData: [],
      supplyLoading: false,
      supplyError: null,
      listData: { peggedAssets: [] } as never,
      listLoading: false,
      listError: null,
      isListError: false,
      listUpdatedAt: 1,
      pegSummaryData: undefined,
      pegUpdatedAt: 0,
      pegError: null,
      liquidityMap: undefined,
      liqUpdatedAt: 0,
      liquidityError: null,
      reportCardsData: undefined,
      rcUpdatedAt: 0,
      reportCardsError: null,
      flowsData: undefined,
      isFlowsLoading: false,
    });

    expect(viewModel.status).toBe("not-found");
  });

  it("preserves reserve fetch errors while still falling back to static reserve metadata", () => {
    const coin = TRACKED_META_BY_ID.get("iusd-infinifi");
    expect(coin).toBeDefined();

    const viewModel = buildStablecoinDetailViewModel({
      id: "iusd-infinifi",
      coin: coin!,
      summary: null,
      handleRetryAll: () => {},
      supplyData: [{ date: 1_700_000_000, circulatingUsd: 100, price: null }],
      supplyLoading: false,
      supplyError: null,
      listData: {
        peggedAssets: [
          {
            id: "iusd-infinifi",
            name: "iUSD",
            symbol: "iUSD",
            pegType: "peggedUSD",
            price: 1,
            circulating: { peggedUSD: 100 },
            circulatingPrevDay: { peggedUSD: 90 },
            circulatingPrevWeek: { peggedUSD: 80 },
            circulatingPrevMonth: { peggedUSD: 70 },
          },
        ],
        fxFallbackRates: {},
      } as never,
      listLoading: false,
      listError: null,
      isListError: false,
      listUpdatedAt: 1,
      pegSummaryData: undefined,
      pegUpdatedAt: 0,
      pegError: null,
      liquidityMap: undefined,
      liqUpdatedAt: 0,
      liquidityError: null,
      reportCardsData: undefined,
      rcUpdatedAt: 0,
      reportCardsError: null,
      flowsData: undefined,
      isFlowsLoading: false,
      liveReserves: null,
      liveReserveError: new Error("reserve api failed"),
      nowMs: 1_700_000_000_000,
    });

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;

    expect(viewModel.reserves?.mode).toBe("curated-fallback");
    expect(viewModel.reserveFetchError).toBeInstanceOf(Error);
  });
});
