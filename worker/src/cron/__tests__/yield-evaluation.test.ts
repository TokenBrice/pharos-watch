import { describe, expect, it } from "vitest";
import {
  SOURCE_RISK_GOLDEN_ROWS,
  type YieldSourceRiskGoldenCaseId,
} from "@shared/test-utils/yield-source-risk-golden-fixtures";
import {
  buildHardcodedUsdBenchmark,
  withYieldBenchmarkStaticMeta,
  type ParsedYieldBenchmarkMeta,
} from "../yield-sync/benchmarks";
import { buildHistoryKey, evaluateYieldSources, evaluateYieldSourcesCooperative } from "../yield-sync/evaluation";
import type { EvaluateYieldSourcesInput } from "../yield-sync/evaluation";
import { compareCandidates } from "../yield-sync/evaluation-arbitration";
import type { ResolvedYield } from "../yield-sync/types";
import { baseEvaluationInput, resolvedYield } from "./yield-evaluation.test-support";


function gbpBenchmark(observedAt: number, ageSeconds: number, rate = 4.5) {
  return {
    ...withYieldBenchmarkStaticMeta("GBP", {
      rate,
      recordDate: "2026-04-17",
      fetchedAt: observedAt,
      ageSeconds,
      source: "fred-sonia-compounded-index-test",
      isFallback: false,
      fallbackMode: null,
    }),
    lastMarketRate: rate,
    lastMarketRecordDate: "2026-04-17",
    lastMarketFetchedAt: observedAt,
    lastMarketSource: "fred-sonia-compounded-index-test",
  };
}


function benchmarkMeta(key: "USD_EFFR", rate: number) {
  return {
    ...withYieldBenchmarkStaticMeta(key, {
      rate,
      recordDate: "2026-03-26",
      fetchedAt: 1774479600,
      ageSeconds: 0,
      source: `${key.toLowerCase()}-test`,
      isFallback: false,
      fallbackMode: null,
    }),
    lastMarketRate: rate,
    lastMarketRecordDate: "2026-03-26",
    lastMarketFetchedAt: 1774479600,
    lastMarketSource: `${key.toLowerCase()}-test`,
  };
}

function usdBenchmark(overrides: {
  rate?: number;
  ageSeconds?: number | null;
  isFallback?: boolean;
  fallbackMode?: string | null;
} = {}): ParsedYieldBenchmarkMeta {
  const rate = overrides.rate ?? 4.2;
  return {
    ...withYieldBenchmarkStaticMeta("USD", {
      rate,
      recordDate: "2026-04-20",
      fetchedAt: 1776729600,
      ageSeconds: overrides.ageSeconds ?? 0,
      source: "fred-dgs3mo-test",
      isFallback: overrides.isFallback ?? false,
      fallbackMode: overrides.fallbackMode ?? null,
    }),
    lastMarketRate: rate,
    lastMarketRecordDate: "2026-04-20",
    lastMarketFetchedAt: 1776729600,
    lastMarketSource: "fred-dgs3mo-test",
  };
}

function eurBenchmark(rate = 2.17) {
  return {
    ...withYieldBenchmarkStaticMeta("EUR", {
      rate,
      recordDate: "2026-04-17",
      fetchedAt: 1776729600,
      ageSeconds: 0,
      source: "ecb-estr-test",
      isFallback: false,
      fallbackMode: null,
    }),
    lastMarketRate: rate,
    lastMarketRecordDate: "2026-04-17",
    lastMarketFetchedAt: 1776729600,
    lastMarketSource: "ecb-estr-test",
  };
}

function historyRows(sourceKey: string, count: number, startSec: number, apy = 5) {
  return Array.from({ length: count }, (_, index) => ({
    stablecoin_id: "coin-a",
    source_key: sourceKey,
    recorded_at: startSec - (index + 1) * 86400,
    is_best: 1,
    apy,
    source_tvl_usd: 1_000_000,
    data_source: "defillama",
    yield_source: "Fixture source",
    yield_type: "lending-vault" as const,
  }));
}

type SourceRiskEvaluationScenario = {
  yield: Partial<ResolvedYield>;
  /** Additional candidates resolved for the same coin, after the primary source. */
  extraResolved?: Partial<ResolvedYield>[];
  historyCount: number;
  input?: Partial<EvaluateYieldSourcesInput>;
  expectedSourceSwitchCount30d?: number;
  expectedAnomaly?: string;
  expectedPys?: number;
  expectedUsedDefaultSafety?: boolean;
};

const SOURCE_RISK_EVALUATION_SCENARIOS: Record<YieldSourceRiskGoldenCaseId, SourceRiskEvaluationScenario> = {
  "reward-heavy": {
    yield: {
      sourceKey: "protocol-api:coin-a:reward-heavy",
      dataSource: "protocol-api",
      currentApy: 10,
      apyBase: 1,
      apyReward: 9,
    },
    historyCount: 9,
  },
  "stale-source-age": {
    yield: {
      sourceKey: "defillama:coin-a:stale",
      sourceObservedAt: 1776729600 - 7 * 60 * 60,
    },
    historyCount: 9,
  },
  "low-source-depth": {
    yield: {
      sourceKey: "defillama:coin-a:thin",
      sourceTvlUsd: 1_000,
    },
    historyCount: 9,
  },
  "source-switch-churn": {
    yield: {
      sourceKey: "defillama:coin-a:switch",
    },
    // B2: the switch only counts while the previous winner is still a candidate,
    // so the fixture now resolves the prior source instead of relying on its
    // absence to manufacture the increment.
    extraResolved: [{ sourceKey: "defillama:coin-a:prior", currentApy: 3 }],
    historyCount: 9,
    input: {
      prevBestSourceKeyByCoin: new Map([["coin-a", "defillama:coin-a:prior"]]),
      sourceSwitchCount30dByCoin: new Map([["coin-a", 2]]),
    },
    expectedSourceSwitchCount30d: 3,
  },
  "bootstrap-observation-count": {
    yield: {
      sourceKey: "defillama:coin-a:bootstrap",
    },
    historyCount: 0,
  },
  "zero-apy": {
    yield: {
      sourceKey: "defillama:coin-a:zero",
      currentApy: 0,
      apyBase: 0,
      apyReward: 0,
    },
    historyCount: 0,
    expectedPys: 0,
  },
  "negative-apy": {
    yield: {
      sourceKey: "defillama:coin-a:negative",
      currentApy: -1,
      apyBase: -1,
      apyReward: null,
    },
    historyCount: 0,
    expectedPys: 0,
  },
  "missing-safety": {
    yield: {
      sourceKey: "defillama:coin-a:missing-safety",
    },
    historyCount: 9,
    input: {
      safetyScores: new Map(),
    },
    expectedUsedDefaultSafety: true,
  },
};

