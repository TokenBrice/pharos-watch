import { describe, expect, it } from "vitest";
import {
  MintBurnFlowsResponseSchema,
  StressSignalsAllResponseSchema,
  YieldRankingsResponseSchema,
} from "../types";

describe("critical invariants", () => {
  it("rejects non-finite numbers in yield rankings payloads", () => {
    const base = {
      rankings: [
        {
          id: "1",
          symbol: "USDC",
          name: "USD Coin",
          currentApy: 5,
          apy7d: 5,
          apy30d: 5,
          apyBase: 5,
          apyReward: null,
          yieldSource: "Aave",
          yieldType: "lending-vault",
          dataSource: "defillama",
          sourceTvlUsd: 1000000,
          pharosYieldScore: 70,
          safetyScore: 80,
          safetyGrade: "A-",
          yieldToRisk: 0.5,
          excessYield: 1,
          yieldStability: 0.9,
          apyVariance30d: 0.2,
          apyMin30d: 4,
          apyMax30d: 6,
          warningSignals: [],
        },
      ],
      riskFreeRate: 4.25,
      scalingFactor: 1,
      updatedAt: 1700000000,
    };

    const ok = YieldRankingsResponseSchema.safeParse(base);
    expect(ok.success).toBe(true);

    const nanBad = YieldRankingsResponseSchema.safeParse({
      ...base,
      rankings: [{ ...base.rankings[0], currentApy: Number.NaN }],
    });
    expect(nanBad.success).toBe(false);

    const infBad = YieldRankingsResponseSchema.safeParse({
      ...base,
      rankings: [{ ...base.rankings[0], apy7d: Number.POSITIVE_INFINITY }],
    });
    expect(infBad.success).toBe(false);
  });

  it("rejects non-finite stress and flow numbers", () => {
    const stress = {
      signals: {
        "1": {
          score: 42,
          band: "WATCH",
          signals: {
            peg: { value: 10, available: true },
          },
          computedAt: 1700000000,
        },
      },
      updatedAt: 1700000000,
    };
    expect(StressSignalsAllResponseSchema.safeParse(stress).success).toBe(true);
    expect(
      StressSignalsAllResponseSchema.safeParse({
        ...stress,
        signals: {
          ...stress.signals,
          "1": { ...stress.signals["1"], score: Number.NaN },
        },
      }).success,
    ).toBe(false);

    const flows = {
      gauge: {
        score: 50,
        band: "ELEVATED",
        flightToQuality: false,
        flightIntensity: 10,
        trackedCoins: 20,
        trackedMcapUsd: 1000000000,
      },
      coins: [],
      hourly: [],
      updatedAt: 1700000000,
    };
    expect(MintBurnFlowsResponseSchema.safeParse(flows).success).toBe(true);
    expect(
      MintBurnFlowsResponseSchema.safeParse({
        ...flows,
        gauge: { ...flows.gauge, trackedMcapUsd: Number.POSITIVE_INFINITY },
      }).success,
    ).toBe(false);
  });
});
