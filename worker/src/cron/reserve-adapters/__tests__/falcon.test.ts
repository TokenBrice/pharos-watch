import { describe, expect, it } from "vitest";
import { adaptFalconTransparency, type FalconTransparencyResponse } from "../falcon";

function falconPayload(
  assets: Array<{ label: string; [venue: string]: string | number }>,
  { timestamp = 1773316982, supply = "100", insurance = "5" } = {},
): FalconTransparencyResponse {
  return { snapshot_date: timestamp, usdf: { supply, insurance_fund: insurance, breakdown: { assets } } };
}

describe("adaptFalconTransparency", () => {
  it("groups Falcon asset-level reserves into reserve buckets", () => {
    const payload = falconPayload([
      { label: "USDC", ceffu: "20", fireblocks: "10" },
      { label: "BTC", multisig: "25" },
      { label: "ETH", multisig: "10" },
      { label: "USTB", fireblocks: "15" },
      { label: "AVAX", fireblocks: "15" },
    ]);

    const result = adaptFalconTransparency(payload);

    expect(result.slices).toEqual([
      { name: "USDC cash-equivalent assets", pct: 30, risk: "low", coinId: "usdc-circle", depType: "collateral" },
      { name: "BTC collateral", pct: 25, risk: "medium" },
      { name: "USTB tokenized Treasury assets", pct: 15, risk: "low", coinId: "ustb-superstate" },
      { name: "Other crypto / tokenized assets", pct: 15, risk: "high" },
      { name: "ETH / liquid staking collateral", pct: 10, risk: "medium" },
      { name: "Insurance fund", pct: 5, risk: "medium" },
    ]);
    expect(result.metadata).toMatchObject({
      snapshotDate: 1773316982,
      supply: "100",
      supplyUsd: 100,
      insuranceFund: "5",
      immediateRedeemableUsd: 30,
      immediateRedeemableRatio: 0.3,
      assetCount: 5,
      sourceTimestamp: 1773316982,
      freshnessMode: "verified",
      redemption: {
        routeStatus: "open",
        routeStatusSource: "protocol-api",
        settlementDelaySec: 604800,
      },
    });
    // AVAX is a known altcoin — no warning emitted
    expect(result.warnings).toBeUndefined();
    expect(() => adaptFalconTransparency(falconPayload([
      { label: "USDC", ceffu: "malformed", fireblocks: "100" },
    ]))).toThrow(/Falcon USDC venue values row 1 has invalid value: NaN/);
  });

  it.each([
    ["UNKNOWN_TOKEN_XYZ", "50000", true],
    ["UNKNOWN_TOKEN_XYZ", "0.01", false],
    ["SOL", "500000", false],
  ] as const)("classifies warning exposure for %s worth %s", (label, value, warns) => {
    const result = adaptFalconTransparency(falconPayload([
      { label: "USDC", ceffu: "50" }, { label, ceffu: value },
    ]));
    if (warns) {
      expect(result.warnings).toEqual([
        expect.objectContaining({ code: "unknown-asset", message: expect.stringContaining(label) }),
      ]);
    } else {
      expect(result.warnings).toBeUndefined();
    }
  });

  it("treats DUSK as a reviewed Falcon altcoin instead of degrading the snapshot", () => {
    const payload = falconPayload([
      { label: "USDC", ceffu: "998949900" },
      { label: "DUSK", ceffu: "105100" },
    ], { timestamp: 1775023886, supply: "1000000000", insurance: "0" });

    const result = adaptFalconTransparency(payload);

    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      immediateRedeemableUsd: 998949900,
      unknownExposurePct: 0,
    });
  });

  it("normalizes a millisecond snapshot_date to unix seconds", () => {
    const payload = falconPayload(
      [{ label: "USDC", ceffu: "100" }],
      { timestamp: 1776067200000, insurance: "0" },
    );
    const result = adaptFalconTransparency(payload);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: 1776067200,
      freshnessMode: "verified",
    });
  });
});
