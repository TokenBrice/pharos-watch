import { describe, expect, it } from "vitest";
import { adaptRiverProtocolInfo } from "../river-protocol-info";
import { validateAdapterOutput } from "../validate";
import { getReserveAdapter } from "../index";

describe("adaptRiverProtocolInfo", () => {
  it("maps aggregate River TVL telemetry as proof-class collateral context", () => {
    const result = adaptRiverProtocolInfo({
      tvl: 300_000_000,
      circulatingSupply: 150_000_000,
      chainCirculating: [{ chain: "Base", circulating: 100_000_000 }],
      tvlData: [{ chainId: 8453, timestamp: "1776290400", value: 120_000_000 }],
      circulatingData: [{ chainId: 8453, timestamp: "1776290400", value: 30_000_000 }],
    });

    expect(result.slices).toEqual([
      { name: "Aggregate River protocol collateral TVL", pct: 100, risk: "medium" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1776290400,
      totalReserveUsd: 300_000_000,
      supplyUsd: 150_000_000,
      collateralizationRatio: 2,
      chainCirculatingCount: 1,
      tvlPointCount: 1,
      circulatingPointCount: 1,
    });
  });

  it("uses the latest point for snapshot timestamp (not min)", () => {
    const result = adaptRiverProtocolInfo({
      tvl: 300_000_000,
      circulatingSupply: 150_000_000,
      tvlData: [
        { timestamp: 1_775_000_000, value: 1000 },
        { timestamp: 1_776_000_000, value: 2000 },
      ],
      circulatingData: [
        { timestamp: 1_775_500_000, value: 500 },
        { timestamp: 1_776_500_000, value: 1500 },
      ],
    });

    expect(result.metadata?.sourceTimestamp).toBe(1_776_500_000);
    expect(result.metadata?.freshnessMode).toBe("verified");
    expect(result.metadata?.latestSourceTimestamp).toBe(1_776_500_000);
  });

  it("throws when TVL or circulatingSupply is missing (parse-failure path)", () => {
    expect(() => adaptRiverProtocolInfo({ circulatingSupply: 100 })).toThrow(
      "river-protocol-info missing TVL or circulating supply",
    );
    expect(() => adaptRiverProtocolInfo({ tvl: 100 })).toThrow(
      "river-protocol-info missing TVL or circulating supply",
    );
    expect(() => adaptRiverProtocolInfo({ tvl: 0, circulatingSupply: 100 })).toThrow();
  });

  it("falls back to unverified freshness when both time series are empty", () => {
    const result = adaptRiverProtocolInfo({
      tvl: 1000,
      circulatingSupply: 500,
      tvlData: [],
      circulatingData: [],
    });
    expect(result.metadata?.freshnessMode).toBe("unverified");
  });

  it("is rejected by validateAdapterOutput when the latest source timestamp is in the future", () => {
    const futureSec = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
    const result = adaptRiverProtocolInfo({
      tvl: 1000,
      circulatingSupply: 500,
      tvlData: [{ timestamp: futureSec, value: 1000 }],
      circulatingData: [{ timestamp: futureSec, value: 500 }],
    });
    const adapter = getReserveAdapter("river-protocol-info") ?? undefined;
    const report = validateAdapterOutput(result, { adapter });
    expect(report.valid).toBe(false);
  });
});
