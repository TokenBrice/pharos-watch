import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildCoverageMatrixModel } from "@/lib/coverage-matrix-model";

function resource<T>(
  data: T | undefined,
  overrides: Partial<{ dataUpdatedAt: number; error: unknown | null; meta: null }> = {},
) {
  return {
    data,
    dataUpdatedAt: 7,
    error: null,
    meta: null,
    ...overrides,
  };
}

describe("buildCoverageMatrixModel", () => {
  it("builds the pure coverage matrix model from query snapshots", () => {
    const coin = TRACKED_META_BY_ID.get("usdc-circle");
    expect(coin).toBeDefined();

    const model = buildCoverageMatrixModel({
      stablecoins: resource({
        peggedAssets: [
          {
            id: "usdc-circle",
            name: "USD Coin",
            symbol: "USDC",
            circulating: { peggedUSD: 1_000 },
          },
        ],
      } as never),
      pegSummary: resource({
        summary: {},
        coins: [
          {
            id: "usdc-circle",
            consensusSources: ["CoinGecko", "DefiLlama", "Pyth"],
            priceConfidence: "high",
          },
        ],
      } as never),
      dexLiquidity: resource({
        "usdc-circle": { coverageClass: "primary" },
      } as never),
      redemptionBackstops: resource({ coins: {} } as never),
      yieldRankings: resource({ rankings: [{ id: "usdc-circle" }] } as never),
      mintBurnFlows: resource({
        gauge: {},
        hourly: [],
        coins: [{ stablecoinId: "usdc-circle", coverage: { status: "full" } }],
      } as never),
      reportCards: resource({
        cards: [
          {
            id: "usdc-circle",
            overallScore: 90,
            isDefunct: false,
            rawInputs: {
              canBeBlacklisted: true,
              collateralFromLive: true,
            },
          },
        ],
        dependencyGraph: { nodes: [], edges: [] },
      } as never),
      activeStablecoins: [coin!],
    });

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({
      id: "usdc-circle",
      marketCapUsd: 1_000,
    });
    expect(model.sourceDepthProgress).toMatchObject({
      totalCount: 1,
      atTargetCount: 1,
      exactTwoCount: 0,
      belowTargetCount: 0,
    });
    expect(model.pricingSources).toEqual([
      { name: "CoinGecko", count: 1 },
      { name: "DefiLlama", count: 1 },
      { name: "Pyth", count: 1 },
    ]);
    expect(model.unavailableFeatures).toEqual([]);
    expect(model.isInitialDataLoading).toBe(false);
    expect(model.isStablecoinDataUnavailable).toBe(false);
    expect(model.dataUpdatedAt).toBe(7);
    expect(model.staleQueries.every((query) => query.hasData)).toBe(true);
  });
});
