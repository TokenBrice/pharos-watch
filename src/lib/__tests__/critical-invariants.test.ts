import { describe, expect, it } from "vitest";
import { StressSignalsAllResponseSchema } from "@shared/types/market";
import { MintBurnFlowsResponseSchema } from "@shared/types/mint-burn";
import { YieldRankingsResponseSchema } from "@shared/types/yield";
import { mergeDepegSeconds, worstDeviation } from "@shared/lib/peg-utils";
import type { DepegEvent } from "@shared/types";

function makeDepegEvent(
  overrides: Partial<DepegEvent> & Pick<DepegEvent, "startedAt" | "peakDeviationBps">,
): DepegEvent {
  return {
    id: 1,
    stablecoinId: "usdt-tether",
    symbol: "USDT",
    pegType: "USD",
    direction: overrides.peakDeviationBps < 0 ? "below" : "above",
    startPrice: 1,
    peakPrice: null,
    recoveryPrice: null,
    pegReference: 1,
    source: "live",
    endedAt: null,
    confirmationSources: null,
    pendingReason: null,
    closeReason: null,
    provenance: null,
    ...overrides,
  };
}

describe("critical invariants", () => {
  it("rejects non-finite numbers in yield rankings payloads", () => {
    const base = {
      rankings: [
        {
          id: "usdt-tether",
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
      medianApy: 4.8,
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

    const medianNanBad = YieldRankingsResponseSchema.safeParse({
      ...base,
      medianApy: Number.NaN,
    });
    expect(medianNanBad.success).toBe(false);
  });

  it("rejects non-finite stress and flow numbers", () => {
    const stress = {
      signals: {
        "usdt-tether": {
          score: 42,
          band: "WATCH",
          signals: {
            peg: { value: 10, available: true },
          },
          computedAt: 1700000000,
          methodologyVersion: "4.0",
        },
      },
      updatedAt: 1700000000,
      methodology: {
        version: "4.0",
        versionLabel: "v4.0",
        currentVersion: "4.4",
        currentVersionLabel: "v4.4",
        changelogPath: "/methodology/depeg-changelog/",
        asOf: 1700000000,
        isCurrent: false,
      },
    };
    expect(StressSignalsAllResponseSchema.safeParse(stress).success).toBe(true);
    expect(
      StressSignalsAllResponseSchema.safeParse({
        ...stress,
        signals: {
          ...stress.signals,
          "usdt-tether": { ...stress.signals["usdt-tether"], score: Number.NaN },
        },
      }).success,
    ).toBe(false);

    const flows = {
      gauge: {
        score: 50,
        band: "ELEVATED",
        intensitySemantics: "signed-v2",
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

  it("preserves depeg interval merge and worst signed deviation invariants", () => {
    const events = [
      makeDepegEvent({ startedAt: 100, endedAt: 200, peakDeviationBps: -120 }),
      makeDepegEvent({ id: 2, startedAt: 180, endedAt: 260, peakDeviationBps: 95 }),
      makeDepegEvent({ id: 3, startedAt: 400, endedAt: 450, peakDeviationBps: -310 }),
    ];

    expect(mergeDepegSeconds(events, 0, 500)).toBe(210);
    expect(worstDeviation(events)).toBe(-310);
  });
});
