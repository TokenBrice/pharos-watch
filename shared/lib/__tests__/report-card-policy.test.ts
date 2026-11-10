import { describe, it, expect } from "vitest";
import { computeCollateralQualityFromReserves, resolveCustodyModel } from "../report-card-policy";
import { BACKING_TYPE_VALUES, CUSTODY_MODEL_VALUES, GOVERNANCE_TYPE_VALUES } from "@shared/types/core";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";
import { applyInputDrivenExclusions } from "../selector/exclusions";
import { makeInput, makeMergedRow as makeRow } from "../selector/__tests__/fixture";

describe("whole-book custody eligibility", () => {
  it.each([
    ["rwa-backed", "centralized", "unknown"],
    ["rwa-backed", "centralized-dependent", "unknown"],
    ["rwa-backed", "decentralized", "onchain"],
    ["crypto-backed", "centralized", "onchain"],
    ["crypto-backed", "centralized-dependent", "onchain"],
    ["crypto-backed", "decentralized", "onchain"],
    ["algorithmic", "centralized", "onchain"],
    ["algorithmic", "centralized-dependent", "onchain"],
    ["algorithmic", "decentralized", "onchain"],
  ] as const)("defaults %s:%s to %s without inventing institutional coverage", (backing, governance, expected) => {
    const custodyModel = resolveCustodyModel({
      ...makeStablecoinMeta(),
      listingClass: "core-stablecoin",
      hasAuthoredDependencyEvidence: false,
      flags: { ...makeStablecoinMeta().flags, backing, governance },
    });
    expect(custodyModel).toBe(expected);
    expect(applyInputDrivenExclusions(makeRow({ custodyModel }), makeInput({ custodyOk: "regulated-only" })))
      .toMatchObject({ reason: "custody-regulated-only-violation" });
    const onchainExclusion = applyInputDrivenExclusions(makeRow({ custodyModel }), makeInput({ custodyOk: "onchain-only" }));
    if (expected === "onchain") {
      expect(onchainExclusion).toBeNull();
    } else {
      expect(onchainExclusion).toMatchObject({ reason: "custody-onchain-only-violation" });
    }
  });

  it.each(CUSTODY_MODEL_VALUES)("preserves the authored value %s over every class default", (custodyModel) => {
    for (const backing of BACKING_TYPE_VALUES) {
      for (const governance of GOVERNANCE_TYPE_VALUES) {
        expect(resolveCustodyModel({
          ...makeStablecoinMeta(),
          listingClass: "core-stablecoin",
          hasAuthoredDependencyEvidence: false,
          custodyModel,
          flags: { ...makeStablecoinMeta().flags, backing, governance },
        })).toBe(custodyModel);
      }
    }
  });

  it.each(["mixed", "unknown"] as const)("does not credit %s as regulated or all-onchain", (custodyModel) => {
    for (const custodyOk of ["regulated-only", "onchain-only"] as const) {
      expect(applyInputDrivenExclusions(makeRow({ custodyModel }), makeInput({ custodyOk })))
        .toMatchObject({ reason: `custody-${custodyOk}-violation` });
    }
    expect(applyInputDrivenExclusions(makeRow({ custodyModel }), makeInput({ custodyOk: "any" }))).toBeNull();
  });
});

describe("computeCollateralQualityFromReserves", () => {
  it("returns 0 for empty reserves array", () => {
    expect(computeCollateralQualityFromReserves([])).toBe(0);
  });

  it("returns 100 for 100% very-low risk reserves", () => {
    const reserves = [{ name: "US Treasuries", pct: 100, risk: "very-low" as const }];
    expect(computeCollateralQualityFromReserves(reserves)).toBe(100);
  });

  it("returns 5 for 100% very-high risk reserves", () => {
    const reserves = [{ name: "Algo backing", pct: 100, risk: "very-high" as const }];
    expect(computeCollateralQualityFromReserves(reserves)).toBe(5);
  });

  it("computes weighted average for mixed reserves", () => {
    const reserves = [
      { name: "Treasuries", pct: 60, risk: "very-low" as const },  // 60% * 100 = 6000
      { name: "Corporate bonds", pct: 40, risk: "medium" as const }, // 40% * 50  = 2000
    ];
    // (6000 + 2000) / 100 = 80
    expect(computeCollateralQualityFromReserves(reserves)).toBe(80);
  });

  it("handles reserves that don't sum to 100%", () => {
    const reserves = [
      { name: "USDC", pct: 30, risk: "low" as const },     // 30 * 75 = 2250
      { name: "ETH", pct: 20, risk: "high" as const },      // 20 * 25 = 500
    ];
    // totalPct = 50, weighted = 2750, result = 2750/50 = 55
    expect(computeCollateralQualityFromReserves(reserves)).toBe(55);
  });

  it("rounds to nearest integer", () => {
    const reserves = [
      { name: "Treasuries", pct: 70, risk: "very-low" as const },  // 70 * 100 = 7000
      { name: "Crypto", pct: 30, risk: "high" as const },           // 30 * 25  = 750
    ];
    // (7000 + 750) / 100 = 77.5, rounded to 78
    expect(computeCollateralQualityFromReserves(reserves)).toBe(78);
  });

  it("treats unknown risk values as 0 instead of producing NaN", () => {
    const slices = [
      { name: "Good", pct: 50, risk: "low" as const },
      { name: "Bad", pct: 50, risk: "bogus" as unknown as "low" },
    ];
    const score = computeCollateralQualityFromReserves(slices);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBe(Math.round((50 * 75 + 50 * 0) / 100)); // 38
  });
});
