import { describe, expect, it } from "vitest";
import type { OracleRiskBranch, OracleRiskProfile, OracleRiskTier } from "@shared/types/core";
import type { LenderBookObservation, LenderMarketObservation } from "@shared/types/safety-score-v9-lender-book";
import { deriveMorphoOracleBranchMateriality, deriveOracleBranchMateriality } from "../safety-score-v9/extension-oracle";
import { unknownQuality, V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { lenderOracleBranchKey } from "@shared/lib/safety-score-v9/lender-book-registry";

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

  it("retains a verified material weak branch alongside MAI-shaped opacity independently of inventory order", () => {
    const branches = [
      branch("opaque", "opaque-or-unknown", 71.72),
      branch("verified-weak", "single-source-or-laggy", 14.57),
      branch("standard", "standard-external", 13.71),
    ];
    for (const ordered of [branches, [...branches].reverse(), [branches[1]!, branches[0]!, branches[2]!]]) {
      expect(deriveOracleBranchMateriality(ordered, "opaque-or-unknown")).toEqual({
        tier: "single-source-or-laggy",
      });
    }
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

  it.each([9.99, 10, undefined])("does not classify privileged pricing at share %s as a weak-oracle ceiling", (share) => {
    expect(deriveOracleBranchMateriality([
      branch("safe", "standard-external", 90),
      branch("internal", "privileged-internal-pricing", share),
    ], "privileged-internal-pricing")).toEqual({
      tier: share === 9.99 ? "standard-external" : "privileged-internal-pricing",
    });
  });

  it.each([9.99])("does not turn opaque sub-material topology at share %s into a measured weak branch", (share) => {
    expect(deriveOracleBranchMateriality([
      branch("safe", "standard-external", 90),
      branch("unknown", "opaque-or-unknown", share),
    ], "opaque-or-unknown")).toEqual({ tier: "standard-external" });
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

});

const morphoCore = "0x1111111111111111111111111111111111111111";
const morphoOracle = "0x2222222222222222222222222222222222222222";
const morphoVault = "0x3333333333333333333333333333333333333333";
const marketWord = (digit: string) => `0x${digit.repeat(64)}`;

function lenderClaim(digit: string, amount: string, account = morphoVault): LenderMarketObservation {
  return {
    account, adapter: null, morpho: morphoCore, marketId: marketWord(digit),
    loanToken: morphoOracle, collateralToken: morphoOracle, oracle: morphoOracle, irm: morphoCore,
    lltvRaw: "860000000000000000", supplySharesRaw: amount,
    positionBorrowSharesRaw: "0", positionCollateralRaw: "0",
    marketSupplyAssetsRaw: amount, marketSupplySharesRaw: amount,
    marketBorrowAssetsRaw: "0", marketBorrowSharesRaw: "0", marketLastUpdateSec: 100,
    marketFeeRaw: "0", includedAssetsRaw: amount,
    accruedMethod: "adapter-expected-supply-assets", collateralMode: "collateralized",
  };
}

function lenderBook(markets: LenderMarketObservation[], totalAssetsRaw = "100000"): Extract<LenderBookObservation, { status: "ok" }> {
  const included = markets.reduce((sum, market) => sum + BigInt(market.includedAssetsRaw), 0n);
  return {
    schemaVersion: 1, status: "ok", assetId: "kpkusdcprime-kpk", sourceGenerationId: "fixture",
    acquiredAtSec: 100, maxAgeSec: 28800, contentSha256: "a".repeat(64),
    censusScope: "complete-nav-accounted-current-book",
    deployments: [{
      chain: "ethereum", vault: morphoVault, kind: "vault-v2",
      pin: { chain: "ethereum", number: 1, hash: marketWord("a"), timestampSec: 100, finality: "finalized" },
      loanToken: morphoOracle, loanDecimals: 6, totalAssetsRaw, totalSupplyRaw: totalAssetsRaw,
      idleAssetsRaw: (BigInt(totalAssetsRaw) - included).toString(), reconciledAssetsRaw: totalAssetsRaw,
      reconciliationResidualRaw: "0", codeHashes: {}, selectorsRead: [], markets,
    }],
  };
}

function morphoBranches() {
  return [
    branch(`market-${marketWord("a").slice(2)}`, "standard-external"),
    branch(`market-${marketWord("b").slice(2)}`, "single-source-or-laggy"),
  ];
}

function borrowerPaths(branches: OracleRiskBranch[]): NonNullable<OracleRiskProfile["paths"]> {
  return branches.map((row) => ({
    id: row.id, branchId: row.id, chain: "ethereum", address: morphoOracle,
    pricingAuthority: "external-price" as const,
    applicability: {
      disposition: "branches-required" as const, reviewedAt: "1970-01-01", reviewer: "Fixture reviewer",
      confidence: "verified" as const, rationale: "Exact market borrower pricing path reviewed.",
      sources: [{ label: "Source", url: "https://example.com/source" }],
    },
  }));
}

describe("Morpho lender NAV branch materiality", () => {
  it.each(["market-prefix", "bare-market", "oracle-address", "core-market-key"] as const)(
    "joins the reviewed %s identity without changing borrower evidence", (form) => {
      const branches = morphoBranches();
      const claims = [lenderClaim("a", "90000"), lenderClaim("b", "999")];
      claims[1]!.oracle = morphoCore;
      for (const [index, row] of branches.entries()) {
        const claim = claims[index]!;
        if (form === "bare-market") row.id = claim.marketId;
        if (form === "oracle-address") row.id = `oracle-${claim.oracle}`;
        if (form === "core-market-key") row.id = lenderOracleBranchKey("ethereum", claim.morpho, claim.marketId);
      }
      const paths = borrowerPaths(branches).map((path, index) => ({ ...path, address: claims[index]!.oracle }));
      const originalBranches = structuredClone(branches);
      expect(deriveMorphoOracleBranchMateriality(branches, "single-source-or-laggy", lenderBook(claims), paths))
        .toEqual({ tier: "standard-external", missingBranch: false });
      expect(branches).toEqual(originalBranches);
    },
  );

  it("joins checksum-case oracle IDs through the exact chain-local observed oracle path", () => {
    const claim = lenderClaim("a", "90000");
    claim.oracle = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const branches = [branch(`oracle-${claim.oracle.toUpperCase()}`, "standard-external")];
    const paths = borrowerPaths(branches).map((path) => ({ ...path, address: claim.oracle.toUpperCase() }));
    expect(deriveMorphoOracleBranchMateriality(branches, "opaque-or-unknown", lenderBook([claim]), paths))
      .toEqual({ tier: "standard-external", missingBranch: false });
  });

  it("shares an oracle-address review across distinct markets without inventing an unreviewed feed", () => {
    const branches = [branch(`oracle-${morphoOracle}`, "standard-external")];
    expect(deriveMorphoOracleBranchMateriality(branches, "opaque-or-unknown",
      lenderBook([lenderClaim("a", "50000"), lenderClaim("b", "50000")]), borrowerPaths(branches)))
      .toEqual({ tier: "standard-external", missingBranch: false });
  });

  it.each(["wrong-address", "wrong-chain", "wrong-branch-chain", "wrong-disposition", "duplicate-review"] as const)(
    "diagnoses %s instead of assigning a new opaque tier or excluding unmatched exposure", (failure) => {
      const branches = [branch(`oracle-${morphoOracle}`, "standard-external")];
      const paths = borrowerPaths(branches);
      if (failure === "wrong-address") paths[0]!.address = morphoCore;
      if (failure === "wrong-chain") paths[0]!.chain = "base";
      if (failure === "wrong-branch-chain") branches[0]!.chains = ["base"];
      if (failure === "wrong-disposition") paths[0]!.applicability!.disposition = "top-level-only";
      if (failure === "duplicate-review") branches.push({ ...branches[0]! });
      expect(deriveMorphoOracleBranchMateriality(branches, "standard-external",
        lenderBook([lenderClaim("a", "1")]), paths))
        .toEqual({ tier: "standard-external", missingBranch: true });
    },
  );

  it("uses core-qualified keys to distinguish the same market hash on different cores", () => {
    const claims = [lenderClaim("a", "90000"), { ...lenderClaim("a", "999"), morpho: morphoOracle }];
    const branches = claims.map((claim, index) => branch(
      lenderOracleBranchKey("ethereum", claim.morpho, claim.marketId),
      index === 0 ? "standard-external" : "single-source-or-laggy",
    ));
    expect(deriveMorphoOracleBranchMateriality(branches, "single-source-or-laggy", lenderBook(claims), borrowerPaths(branches)))
      .toEqual({ tier: "standard-external", missingBranch: false });
  });

  it.each(["market-prefix", "oracle-address"] as const)("retains the reviewed aggregate for ambiguous %s cores", (form) => {
    const branches = [branch(form === "oracle-address" ? `oracle-${morphoOracle}` : `market-${marketWord("a").slice(2)}`,
      "single-source-or-laggy")];
    const claims = [lenderClaim("a", "90000"), { ...lenderClaim("a", "999"), morpho: morphoOracle }];
    expect(deriveMorphoOracleBranchMateriality(branches, "single-source-or-laggy", lenderBook(claims), borrowerPaths(branches)))
      .toEqual({ tier: "single-source-or-laggy", missingBranch: true });
  });

  it("disables dust relief when another positive claim cannot be joined, even below 1% NAV", () => {
    const branches = morphoBranches();
    expect(deriveMorphoOracleBranchMateriality(branches, "single-source-or-laggy",
      lenderBook([lenderClaim("a", "90000"), lenderClaim("b", "999"), lenderClaim("c", "1")]), borrowerPaths(branches)))
      .toEqual({ tier: "single-source-or-laggy", missingBranch: true });
  });

  it("does not disable dust relief for an unreviewed zero-asset claim", () => {
    const branches = morphoBranches();
    expect(deriveMorphoOracleBranchMateriality(branches, "single-source-or-laggy",
      lenderBook([lenderClaim("a", "90000"), lenderClaim("b", "999"), lenderClaim("c", "0")]), borrowerPaths(branches)))
      .toEqual({ tier: "standard-external", missingBranch: false });
  });

  it("retains the aggregate when accounts report conflicting oracle identities for one core/market", () => {
    const branches = morphoBranches();
    const claims = [lenderClaim("a", "90000"), lenderClaim("b", "500"),
      { ...lenderClaim("b", "499", morphoCore), oracle: morphoCore }];
    expect(deriveMorphoOracleBranchMateriality(branches, "single-source-or-laggy", lenderBook(claims), borrowerPaths(branches)))
      .toEqual({ tier: "single-source-or-laggy", missingBranch: true });
  });

  it.each([
    ["999", "standard-external"],
    ["1000", "single-source-or-laggy"],
  ] as const)("compares %s raw assets against NAV with the inclusive exact 1%% boundary", (amount, tier) => {
    const branches = morphoBranches();
    const result = deriveMorphoOracleBranchMateriality(branches, "single-source-or-laggy",
      lenderBook([lenderClaim("a", "50000"), lenderClaim("b", amount)]), borrowerPaths(branches));
    expect(result).toEqual({ tier, missingBranch: false });
    expect(result).not.toHaveProperty("subMaterialWeakBand");
    expect(branches[1]).not.toHaveProperty("debtSharePct");
  });

  it.each([["1999", "standard-external"], ["2000", "single-source-or-laggy"]] as const)(
    "uses measured realAssets NAV for capped VaultV2 books at %s raw assets", (amount, tier) => {
      const branches = morphoBranches();
      const book = lenderBook([lenderClaim("a", "90000"), lenderClaim("b", amount)]);
      const deployment = book.deployments[0]!;
      deployment.realAssetsRaw = "200000";
      deployment.undistributedAssetsRaw = "100000";
      deployment.idleAssetsRaw = (200000n - 90000n - BigInt(amount)).toString();
      deployment.reconciledAssetsRaw = "200000";
      expect(deriveMorphoOracleBranchMateriality(branches, "single-source-or-laggy", book, borrowerPaths(branches)))
        .toEqual({ tier, missingBranch: false });
    },
  );

  it("retains a semantic-only review with no path identity rather than inventing a match", () => {
    const branches = [branch("rlusd-wbtc-86", "standard-external")];
    expect(deriveMorphoOracleBranchMateriality(branches, "standard-external",
      lenderBook([lenderClaim("a", "90000")]), []))
      .toEqual({ tier: "standard-external", missingBranch: true });
  });

  it("uses total NAV including idle, not the deployed denominator or rounded weights", () => {
    const branches = morphoBranches();
    expect(deriveMorphoOracleBranchMateriality(branches, "single-source-or-laggy",
      lenderBook([lenderClaim("a", "1000"), lenderClaim("b", "999")]), borrowerPaths(branches)))
      .toEqual({ tier: "standard-external", missingBranch: false });
  });

  it("aggregates accounts of the same core/market before thresholding", () => {
    const branches = morphoBranches();
    expect(deriveMorphoOracleBranchMateriality(branches, "single-source-or-laggy",
      lenderBook([lenderClaim("a", "90000"), lenderClaim("b", "600"),
        lenderClaim("b", "600", "0x4444444444444444444444444444444444444444")]), borrowerPaths(branches)))
      .toEqual({ tier: "single-source-or-laggy", missingBranch: false });
  });

  it("takes the worst material tier per deployment without merging cross-chain positions", () => {
    const branches = morphoBranches();
    const book = lenderBook([lenderClaim("a", "90000"), lenderClaim("b", "600")]);
    book.deployments.push({ ...book.deployments[0]!, chain: "base",
      pin: { ...book.deployments[0]!.pin, chain: "base" } });
    const paths = borrowerPaths(branches);
    expect(deriveMorphoOracleBranchMateriality(branches, "single-source-or-laggy", book,
      [...paths, ...paths.map((path) => ({ ...path, id: `base:${path.id}`, chain: "base" }))]))
      .toEqual({ tier: "standard-external", missingBranch: false });
    book.deployments[1]!.markets = [lenderClaim("a", "90000"), lenderClaim("b", "1000")];
    expect(deriveMorphoOracleBranchMateriality(branches, "single-source-or-laggy", book,
      [...paths, ...paths.map((path) => ({ ...path, id: `base:${path.id}`, chain: "base" }))]).tier)
      .toBe("single-source-or-laggy");
  });

  it("retains unknown reviewed weights as material and diagnoses newly funded unreviewed markets without a new tier", () => {
    const branches = morphoBranches();
    const book = lenderBook([lenderClaim("a", "90000")]);
    expect(deriveMorphoOracleBranchMateriality(branches, "standard-external", book, borrowerPaths(branches)).tier)
      .toBe("single-source-or-laggy");
    book.deployments[0]!.markets.push(lenderClaim("c", "1000"));
    expect(deriveMorphoOracleBranchMateriality([branches[0]!], "standard-external", book, borrowerPaths(branches)))
      .toEqual({ tier: "standard-external", missingBranch: true });
  });

  it("never drops a material unknown branch or ambiguous same-market core identity", () => {
    const branches = morphoBranches();
    branches[1]!.tier = "opaque-or-unknown";
    const book = lenderBook([lenderClaim("a", "90000"), lenderClaim("b", "1000")]);
    expect(deriveMorphoOracleBranchMateriality(branches, "standard-external", book, borrowerPaths(branches)).tier)
      .toBe("opaque-or-unknown");
    book.deployments[0]!.markets.push({ ...lenderClaim("b", "1"), morpho: morphoOracle });
    expect(deriveMorphoOracleBranchMateriality(branches, "opaque-or-unknown", book, borrowerPaths(branches)))
      .toEqual({ tier: "opaque-or-unknown", missingBranch: true });
  });

  it("retains Prime's material OETH internal pricing at 8.06% NAV despite LsETH and weETH dust", () => {
    const branches = morphoBranches();
    branches[1]!.tier = "privileged-internal-pricing";
    branches.push(branch(`market-${marketWord("c").slice(2)}`, "single-source-or-laggy"));
    expect(deriveMorphoOracleBranchMateriality(branches, "privileged-internal-pricing",
      lenderBook([lenderClaim("a", "90000"), lenderClaim("b", "8060"), lenderClaim("c", "981")]),
      borrowerPaths(branches))).toEqual({ tier: "privileged-internal-pricing", missingBranch: false });
    expect(V9_CANDIDATE_POLICY_V1.policy.semantic.control.oracleTierQuality["privileged-internal-pricing"]).toBe(45);
  });

  it("does not round a uint256-scale claim just below the 1% integer boundary up to material", () => {
    const branches = morphoBranches();
    const nav = 10n ** 60n;
    for (const difference of [-1n, 0n, 1n]) {
      const claim = nav / 100n + difference;
      expect(deriveMorphoOracleBranchMateriality(branches, "single-source-or-laggy",
        lenderBook([lenderClaim("a", (nav / 2n).toString()), lenderClaim("b", claim.toString())], nav.toString()),
        borrowerPaths(branches)).tier).toBe(difference < 0n ? "standard-external" : "single-source-or-laggy");
    }
  });

  it("keeps a reviewed path with an unjoined oracle identity material even when a sibling path joins dust", () => {
    const branches = morphoBranches();
    const paths = borrowerPaths(branches);
    paths.push({ ...paths[1]!, id: "unjoined", address: morphoCore });
    expect(deriveMorphoOracleBranchMateriality(branches, "standard-external",
      lenderBook([lenderClaim("a", "90000"), lenderClaim("b", "1")]), paths))
      .toEqual({ tier: "single-source-or-laggy", missingBranch: false });
  });

  it("can only improve or retain the pre-v10.19 worst reviewed quality across all tier pairs", () => {
    const policy = V9_CANDIDATE_POLICY_V1.policy.semantic;
    const quality = (tier: OracleRiskTier): number => tier === "opaque-or-unknown"
      ? unknownQuality("control", undefined, policy) : policy.control.oracleTierQuality[tier];
    const tiers = [...Object.keys(policy.control.oracleTierQuality), "opaque-or-unknown"] as OracleRiskTier[];
    for (const first of tiers) {
      for (const second of tiers) {
        const branches = morphoBranches();
        branches[0]!.tier = first;
        branches[1]!.tier = second;
        const baseline = quality(first) <= quality(second) ? first : second;
        for (const amount of ["0", "999", "1000", "1001"]) {
          const book = lenderBook([lenderClaim("a", "50000"), lenderClaim("b", amount)]);
          const result = deriveMorphoOracleBranchMateriality(branches, baseline, book, borrowerPaths(branches));
          expect(quality(result.tier), `${first}/${second} at ${amount}`).toBeGreaterThanOrEqual(quality(baseline));
          book.deployments[0]!.markets.push(lenderClaim("c", "1"));
          expect(deriveMorphoOracleBranchMateriality(branches, baseline, book, borrowerPaths(branches)))
            .toEqual({ tier: baseline, missingBranch: true });
        }
      }
    }
  });

  it("does not infer oracleless or improve the aggregate tier for all-idle books", () => {
    const branches = morphoBranches();
    expect(deriveMorphoOracleBranchMateriality(branches, "single-source-or-laggy",
      lenderBook([]), borrowerPaths(branches))).toEqual({ tier: "single-source-or-laggy", missingBranch: false });
  });
});