describe("evaluateYieldSources", () => {
  it("cooperative evaluation matches synchronous evaluation and reports progress", async () => {
    const input = baseEvaluationInput({
      resolved: [
        { id: "coin-a", symbol: "A", yield: resolvedYield({ sourceKey: "new-source", currentApy: 8, apyReward: 7 }) },
        { id: "coin-a", symbol: "A", yield: resolvedYield({ sourceKey: "old-source", currentApy: 3 }) },
        { id: "coin-b", symbol: "B", yield: resolvedYield({ sourceKey: "stale-source", sourceObservedAt: 1 }) },
        { id: "coin-c", symbol: "C", yield: resolvedYield({ sourceKey: "invalid-source", currentApy: NaN }) },
        { id: "coin-d", symbol: "D", yield: resolvedYield({ sourceKey: "valid-source", currentApy: 4 }) },
      ],
      prevBestSourceKeyByCoin: new Map([["coin-a", "previous-source"]]),
      sourceSwitchCount30dByCoin: new Map([["coin-a", 3]]),
      prevTvlBySource: new Map([[buildHistoryKey("coin-a", "new-source"), 5_000_000]]),
    });
    const progress: number[] = [];

    const sync = evaluateYieldSources(input);
    const cooperative = await evaluateYieldSourcesCooperative(input, {
      yieldEveryCoins: 1,
      onProgress: (snapshot) => {
        progress.push(snapshot.coinsDone);
      },
    });

    expect(cooperative).toEqual(sync);
    expect(sync.rowsRejected).toBeGreaterThan(0);
    // B2: "previous-source" is not among coin-a's candidates, so the absence is a
    // fetch gap and no switch is charged.
    expect(sync.sourceSwitches).toBe(0);
    expect(progress[progress.length - 1]).toBe(4);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it("covers source-risk golden rows from evaluation inputs", () => {
    const startSec = 1776729600;
    for (const row of SOURCE_RISK_GOLDEN_ROWS) {
      const scenario = SOURCE_RISK_EVALUATION_SCENARIOS[row.label];
      const source = resolvedYield(scenario.yield);
      const sourceHistory = scenario.historyCount > 0
        ? new Map([
            [
              buildHistoryKey("coin-a", source.sourceKey),
              historyRows(source.sourceKey, scenario.historyCount, startSec),
            ],
          ])
        : new Map();
      const result = evaluateYieldSources(baseEvaluationInput({
        startSec,
        sevenDaysAgoSec: startSec - 7 * 86400,
        resolved: [
          { id: "coin-a", symbol: "A", yield: source },
          ...(scenario.extraResolved ?? []).map((extra) => ({
            id: "coin-a",
            symbol: "A",
            yield: resolvedYield(extra),
          })),
        ],
        sourceHistory,
        ...(scenario.input ?? {}),
      }));
      const evaluated = result.evaluatedSources[0];

      expect(evaluated?.sourceRiskPenalty, row.label).toBeCloseTo(
        row.expectedEvaluationPenalty ?? row.expectedDerivedPenalty,
        6,
      );
      if (scenario.expectedSourceSwitchCount30d != null) {
        expect(evaluated?.sourceSwitchCount30d, row.label).toBe(scenario.expectedSourceSwitchCount30d);
      }
      if (scenario.expectedAnomaly != null) {
        expect(evaluated?.anomalies, row.label).toContain(scenario.expectedAnomaly);
      }
      if (scenario.expectedPys != null) {
        expect(evaluated?.pharosYieldScore, row.label).toBe(scenario.expectedPys);
      }
      if (scenario.expectedUsedDefaultSafety != null) {
        expect(evaluated?.usedDefaultSafety, row.label).toBe(scenario.expectedUsedDefaultSafety);
      }
    }
  });

  it("explains default and explicitly not-rated safety inputs", () => {
    const missing = evaluateYieldSources(baseEvaluationInput({
      resolved: [{ id: "coin-a", symbol: "A", yield: resolvedYield({}) }],
      safetyScores: new Map(),
    })).evaluatedSources[0];
    expect(missing).toMatchObject({
      safetyGrade: "NR",
      usedDefaultSafety: true,
      safetyReason: "report-card-score-missing",
      scoreQualification: "estimated",
      pysNullReason: null,
    });
    expect(missing?.pharosYieldScore).toBeGreaterThan(0);
    expect(missing?.warnings).toContain("safety-unrated");

    const notRated = evaluateYieldSources(baseEvaluationInput({
      resolved: [{ id: "coin-a", symbol: "A", yield: resolvedYield({}) }],
      safetyScores: new Map([["coin-a", { score: 40, grade: "NR" }]]),
    })).evaluatedSources[0];
    expect(notRated).toMatchObject({
      safetyGrade: "NR",
      usedDefaultSafety: false,
      safetyReason: "report-card-grade-not-rated",
      scoreQualification: "estimated",
      pysNullReason: null,
    });
    expect(notRated?.pharosYieldScore).toBeGreaterThan(0);
    expect(notRated?.warnings).toContain("safety-unrated");
  });

  it("keeps rows explicit NR when the identified compact safety snapshot is unavailable", () => {
    const unavailable = evaluateYieldSources(baseEvaluationInput({
      resolved: [{
        id: "coin-a",
        symbol: "A",
        yield: resolvedYield({
          sourceRisk: {
            venueProtocol: "aave-v3",
            underlyingSafetyScore: 80,
            trancheSafetyScore: 72,
            trancheSafetyPenalty: 8,
            opportunityRisk: {
              opportunityClass: "lending",
              underlyingSafetyScore: 80,
              opportunitySafetyScore: 72,
              opportunitySafetyPenalty: 8,
              venueReviewed: true,
              missingCriticalEvidence: [],
            },
          },
        }),
      }],
      safetySnapshotAvailable: false,
      safetyScores: new Map([["coin-a", { score: 80, grade: "B+" }]]),
    })).evaluatedSources[0];

    expect(unavailable).toMatchObject({
      safetyScore: 40,
      safetyGrade: "NR",
      safetyProvenance: "safety-snapshot-unavailable",
      safetyReason: "safety-snapshot-unavailable",
      pharosYieldScore: null,
      pysNullReason: "safety-unrated",
      yieldToRisk: null,
      scoreQualification: "NR",
      scoreQualified: false,
    });
    expect(unavailable?.warnings).toContain("safety-unrated");
    expect(unavailable?.sourceRisk).toMatchObject({
      venueProtocol: "aave-v3",
      underlyingSafetyScore: null,
      trancheSafetyScore: null,
      trancheSafetyPenalty: null,
    });
    expect(unavailable?.sourceRisk?.opportunityRisk).toBeUndefined();
  });

  it("uses risk-adjusted utility for same-tier arbitration when a source-risk penalty is present", () => {
    const result = evaluateYieldSources(baseEvaluationInput({
      resolved: [
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "defillama:coin-a:fragile",
            currentApy: 10,
            sourceRisk: { sourceRiskPenalty: 2.5 },
          }),
        },
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "protocol-api:coin-a:clean",
            currentApy: 8,
            dataSource: "protocol-api",
            sourceRisk: null,
          }),
        },
      ],
    }));

    expect(result.bestSourceKeyByCoin.get("coin-a")).toBe("protocol-api:coin-a:clean");
    const fragile = result.evaluatedSources.find((source) => source.sourceKey === "defillama:coin-a:fragile");
    const clean = result.evaluatedSources.find((source) => source.sourceKey === "protocol-api:coin-a:clean");
    expect(fragile?.sourceRisk).toMatchObject({ sourceRiskPenalty: 2.5 });
    expect(fragile?.sourceRiskPenalty).toBe(2.5);
    expect(clean?.sourceRiskPenalty).toBe(1.2);
    expect(clean?.sourceRiskPenaltyReason).toBe("provided");
    expect(clean?.sourceRiskAdjustedUtility).toBeGreaterThan(fragile?.sourceRiskAdjustedUtility ?? 0);
  });
  it("rejects discovered source that diverges >35% from canonical reference", () => {
    const result = evaluateYieldSources(baseEvaluationInput({
      resolved: [
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "defillama:coin-a:native",
            currentApy: 5,
            dataSource: "defillama",
          }),
        },
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "defillama-auto:coin-a:divergent",
            currentApy: 15,
            dataSource: "defillama-auto",
          }),
        },
      ],
    }));

    const divergent = result.evaluatedSources.find(
      (source) => source.sourceKey === "defillama-auto:coin-a:divergent",
    );
    expect(result.divergenceFlags).toBe(1);
    expect(divergent).toMatchObject({
      rejected: true,
      anomalies: expect.arrayContaining(["diverges-from-canonical"]),
    });
  });
  it("computes excessYield = apy30d - riskFreeRate for each source", () => {
    const result = evaluateYieldSources(baseEvaluationInput({
      resolved: [{
        id: "coin-a",
        symbol: "A",
        yield: resolvedYield({
          currentApy: 6,
        }),
      }],
    }));

    expect(result.evaluatedSources[0]?.excessYield).toBeCloseTo(1.8, 6);
  });

  it("keeps fixed-yield PT rows as alternatives when a holder-yield source exists", () => {
    const result = evaluateYieldSources(baseEvaluationInput({
      resolved: [
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "rate-derived",
            dataSource: "rate-derived",
            currentApy: 4,
            yieldType: "governance-set",
          }),
        },
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "protocol-api:pendle:ethereum:0xpt",
            dataSource: "protocol-api",
            currentApy: 8,
            yieldSource: "Pendle fixed yield: Fixture PT-A",
            yieldType: "fixed-yield",
          }),
        },
      ],
    }));

    expect(result.bestSourceKeyByCoin.get("coin-a")).toBe("rate-derived");
    expect(result.evaluatedSources.find(
      (source) => source.sourceKey === "protocol-api:pendle:ethereum:0xpt",
    )?.yieldType).toBe("fixed-yield");
  });

  it("derives source-risk penalties from measured fields before same-tier arbitration", () => {
    const startSec = 1776729600;
    const result = evaluateYieldSources(baseEvaluationInput({
      startSec,
      resolved: [
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "protocol-api:coin-a:fragile",
            currentApy: 10,
            apyReward: 9,
            sourceTvlUsd: 1_000,
            dataSource: "protocol-api",
            sourceObservedAt: startSec - 7 * 60 * 60,
          }),
        },
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "protocol-api:coin-a:clean",
            currentApy: 8,
            dataSource: "protocol-api",
            sourceTvlUsd: 10_000_000,
          }),
        },
      ],
      stablecoinSupplyById: new Map([["coin-a", 10_000_000]]),
    }));

    expect(result.bestSourceKeyByCoin.get("coin-a")).toBe("protocol-api:coin-a:clean");
    const fragile = result.evaluatedSources.find((source) => source.sourceKey === "protocol-api:coin-a:fragile");
    const clean = result.evaluatedSources.find((source) => source.sourceKey === "protocol-api:coin-a:clean");
    expect(fragile?.sourceRiskPenalty).toBeGreaterThan(clean?.sourceRiskPenalty ?? 0);
    expect(clean?.sourceRiskAdjustedUtility).toBeGreaterThan(fragile?.sourceRiskAdjustedUtility ?? 0);
  });

  it("uses DeFiLlama input metadata age when the source row lacks its own observed timestamp", () => {
    const startSec = 1776729600;
    const result = evaluateYieldSources(baseEvaluationInput({
      startSec,
      dlPoolsMeta: {
        mode: "dex-cache",
        updatedAt: startSec - 8 * 60 * 60,
        ageSeconds: 8 * 60 * 60,
        poolCount: 1,
        fallbackMode: null,
      },
      resolved: [
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "defillama:coin-a:stale",
            sourceObservedAt: undefined,
          }),
        },
      ],
    }));

    const stale = result.evaluatedSources.find((source) => source.sourceKey === "defillama:coin-a:stale");
    expect(stale?.sourceObservedAt).toBe(startSec - 8 * 60 * 60);
    expect(stale?.sourceRiskPenalty).toBeGreaterThan(1);
  });

  it("uses DeFiLlama row-level observed timestamps before input metadata age", () => {
    const startSec = 1776729600;
    const rowObservedAt = startSec - 8 * 60 * 60;
    const result = evaluateYieldSources(baseEvaluationInput({
      startSec,
      dlPoolsMeta: {
        mode: "dex-cache",
        updatedAt: startSec - 60,
        ageSeconds: 60,
        poolCount: 1,
        fallbackMode: null,
      },
      resolved: [
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "defillama:coin-a:row-stale",
            sourceObservedAt: rowObservedAt,
          }),
        },
      ],
    }));

    const stale = result.evaluatedSources.find((source) => source.sourceKey === "defillama:coin-a:row-stale");
    expect(stale?.sourceObservedAt).toBe(rowObservedAt);
    expect(stale?.sourceRiskPenalty).toBeGreaterThan(1);
  });

  it("marks derived rows with materially stale comparison anchors", () => {
    const startSec = 1776729600;
    const result = evaluateYieldSources(baseEvaluationInput({
      startSec,
      resolved: [
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "onchain:coin-a",
            dataSource: "onchain",
            sourceObservedAt: startSec,
            comparisonAnchorObservedAt: startSec - 15 * 86400,
          }),
        },
      ],
    }));

    const source = result.evaluatedSources.find((row) => row.sourceKey === "onchain:coin-a");
    expect(source?.sourceObservedAt).toBe(startSec);
    expect(source?.anomalies).toContain("anchor-stale");
  });

  it("penalizes reward-heavy rows when reward APY exceeds current APY", () => {
    const result = evaluateYieldSources(baseEvaluationInput({
      resolved: [
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "protocol-api:coin-a:reward-heavy",
            currentApy: 8,
            apyBase: -4,
            apyReward: 12,
            dataSource: "protocol-api",
          }),
        },
      ],
    }));

    const source = result.evaluatedSources.find((row) => row.sourceKey === "protocol-api:coin-a:reward-heavy");
    expect(source?.sourceRiskPenalty).toBeGreaterThanOrEqual(1.5);
  });

  it("keeps APY-first ordering for same-tier candidates when source-risk is missing", () => {
    const result = evaluateYieldSources(baseEvaluationInput({
      resolved: [
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "defillama:coin-a:lower",
            currentApy: 7,
          }),
        },
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "protocol-api:coin-a:higher",
            currentApy: 8,
            dataSource: "protocol-api",
          }),
        },
      ],
    }));

    expect(result.bestSourceKeyByCoin.get("coin-a")).toBe("protocol-api:coin-a:higher");
  });

  it("keeps a curated native row ahead of a lower external lending opportunity", () => {
    const result = evaluateYieldSources(baseEvaluationInput({
      resolved: [
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "defillama:coin-a:native",
            currentApy: 4.5,
            dataSource: "defillama",
            yieldType: "lending-vault",
          }),
        },
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "protocol-api:coin-a:opportunity",
            currentApy: 2.2,
            dataSource: "protocol-api",
            yieldType: "lending-opportunity",
          }),
        },
      ],
    }));

    expect(result.bestSourceKeyByCoin.get("coin-a")).toBe("defillama:coin-a:native");
    expect(result.evaluatedSources.find(
      (source) => source.sourceKey === "protocol-api:coin-a:opportunity",
    )).toMatchObject({
      evidenceClass: "discovered-observation",
      confidenceTier: "discovered",
    });
  });

  it("prefers a non-fixed-yield holder row over a fixed-yield market for the same coin", () => {
    const result = evaluateYieldSources(baseEvaluationInput({
      resolved: [
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "protocol-api:pendle:ethereum:0xpool",
            yieldSource: "Pendle fixed yield: A",
            yieldType: "fixed-yield",
            currentApy: 12,
            dataSource: "protocol-api",
          }),
        },
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "protocol-api:coin-a:holder",
            yieldSource: "Holder row",
            yieldType: "lending-vault",
            currentApy: 5,
            dataSource: "protocol-api",
          }),
        },
      ],
    }));

    expect(result.bestSourceKeyByCoin.get("coin-a")).toBe("protocol-api:coin-a:holder");
    expect(result.evaluatedSources.find((source) => source.sourceKey === "protocol-api:pendle:ethereum:0xpool"))
      .toMatchObject({
        yieldType: "fixed-yield",
        currentApy: 12,
      });
  });

  it("derives depth, observation count, and 30d switch count from existing cache and history", () => {
    const startSec = 1776729600;
    const result = evaluateYieldSources(baseEvaluationInput({
      startSec,
      sevenDaysAgoSec: startSec - 7 * 86400,
      resolved: [
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "defillama:coin-a:base",
            sourceTvlUsd: 2_500_000,
          }),
        },
      ],
      stablecoinSupplyById: new Map([["coin-a", 10_000_000]]),
      sourceHistory: new Map([
        [
          buildHistoryKey("coin-a", "defillama:coin-a:base"),
          [
            {
              stablecoin_id: "coin-a",
              source_key: "defillama:coin-a:base",
              recorded_at: startSec - 3600,
              is_best: 1,
              apy: 4.8,
              source_tvl_usd: 2_400_000,
              data_source: "defillama",
              yield_source: "Fixture source",
              yield_type: "lending-vault",
            },
          ],
        ],
      ]),
      sourceSwitchCount30dByCoin: new Map([["coin-a", 2]]),
    }));

    expect(result.evaluatedSources[0]?.sourceDepthRatio).toBe(0.25);
    expect(result.evaluatedSources[0]?.observationCount30d).toBe(2);
    expect(result.evaluatedSources[0]?.sourceSwitchCount30d).toBe(2);
  });

  it("counts distinct UTC history days instead of hourly samples for maturity", () => {
    const startSec = 1776729600;
    const historyRows = Array.from({ length: 8 }, (_, index) => ({
      stablecoin_id: "coin-a",
      source_key: "defillama:coin-a:base",
      recorded_at: startSec - (index + 1) * 3600,
      is_best: 1,
      apy: 4.8,
      source_tvl_usd: 2_400_000,
      data_source: "defillama",
      yield_source: "Fixture source",
      yield_type: "lending-vault",
    }));
    const result = evaluateYieldSources(baseEvaluationInput({
      startSec,
      sevenDaysAgoSec: startSec - 7 * 86400,
      resolved: [
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({ sourceKey: "defillama:coin-a:base" }),
        },
      ],
      sourceHistory: new Map([[buildHistoryKey("coin-a", "defillama:coin-a:base"), historyRows]]),
    }));

    expect(result.evaluatedSources[0]?.observationCount30d).toBeLessThan(7);
    expect(result.evaluatedSources[0]?.sourceRiskPenalty).toBeGreaterThan(1);
  });

  it("keeps a fresh direct observation ahead of a deterministic modeled proxy", () => {
    const result = evaluateYieldSources(baseEvaluationInput({
      resolved: [
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "rate-derived:coin-a",
            currentApy: 5,
            dataSource: "rate-derived",
            sourceRisk: { sourceRiskPenalty: 2.5 },
          }),
        },
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "defillama:coin-a:high",
            currentApy: 20,
          }),
        },
      ],
    }));

    expect(result.bestSourceKeyByCoin.get("coin-a")).toBe("defillama:coin-a:high");
    expect(result.evaluatedSources.find((source) => source.sourceKey === "rate-derived:coin-a")).toMatchObject({
      calculationMode: "benchmark-model",
      evidenceClass: "modeled-proxy",
      scoreQualification: "estimated",
    });
    expect(result.evaluatedSources.find((source) => source.sourceKey === "defillama:coin-a:high")).toMatchObject({
      calculationMode: "market-api",
      evidenceClass: "curated-observation",
    });
  });

  it("rejects an expired deterministic source before arbitration and retains it behind a fresh curated source", () => {
    const startSec = 1776729600;
    const result = evaluateYieldSources(baseEvaluationInput({
      startSec,
      resolved: [
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "rate-derived:coin-a",
            dataSource: "rate-derived",
            currentApy: 12,
            sourceObservedAt: startSec - 49 * 60 * 60,
          }),
        },
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "defillama:coin-a:fresh",
            currentApy: 5,
            sourceObservedAt: startSec - 60,
          }),
        },
      ],
    }));

    expect(result.bestSourceKeyByCoin.get("coin-a")).toBe("defillama:coin-a:fresh");
    expect(result.evaluatedSources.find((source) => source.sourceKey === "rate-derived:coin-a")).toMatchObject({
      rejected: true,
      sourceFreshness: "stale",
      scoreQualified: false,
      pharosYieldScore: null,
      pysNullReason: "source-stale",
      warnings: expect.arrayContaining(["data-stale"]),
    });
  });

  it("publishes stale no-alternative observations only as unscored last-known context", () => {
    const startSec = 1776729600;
    const result = evaluateYieldSources(baseEvaluationInput({
      startSec,
      resolved: [{
        id: "coin-a",
        symbol: "A",
        yield: resolvedYield({
          sourceKey: "rate-derived:coin-a",
          dataSource: "rate-derived",
          sourceObservedAt: startSec - 49 * 60 * 60,
        }),
      }],
    }));

    expect(result.bestSourceKeyByCoin.get("coin-a")).toBe("rate-derived:coin-a");
    expect(result.evaluatedSources[0]).toMatchObject({
      rejected: true,
      scoreQualified: false,
      pharosYieldScore: null,
      pysNullReason: "source-stale",
      warnings: expect.arrayContaining(["data-stale"]),
    });
  });

  it("marks a fresh GBP source unscored when its native benchmark is stale", () => {
    const startSec = 1776729600;
    const staleAgeSeconds = 49 * 60 * 60;
    const input = baseEvaluationInput({
      startSec,
      resolved: [{
        id: "tgbp-tokenised",
        symbol: "TGBP",
        yield: resolvedYield({
          sourceKey: "defillama:tgbp:fresh",
          sourceObservedAt: startSec - 60,
        }),
      }],
      safetyScores: new Map([["tgbp-tokenised", { score: 75, grade: "B" }]]),
    });
    input.riskFreeRates.GBP = gbpBenchmark(startSec - staleAgeSeconds, staleAgeSeconds);

    const [source] = evaluateYieldSources(input).evaluatedSources;
    expect(source).toMatchObject({
      benchmarkKey: "GBP",
      sourceFreshness: "fresh",
      benchmarkFreshness: "stale",
      scoreQualified: false,
      pharosYieldScore: null,
      pysNullReason: "benchmark-stale",
      warnings: expect.arrayContaining(["benchmark-stale"]),
    });
  });

  it("does not carry old scrvUSD trailing-delta history into the current-rate source", () => {
    const startSec = 1775891171;
    const result = evaluateYieldSources(baseEvaluationInput({
      resolved: [
        {
          id: "scrvusd-curve",
          symbol: "scrvUSD",
          yield: {
            currentApy: 4.2747,
            apyBase: 4.2747,
            apyReward: null,
            sourcePool: "5fd328af-4203-471b-bd16-1705c726d926",
            sourceTvlUsd: 30_158_843,
            dataSource: "onchain",
            exchangeRate: null,
            sourceKey: "onchain:scrvusd-curve:scrvusd-current-rate",
            sourceObservedAt: startSec,
            comparisonAnchorObservedAt: null,
            yieldSource: "Curve Savings (scrvUSD)",
            yieldType: "governance-set",
          },
        },
      ],
      startSec,
      safetyScores: new Map([["scrvusd-curve", { score: 86, grade: "A-" }]]),
      riskFreeRates: {
        ...baseEvaluationInput().riskFreeRates,
        USD: buildHardcodedUsdBenchmark("test"),
      },
      legacyHistoryById: new Map([
        [
          "scrvusd-curve",
          [
            {
              stablecoin_id: "scrvusd-curve",
              source_key: "onchain:scrvusd-curve",
              recorded_at: startSec - 2 * 86400,
              is_best: 1,
              apy: 3.06,
              source_tvl_usd: null,
              data_source: "onchain",
              yield_source: "Curve Savings (scrvUSD)",
              yield_type: "governance-set",
              exchange_rate: 1.097,
            },
          ],
        ],
      ]),
      prevBestSourceKeyByCoin: new Map([["scrvusd-curve", "onchain:scrvusd-curve"]]),
      stablecoinSupplyById: new Map([["scrvusd-curve", 100_000_000]]),
    }));

    const [source] = result.evaluatedSources;
    expect(source?.currentApy).toBeCloseTo(4.2747, 4);
    expect(source?.apy30d).toBeCloseTo(4.2747, 4);
    expect(source?.usedLegacyHistory).toBe(false);
  });

  it("excludes deterministic on-chain bootstrap seed rows from rolling APY stats", () => {
    const startSec = 1776729600;
    const sourceKey = "onchain:iusd-infinifi";
    const result = evaluateYieldSources(baseEvaluationInput({
      resolved: [
        {
          id: "iusd-infinifi",
          symbol: "iUSD",
          yield: {
            currentApy: 6,
            apyBase: 6,
            apyReward: null,
            sourcePool: null,
            sourceTvlUsd: null,
            dataSource: "onchain",
            exchangeRate: 1.06,
            sourceKey,
            sourceObservedAt: startSec,
            comparisonAnchorObservedAt: startSec - 7 * 86400,
            yieldSource: "infiniFi savings (siUSD)",
            yieldType: "lending-vault",
          },
        },
      ],
      startSec,
      safetyScores: new Map([["iusd-infinifi", { score: 72, grade: "B" }]]),
      riskFreeRates: {
        ...baseEvaluationInput().riskFreeRates,
        USD: buildHardcodedUsdBenchmark("test"),
      },
      sourceHistory: new Map([
        [
          buildHistoryKey("iusd-infinifi", sourceKey),
          [
            {
              stablecoin_id: "iusd-infinifi",
              source_key: sourceKey,
              recorded_at: startSec - 6 * 86400,
              is_best: 0,
              apy: 0,
              apy_base: null,
              source_tvl_usd: null,
              data_source: "onchain",
              yield_source: "infiniFi savings (siUSD)",
              yield_type: "lending-vault",
              exchange_rate: 1.01,
            },
            {
              stablecoin_id: "iusd-infinifi",
              source_key: sourceKey,
              recorded_at: startSec - 5 * 86400,
              is_best: 0,
              apy: 0,
              apy_base: null,
              source_tvl_usd: null,
              data_source: "onchain",
              yield_source: "infiniFi savings (siUSD)",
              yield_type: "lending-vault",
              exchange_rate: 1.02,
            },
            {
              stablecoin_id: "iusd-infinifi",
              source_key: sourceKey,
              recorded_at: startSec - 1 * 86400,
              is_best: 1,
              apy: 5,
              apy_base: 5,
              source_tvl_usd: null,
              data_source: "onchain",
              yield_source: "infiniFi savings (siUSD)",
              yield_type: "lending-vault",
              exchange_rate: 1.05,
            },
          ],
        ],
      ]),
      stablecoinSupplyById: new Map([["iusd-infinifi", 100_000_000]]),
    }));

    const [source] = result.evaluatedSources;
    expect(source?.apy30d).toBeCloseTo(5.5, 4);
    expect(source?.apy7d).toBeCloseTo(5.5, 4);
  });

  it("excludes protocol-api NAV seed rows from rolling APY stats", () => {
    const startSec = 1776729600;
    const sourceKey = "protocol-api:midas-mmev-nav-oracle";
    const result = evaluateYieldSources(baseEvaluationInput({
      resolved: [
        {
          id: "mmev-midas",
          symbol: "mMEV",
          yield: resolvedYield({
            currentApy: 6,
            apyBase: 6,
            apyReward: null,
            sourcePool: null,
            sourceTvlUsd: null,
            dataSource: "protocol-api",
            exchangeRate: 1.06,
            sourceKey,
            sourceObservedAt: startSec,
            comparisonAnchorObservedAt: startSec - 7 * 86400,
            yieldSource: "Midas mMEV/USD Oracle",
            yieldType: "nav-appreciation",
          }),
        },
      ],
      startSec,
      safetyScores: new Map([["mmev-midas", { score: 74, grade: "B" }]]),
      sourceHistory: new Map([
        [
          buildHistoryKey("mmev-midas", sourceKey),
          [
            {
              stablecoin_id: "mmev-midas",
              source_key: sourceKey,
              recorded_at: startSec - 6 * 86400,
              is_best: 0,
              apy: 0,
              apy_base: null,
              source_tvl_usd: null,
              data_source: "protocol-api",
              yield_source: "Midas mMEV/USD Oracle",
              yield_type: "nav-appreciation",
              exchange_rate: 1.01,
            },
            {
              stablecoin_id: "mmev-midas",
              source_key: sourceKey,
              recorded_at: startSec - 5 * 86400,
              is_best: 0,
              apy: 0,
              apy_base: null,
              source_tvl_usd: null,
              data_source: "protocol-api",
              yield_source: "Midas mMEV/USD Oracle",
              yield_type: "nav-appreciation",
              exchange_rate: 1.02,
            },
            {
              stablecoin_id: "mmev-midas",
              source_key: sourceKey,
              recorded_at: startSec - 1 * 86400,
              is_best: 1,
              apy: 5,
              apy_base: 5,
              source_tvl_usd: null,
              data_source: "protocol-api",
              yield_source: "Midas mMEV/USD Oracle",
              yield_type: "nav-appreciation",
              exchange_rate: 1.05,
            },
          ],
        ],
      ]),
      stablecoinSupplyById: new Map([["mmev-midas", 100_000_000]]),
    }));

    const [source] = result.evaluatedSources;
    // Both seed rows are inside the 7d window, so carrying them would publish
    // apy7d/apy30d of 2.75 — only the anchored observation may count.
    expect(source?.apy30d).toBeCloseTo(5.5, 4);
    expect(source?.apy7d).toBeCloseTo(5.5, 4);
    expect(source?.apyMin30d).toBe(5);
  });

  it("uses a source-level benchmark override for PYS provenance without changing resolved APY", () => {
    const input = baseEvaluationInput({
      resolved: [{
        id: "usdc-circle",
        symbol: "USDC",
        yield: resolvedYield({
          currentApy: 4.2,
          apyBase: 4.2,
          dataSource: "rate-derived",
          sourceKey: "rate-derived",
          yieldSource: "T-bill proxy",
          benchmarkOverrideKey: "USD_EFFR",
        }),
      }],
      safetyScores: new Map([["usdc-circle", { score: 80, grade: "B+" }]]),
      riskFreeRates: {
        ...baseEvaluationInput().riskFreeRates,
        USD_EFFR: benchmarkMeta("USD_EFFR", 3.9),
      },
    });

    const [source] = evaluateYieldSources(input).evaluatedSources;
    expect(source?.currentApy).toBe(4.2);
    expect(source?.benchmarkKey).toBe("USD_EFFR");
    expect(source?.benchmarkRate).toBe(3.9);
    expect(source?.benchmarkSelectionMode).toBe("manual-override");
  });

  it("records a transiently missing previous winner instead of a switch", () => {
    const startSec = 1776729600;
    const result = evaluateYieldSources(baseEvaluationInput({
      startSec,
      resolved: [
        {
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({
            sourceKey: "defillama:coin-a:now",
            sourceObservedAt: startSec,
          }),
        },
      ],
      prevBestSourceKeyByCoin: new Map([["coin-a", "defillama:coin-a:gone"]]),
      sourceSwitchCount30dByCoin: new Map([["coin-a", 4]]),
    }));

    expect(result.sourceSwitches).toBe(0);
    const [source] = result.evaluatedSources;
    expect(source).toMatchObject({
      sourceKey: "defillama:coin-a:now",
      sourceSwitchCount30d: 4,
      anomalies: expect.arrayContaining(["previous-source-transiently-missing"]),
      // The unpublished gap is not charged, so the penalty keeps the true 4-switch term.
      sourceRiskPenalty: 1.5,
    });
  });

  it("keeps the incumbent when the churn penalty has already saturated (B3 ratchet)", () => {
    const startSec = 1776729600;
    for (const prior of [0, 3]) {
      const result = evaluateYieldSources(baseEvaluationInput({
        startSec,
        resolved: [
          {
            id: "coin-a",
            symbol: "A",
            yield: resolvedYield({
              sourceKey: "protocol-api:venue:ethereum:0xa",
              dataSource: "protocol-api",
              currentApy: 5,
              sourceTvlUsd: 1_000_000,
            }),
          },
          {
            id: "coin-a",
            symbol: "A",
            yield: resolvedYield({
              sourceKey: "protocol-api:venue:ethereum:0xb",
              dataSource: "protocol-api",
              currentApy: 5.02,
              sourceTvlUsd: 1_000_000,
            }),
          },
        ],
        prevBestSourceKeyByCoin: new Map([["coin-a", "protocol-api:venue:ethereum:0xa"]]),
        sourceSwitchCount30dByCoin: new Map([["coin-a", prior]]),
      }));

      const label = `prior ${prior}`;
      expect(result.bestSourceKeyByCoin.get("coin-a"), label).toBe("protocol-api:venue:ethereum:0xa");
      const incumbent = result.evaluatedSources.find((source) => source.sourceKey.endsWith("0xa"));
      const challenger = result.evaluatedSources.find((source) => source.sourceKey.endsWith("0xb"));
      expect(incumbent?.sourceSwitchCount30d, label).toBe(prior);
      expect(challenger?.sourceSwitchCount30d, label).toBeNull();
      expect(incumbent?.sourceRiskPenalty, label).toBeCloseTo(1.2 + Math.min(0.3, prior * 0.1), 6);
      // B42: the alternate drops the switch term it publishes no count for, so the
      // published alternate utility is not the arbitration utility.
      expect(challenger?.sourceRiskPenalty, label).toBeCloseTo(1.2, 6);
    }
  });

  it("breaks exact arbitration ties deterministically and antisymmetrically", () => {
    const run = (keys: [string, string]) =>
      evaluateYieldSources(baseEvaluationInput({
        resolved: keys.map((sourceKey) => ({
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({ sourceKey, currentApy: 5, sourceTvlUsd: 1_000_000 }),
        })),
      }));

    const forward = run(["defillama:coin-a:alpha", "defillama:coin-a:beta"]);
    const reversed = run(["defillama:coin-a:beta", "defillama:coin-a:alpha"]);
    expect(forward.bestSourceKeyByCoin.get("coin-a")).toBe("defillama:coin-a:alpha");
    expect(reversed.bestSourceKeyByCoin.get("coin-a")).toBe("defillama:coin-a:alpha");

    const [alpha, beta] = forward.evaluatedSources;
    expect(compareCandidates(alpha!, beta!)).toBe(-compareCandidates(beta!, alpha!));
    expect(compareCandidates(alpha!, beta!)).toBeLessThan(0);
  });

  it("does not re-base non-USD rows on a degraded or stale USD reference", () => {
    const startSec = 1776729600;
    const run = (usd: ParsedYieldBenchmarkMeta) =>
      evaluateYieldSources(baseEvaluationInput({
        startSec,
        resolved: [
          {
            id: "eurc-circle",
            symbol: "EURC",
            yield: resolvedYield({
              sourceKey: "defillama:eurc-circle:main",
              sourceObservedAt: startSec,
            }),
          },
        ],
        riskFreeRates: {
          ...baseEvaluationInput().riskFreeRates,
          USD: usd,
          EUR: eurBenchmark(),
        },
        safetyScores: new Map([["eurc-circle", { score: 80, grade: "B+" }]]),
      })).evaluatedSources[0];

    const healthy = run(usdBenchmark());
    expect(healthy).toMatchObject({
      benchmarkKey: "EUR",
      benchmarkFreshness: "healthy",
      usdBenchmarkRate: 4.2,
    });
    expect(healthy?.scoreQualification).not.toBe("NR");

    const degraded = run(usdBenchmark({ isFallback: true, fallbackMode: "retained" }));
    expect(degraded).toMatchObject({
      benchmarkFreshness: "healthy",
      scoreQualification: "estimated",
      usdBenchmarkRate: null,
      hurdleRebase: 0,
    });
    expect(degraded?.warnings).toContain("reference-benchmark-degraded");
    expect(degraded?.pharosYieldScore).not.toBeNull();
    expect(degraded?.pharosYieldScore ?? 0).toBeLessThan(healthy?.pharosYieldScore ?? 0);

    const stale = run(usdBenchmark({ ageSeconds: 49 * 60 * 60 }));
    expect(stale).toMatchObject({
      scoreQualification: "NR",
      pharosYieldScore: null,
      pysNullReason: "benchmark-stale",
      usdBenchmarkRate: null,
      hurdleRebase: 0,
    });
    expect(stale?.warnings).toContain("reference-benchmark-degraded");
  });
});

