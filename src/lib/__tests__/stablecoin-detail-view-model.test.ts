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
    expect(viewModel.hasFlows).toBe(true);
    expect(viewModel.pegScoreResult?.pegScore).toBe(99);
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
});
