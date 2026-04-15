import { describe, expect, it } from "vitest";
import { mockD1 } from "../../../api/__tests__/helpers/mock-d1";
import { analyzeDexLiquidityPostScoring, isDexLiquidityDegraded } from "../orchestrator-metadata";
import type { FullScoreResult, GlobalAgg } from "../types";

const BASE_SCORE_RESULT: FullScoreResult = {
  tvl: 100,
  vol24h: 10,
  score: 80,
  hhi: 0.1,
  durability: 0.8,
  components: {
    tvlDepth: 20,
    volumeActivity: 20,
    poolQuality: 20,
    durability: 20,
    pairDiversity: 20,
  },
  weightedBalanceRatio: 0.98,
  organicFrac: 0.9,
  avgStress: 5,
  lockedLiqPct: 0.2,
  coverageClass: "primary",
  coverageConfidence: 0.9,
  sourceMix: {
    dl: {
      poolCount: 1,
      tvlUsd: 100,
    },
  },
  balanceMeasuredTvlUsd: 100,
  organicMeasuredTvlUsd: 90,
};

const BASE_GLOBAL_AGG: GlobalAgg = {
  totalTvl: 100,
  totalVol24h: 10,
  totalVol7d: 70,
  poolCount: 1,
  chainCount: 1,
  protocolTvl: { curve: 100 },
  chainTvl: { ethereum: 100 },
};

describe("analyzeDexLiquidityPostScoring", () => {
  it("treats previous coverage read failures as degraded unavailable state instead of a fake high baseline", async () => {
    const db = mockD1([
      {
        match: "COUNT(*) as cnt FROM dex_liquidity",
        rows: [],
        first: null,
        throwError: new Error("count read failed"),
      },
    ]);

    const analysis = await analyzeDexLiquidityPostScoring({
      db,
      scoreResults: new Map([["usdt-tether", BASE_SCORE_RESULT]]),
      globalAgg: BASE_GLOBAL_AGG,
      retainedPoolsByStablecoin: new Map(),
      priceObservations: new Map(),
      protocolTvlCaps: new Map(),
      diagnostics: {
        protocolCapReductions: {},
      },
      stagedMergedCount: 0,
      stagedSkippedCount: 0,
      weakCoverageCoinsBeforeFallback: 0,
      coverageRecoveredCoins: 0,
      dsFallbackCoins: 0,
      cgTickerFallbackCoins: 0,
      dlYieldsAvailable: true,
      dlProtocolsAvailable: true,
      directCexOrderbookDepth: null,
      criticalSourceFailures: [],
    });

    expect(analysis.previousCoverage).toBe(0);
    expect(analysis.previousCoverageBaselineAvailable).toBe(false);
    expect(analysis.minExpectedCoverage).toBe(0);
    expect(analysis.nearCoverageGuard).toBe(false);
    expect(analysis.sourceCoverage.previousCoverageBaselineAvailable).toBe(false);
    expect(
      isDexLiquidityDegraded({
        criticalSourceFailures: [],
        analysis,
        persistence: {
          placeholderCount: 0,
          orphanRowsDeleted: 0,
          orphanCleanupFailed: false,
        },
        historicalSnapshot: {
          snapshotRowsWritten: 0,
          skipped: true,
          writeFailed: false,
        },
      }),
    ).toBe(true);
  });
});
