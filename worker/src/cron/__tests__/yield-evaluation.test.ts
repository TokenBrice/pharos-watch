import { describe, expect, it } from "vitest";
import { buildHardcodedUsdBenchmark } from "../yield-sync/benchmarks";
import { buildHistoryKey, evaluateYieldSources } from "../yield-sync/evaluation";

describe("evaluateYieldSources", () => {
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
    });

    const [source] = result.evaluatedSources;
    expect(source?.apy30d).toBeCloseTo(5.5, 4);
    expect(source?.apy7d).toBeCloseTo(5.5, 4);
  });
});
