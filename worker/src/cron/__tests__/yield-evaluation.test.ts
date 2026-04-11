import { describe, expect, it } from "vitest";
import { buildHardcodedUsdBenchmark } from "../yield-sync/benchmarks";
import { evaluateYieldSources } from "../yield-sync/evaluation";

describe("evaluateYieldSources", () => {
  it("does not carry old scrvUSD trailing-delta history into the current-rate source", () => {
    const startSec = 1775891171;
    const result = evaluateYieldSources({
      resolved: [
        {
          id: "crvusd-curve",
          symbol: "crvUSD",
          yield: {
            currentApy: 4.2747,
            apyBase: 4.2747,
            apyReward: null,
            sourcePool: "5fd328af-4203-471b-bd16-1705c726d926",
            sourceTvlUsd: 30_158_843,
            dataSource: "onchain",
            exchangeRate: null,
            sourceKey: "onchain:crvusd-curve:scrvusd-current-rate",
            sourceObservedAt: startSec,
            comparisonAnchorObservedAt: null,
            yieldSource: "Curve Savings (scrvUSD)",
            yieldType: "governance-set",
          },
        },
      ],
      startSec,
      sevenDaysAgoSec: startSec - 7 * 86400,
      safetyScores: new Map([["crvusd-curve", { score: 86, grade: "A-" }]]),
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
          "crvusd-curve",
          [
            {
              stablecoin_id: "crvusd-curve",
              source_key: "onchain:crvusd-curve",
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
      prevBestSourceKeyByCoin: new Map([["crvusd-curve", "onchain:crvusd-curve"]]),
    });

    const [source] = result.evaluatedSources;
    expect(source?.currentApy).toBeCloseTo(4.2747, 4);
    expect(source?.apy30d).toBeCloseTo(4.2747, 4);
    expect(source?.usedLegacyHistory).toBe(false);
  });
});
