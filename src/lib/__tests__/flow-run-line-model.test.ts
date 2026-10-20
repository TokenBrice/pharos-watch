import { describe, expect, it } from "vitest";
import { buildRunLineModel, selectRunLineDrivers } from "@/lib/flow-run-line-model";
import { buildGaugeVerdict } from "@/lib/flow-signal-ui";
import { makeMintBurnCoinValuation, makeMintBurnFlowCoin } from "@/test-utils/mint-burn-fixtures";
import type { MintBurnGauge } from "@shared/types";

const gauge = (overrides: Partial<MintBurnGauge> = {}): MintBurnGauge => ({
  score: -5,
  band: "NEUTRAL",
  intensitySemantics: "signed-v2",
  flightToQuality: false,
  flightIntensity: 0,
  trackedCoins: 4,
  trackedMcapUsd: 200,
  ...overrides,
});

const scored = (stablecoinId: string, symbol: string, pressureShiftScore: number, gaugeWeightUsd: number | null) =>
  makeMintBurnFlowCoin({ stablecoinId, symbol, pressureShiftScore, gaugeWeightUsd });

describe("buildRunLineModel", () => {
  it("draws scored coins as weighted ticks whose pulls sum to the score, and the rest as reasoned stubs", () => {
    const coins = [
      scored("usdc-circle", "USDC", -10, 90),
      scored("usdg-global", "USDG", 80, 10),
      makeMintBurnFlowCoin({ stablecoinId: "usdt-tether", symbol: "USDT", pressureShiftScore: null, has24hActivity: false, mintCount24h: 0, burnCount24h: 0, mintVolume24hUsd: 0, burnVolume24hUsd: 0, netFlow24hUsd: 0, gaugeWeightUsd: 150 }),
      makeMintBurnFlowCoin({
        stablecoinId: "dai-makerdao",
        symbol: "DAI",
        pressureShiftScore: null,
        valuation: makeMintBurnCoinValuation({ completeness: "partial", burnCompleteness: "partial", unpricedBurnEventCount: 2 }),
        gaugeWeightUsd: 20,
      }),
      // Unpriced, but under the 7-day history floor: the producer does not count it as withheld for valuation.
      makeMintBurnFlowCoin({
        stablecoinId: "brsrv-blackrock",
        symbol: "BRSRV",
        pressureShiftScore: null,
        baselineDataDays: 3,
        valuation: makeMintBurnCoinValuation({ completeness: "partial", mintCompleteness: "partial", unpricedMintEventCount: 1 }),
        gaugeWeightUsd: 5,
      }),
      scored("pyusd-paypal", "PYUSD", -30, null),
    ];
    const model = buildRunLineModel(gauge({ score: -1, partialValuationInputs: 1, scoredMcapUsd: 100, partialValuationMcapUsd: 20 }), coins);

    expect(model.weightsPublished).toBe(true);
    expect(model.ticks.map((tick) => tick.symbol)).toEqual(["USDC", "USDG"]);
    expect(model.ticks.reduce((sum, tick) => sum + (tick.pullPoints ?? 0), 0)).toBeCloseTo(-1, 9);
    // Heaviest stub first; a scored coin without a weight is outside the gauge, never weight 0.
    expect(model.stubs.map((stub) => [stub.symbol, stub.reason])).toEqual([
      ["USDT", "no-24h-activity"],
      ["DAI", "valuation-partial"],
      ["BRSRV", "below-scoring-floor"],
      ["PYUSD", "weight-unavailable"],
    ]);
    // Weighted valuation-partial stubs are exactly the producer's withheld count.
    expect(model.stubs.filter((stub) => stub.reason === "valuation-partial" && stub.weightUsd != null)).toHaveLength(1);
    expect(model.maxWeightUsd).toBe(150);
    expect(selectRunLineDrivers(model)).toMatchObject({ down: [{ symbol: "USDC" }], up: [{ symbol: "USDG" }] });
  });

  it("keeps unknown scan activity as an unavailable stub, not a quiet coin", () => {
    const model = buildRunLineModel(gauge({ score: null, band: null }), [
      makeMintBurnFlowCoin({ has24hActivity: null, netFlow24hUsd: null, pressureShiftScore: null }),
    ]);
    expect(model.ticks).toEqual([]);
    expect(model.stubs).toMatchObject([{ symbol: "USDC", reason: "activity-unknown" }]);
    expect(model.band).toBeNull();
  });

  it("names incomplete scanning even when activity is observed and never invents pulls on an unavailable composite", () => {
    const incomplete = { complete: false, unavailableReason: "scan-coverage-incomplete" } as const;
    const model = buildRunLineModel(gauge({ score: null, band: null }), [
      makeMintBurnFlowCoin({ stablecoinId: "scanned", pressureShiftScore: 20, gaugeWeightUsd: 100 }),
      makeMintBurnFlowCoin({ stablecoinId: "unknown", has24hActivity: true, netFlow24hUsd: null,
        pressureShiftScore: null, gaugeWeightUsd: 100,
        coverage: { startBlock: 1, lastSyncedBlock: 2, lagBlocks: 0, historyStartAt: null,
          has24hWindow: false, has30dWindow: false, has90dWindow: false, status: "unknown", isPartial: true,
          windows: { window24h: incomplete, window7d: incomplete, window30d: incomplete, window90d: incomplete } } }),
    ]);
    expect(model.stubs).toMatchObject([{ id: "unknown", reason: "scan-coverage-incomplete" }]);
    expect(model.ticks[0]?.pullPoints).toBeNull();
    expect(selectRunLineDrivers(model)).toEqual({ down: [], up: [] });
  });

  it("does not encode height or pull when the payload predates per-coin weights", () => {
    const legacy = makeMintBurnFlowCoin({ pressureShiftScore: -20 });
    delete (legacy as { gaugeWeightUsd?: number | null }).gaugeWeightUsd;
    const model = buildRunLineModel(gauge(), [legacy]);

    expect(model.weightsPublished).toBe(false);
    expect(model.ticks[0]).toMatchObject({ weightUsd: null, pullPoints: null });
    expect(model.maxWeightUsd).toBeNull();
    expect(selectRunLineDrivers(model)).toEqual({ down: [], up: [] });
  });

  it("has no band when the gauge is not rated", () => {
    expect(buildRunLineModel(gauge({ score: null, band: null }), []).band).toBeNull();
  });

  it("withholds the band, with its score interval, when withheld weight could cross an edge", () => {
    const model = buildRunLineModel(
      gauge({ score: -6, band: "NEUTRAL", partialValuationInputs: 1, scoredMcapUsd: 50, partialValuationMcapUsd: 50 }),
      [],
    );
    expect(model).toMatchObject({ band: null, bandUnsettled: true, scoreInterval: [-53, 47] });
  });
});

describe("buildGaugeVerdict", () => {
  it("states the band and the weighted drivers in at most 25 words", () => {
    const verdict = buildGaugeVerdict("CRISIS", {
      down: [{ symbol: "USDS" }, { symbol: "USDC" }],
      up: [{ symbol: "USDG" }, { symbol: "M" }],
    });
    expect(verdict).toBe(
      "Weighted pressure is at crisis levels against the 30-day norm. USDS and USDC pull it down most; USDG and M lift it most.",
    );
    expect(verdict.split(/\s+/).length).toBeLessThanOrEqual(25);
  });

  it("never claims a direction without a score", () => {
    expect(buildGaugeVerdict(null, { down: [], up: [] })).not.toMatch(/pressure is|issuance is/i);
    expect(buildGaugeVerdict("NEUTRAL", { down: [], up: [] })).toBe("Weighted pressure is in line with the 30-day norm.");
  });

  it("drops the band sentence when withheld weight leaves the band unsettled", () => {
    expect(buildGaugeVerdict("unsettled", { down: [{ symbol: "USDC" }], up: [] })).toBe("USDC pulls it down most.");
    expect(buildGaugeVerdict("unsettled", { down: [], up: [] })).not.toMatch(/neutral|stress|crisis|in line/i);
  });
});
