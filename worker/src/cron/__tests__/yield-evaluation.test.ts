import { describe, expect, it } from "vitest";
import {
  SOURCE_RISK_GOLDEN_ROWS,
  type YieldSourceRiskGoldenCaseId,
} from "@shared/lib/__tests__/yield-source-risk-golden-fixtures";
import { buildHardcodedUsdBenchmark, withYieldBenchmarkStaticMeta } from "../yield-sync/benchmarks";
import { buildHistoryKey, evaluateYieldSources, evaluateYieldSourcesCooperative } from "../yield-sync/evaluation";
import type { EvaluateYieldSourcesInput } from "../yield-sync/evaluation";
import type { ResolvedYield } from "../yield-sync/types";

function baseEvaluationInput(overrides: Partial<EvaluateYieldSourcesInput> = {}): EvaluateYieldSourcesInput {
  const startSec = overrides.startSec ?? 1776729600;
  return {
    resolved: [],
    startSec,
    sevenDaysAgoSec: startSec - 7 * 86400,
    safetyScores: new Map([["coin-a", { score: 80, grade: "B+" }]]),
    riskFreeRates: {
      USD: freshUsdBenchmark(startSec),
      EUR: null,
      CHF: null,
      GBP: null,
      JPY: null,
      MXN: null,
      BRL: null,
      AUD: null,
      CAD: null,
      RUB: null,
      TRY: null,
      SGD: null,
    },
    tier1PrevRates: new Map(),
    sourceHistory: new Map(),
    onChainCompatibilityHistoryById: new Map(),
    legacyDeterministicOnChainHistoryById: new Map(),
    legacyHistoryById: new Map(),
    prevTvlBySource: new Map(),
    legacyPrevTvlById: new Map(),
    prevBestSourceKeyByCoin: new Map(),
    sourceSwitchCount30dByCoin: new Map(),
    stablecoinSupplyById: new Map([["coin-a", 10_000_000]]),
    ...overrides,
  };
}

function freshUsdBenchmark(observedAt: number, rate = 4.2) {
  return {
    ...withYieldBenchmarkStaticMeta("USD", {
      rate,
      recordDate: "2026-04-20",
      fetchedAt: observedAt,
      ageSeconds: 0,
      source: "fred-dgs3mo-test",
      isFallback: false,
      fallbackMode: null,
    }),
    lastMarketRate: rate,
    lastMarketRecordDate: "2026-04-20",
    lastMarketFetchedAt: observedAt,
    lastMarketSource: "fred-dgs3mo-test",
  };
}

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

function resolvedYield(overrides: Partial<ResolvedYield>): ResolvedYield {
  return {
    currentApy: 5,
    apyBase: 5,
    apyReward: null,
    sourcePool: null,
    sourceTvlUsd: 1_000_000,
    dataSource: "defillama",
    exchangeRate: null,
    sourceKey: "defillama:coin-a:base",
    sourceObservedAt: 1776729600,
    comparisonAnchorObservedAt: null,
    yieldSource: "Fixture source",
    yieldType: "lending-vault",
    ...overrides,
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
  historyCount: number;
  input?: Partial<EvaluateYieldSourcesInput>;
  expectedSourceSwitchCount30d?: number;
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
      resolved: [{
        id: "coin-a",
        symbol: "A",
        yield: resolvedYield({
          sourceKey: "defillama:coin-a:base",
        }),
      }],
    });
    const progress: string[] = [];

    const sync = evaluateYieldSources(input);
    const cooperative = await evaluateYieldSourcesCooperative(input, {
      yieldEveryCoins: 1,
      onProgress: (snapshot) => {
        progress.push(snapshot.phase);
      },
    });

    expect(cooperative.evaluatedSources).toHaveLength(sync.evaluatedSources.length);
    expect(cooperative.bestSourceKeyByCoin.get("coin-a")).toBe(sync.bestSourceKeyByCoin.get("coin-a"));
    expect(cooperative.medianApy).toBe(sync.medianApy);
    expect(progress).toEqual(["coin-evaluation", "coin-evaluation", "warning-finalization"]);
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
        resolved: [{ id: "coin-a", symbol: "A", yield: source }],
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
      resolved: [{ id: "coin-a", symbol: "A", yield: resolvedYield({}) }],
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
    const result = evaluateYieldSources({
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
      sevenDaysAgoSec: startSec - 7 * 86400,
      safetyScores: new Map([["scrvusd-curve", { score: 86, grade: "A-" }]]),
      riskFreeRates: {
        USD: buildHardcodedUsdBenchmark("test"),
        EUR: null,
        CHF: null,
        GBP: null,
        JPY: null,
        MXN: null,
        BRL: null,
        AUD: null,
        CAD: null,
        RUB: null,
        TRY: null,
        SGD: null,
      },
      tier1PrevRates: new Map(),
      sourceHistory: new Map(),
      onChainCompatibilityHistoryById: new Map(),
      legacyDeterministicOnChainHistoryById: new Map(),
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
      prevTvlBySource: new Map(),
      legacyPrevTvlById: new Map(),
      prevBestSourceKeyByCoin: new Map([["scrvusd-curve", "onchain:scrvusd-curve"]]),
      sourceSwitchCount30dByCoin: new Map(),
      stablecoinSupplyById: new Map([["scrvusd-curve", 100_000_000]]),
    });

    const [source] = result.evaluatedSources;
    expect(source?.currentApy).toBeCloseTo(4.2747, 4);
    expect(source?.apy30d).toBeCloseTo(4.2747, 4);
    expect(source?.usedLegacyHistory).toBe(false);
  });

  it("excludes deterministic on-chain bootstrap seed rows from rolling APY stats", () => {
    const startSec = 1776729600;
    const sourceKey = "onchain:iusd-infinifi";
    const result = evaluateYieldSources({
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
      sevenDaysAgoSec: startSec - 7 * 86400,
      safetyScores: new Map([["iusd-infinifi", { score: 72, grade: "B" }]]),
      riskFreeRates: {
        USD: buildHardcodedUsdBenchmark("test"),
        EUR: null,
        CHF: null,
        GBP: null,
        JPY: null,
        MXN: null,
        BRL: null,
        AUD: null,
        CAD: null,
        RUB: null,
        TRY: null,
        SGD: null,
      },
      tier1PrevRates: new Map(),
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
      onChainCompatibilityHistoryById: new Map(),
      legacyDeterministicOnChainHistoryById: new Map(),
      legacyHistoryById: new Map(),
      prevTvlBySource: new Map(),
      legacyPrevTvlById: new Map(),
      prevBestSourceKeyByCoin: new Map(),
      sourceSwitchCount30dByCoin: new Map(),
      stablecoinSupplyById: new Map([["iusd-infinifi", 100_000_000]]),
    });

    const [source] = result.evaluatedSources;
    expect(source?.apy30d).toBeCloseTo(5.5, 4);
    expect(source?.apy7d).toBeCloseTo(5.5, 4);
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

    // The fixture coin resolves a fallback-USD benchmark, so qualification is
    // estimated rather than rated; the opportunity contract itself is complete.
    expect(source).toMatchObject({
      safetyScore: 80,
      safetyProvenance: "opportunity-safety",
      scoreQualification: "estimated",
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
            venueRiskTier: "medium",
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
