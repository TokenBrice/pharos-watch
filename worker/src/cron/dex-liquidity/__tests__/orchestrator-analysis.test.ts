import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { analyzeDexLiquidityPostScoring } from "../orchestrator-analysis";
import { isDexLiquidityDegraded } from "../orchestrator-metadata";
import type { FullScoreResult, GlobalAgg } from "../types";

const BASE_SCORE_RESULT: FullScoreResult = {
  tvl: 100,
  effectiveTvl: 100,
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
  totalVol7dMeasured: true,
  poolCount: 1,
  chainCount: 1,
  protocolTvl: { curve: 100 },
  chainTvl: { ethereum: 100 },
};

function makeAnalysisInput(overrides: Partial<Parameters<typeof analyzeDexLiquidityPostScoring>[0]> = {}) {
  return {
    db: mockD1(),
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
    dlYieldsAvailable: true,
    dlProtocolsAvailable: true,
    directCexOrderbookDepth: null,
    criticalSourceFailures: [],
    ...overrides,
  };
}

function makeCronMetadata(params: {
  dlProtocolsAvailable: boolean;
  currentGlobalTvl: number;
  failedSources?: string[];
  stagedPoolsMerged?: number;
  stagedPoolsSkipped?: number;
  priceObservationCoins?: number;
  measuredBalanceCoveragePct?: number;
  weakCoverageCoins?: number;
  persistenceSkipped?: boolean;
  currentCoverage?: number;
  qualityDriftCandidates?: Array<{
    flag: string;
    consecutiveRuns: number;
    baselineValue: number;
    observedValue: number;
  }>;
}) {
  return JSON.stringify({
    stagedPoolsMerged: params.stagedPoolsMerged,
    stagedPoolsSkipped: params.stagedPoolsSkipped,
    failedSources: params.failedSources ?? [],
    sourceCoverage: {
      dlYieldsAvailable: true,
      dlProtocolsAvailable: params.dlProtocolsAvailable,
      currentGlobalTvl: params.currentGlobalTvl,
      sourceDegradedFamilies: params.failedSources ?? [],
      currentCoverage: params.currentCoverage ?? 159,
      previousCoverage: 158,
      minExpectedCoverage: 94,
      nearCoverageGuard: false,
      nearValueGuard: false,
      nearMajorCoverageGuard: false,
      priceObservationCoins: params.priceObservationCoins,
      measuredBalanceCoveragePct: params.measuredBalanceCoveragePct,
      weakCoverageCoins: params.weakCoverageCoins,
      qualityDriftCandidates: params.qualityDriftCandidates,
    },
    persistence: params.persistenceSkipped == null ? undefined : { skipped: params.persistenceSkipped },
  });
}

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

    const analysis = await analyzeDexLiquidityPostScoring(makeAnalysisInput({
      db,
    }));

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
          inactiveMetricRowsSkipped: 0,
          inactiveMetricIdsSkipped: [],
          orphanRowsDeleted: 0,
          orphanCleanupFailed: false,
        },
        historicalSnapshot: {
          snapshotRowsWritten: 0,
          skipped: true,
          writeFailed: false,
          historyRowsPruned: 0,
          retentionPruneFailed: false,
        },
      }),
    ).toBe(true);
  });

  it("ignores a source-incomplete persisted value baseline and uses the last source-complete cron baseline", async () => {
    const db = mockD1([
      {
        match: "COUNT(*) as cnt FROM dex_liquidity",
        rows: [],
        first: { cnt: 159 },
      },
      {
        match: "SELECT total_tvl_usd, updated_at FROM dex_liquidity WHERE stablecoin_id = '__global__'",
        rows: [],
        first: { total_tvl_usd: 12_703_104_619, updated_at: 1_776_323_404 },
      },
      {
        match: "GROUP BY coverage_class",
        rows: [],
      },
      {
        match: "ORDER BY total_tvl_usd DESC",
        rows: [{ stablecoin_id: "usdt-tether", total_tvl_usd: 6_000_000_000 }],
      },
      {
        match: "FROM cron_runs",
        rows: [
          {
            started_at: 1_776_323_404,
            status: "degraded",
            metadata: makeCronMetadata({
              dlProtocolsAvailable: false,
              currentGlobalTvl: 12_703_104_619,
              failedSources: ["defillama-protocols"],
            }),
          },
          {
            started_at: 1_776_321_604,
            status: "ok",
            metadata: makeCronMetadata({
              dlProtocolsAvailable: true,
              currentGlobalTvl: 7_025_252_002,
            }),
          },
        ],
      },
      {
        match: "WHERE stablecoin_id IN",
        rows: [],
      },
    ]);

    const analysis = await analyzeDexLiquidityPostScoring(makeAnalysisInput({
      db,
      globalAgg: { ...BASE_GLOBAL_AGG, totalTvl: 7_159_006_645 },
    }));

    expect(analysis.previousGlobalTvl).toBe(7_025_252_002);
    expect(analysis.minExpectedGlobalTvl).toBeCloseTo(4_215_151_201.2);
    expect(analysis.hardValueGuard).toBe(false);
    expect(analysis.sourceCoverage.valueBaselineSource).toBe("cron_metadata_source_complete");
    expect(analysis.sourceCoverage.valueBaselineGlobalTvl).toBe(7_025_252_002);
    expect(analysis.sourceCoverage.ignoredPersistedGlobalTvl).toBe(12_703_104_619);
  });

  it("uses the latest productive run for drift instead of a synthetic failed row", async () => {
    const db = mockD1([
      {
        match: "COUNT(*) as cnt FROM dex_liquidity",
        rows: [],
        first: { cnt: 255 },
      },
      {
        match: "SELECT total_tvl_usd, updated_at FROM dex_liquidity WHERE stablecoin_id = '__global__'",
        rows: [],
        first: { total_tvl_usd: 6_020_380_715, updated_at: 1_784_146_228 },
      },
      {
        match: "GROUP BY coverage_class",
        rows: [],
      },
      {
        match: "ORDER BY total_tvl_usd DESC",
        rows: [],
      },
      {
        match: "FROM cron_runs",
        rows: [
          {
            started_at: 1_784_148_027,
            status: "error",
            metadata: JSON.stringify({
              reason: "stale-slot-reconciled",
              progressStage: "direct-api-fetch",
            }),
          },
          {
            started_at: 1_784_147_427,
            status: "ok",
            metadata: JSON.stringify({}),
          },
          {
            started_at: 1_784_146_827,
            status: "degraded",
            metadata: makeCronMetadata({
              dlProtocolsAvailable: true,
              currentGlobalTvl: 6_020_380_715,
              stagedPoolsMerged: 0,
              stagedPoolsSkipped: 0,
              priceObservationCoins: 0,
              measuredBalanceCoveragePct: 0,
              weakCoverageCoins: 0,
              persistenceSkipped: true,
            }),
          },
          {
            started_at: 1_784_146_227,
            status: "ok",
            metadata: makeCronMetadata({
              dlProtocolsAvailable: true,
              currentGlobalTvl: 6_020_380_715,
              stagedPoolsMerged: 2_614,
              stagedPoolsSkipped: 1_850,
              priceObservationCoins: 0,
              measuredBalanceCoveragePct: 1,
              weakCoverageCoins: 300,
            }),
          },
        ],
      },
      {
        match: "WHERE stablecoin_id IN",
        rows: [],
      },
    ]);

    const analysis = await analyzeDexLiquidityPostScoring(makeAnalysisInput({
      db,
      stagedMergedCount: 2_614,
      stagedSkippedCount: 1_850,
      weakCoverageCoinsBeforeFallback: 301,
      globalAgg: { ...BASE_GLOBAL_AGG, totalTvl: 6_020_380_715 },
    }));

    expect(analysis.sourceCoverage.qualityDriftMetrics.previousWeakCoverageCoins).toBe(300);
    expect(analysis.sourceCoverage.qualityDriftMetrics.weakCoverageDelta).toBe(1);
    expect(analysis.sourceCoverage.qualityDriftFlags).toEqual([]);
    expect(analysis.sourceCoverage.qualityDriftSeverity).toBe("none");
  });

  it("records a first-run coin TVL cliff as a candidate and reports it only on the second run", async () => {
    const collapsedTvl = 13_720_000;
    const makeDb = (candidates?: Array<{ flag: string; consecutiveRuns: number; baselineValue: number; observedValue: number }>) =>
      mockD1([
        {
          match: "COUNT(*) as cnt FROM dex_liquidity",
          rows: [],
          first: { cnt: 1 },
        },
        {
          match: "SELECT total_tvl_usd, updated_at FROM dex_liquidity WHERE stablecoin_id = '__global__'",
          rows: [],
          first: { total_tvl_usd: 6_000_000_000, updated_at: 1_784_000_000 },
        },
        {
          match: "GROUP BY coverage_class",
          rows: [],
        },
        {
          match: "ORDER BY total_tvl_usd DESC",
          rows: [{ stablecoin_id: "usds-sky", total_tvl_usd: 152_000_000 }],
        },
        {
          match: "FROM cron_runs",
          rows: [
            {
              started_at: 1_784_000_000,
              status: "ok",
              metadata: makeCronMetadata({
                dlProtocolsAvailable: true,
                currentGlobalTvl: 6_000_000_000,
                currentCoverage: 1,
                stagedPoolsMerged: 0,
                stagedPoolsSkipped: 0,
                priceObservationCoins: 0,
                measuredBalanceCoveragePct: 0,
                weakCoverageCoins: 0,
                qualityDriftCandidates: candidates,
              }),
            },
          ],
        },
        {
          match: "WHERE stablecoin_id IN",
          rows: [],
        },
      ]);
    const scoreResults = new Map([
      ["usds-sky", { ...BASE_SCORE_RESULT, tvl: collapsedTvl, effectiveTvl: collapsedTvl }],
    ]);

    const first = await analyzeDexLiquidityPostScoring(
      makeAnalysisInput({ db: makeDb(), scoreResults }),
    );

    expect(first.sourceCoverage.qualityDriftFlags).toEqual([]);
    expect(first.sourceCoverage.qualityDriftSeverity).toBe("none");
    expect(first.sourceCoverage.qualityDriftCandidates).toEqual([
      {
        flag: "major-tvl-cliff:usds-sky",
        consecutiveRuns: 1,
        baselineValue: 152_000_000,
        observedValue: collapsedTvl,
      },
    ]);

    const second = await analyzeDexLiquidityPostScoring(
      makeAnalysisInput({
        db: makeDb(first.sourceCoverage.qualityDriftCandidates),
        scoreResults,
      }),
    );

    expect(second.sourceCoverage.qualityDriftFlags).toEqual(["major-tvl-cliff:usds-sky"]);
    expect(second.sourceCoverage.qualityDriftSeverity).toBe("high");
    expect(second.sourceCoverage.qualityDriftCandidates[0]?.consecutiveRuns).toBe(2);
  });

  it("keeps a confirmed cliff after the published baseline row was overwritten", async () => {
    const db = mockD1([
      {
        match: "COUNT(*) as cnt FROM dex_liquidity",
        rows: [],
        first: { cnt: 1 },
      },
      {
        match: "SELECT total_tvl_usd, updated_at FROM dex_liquidity WHERE stablecoin_id = '__global__'",
        rows: [],
        first: { total_tvl_usd: 6_000_000_000, updated_at: 1_784_000_000 },
      },
      {
        match: "GROUP BY coverage_class",
        rows: [],
      },
      {
        // The row the comparison used to read now carries the collapsed value.
        match: "ORDER BY total_tvl_usd DESC",
        rows: [{ stablecoin_id: "usds-sky", total_tvl_usd: 13_700_000 }],
      },
      {
        match: "FROM cron_runs",
        rows: [
          {
            started_at: 1_784_000_000,
            status: "ok",
            metadata: makeCronMetadata({
              dlProtocolsAvailable: true,
              currentGlobalTvl: 6_000_000_000,
              currentCoverage: 1,
              stagedPoolsMerged: 0,
              stagedPoolsSkipped: 0,
              priceObservationCoins: 0,
              measuredBalanceCoveragePct: 0,
              weakCoverageCoins: 0,
              qualityDriftCandidates: [
                {
                  flag: "major-tvl-cliff:usds-sky",
                  consecutiveRuns: 2,
                  baselineValue: 152_000_000,
                  observedValue: 13_720_000,
                },
              ],
            }),
          },
        ],
      },
      {
        match: "WHERE stablecoin_id IN",
        rows: [],
      },
    ]);

    const analysis = await analyzeDexLiquidityPostScoring(
      makeAnalysisInput({
        db,
        scoreResults: new Map([
          ["usds-sky", { ...BASE_SCORE_RESULT, tvl: 13_600_000, effectiveTvl: 13_600_000 }],
        ]),
      }),
    );

    expect(analysis.sourceCoverage.qualityDriftFlags).toEqual(["major-tvl-cliff:usds-sky"]);
    expect(analysis.sourceCoverage.qualityDriftCandidates).toEqual([
      {
        flag: "major-tvl-cliff:usds-sky",
        consecutiveRuns: 3,
        baselineValue: 152_000_000,
        observedValue: 13_600_000,
      },
    ]);
    expect(analysis.sourceCoverage.majorTvlCliffs[0]?.previousTvlUsd).toBe(152_000_000);
  });

  it("keeps hard value guard behavior for source-complete table baselines", async () => {
    const db = mockD1([
      {
        match: "COUNT(*) as cnt FROM dex_liquidity",
        rows: [],
        first: { cnt: 159 },
      },
      {
        match: "SELECT total_tvl_usd, updated_at FROM dex_liquidity WHERE stablecoin_id = '__global__'",
        rows: [],
        first: { total_tvl_usd: 10_000_000_000, updated_at: 1_776_321_604 },
      },
      {
        match: "GROUP BY coverage_class",
        rows: [],
      },
      {
        match: "ORDER BY total_tvl_usd DESC",
        rows: [{ stablecoin_id: "usdt-tether", total_tvl_usd: 6_000_000_000 }],
      },
      {
        match: "FROM cron_runs",
        rows: [
          {
            started_at: 1_776_321_604,
            status: "ok",
            metadata: makeCronMetadata({
              dlProtocolsAvailable: true,
              currentGlobalTvl: 10_000_000_000,
            }),
          },
        ],
      },
      {
        match: "WHERE stablecoin_id IN",
        rows: [],
      },
    ]);

    const analysis = await analyzeDexLiquidityPostScoring(makeAnalysisInput({
      db,
      globalAgg: { ...BASE_GLOBAL_AGG, totalTvl: 5_000_000_000 },
    }));

    expect(analysis.sourceCoverage.valueBaselineSource).toBe("dex_liquidity_global");
    expect(analysis.sourceCoverage.ignoredPersistedGlobalTvl).toBeNull();
    expect(analysis.hardValueGuard).toBe(true);
  });

  it("measures the coverage guard against the trailing median, not the row it just overwrote", async () => {
    const db = mockD1([
      {
        match: "COUNT(*) as cnt FROM dex_liquidity",
        rows: [],
        first: { cnt: 288 },
      },
      {
        match: "SELECT total_tvl_usd, updated_at FROM dex_liquidity WHERE stablecoin_id = '__global__'",
        rows: [],
        first: { total_tvl_usd: 6_000_000_000, updated_at: 1_784_000_000 },
      },
      {
        match: "GROUP BY coverage_class",
        rows: [],
      },
      {
        match: "ORDER BY total_tvl_usd DESC",
        rows: [],
      },
      {
        match: "FROM cron_runs",
        // A slow six-run slide: the previous-run comparison stays inside the
        // band at every step, which is how the 2026-09-04 crawl collapse
        // published as `ok`.
        rows: [305, 300, 296, 292, 288, 284].map((currentCoverage, index) => ({
          started_at: 1_784_000_000 - index * 3_600,
          status: "ok",
          metadata: makeCronMetadata({
            dlProtocolsAvailable: true,
            currentGlobalTvl: 6_000_000_000,
            currentCoverage,
          }),
        })),
      },
      {
        match: "WHERE stablecoin_id IN",
        rows: [],
      },
    ]);

    const analysis = await analyzeDexLiquidityPostScoring(
      makeAnalysisInput({
        db,
        scoreResults: new Map(
          Array.from({ length: 232 }, (_, index) => [`coin-${index}`, BASE_SCORE_RESULT]),
        ),
        globalAgg: { ...BASE_GLOBAL_AGG, totalTvl: 6_000_000_000 },
      }),
    );

    // Median of the published row (288) plus the five newest productive runs.
    expect(analysis.currentCoverage).toBe(232);
    expect(analysis.previousCoverage).toBe(294);
    expect(analysis.nearCoverageGuard).toBe(true);
    expect(analysis.hardCoverageGuard).toBe(false);
    // The published row the previous-run comparison read stays inside the band.
    expect(analysis.currentCoverage).toBeGreaterThan(Math.floor(288 * 0.8));
    expect(analysis.sourceCoverage.nearCoverageGuard).toBe(true);
  });

  it("records guard state on a run with a critical source failure", async () => {
    const db = mockD1([
      {
        match: "COUNT(*) as cnt FROM dex_liquidity",
        rows: [],
        first: { cnt: 165 },
      },
      {
        match: "SELECT total_tvl_usd, updated_at FROM dex_liquidity WHERE stablecoin_id = '__global__'",
        rows: [],
        first: { total_tvl_usd: 6_000_000_000, updated_at: 1_777_556_412 },
      },
      {
        match: "GROUP BY coverage_class",
        rows: [],
      },
      {
        match: "ORDER BY total_tvl_usd DESC",
        rows: [],
      },
      {
        match: "FROM cron_runs",
        rows: [],
      },
      {
        match: "WHERE stablecoin_id IN",
        rows: [],
      },
    ]);

    const analysis = await analyzeDexLiquidityPostScoring(makeAnalysisInput({
      db,
      dlYieldsAvailable: false,
      criticalSourceFailures: ["defillama-yields"],
      globalAgg: { ...BASE_GLOBAL_AGG, totalTvl: 2_000_000_000 },
    }));

    // The critical failure keeps the run degraded and suppresses the hard
    // abort; it must not blank the guard evaluation that records what happened.
    expect(analysis.sourceCoverage.nearCoverageGuard).toBe(true);
    expect(analysis.sourceCoverage.hardCoverageGuard).toBe(true);
    expect(analysis.sourceCoverage.nearValueGuard).toBe(true);
    expect(analysis.sourceCoverage.valueBaselineSource).toBe("dex_liquidity_global");
    expect(analysis.sourceCoverage.sourceDegradedFamilies).toEqual(["defillama-yields"]);
  });

  it("discounts low-effective previous top rows before hard-failing major coverage recovery", async () => {
    const db = mockD1([
      {
        match: "COUNT(*) as cnt FROM dex_liquidity",
        rows: [],
        first: { cnt: 274 },
      },
      {
        match: "SELECT total_tvl_usd, updated_at FROM dex_liquidity WHERE stablecoin_id = '__global__'",
        rows: [],
        first: { total_tvl_usd: 7_000_000_000, updated_at: 1_781_889_009 },
      },
      {
        match: "GROUP BY coverage_class",
        rows: [],
      },
      {
        match: "ORDER BY total_tvl_usd DESC",
        rows: [
          { stablecoin_id: "xaum-matrixdock", total_tvl_usd: 9_153_768_423, effective_tvl_usd: 156_624 },
          { stablecoin_id: "usdc-circle", total_tvl_usd: 5_519_710_397, effective_tvl_usd: 944_522_429 },
          { stablecoin_id: "dai-makerdao", total_tvl_usd: 3_810_439_079, effective_tvl_usd: 57_710_429 },
          { stablecoin_id: "usdt-tether", total_tvl_usd: 2_631_921_285, effective_tvl_usd: 760_880_605 },
        ],
      },
      {
        match: "FROM cron_runs",
        rows: [
          {
            started_at: 1_781_889_009,
            status: "ok",
            metadata: makeCronMetadata({
              dlProtocolsAvailable: true,
              currentGlobalTvl: 7_000_000_000,
            }),
          },
        ],
      },
      {
        match: "WHERE stablecoin_id IN",
        rows: [],
      },
    ]);

    const analysis = await analyzeDexLiquidityPostScoring(makeAnalysisInput({
      db,
      scoreResults: new Map([
        ["xaum-matrixdock", { ...BASE_SCORE_RESULT, tvl: 400_000, effectiveTvl: 150_000 }],
        ["usdc-circle", { ...BASE_SCORE_RESULT, tvl: 3_900_000_000, effectiveTvl: 900_000_000 }],
        ["dai-makerdao", { ...BASE_SCORE_RESULT, tvl: 60_000_000, effectiveTvl: 55_000_000 }],
        ["usdt-tether", { ...BASE_SCORE_RESULT, tvl: 2_650_000_000, effectiveTvl: 760_000_000 }],
      ]),
      globalAgg: { ...BASE_GLOBAL_AGG, totalTvl: 6_610_400_000 },
    }));

    expect(analysis.previousTop10CoveredTvl).toBe(21_115_839_184);
    expect(analysis.previousTop10GuardTvl).toBe(8_209_498_735);
    expect(analysis.currentTop10GuardTvl).toBe(6_610_400_000);
    expect(analysis.nearMajorCoverageGuard).toBe(true);
    expect(analysis.hardMajorCoverageGuard).toBe(false);
    expect(analysis.sourceCoverage.previousTop10GuardTvl).toBe(8_209_498_735);
  });

  it("falls back to the table baseline when cron metadata is not parseable", async () => {
    const db = mockD1([
      {
        match: "COUNT(*) as cnt FROM dex_liquidity",
        rows: [],
        first: { cnt: 159 },
      },
      {
        match: "SELECT total_tvl_usd, updated_at FROM dex_liquidity WHERE stablecoin_id = '__global__'",
        rows: [],
        first: { total_tvl_usd: 10_000_000_000, updated_at: 1_776_321_604 },
      },
      {
        match: "GROUP BY coverage_class",
        rows: [],
      },
      {
        match: "ORDER BY total_tvl_usd DESC",
        rows: [],
      },
      {
        match: "FROM cron_runs",
        rows: [{ started_at: 1_776_321_604, status: "ok", metadata: "{not-json" }],
      },
      {
        match: "WHERE stablecoin_id IN",
        rows: [],
      },
    ]);

    const analysis = await analyzeDexLiquidityPostScoring(makeAnalysisInput({
      db,
      globalAgg: { ...BASE_GLOBAL_AGG, totalTvl: 5_000_000_000 },
    }));

    expect(analysis.sourceCoverage.valueBaselineSource).toBe("dex_liquidity_global");
    expect(analysis.hardValueGuard).toBe(true);
  });

  it("degrades cron status when rejected primary-pool TVL reaches the materiality threshold", () => {
    const analysis = {
      previousCoverageBaselineAvailable: true,
      nearCoverageGuard: false,
      nearValueGuard: false,
      nearMajorCoverageGuard: false,
    } as Awaited<ReturnType<typeof analyzeDexLiquidityPostScoring>>;
    const base = {
      criticalSourceFailures: [],
      analysis,
      persistence: {
        placeholderCount: 0,
        inactiveMetricRowsSkipped: 0,
        inactiveMetricIdsSkipped: [],
        orphanRowsDeleted: 0,
        orphanCleanupFailed: false,
      },
      historicalSnapshot: {
        snapshotRowsWritten: 0,
        skipped: false,
        writeFailed: false,
        historyRowsPruned: 0,
        retentionPruneFailed: false,
      },
    };

    expect(
      isDexLiquidityDegraded({
        ...base,
        poolRejections: [
          {
            reason: "invalid-pool-identity",
            poolIds: ["0xmaterial"],
            count: 1,
            tvlUsd: 10_000,
          },
        ],
      }),
    ).toBe(true);
    expect(
      isDexLiquidityDegraded({
        ...base,
        poolRejections: [
          {
            reason: "invalid-pool-identity",
            poolIds: ["0xsubthreshold"],
            count: 1,
            tvlUsd: 9_999,
          },
        ],
      }),
    ).toBe(false);
  });
});
