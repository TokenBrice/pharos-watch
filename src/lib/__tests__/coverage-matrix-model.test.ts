import { describe, expect, it } from "vitest";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { buildCoverageMatrixModel } from "@/lib/coverage-matrix-model";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";

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
    const coin = CLIENT_TRACKED_META_BY_ID.get("usdc-circle");
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
      reportCards: resource(makeReportCardsV9Response({
        cards: [makeV9Card({ id: "usdc-circle", score: 90 })],
      })),
      activeStablecoins: [coin!],
    });

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({
      id: "usdc-circle",
      marketCapUsd: 1_000,
      statuses: {
        dependency: {
          kind: "resolved-none",
          available: true,
        },
        mintAuthority: {
          kind: "issuer-or-backend-mint",
          available: true,
        },
      },
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

  it("classifies dependency-map roles from live report-card graph edges", () => {
    const usdc = CLIENT_TRACKED_META_BY_ID.get("usdc-circle");
    const dai = CLIENT_TRACKED_META_BY_ID.get("dai-makerdao");
    const usdt = CLIENT_TRACKED_META_BY_ID.get("usdt-tether");
    expect(usdc).toBeDefined();
    expect(dai).toBeDefined();
    expect(usdt).toBeDefined();

    const model = buildCoverageMatrixModel({
      stablecoins: resource({ peggedAssets: [] } as never),
      pegSummary: resource({ summary: {}, coins: [] } as never),
      dexLiquidity: resource({} as never),
      redemptionBackstops: resource({ coins: {} } as never),
      yieldRankings: resource({ rankings: [] } as never),
      mintBurnFlows: resource({ gauge: {}, hourly: [], coins: [] } as never),
      reportCards: resource(makeReportCardsV9Response({
        cards: [
          makeV9Card({ id: "usdc-circle", score: 90 }),
          makeV9Card({
            id: "dai-makerdao",
            score: 80,
            dependencies: {
              serial: [{ upstreamAssetId: "usdc-circle", score: 90, blocked: false }],
              basket: [],
              cycleBlocked: false,
              reasonCodes: [],
            },
          }),
          makeV9Card({
            id: "usdt-tether",
            score: 85,
            dependencies: {
              serial: [],
              basket: [{ upstreamAssetId: "untracked", weight: 0.2, score: null, boundedUnknown: true }],
              cycleBlocked: false,
              reasonCodes: [],
            },
          }),
        ],
      })),
      activeStablecoins: [usdc!, dai!, usdt!],
    });

    const dependencyKindById = new Map(model.rows.map((row) => [row.id, row.statuses.dependency.kind]));
    expect(dependencyKindById.get("usdc-circle")).toBe("upstream");
    expect(dependencyKindById.get("dai-makerdao")).toBe("dependent");
    expect(dependencyKindById.get("usdt-tether")).toBe("unmapped-gap");
  });

  it("passes client mint-authority summaries into coverage rows", () => {
    const coin = CLIENT_TRACKED_META_BY_ID.get("usdc-circle");
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
      pegSummary: resource({ summary: {}, coins: [] } as never),
      dexLiquidity: resource({} as never),
      redemptionBackstops: resource({ coins: {} } as never),
      yieldRankings: resource({ rankings: [] } as never),
      mintBurnFlows: resource({ gauge: {}, hourly: [], coins: [] } as never),
      reportCards: resource(makeReportCardsV9Response({ cards: [] })),
      activeStablecoins: [
        {
          ...coin!,
          mintAuthoritySummary: {
            mintPath: "issuer-direct-mint",
            authorityPosture: "concentrated-admin",
            confidence: "verified",
          },
        },
      ],
    });

    expect(model.rows[0].statuses.mintAuthority).toMatchObject({
      kind: "issuer-or-backend-mint",
      available: true,
    });
  });

  it("selects widest/narrowest/mostConcentrated features consistently with featureSummaries", () => {
    const usdc = CLIENT_TRACKED_META_BY_ID.get("usdc-circle");
    const dai = CLIENT_TRACKED_META_BY_ID.get("dai-makerdao");
    const usdt = CLIENT_TRACKED_META_BY_ID.get("usdt-tether");
    expect(usdc && dai && usdt).toBeTruthy();

    const model = buildCoverageMatrixModel({
      stablecoins: resource({
        peggedAssets: [
          { id: "usdc-circle", name: "USD Coin", symbol: "USDC", circulating: { peggedUSD: 5_000 } },
          { id: "dai-makerdao", name: "Dai", symbol: "DAI", circulating: { peggedUSD: 2_000 } },
          { id: "usdt-tether", name: "Tether", symbol: "USDT", circulating: { peggedUSD: 1_000 } },
        ],
      } as never),
      pegSummary: resource({
        summary: {},
        coins: [
          { id: "usdc-circle", consensusSources: ["CoinGecko", "DefiLlama", "Pyth"], priceConfidence: "high" },
          { id: "dai-makerdao", consensusSources: ["CoinGecko"], priceConfidence: "medium" },
        ],
      } as never),
      dexLiquidity: resource({ "usdc-circle": { coverageClass: "primary" } } as never),
      redemptionBackstops: resource({ coins: {} } as never),
      yieldRankings: resource({ rankings: [{ id: "usdc-circle" }] } as never),
      mintBurnFlows: resource({
        gauge: {},
        hourly: [],
        coins: [{ stablecoinId: "usdc-circle", coverage: { status: "full" } }],
      } as never),
      reportCards: resource(makeReportCardsV9Response({
        cards: [makeV9Card({ id: "usdc-circle", score: 90 })],
      })),
      activeStablecoins: [usdc!, dai!, usdt!],
    });

    const summaries = model.featureSummaries;
    const concentration = (s: (typeof summaries)[number]) => (s.mcapSharePct ?? 0) - s.coveragePct;

    expect(model.widestFeature?.coveragePct).toBe(Math.max(...summaries.map((s) => s.coveragePct)));
    expect(model.narrowestFeature?.coveragePct).toBe(Math.min(...summaries.map((s) => s.coveragePct)));
    expect(concentration(model.mostConcentratedFeature!)).toBe(Math.max(...summaries.map(concentration)));
  });

  it("marks redemption coverage as Data n/a when the redemption feed is unavailable", () => {
    const coin = CLIENT_TRACKED_META_BY_ID.get("usdc-circle");
    expect(coin).toBeDefined();
    const error = new Error("redemption feed unavailable");

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
      pegSummary: resource({ summary: {}, coins: [] } as never),
      dexLiquidity: resource({} as never),
      redemptionBackstops: resource<never>(undefined, { error }),
      yieldRankings: resource({ rankings: [] } as never),
      mintBurnFlows: resource({ gauge: {}, hourly: [], coins: [] } as never),
      reportCards: resource({ cards: [], dependencyGraph: { nodes: [], edges: [] } } as never),
      activeStablecoins: [coin!],
    });

    expect(model.rows[0].statuses.redemption).toMatchObject({
      kind: "data-unavailable",
      label: "Data n/a",
      available: false,
    });
    expect(model.unavailableFeatures).toEqual(["redemption"]);
    expect(model.isInitialDataLoading).toBe(false);
    expect(model.staleQueries.find((query) => query.preset === "redemptionBackstops")).toMatchObject({
      error,
      hasData: false,
    });
  });

  it("keeps impaired redemption rows out of strong coverage", () => {
    const coin = CLIENT_TRACKED_META_BY_ID.get("usdc-circle");
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
      pegSummary: resource({ summary: {}, coins: [] } as never),
      dexLiquidity: resource({} as never),
      redemptionBackstops: resource({
        coins: {
          "usdc-circle": {
            stablecoinId: "usdc-circle",
            resolutionState: "resolved",
            routeStatus: "paused",
            routeStatusReason: "Issuer paused primary redemption while reserves are reconciled.",
            routeFamily: "offchain-issuer",
            modelConfidence: "medium",
            capacitySemantics: "immediate-bounded",
            score: 65,
          },
        },
      } as never),
      yieldRankings: resource({ rankings: [] } as never),
      mintBurnFlows: resource({ gauge: {}, hourly: [], coins: [] } as never),
      reportCards: resource({ cards: [], dependencyGraph: { nodes: [], edges: [] } } as never),
      activeStablecoins: [coin!],
    });

    expect(model.rows[0].statuses.redemption).toMatchObject({
      kind: "impaired",
      label: "Impaired",
      available: false,
      detail: "Issuer paused primary redemption while reserves are reconciled.",
    });
    const redemptionSummary = model.featureSummaries.find((summary) => summary.feature.key === "redemption");
    expect(redemptionSummary).toMatchObject({
      availableCount: 0,
      coveragePct: 0,
    });
    expect(redemptionSummary?.breakdown.find((item) => item.key === "impaired")).toMatchObject({
      label: "impaired",
      count: 1,
    });
  });
});
