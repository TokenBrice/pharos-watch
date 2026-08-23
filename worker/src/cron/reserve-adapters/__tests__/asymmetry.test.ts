import { describe, expect, it } from "vitest";
import { adaptAsymmetry } from "../asymmetry";
import { validateAdapterOutput } from "../validate";
import { getReserveAdapter } from "../index";

describe("adaptAsymmetry", () => {
  it("maps branch collateral values into normalized reserve slices", () => {
    const slices = adaptAsymmetry({
      timestamp: 1776239429591,
      usdaf: {
        total_bold_supply: "996",
        branch: {
          ysyBOLD: { coll_value: "650" },
          scrvUSD: { coll_value: "225" },
          sUSDS: { coll_value: "74" },
          tBTC: { coll_value: "23" },
          sfrxUSD: { coll_value: "19" },
          wBTC: { coll_value: "5" },
        },
      },
    });

    expect(slices.slices).toEqual([
      { name: "ysyBOLD", pct: 65.3, risk: "medium", coinId: "bold-liquity", depType: "collateral" },
      { name: "scrvUSD", pct: 22.6, risk: "medium", coinId: "scrvusd-curve", depType: "collateral" },
      { name: "sUSDS", pct: 7.4, risk: "low", coinId: "susds-sky", depType: "collateral" },
      { name: "tBTC", pct: 2.3, risk: "medium" },
      { name: "sfrxUSD", pct: 1.9, risk: "medium", coinId: "sfrxusd-frax", depType: "collateral" },
      { name: "wBTC", pct: 0.5, risk: "medium" },
    ]);
    expect(slices.metadata).toMatchObject({
      branchCount: 6,
      activeBranchCount: 6,
      unknownBranchCount: 0,
      freshnessMode: "verified",
      sourceTimestamp: 1776239429,
      immediateRedeemableUsd: 996,
      capacityRatioOfSupply: 1,
      redemption: {
        capacityUsd: 996,
        capacityRatioOfSupply: 1,
        capacityKind: "live-direct-bounded",
        freshnessKind: "verified-source-timestamp",
        sourceTimestamp: 1776239429,
        routeStatus: "open",
      },
    });
    const adapter = getReserveAdapter("asymmetry") ?? undefined;
    expect(validateAdapterOutput(slices, { adapter, now: 1776239430 }).valid).toBe(true);
    expect(slices.warnings).toBeUndefined();
  });

  it("clamps capacity and emits under-collateralization warning when supply > reserveTotal", () => {
    const result = adaptAsymmetry({
      timestamp: 1776239429,
      usdaf: {
        total_bold_supply: "1000",
        branch: {
          ysyBOLD: { coll_value: "400" },
          scrvUSD: { coll_value: "400" },
        },
      },
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "under-collateralization", severity: "warning" }),
      ]),
    );
    expect(result.metadata).toMatchObject({
      immediateRedeemableUsd: 800,
      capacityRatioOfSupply: 0.8,
      redemption: {
        capacityUsd: 800,
        capacityRatioOfSupply: 0.8,
      },
    });
  });

  it("keeps zero branches ignorable but rejects malformed or negative collateral rows", () => {
    const result = adaptAsymmetry({
      timestamp: 1776239429,
      usdaf: {
        total_bold_supply: "1000",
        branch: {
          ysyBOLD: { coll_value: "0" },
        },
      },
    });
    expect(result.slices).toEqual([]);
    expect(() => adaptAsymmetry({
      usdaf: {
        branch: {
          ysyBOLD: { coll_value: "not-a-number" },
          scrvUSD: { coll_value: "100" },
        },
      },
    })).toThrow(/Asymmetry branch collateral row 1 has invalid value: NaN/);
    expect(() => adaptAsymmetry({
      usdaf: {
        branch: {
          ysyBOLD: { coll_value: "-1" },
          scrvUSD: { coll_value: "100" },
        },
      },
    })).toThrow(/Asymmetry branch collateral row 1 has invalid value: -1/);
  });

  it("falls back to unverified freshness when timestamp is missing", () => {
    const result = adaptAsymmetry({
      usdaf: {
        total_bold_supply: "100",
        branch: {
          ysyBOLD: { coll_value: "100" },
        },
      },
    });
    expect(result.metadata?.freshnessMode).toBe("unverified");
  });

  it("is rejected by validateAdapterOutput when timestamp is in the future", () => {
    const futureMs = (Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60) * 1000;
    const result = adaptAsymmetry({
      timestamp: futureMs,
      usdaf: {
        total_bold_supply: "100",
        branch: {
          ysyBOLD: { coll_value: "100" },
        },
      },
    });
    const adapter = getReserveAdapter("asymmetry") ?? undefined;
    const report = validateAdapterOutput(result, { adapter });
    expect(report.valid).toBe(false);
  });
});
