import { describe, expect, it } from "vitest";
import type { OracleRiskBranch, OracleRiskTier } from "@shared/types/core";
import { deriveOracleBranchMateriality } from "../safety-score-v9/extension";

function branch(id: string, tier: OracleRiskTier, debtSharePct?: number): OracleRiskBranch {
  return {
    id,
    label: `${id} controller`,
    tier,
    summary: `Reviewed ${id} oracle branch for the materiality fixture.`,
    ...(debtSharePct === undefined ? {} : { debtSharePct }),
  };
}

describe("deriveOracleBranchMateriality", () => {
  it("leaves the reviewed aggregate tier untouched when no branch carries a measured share (mim-shape)", () => {
    const branches = [
      branch("weth", "opaque-or-unknown"),
      branch("wbtc", "single-source-or-laggy"),
    ];
    // Authored single-source-or-laggy must NOT be worsened to the opaque worst
    // branch: the lever is inactive without measured shares, so byte-held
    // multi-branch assets never move.
    expect(deriveOracleBranchMateriality(branches, "single-source-or-laggy")).toEqual({
      tier: "single-source-or-laggy",
    });
  });

  it("relaxes to the worst MATERIAL branch when weak branches are sub-material (crvUSD-shape)", () => {
    const branches = [
      branch("wbtc", "standard-external", 50.2),
      branch("wsteth", "standard-external", 25.5),
      branch("weth", "standard-external", 5.1),
      branch("sfrxeth-v2", "standard-external"), // unmeasured -> material, but standard
      branch("tbtc", "single-source-or-laggy", 9.33),
      branch("cbbtc", "single-source-or-laggy", 5.34),
      branch("weeth", "single-source-or-laggy", 0.42),
      branch("lbtc", "single-source-or-laggy", 0),
      branch("legacy-sfrxeth", "single-source-or-laggy", 0.45),
    ];
    // Material branches (>=10% or unmeasured) are all standard-external; the
    // 5-10% weak branches (tBTC/cbBTC) leave a moderate diagnostic.
    expect(deriveOracleBranchMateriality(branches, "single-source-or-laggy")).toEqual({
      tier: "standard-external",
      subMaterialWeakBand: "moderate",
    });
  });

  it("keeps a share-undefined weak branch material so it fails closed at the worst tier", () => {
    const branches = [
      branch("safe", "standard-external", 70),
      branch("weak", "single-source-or-laggy"), // undefined share -> material
    ];
    expect(deriveOracleBranchMateriality(branches, "standard-external")).toEqual({
      tier: "single-source-or-laggy",
    });
  });

  it("treats a 9.33% weak branch as sub-material (just below the 10% floor) -> moderate", () => {
    const branches = [
      branch("safe", "standard-external", 80),
      branch("tbtc", "single-source-or-laggy", 9.33),
    ];
    expect(deriveOracleBranchMateriality(branches, "single-source-or-laggy")).toEqual({
      tier: "standard-external",
      subMaterialWeakBand: "moderate",
    });
  });

  it("keeps a >=10% weak branch material -> worst tier weak (no relaxation)", () => {
    const branches = [
      branch("safe", "standard-external", 60),
      branch("weak", "single-source-or-laggy", 10),
    ];
    expect(deriveOracleBranchMateriality(branches, "single-source-or-laggy")).toEqual({
      tier: "single-source-or-laggy",
    });
  });

  it("bands a sub-material weak branch below 5% as a low diagnostic only", () => {
    const branches = [
      branch("safe", "standard-external", 90),
      branch("dust", "single-source-or-laggy", 0.45),
    ];
    expect(deriveOracleBranchMateriality(branches, "single-source-or-laggy")).toEqual({
      tier: "standard-external",
      subMaterialWeakBand: "low",
    });
  });

  it("stays capped for a cdp-enosys-shaped profile whose weak branches are all material (undefined share)", () => {
    const branches = [
      branch("fxrp", "standard-external", 55), // one measured share activates the lever
      branch("wflr", "standard-external"),
      branch("stxrp", "single-source-or-laggy"), // undefined -> material
      branch("sflr", "single-source-or-laggy"), // undefined -> material
    ];
    expect(deriveOracleBranchMateriality(branches, "single-source-or-laggy")).toEqual({
      tier: "single-source-or-laggy",
    });
  });
});