describe("opportunity-level risk (yield v8.32)", () => {
  it("scores a reviewed blue-chip lending opportunity at the underlying safety", () => {
    const startSec = 1776729600;
    const [source] = evaluateYieldSources(baseEvaluationInput({
      startSec,
      resolved: [{
        id: "coin-a",
        symbol: "A",
        yield: resolvedYield({
          sourceKey: "defillama:coin-a:aave",
          project: "aave-v3",
          yieldType: "lending-opportunity",
        }),
      }],
      sourceHistory: new Map([
        [buildHistoryKey("coin-a", "defillama:coin-a:aave"), historyRows("defillama:coin-a:aave", 9, startSec)],
      ]),
    })).evaluatedSources;

    // A1: `fallback-usd` selection is a per-row methodology decision (coin-a has
    // no native benchmark feed), not a degraded feed, so the fresh USD benchmark
    // keeps `benchmarkFreshness` healthy and the row is no longer capped at
    // `estimated`: with safety observed and the opportunity evidence complete it
    // now qualifies as `rated`.
    expect(source).toMatchObject({
      benchmarkSelectionMode: "fallback-usd",
      benchmarkFreshness: "healthy",
      safetyScore: 80,
      safetyProvenance: "opportunity-safety",
      scoreQualification: "rated",
      pysNullReason: null,
    });
    expect(source?.pharosYieldScore).toBeGreaterThan(0);
    expect(source?.sourceRisk?.opportunityRisk).toEqual({
      opportunityClass: "lending",
      underlyingSafetyScore: 80,
      opportunitySafetyScore: 80,
      opportunitySafetyPenalty: 0,
      venueReviewed: true,
      missingCriticalEvidence: [],
    });
  });

  it("deducts opportunity safety for a reviewed higher-risk venue without touching the underlying input", () => {
    const [source] = evaluateYieldSources(baseEvaluationInput({
      resolved: [{
        id: "coin-a",
        symbol: "A",
        yield: resolvedYield({
          sourceKey: "defillama:coin-a:clearpool",
          project: "clearpool",
          yieldType: "lending-opportunity",
        }),
      }],
    })).evaluatedSources;

    expect(source?.safetyProvenance).toBe("opportunity-safety");
    expect(source?.safetyScore).toBeLessThan(80);
    expect(source?.sourceRisk?.opportunityRisk).toMatchObject({
      opportunityClass: "lending",
      underlyingSafetyScore: 80,
      venueReviewed: true,
      missingCriticalEvidence: [],
    });
    expect(source?.sourceRisk?.opportunityRisk?.opportunitySafetyScore).toBe(source?.safetyScore);
  });

  it("publishes an estimated PYS when an external opportunity's venue is unreviewed", () => {
    const [source] = evaluateYieldSources(baseEvaluationInput({
      resolved: [{
        id: "coin-a",
        symbol: "A",
        yield: resolvedYield({
          sourceKey: "defillama:coin-a:obscure",
          project: "obscure-unreviewed-venue",
          yieldType: "lending-opportunity",
        }),
      }],
    })).evaluatedSources;

    expect(source).toMatchObject({
      safetyScore: 80,
      safetyProvenance: "cached-publish",
      scoreQualification: "estimated",
      pysNullReason: null,
    });
    expect(source?.pharosYieldScore).toBeGreaterThan(0);
    expect(source?.warnings).toContain("opportunity-evidence-missing");
    expect(source?.sourceRisk?.opportunityRisk).toMatchObject({
      opportunitySafetyScore: null,
      venueReviewed: false,
      missingCriticalEvidence: ["venue-review"],
    });
  });

  it("keeps an estimated PYS when market size is unavailable", () => {
    const [source] = evaluateYieldSources(baseEvaluationInput({
      resolved: [{
        id: "coin-a",
        symbol: "A",
        yield: resolvedYield({
          sourceKey: "defillama:coin-a:aave",
          project: "aave-v3",
          yieldType: "lending-opportunity",
          sourceTvlUsd: null,
        }),
      }],
    })).evaluatedSources;

    expect(source).toMatchObject({
      pysNullReason: null,
      scoreQualification: "estimated",
    });
    expect(source?.pharosYieldScore).toBeGreaterThan(0);
    expect(source?.warnings).toContain("opportunity-evidence-missing");
    expect(source?.sourceRisk?.opportunityRisk?.missingCriticalEvidence).toEqual(["market-size"]);
  });

  it("leaves holder yield untouched by opportunity evidence requirements", () => {
    const [source] = evaluateYieldSources(baseEvaluationInput({
      resolved: [{
        id: "coin-a",
        symbol: "A",
        yield: resolvedYield({
          sourceKey: "defillama:coin-a:holder",
          project: "obscure-unreviewed-venue",
          yieldType: "lending-vault",
        }),
      }],
    })).evaluatedSources;

    expect(source?.pharosYieldScore).toBeGreaterThan(0);
    expect(source?.safetyProvenance).toBe("cached-publish");
    expect(source?.sourceRisk?.opportunityRisk).toBeUndefined();
  });

  it("publishes the opportunity contract for Royco Dawn tranches from the bespoke tranche model", () => {
    const [source] = evaluateYieldSources(baseEvaluationInput({
      resolved: [{
        id: "coin-a",
        symbol: "A",
        yield: resolvedYield({
          sourceKey: "royco-dawn:ethereum:0xmarket:junior",
          dataSource: "protocol-api",
          yieldType: "structured-tranche",
          sourceRisk: {
            trancheSide: "junior",
            venueProtocol: "royco-dawn",
            // Venue review is the weighted score; the tier is derived from it
            // (yield v8.33), so a reviewed venue must publish the weighted value.
            venueRiskTier: "medium",
            venueRiskWeighted: 3,
            marketStatus: "normal",
            marketTvlUsd: 2_000_000,
          },
        }),
      }],
    })).evaluatedSources;

    expect(source?.safetyProvenance).toBe("opportunity-safety");
    expect(source?.safetyScore).toBeLessThan(80);
    expect(source?.sourceRisk?.trancheSafetyScore).toBe(source?.safetyScore);
    expect(source?.sourceRisk?.opportunityRisk).toMatchObject({
      opportunityClass: "structured-tranche",
      underlyingSafetyScore: 80,
      opportunitySafetyScore: source?.safetyScore,
      opportunitySafetyPenalty: source?.sourceRisk?.trancheSafetyPenalty,
      venueReviewed: true,
      missingCriticalEvidence: [],
    });
  });
});
