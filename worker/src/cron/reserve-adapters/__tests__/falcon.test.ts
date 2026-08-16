import { describe, expect, it } from "vitest";
import { adaptFalconTransparency, type FalconTransparencyResponse } from "../falcon";

describe("adaptFalconTransparency", () => {
  it("groups Falcon asset-level reserves into reserve buckets", () => {
    const payload: FalconTransparencyResponse = {
      snapshot_date: 1773316982,
      usdf: {
        supply: "100",
        insurance_fund: "5",
        breakdown: {
          assets: [
            { label: "USDC", ceffu: "20", fireblocks: "10" },
            { label: "BTC", multisig: "25" },
            { label: "ETH", multisig: "10" },
            { label: "USTB", fireblocks: "15" },
            { label: "AVAX", fireblocks: "15" },
          ],
        },
      },
    };

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
  });

  it("emits a warning for unknown assets above the value threshold", () => {
    const payload: FalconTransparencyResponse = {
      snapshot_date: 1773316982,
      usdf: {
        supply: "100",
        insurance_fund: "5",
        breakdown: {
          assets: [
            { label: "USDC", ceffu: "50" },
            { label: "UNKNOWN_TOKEN_XYZ", ceffu: "50000" },
          ],
        },
      },
    };
    const result = adaptFalconTransparency(payload);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(
      (w) => w.code === "unknown-asset" && w.message.includes("UNKNOWN_TOKEN_XYZ"),
    )).toBe(true);
  });

  it("suppresses warnings for unknown assets below the value threshold", () => {
    const payload: FalconTransparencyResponse = {
      snapshot_date: 1773316982,
      usdf: {
        supply: "100",
        insurance_fund: "5",
        breakdown: {
          assets: [
            { label: "USDC", ceffu: "50" },
            { label: "UNKNOWN_TOKEN_XYZ", ceffu: "0.01" },
          ],
        },
      },
    };
    const result = adaptFalconTransparency(payload);
    expect(result.warnings).toBeUndefined();
  });

  it("suppresses warnings for known altcoins regardless of value", () => {
    const payload: FalconTransparencyResponse = {
      snapshot_date: 1773316982,
      usdf: {
        supply: "100",
        insurance_fund: "5",
        breakdown: {
          assets: [
            { label: "USDC", ceffu: "50" },
            { label: "SOL", ceffu: "500000" },
          ],
        },
      },
    };
    const result = adaptFalconTransparency(payload);
    expect(result.warnings).toBeUndefined();
  });

  it("treats DUSK as a reviewed Falcon altcoin instead of degrading the snapshot", () => {
    const payload: FalconTransparencyResponse = {
      snapshot_date: 1775023886,
      usdf: {
        supply: "1000000000",
        insurance_fund: "0",
        breakdown: {
          assets: [
            { label: "USDC", ceffu: "998949900" },
            { label: "DUSK", ceffu: "105100" },
          ],
        },
      },
    };

    const result = adaptFalconTransparency(payload);

    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      immediateRedeemableUsd: 998949900,
      unknownExposurePct: 0,
    });
  });

  it("normalizes a millisecond snapshot_date to unix seconds", () => {
    const payload: FalconTransparencyResponse = {
      // 2026-04-10T00:00:00Z in ms
      snapshot_date: 1776067200000 as unknown as number,
      usdf: {
        supply: "100",
        insurance_fund: "0",
        breakdown: {
          assets: [{ label: "USDC", ceffu: "100" }],
        },
      },
    };
    const result = adaptFalconTransparency(payload);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: 1776067200,
      freshnessMode: "verified",
    });
  });
});
