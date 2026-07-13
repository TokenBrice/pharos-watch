import { describe, expect, it } from "vitest";
import { buildDexScoreDetailsJson } from "../persistence";
import type { FullScoreResult } from "../types";

function scoreResult(): FullScoreResult {
  return {
    tvl: 1_000_000,
    effectiveTvl: 900_000,
    vol24h: 100_000,
    score: 42,
    hhi: 1,
    durability: 50,
    components: {
      tvlDepth: 10,
      volumeActivity: 20,
      poolQuality: 30,
      durability: 40,
      pairDiversity: 50,
    },
    weightedBalanceRatio: null,
    organicFrac: null,
    avgStress: null,
    lockedLiqPct: null,
    coverageClass: "primary",
    coverageConfidence: 0.8,
    sourceMix: { cg_tickers: { poolCount: 1, tvlUsd: 1_000_000 } },
    balanceMeasuredTvlUsd: 0,
    organicMeasuredTvlUsd: 0,
  };
}

describe("P4 route observation persistence envelope", () => {
  it("preserves the legacy score-component object when route fields are absent", () => {
    expect(JSON.parse(buildDexScoreDetailsJson(scoreResult()))).toEqual({
      tvlDepth: 10,
      volumeActivity: 20,
      poolQuality: 30,
      durability: 40,
      pairDiversity: 50,
    });
  });

  it("adds observations without replacing legacy score component keys", () => {
    const result = Object.assign(scoreResult(), {
      exitRouteObservations: [
        {
          routeId: "dex:usdc:cg-tickers:coinbase",
          routeFamily: "dex-orderbook" as const,
          scope: { kind: "venue" as const, venue: "coinbase", protocol: "coinbase" },
          requestedNotionalUsd: 1_000_000,
          settlementHorizonSec: 300,
          maxCostBps: 200,
          executableUsd: 500_000,
          completionRatio: 0.5,
          output: { kind: "fiat" as const, currency: "USD" },
          evidenceKind: "direct-orderbook-depth" as const,
          confidence: "medium" as const,
          scoreEligible: false,
          observedAt: 1_720_000_000,
          freshnessSeconds: 0,
          commonModeKeys: ["protocol:coinbase", "fiat:usd"],
          capacityCurve: [
            {
              requestedNotionalUsd: 1_000_000,
              maxCostBps: 200,
              executableUsd: 500_000,
              completionRatio: 0.5,
            },
          ],
        },
      ],
      exitRouteObservationCoverage: {
        status: "populated" as const,
        capabilityMatrixVersion: "p4a.1",
        retainedPoolCount: 1,
        observationCount: 1,
        scoreEligibleObservationCount: 0,
        unsupportedPoolCount: 0,
        evidenceCounts: { "direct-orderbook-depth": 1 },
        unsupportedReasons: {},
      },
    });

    expect(JSON.parse(buildDexScoreDetailsJson(result))).toMatchObject({
      tvlDepth: 10,
      pairDiversity: 50,
      exitRouteObservations: [{ routeId: "dex:usdc:cg-tickers:coinbase" }],
      exitRouteObservationCoverage: {
        status: "populated",
        observationCount: 1,
      },
    });
  });
});
