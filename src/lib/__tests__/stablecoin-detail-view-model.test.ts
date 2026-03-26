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
    expect(viewModel.hasYieldSection).toBe(false);
  });

  it("enables the yield section for non-yield-bearing coins when a live ranking exists", () => {
    const coin = TRACKED_META_BY_ID.get("usdc-circle");
    expect(coin).toBeDefined();
    expect(coin?.flags.yieldBearing).toBe(false);

    const viewModel = buildStablecoinDetailViewModel({
      id: "usdc-circle",
      coin: coin!,
      summary: null,
      handleRetryAll: () => {},
      supplyData: [{ date: 1_700_000_000, circulatingUsd: 100, price: 1 }],
      supplyLoading: false,
      supplyError: null,
      listData: {
        peggedAssets: [
          {
            id: "usdc-circle",
            name: "USD Coin",
            symbol: "USDC",
            pegType: "peggedUSD",
            price: 1,
            circulating: { peggedUSD: 100 },
            circulatingPrevDay: { peggedUSD: 95 },
            circulatingPrevWeek: { peggedUSD: 90 },
            circulatingPrevMonth: { peggedUSD: 85 },
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
      yieldRankingsData: {
        rankings: [
          {
            id: "usdc-circle",
            symbol: "USDC",
            name: "USD Coin",
            currentApy: 4.2,
            apy7d: 4.2,
            apy30d: 4.1,
            apyBase: 4.2,
            apyReward: null,
            yieldSource: "Aave v3",
            yieldType: "lending-opportunity",
            dataSource: "defillama-auto",
            sourceTvlUsd: 1_000_000,
            pharosYieldScore: 50,
            safetyScore: 82,
            safetyGrade: "A-",
            yieldToRisk: 0.2,
            excessYield: 0.5,
            yieldStability: 0.9,
            apyVariance30d: 0.1,
            apyMin30d: 3.9,
            apyMax30d: 4.3,
            warningSignals: [],
            altSources: [],
          },
        ],
      } as never,
      flowsData: undefined,
      isFlowsLoading: false,
    });

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;

    expect(viewModel.yieldRanking?.id).toBe("usdc-circle");
    expect(viewModel.hasYieldSection).toBe(true);
  });

  it("enables the yield section for commodity assets when a live ranking exists", () => {
    const coin = TRACKED_META_BY_ID.get("xaut-tether");
    expect(coin).toBeDefined();
    expect(coin?.flags.yieldBearing).toBe(false);
    expect(coin?.flags.pegCurrency).toBe("GOLD");

    const viewModel = buildStablecoinDetailViewModel({
      id: "xaut-tether",
      coin: coin!,
      summary: null,
      handleRetryAll: () => {},
      supplyData: [{ date: 1_700_000_000, circulatingUsd: 100, price: 3_000 }],
      supplyLoading: false,
      supplyError: null,
      listData: {
        peggedAssets: [
          {
            id: "xaut-tether",
            name: "Tether Gold",
            symbol: "XAUT",
            pegType: "peggedGOLD",
            price: 3_000,
            circulating: { peggedGOLD: 100 },
            circulatingPrevDay: { peggedGOLD: 98 },
            circulatingPrevWeek: { peggedGOLD: 96 },
            circulatingPrevMonth: { peggedGOLD: 92 },
          },
        ],
        fxFallbackRates: { peggedGOLD: 3_000 },
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
      yieldRankingsData: {
        rankings: [
          {
            id: "xaut-tether",
            symbol: "XAUT",
            name: "Tether Gold",
            currentApy: 11,
            apy7d: 11,
            apy30d: 11,
            apyBase: 1,
            apyReward: 10,
            yieldSource: "Yo Protocol",
            yieldType: "lending-opportunity",
            dataSource: "defillama",
            sourceTvlUsd: 3_000_000,
            pharosYieldScore: 48,
            safetyScore: 73,
            safetyGrade: "B",
            yieldToRisk: 0.39,
            excessYield: 7.2,
            yieldStability: 0.98,
            apyVariance30d: 0.2,
            apyMin30d: 10.9,
            apyMax30d: 11.3,
            warningSignals: [],
            altSources: [],
          },
        ],
      } as never,
      flowsData: undefined,
      isFlowsLoading: false,
    });

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;

    expect(viewModel.yieldRanking?.id).toBe("xaut-tether");
    expect(viewModel.hasYieldSection).toBe(true);
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
