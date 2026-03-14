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
      { name: "Stablecoins / cash equivalents", pct: 30, risk: "low" },
      { name: "BTC collateral", pct: 25, risk: "medium" },
      { name: "ETH / liquid staking collateral", pct: 10, risk: "medium" },
      { name: "Tokenized RWA / credit assets", pct: 15, risk: "medium" },
      { name: "Other crypto / tokenized assets", pct: 15, risk: "high" },
      { name: "Insurance fund", pct: 5, risk: "medium" },
    ]);
    expect(result.metadata).toMatchObject({
      snapshotDate: 1773316982,
      supply: "100",
      insuranceFund: "5",
      assetCount: 5,
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
            { label: "UNKNOWN_TOKEN_XYZ", ceffu: "5" },
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
});
