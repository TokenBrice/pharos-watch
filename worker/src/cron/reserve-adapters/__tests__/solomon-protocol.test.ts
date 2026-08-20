import { describe, expect, it } from "vitest";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";
import {
  adaptSolomonProtocolData,
  type SolomonProtocolDataResponse,
} from "../solomon-protocol";

const FIXTURE: SolomonProtocolDataResponse = {
  protocolTvl: "1512045.79",
  custodyNotionalUsd: "385331.14",
  vaultNotionalUsd: "98801.87",
  yieldDistributorsNotionalUsd: "701.37",
  reserveFundNotionalUsd: "0",
  positionsNotionalUsd: "561679.99",
  updatedAt: "2026-08-20T00:13:15.844Z",
  dataValidForTimestamp: 1787097600000,
  custody: [
    { name: "Ceffu", asset: "BTC", amount: "5.49", amountUsd: "382753.12" },
    { name: "Ceffu", asset: "SOL", amount: "30.12", amountUsd: "2577.25" },
  ],
  vault: [
    { asset: "USDT", amount: "17520", amountUsd: "17531" },
    { asset: "USDC", amount: "81269.27", amountUsd: "81270.86" },
  ],
  yieldDistributors: [
    { asset: "USDC", amount: "701.37", amountUsd: "701.37" },
  ],
  reserveFund: [],
  positions: [
    {
      exchange: "Binance",
      baseAsset: "BTC",
      marketType: "Inverse",
      notionalUsd: "559199.99",
    },
  ],
};

describe("adaptSolomonProtocolData", () => {
  it("itemizes custody and vault balances and keeps protocolTvl residual explicit", () => {
    const result = adaptSolomonProtocolData(FIXTURE);

    expect(result.slices.map((slice) => slice.name)).toEqual([
      "Unmapped reserve positions (issuer API does not reconcile reserves to supply)",
      "Ceffu-custodied BTC with Binance inverse-perpetual hedge",
      "USDC on-chain vault and yield-distributor balances",
      "USDT on-chain vault balance",
      "Ceffu-custodied SOL with Binance inverse-perpetual hedge",
    ]);

    const unmapped = result.slices.find((slice) => slice.name.startsWith("Unmapped"));
    const btc = result.slices.find((slice) => slice.name.includes("BTC"));
    const usdc = result.slices.find((slice) => slice.name.includes("USDC"));
    expect(unmapped?.risk).toBe("very-high");
    expect(unmapped!.pct).toBeGreaterThan(60);
    expect(btc?.risk).toBe("medium");
    expect(usdc).toMatchObject({
      risk: "low",
      coinId: "usdc-circle",
      depType: "collateral",
      blacklistable: true,
    });

    const pctSum = result.slices.reduce((sum, slice) => sum + slice.pct, 0);
    expect(pctSum).toBeCloseTo(100, 5);

    expect(result.metadata).toMatchObject({
      protocolTvl: 1_512_045.79,
      supplyUsd: 1_512_045.79,
      freshnessMode: "verified",
    });
    // Freshness must reflect the data-validity timestamp, not the newer
    // row-serving `updatedAt`.
    expect(result.metadata?.sourceTimestamp).toBe(1_787_097_600);
    expect(result.warnings).toBeUndefined();
  });

  it("falls back to updatedAt only when no data-validity timestamp exists", () => {
    const result = adaptSolomonProtocolData({ ...FIXTURE, dataValidForTimestamp: undefined });
    expect(result.metadata?.sourceTimestamp).toBe(
      Math.floor(Date.parse("2026-08-20T00:13:15.844Z") / 1000),
    );
  });

  it("publishes the unreconciled residual as canonical unknown exposure that degrades validation", () => {
    const result = adaptSolomonProtocolData(FIXTURE);
    const unknownExposurePct = result.metadata?.unknownExposurePct as number;
    // The fixture's identified components cover ~32% of protocolTvl; the rest
    // is the explicit unmapped residual.
    expect(unknownExposurePct).toBeGreaterThan(60);
    expect(unknownExposurePct).toBeLessThan(75);

    const validation = validateAdapterOutput(result, {
      adapter: getReserveAdapter("solomon-protocol") ?? undefined,
      now: 1_787_097_700,
    });
    expect(
      validation.warnings.some(
        (warning) => warning.code === "material-unknown-exposure" && warning.effect === "degraded",
      ),
    ).toBe(true);
  });

  it("throws when protocolTvl is missing or non-positive", () => {
    expect(() => adaptSolomonProtocolData({ ...FIXTURE, protocolTvl: "0" })).toThrow(
      /protocolTvl must be positive/,
    );
    expect(() => adaptSolomonProtocolData({ ...FIXTURE, protocolTvl: undefined })).toThrow(
      /missing\/invalid protocolTvl/,
    );
  });

  it("throws when identified components exceed protocolTvl", () => {
    expect(() =>
      adaptSolomonProtocolData({
        ...FIXTURE,
        protocolTvl: "100",
      }),
    ).toThrow(/exceed protocolTvl/);
  });
});
