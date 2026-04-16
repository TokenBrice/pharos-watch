import { describe, expect, it } from "vitest";
import { adaptRiverProtocolInfo } from "../river-protocol-info";

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
});
