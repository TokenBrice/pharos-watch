import { describe, expect, it } from "vitest";
import {
  V9_CANDIDATE_POLICY_V1,
  compileNativeV3FactSet,
  compileV9FactSetV2,
  computeV9FactSetDigest,
  coreFixture,
  evaluateV9FactSet,
  parseCompiledV9FactSetV2,
} from "./safety-score-v9-facts.fixture-support";

describe("Safety Score v9 fact digest canonicalization", () => {
  it("canonicalizes every ordered identity surface and produces a permutation-stable digest", () => {
    const ordered = compileV9FactSetV2(coreFixture(false));
    const reversed = compileV9FactSetV2(coreFixture(true));

    expect(reversed).toEqual(ordered);
    expect(ordered.activeAssetIds).toEqual(["alpha", "beta", "gamma"]);
    expect(ordered.assets.map((asset) => asset.assetId)).toEqual(["alpha", "beta", "gamma"]);
    const alpha = ordered.assets[0]!;
    expect(alpha.evidence.map((reference) => reference.evidenceId)).toEqual([
      "evidence:base",
      "evidence:rejected-route",
      "evidence:route",
    ]);
    expect(alpha.dependencies.edges.map((edge) => edge.edgeKey)).toEqual(["collateral:beta", "mechanism:gamma"]);
    expect(alpha.reserveExposures.map((exposure) => exposure.exposureKey)).toEqual(["exposure:beta", "exposure:cash"]);
    expect(alpha.controls.map((control) => control.controlKey)).toEqual([
      "control:admin",
      "control:freezer",
      "control:minter",
    ]);
    expect(alpha.exitRoutes.map((route) => route.routeKey)).toEqual(
      [...alpha.exitRoutes.map((route) => route.routeKey)].sort(),
    );
    expect(alpha.controls[0]!.failureDomains.map((domain) => `${domain.kind}:${domain.key}`)).toEqual([
      "chain:chain:ethereum",
      "upgrade-control:safe:admin",
    ]);

    expect(evaluateV9FactSet(compileNativeV3FactSet(coreFixture(true)), V9_CANDIDATE_POLICY_V1)).toEqual(
      evaluateV9FactSet(compileNativeV3FactSet(coreFixture(false)), V9_CANDIDATE_POLICY_V1),
    );
  });
  it("canonicalizes and reconciles explicit chain supply attribution", () => {
    const attributed = coreFixture();
    attributed.assets[0]!.supply.chainDistribution = {
      chains: [
        { chainId: "fantom", supplyUsd: 499_000, supplyShare: 0.0499 },
        { chainId: "ethereum", supplyUsd: 8_501_000, supplyShare: 0.8501 },
      ],
      unattributedSupplyUsd: 1_000_000,
      unattributedSupplyShare: 0.1,
    };
    expect(compileV9FactSetV2(attributed).assets[0]!.supply.chainDistribution).toEqual({
      chains: [
        { chainId: "ethereum", supplyUsd: 8_501_000, supplyShare: 0.8501 },
        { chainId: "fantom", supplyUsd: 499_000, supplyShare: 0.0499 },
      ],
      unattributedSupplyUsd: 1_000_000,
      unattributedSupplyShare: 0.1,
    });

    const duplicate = structuredClone(attributed);
    duplicate.assets[0]!.supply.chainDistribution!.chains[1]!.chainId = "fantom";
    expect(() => compileV9FactSetV2(duplicate)).toThrow("Duplicate canonical key: fantom");

    const usdMismatch = structuredClone(attributed);
    usdMismatch.assets[0]!.supply.chainDistribution!.chains[0]!.supplyUsd -= 1_000;
    expect(() => compileV9FactSetV2(usdMismatch)).toThrow("Chain supply USD must reconcile");

    const shareMismatch = structuredClone(attributed);
    shareMismatch.assets[0]!.supply.chainDistribution!.unattributedSupplyShare = 0.2;
    expect(() => compileV9FactSetV2(shareMismatch)).toThrow("Chain supply shares must reconcile");

    const zeroSupply = coreFixture();
    zeroSupply.assets[1]!.supply.circulatingUsd = 0;
    zeroSupply.assets[1]!.supply.chainDistribution = {
      chains: [{ chainId: "chain:fixture", supplyUsd: 0, supplyShare: 0 }],
      unattributedSupplyUsd: 0,
      unattributedSupplyShare: 0,
    };
    expect(compileV9FactSetV2(zeroSupply).assets[1]!.supply.chainDistribution).toEqual(
      zeroSupply.assets[1]!.supply.chainDistribution,
    );
    zeroSupply.assets[1]!.supply.chainDistribution.chains[0]!.supplyShare = 0.01;
    expect(() => compileV9FactSetV2(zeroSupply)).toThrow("Chain supply shares must reconcile");
  });
  it("canonicalizes the retained Hyperliquid alias and applies R2 maturity after collisions", () => {
    const configure = (
      input: ReturnType<typeof coreFixture>,
      chains: Array<{ chainId: string; supplyUsd: number; supplyShare: number }>,
    ) => {
      for (const asset of input.assets.slice(1)) {
        asset.supply.chainDistribution = {
          chains,
          unattributedSupplyUsd: 0,
          unattributedSupplyShare: 0,
        };
        asset.supply.failureDomains = [{ kind: "chain", key: "hyperliquid" }];
      }
    };
    const severity = (input: ReturnType<typeof coreFixture>) =>
      evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1)
        .assets.find((asset) => asset.assetId === "beta")!
        .scoreInput.dependencyStructuralSignals.find((signal) => signal.failureDomainKeys.includes("chain:hyperliquid"))
        ?.severity;

    const alias = coreFixture();
    configure(alias, [{ chainId: "hyperliquid-l1", supplyUsd: 1_000_000, supplyShare: 1 }]);
    expect(severity(alias)).toBe("low");

    const collision = coreFixture();
    configure(collision, [
      { chainId: "ethereum", supplyUsd: 950_200, supplyShare: 0.9502 },
      { chainId: "hyperliquid", supplyUsd: 24_900, supplyShare: 0.0249 },
      { chainId: "hyperliquid-l1", supplyUsd: 24_900, supplyShare: 0.0249 },
    ]);
    expect(severity(collision)).toBe("low");
  });
  it("binds semantic facts and source identities but excludes compilation time and all policy fields", () => {
    const first = compileV9FactSetV2(coreFixture());
    const laterInput = coreFixture();
    laterInput.compiledAtSec += 500;
    const later = compileV9FactSetV2(laterInput);
    expect(later.v9FactSetDigest).toBe(first.v9FactSetDigest);

    const factChanged = coreFixture();
    factChanged.assets[0]!.supply.circulatingUsd += 1;
    factChanged.assets[0]!.supply.chainDistribution!.chains[0]!.supplyUsd += 1;
    expect(compileV9FactSetV2(factChanged).v9FactSetDigest).not.toBe(first.v9FactSetDigest);

    const mechanismChanged = coreFixture();
    const mechanismReviewChanged = mechanismChanged.assets[0]!.mechanismRiskReview.review!;
    if (mechanismReviewChanged.archetype !== "fiat-cash") throw new Error("Fixture archetype changed");
    mechanismReviewChanged.claimAndSegregation.failureDomains[0]!.key = "mechanism:changed";
    expect(compileV9FactSetV2(mechanismChanged).v9FactSetDigest).not.toBe(first.v9FactSetDigest);

    const sourceChanged = coreFixture();
    sourceChanged.sourceFingerprints.chainSupply.payloadSha256 = "f".repeat(64);
    expect(compileV9FactSetV2(sourceChanged).v9FactSetDigest).not.toBe(first.v9FactSetDigest);

    expect(() => compileV9FactSetV2({ ...coreFixture(), policyDigest: "f".repeat(64) })).toThrow("Unrecognized key");
    expect(computeV9FactSetDigest(first)).toBe(first.v9FactSetDigest);

    const tampered = { ...first, v9FactSetDigest: "0".repeat(64) };
    expect(() => parseCompiledV9FactSetV2(tampered)).toThrow("does not match");
  });
});
