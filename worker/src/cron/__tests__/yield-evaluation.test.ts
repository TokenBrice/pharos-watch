import { describe, expect, it } from "vitest";
import { buildHardcodedUsdBenchmark } from "../yield-sync/benchmarks";
import { buildHistoryKey, evaluateYieldSources } from "../yield-sync/evaluation";
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
      USD: buildHardcodedUsdBenchmark("test"),
      EUR: null,
      CHF: null,
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

function historyRows(sourceKey: string, count: number, startSec: number, apy = 5) {
  return Array.from({ length: count }, (_, index) => ({
    stablecoin_id: "coin-a",
    source_key: sourceKey,
    recorded_at: startSec - (index + 1) * 3600,
    is_best: 1,
    apy,
    source_tvl_usd: 1_000_000,
    data_source: "defillama",
    yield_source: "Fixture source",
    yield_type: "lending-vault" as const,
  }));
}

describe("evaluateYieldSources", () => {
  it("covers source-risk golden rows from evaluation inputs", () => {
    const startSec = 1776729600;
    const goldenRows = [
      {
        label: "reward-heavy",
        yield: resolvedYield({
          sourceKey: "protocol-api:coin-a:reward-heavy",
          dataSource: "protocol-api",
          currentApy: 10,
          apyBase: 1,
          apyReward: 9,
        }),
        historyCount: 9,
        expectedPenalty: 1.4,
      },
      {
        label: "stale-source-age",
        yield: resolvedYield({
          sourceKey: "defillama:coin-a:stale",
          sourceObservedAt: startSec - 7 * 60 * 60,
        }),
        historyCount: 9,
        expectedPenalty: 1.25,
      },
      {
        label: "low-source-depth",
        yield: resolvedYield({
          sourceKey: "defillama:coin-a:thin",
          sourceTvlUsd: 1_000,
        }),
        historyCount: 9,
        expectedPenalty: 1.35,
      },
      {
        label: "source-switch-churn",
        yield: resolvedYield({
          sourceKey: "defillama:coin-a:switch",
        }),
        historyCount: 9,
        input: {
          prevBestSourceKeyByCoin: new Map([["coin-a", "defillama:coin-a:prior"]]),
          sourceSwitchCount30dByCoin: new Map([["coin-a", 2]]),
        },
        expectedPenalty: 1.3,
        expectedSourceSwitchCount30d: 3,
      },
      {
        label: "bootstrap-observation-count",
        yield: resolvedYield({
          sourceKey: "defillama:coin-a:bootstrap",
        }),
        historyCount: 0,
        expectedPenalty: 1.2,
      },
      {
        label: "zero-apy",
        yield: resolvedYield({
          sourceKey: "defillama:coin-a:zero",
          currentApy: 0,
          apyBase: 0,
          apyReward: 0,
        }),
        historyCount: 0,
        expectedPenalty: 1.2,
        expectedPys: 0,
      },
      {
        label: "negative-apy",
        yield: resolvedYield({
          sourceKey: "defillama:coin-a:negative",
          currentApy: -1,
          apyBase: -1,
          apyReward: null,
        }),
        historyCount: 0,
        expectedPenalty: 1.2,
        expectedPys: 0,
      },
      {
        label: "missing-safety",
        yield: resolvedYield({
          sourceKey: "defillama:coin-a:missing-safety",
        }),
        historyCount: 9,
        input: {
          safetyScores: new Map(),
        },
        expectedPenalty: 1,
        expectedUsedDefaultSafety: true,
      },
    ];

    for (const row of goldenRows) {
      const sourceHistory = row.historyCount > 0
        ? new Map([
            [
              buildHistoryKey("coin-a", row.yield.sourceKey),
              historyRows(row.yield.sourceKey, row.historyCount, startSec),
            ],
          ])
        : new Map();
      const result = evaluateYieldSources(baseEvaluationInput({
        startSec,
        sevenDaysAgoSec: startSec - 7 * 86400,
        resolved: [{ id: "coin-a", symbol: "A", yield: row.yield }],
        sourceHistory,
        ...(row.input ?? {}),
      }));
      const source = result.evaluatedSources[0];

      expect(source?.sourceRiskPenalty, row.label).toBeCloseTo(row.expectedPenalty, 6);
      if (row.expectedSourceSwitchCount30d != null) {
        expect(source?.sourceSwitchCount30d, row.label).toBe(row.expectedSourceSwitchCount30d);
      }
      if (row.expectedPys != null) {
        expect(source?.pharosYieldScore, row.label).toBe(row.expectedPys);
      }
      if (row.expectedUsedDefaultSafety != null) {
        expect(source?.usedDefaultSafety, row.label).toBe(row.expectedUsedDefaultSafety);
      }
    }
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

  it("preserves deterministic precedence over lower-tier rows even when the deterministic row has a penalty", () => {
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

    expect(result.bestSourceKeyByCoin.get("coin-a")).toBe("rate-derived:coin-a");
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
});
