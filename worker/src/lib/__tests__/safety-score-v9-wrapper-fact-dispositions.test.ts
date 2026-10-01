import { describe, expect, it } from "vitest";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import lorenzoMeta from "@shared/data/stablecoins/coins/susd1plus-lorenzo.json";
import { ParentBackingInheritanceSchema } from "@shared/types/stablecoin-meta-schemas";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { createAssetBuildContext } from "../safety-score-v9/fact-set-context";
import { buildWrapperLocalFacts } from "../safety-score-v9/fact-set-wrapper";
import {
  makeV9CohortFixedInput,
  makeV9RoleExtension,
  makeV9TwoAssetFixedInput,
  type V9ExtensionDependencyEdge,
} from "../../test-helpers/v9-fixed-input";

function fixedInputWithTrackedParent() {
  return makeV9TwoAssetFixedInput();
}

function wrapperExtension(
  fixed: ReturnType<typeof fixedInputWithTrackedParent>,
  variantKind: "pure-wrapper" | "savings-passthrough" | "strategy-vault",
  includeParentEdge = true,
) {
  const extension = makeV9RoleExtension(fixed, {});
  const parentEdge: V9ExtensionDependencyEdge = {
    upstreamAssetId: "beta",
    dependencyType: "wrapper",
    weight: 1,
    economicRole: "serial-claim",
    failureDomains: [],
  };
  const asset = extension.assets.find((candidate) => candidate.assetId === "alpha")!;
  asset.variantKind = variantKind;
  asset.dependencies = {
    source: includeParentEdge ? "variant" : "none",
    baseSource: "none",
    dependencyFromLive: false,
    mappedLiveReserveWeight: null,
    fallbackReason: null,
    edges: includeParentEdge ? [parentEdge] : [],
    diagnostics: { graphState: "valid", issueCodes: [], sccMemberAssetIds: [] },
  };
  return extension;
}

function wrapperFacts(
  variantKind: "pure-wrapper" | "savings-passthrough" | "strategy-vault",
) {
  const fixed = fixedInputWithTrackedParent();
  const extension = wrapperExtension(fixed, variantKind);
  const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
  const asset = compiled.assets[0]!;
  if (asset.wrapperLocalFacts?.applicability !== "wrapper") {
    throw new Error("Expected wrapper-local facts");
  }
  return { fixed, extension, asset, facts: asset.wrapperLocalFacts };
}

describe("Safety Score V9 wrapper fact dispositions", () => {
  it("withholds reviewed mixed-book backing for any asset ID while preserving other wrappers' inheritance, caps, peg and supply", () => {
    const fixed = makeV9CohortFixedInput(["susd1plus-lorenzo"]);
    const edge: V9ExtensionDependencyEdge = {
      upstreamAssetId: "alpha",
      dependencyType: "wrapper",
      weight: 1,
      economicRole: "serial-claim",
      failureDomains: [],
    };
    const extension = makeV9RoleExtension(fixed, {
      beta: [edge],
      "susd1plus-lorenzo": [edge],
    });
    for (const asset of extension.assets.filter((asset) => asset.assetId !== "alpha")) {
      asset.variantKind = "strategy-vault";
      asset.dependencies!.source = "variant";
      const review = asset.mechanismRiskReview;
      if (review?.archetype !== "fiat-cash") throw new Error("Expected fiat review fixture");
      review.claimAndSegregation.quality = "weak";
      review.custodyContinuity.quality = "weak";
      review.assuranceAndReconciliation.quality = "weak";
    }
    // Deliberately attach the review to a different ID: the former exception
    // asset inherits normally when no withholding review is authored.
    extension.assets.find((asset) => asset.assetId === "beta")!.parentBackingInheritance =
      ParentBackingInheritanceSchema.parse(lorenzoMeta.parentBackingInheritance);
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1);
    const strategy = evaluated.assets.find((asset) => asset.assetId === "beta")!;
    const wrapper = evaluated.assets.find((asset) => asset.assetId === "susd1plus-lorenzo")!;
    const parent = evaluated.assets.find((asset) => asset.assetId === "alpha")!;
    expect(wrapper.backing.contributions).toContainEqual(expect.objectContaining({
      componentKey: "reserve:inherited-backing:alpha",
    }));
    expect(strategy.backing.contributions.some((entry) => entry.componentKey.startsWith("reserve:inherited-backing:")))
      .toBe(false);
    expect(strategy.backing.score!).toBeLessThan(wrapper.backing.score!);
    expect(strategy.trace.wrapperParentLimit?.parentScore).toBe(parent.trace.inheritableScore);
    const strategyFacts = compiled.assets.find((asset) => asset.assetId === strategy.assetId)!;
    const wrapperFacts = compiled.assets.find((asset) => asset.assetId === wrapper.assetId)!;
    expect(strategyFacts.dependencies.edges[0]).toMatchObject({
      upstreamAssetId: "alpha", economicRole: "serial-claim", weight: 1,
    });
    expect(strategyFacts.peg.pegScore).toBe(wrapperFacts.peg.pegScore);
    expect(strategyFacts.peg.activeDepegBps).toBe(wrapperFacts.peg.activeDepegBps);
    expect(strategyFacts.supply?.circulatingUsd).toBe(wrapperFacts.supply?.circulatingUsd);
    expect(strategyFacts.variantKind).toBe("strategy-vault");
  });

  it("marks an unprofiled direct serial wrapper's local custody classes not-applicable", () => {
    for (const variantKind of ["pure-wrapper", "savings-passthrough"] as const) {
      const { facts } = wrapperFacts(variantKind);

      expect(facts.facts).toMatchObject({
        custodyEscrow: { disposition: "not-applicable" },
        leverage: { disposition: "not-applicable" },
        rehypothecationCorrelation: { disposition: "not-applicable" },
      });
      expect(facts.facts.custodyEscrow.disposition).not.toBe("issuer-undisclosed");
      expect(facts.facts.leverage.disposition).not.toBe("issuer-undisclosed");
      expect(facts.facts.rehypothecationCorrelation.disposition).not.toBe("issuer-undisclosed");
    }
  });

  it.each(["pure-wrapper", "savings-passthrough"] as const)(
    "keeps an uncorroborated onchain %s custody profile conservative",
    (variantKind) => {
      const fixed = fixedInputWithTrackedParent();
      const extension = wrapperExtension(fixed, variantKind);
      extension.assets.find((asset) => asset.assetId === "alpha")!.wrapperCustodyReview = {
        custodyModel: "onchain",
        providers: [{ providerKey: "wrapper-contract", role: "custodian", shareFraction: null }],
        segregation: "unknown",
        bankruptcyRemoteness: "unknown",
        rehypothecation: "unknown",
        knownUnknownExposureShare: 1,
      };

      const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
      const asset = compiled.assets.find((asset) => asset.assetId === "alpha")!;
      if (asset.wrapperLocalFacts?.applicability !== "wrapper") throw new Error("Expected wrapper-local facts");
      expect(asset.wrapperLocalFacts.facts).toMatchObject({
        custodyEscrow: { disposition: "issuer-undisclosed", assessment: null },
        rehypothecationCorrelation: { disposition: "issuer-undisclosed", assessment: null },
      });
    },
  );

  it.each([
    "cex",
    "institutional-top",
    "institutional-regulated",
    "institutional-unregulated",
    "institutional-sanctioned",
    "mixed",
    "unknown",
  ] as const)(
    "keeps an incomplete %s custody profile issuer-undisclosed for a direct wrapper",
    (custodyModel) => {
      const fixed = fixedInputWithTrackedParent();
      const extension = wrapperExtension(fixed, "savings-passthrough");
      extension.assets.find((asset) => asset.assetId === "alpha")!.wrapperCustodyReview = {
        custodyModel,
        providers: [{ providerKey: "custody-provider", role: "custodian", shareFraction: null }],
        segregation: "unknown",
        bankruptcyRemoteness: "unknown",
        rehypothecation: "unknown",
        knownUnknownExposureShare: null,
      };

      const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
      const asset = compiled.assets.find((asset) => asset.assetId === "alpha")!;
      if (asset.wrapperLocalFacts?.applicability !== "wrapper") throw new Error("Expected wrapper-local facts");
      expect(asset.wrapperLocalFacts.facts).toMatchObject({
        custodyEscrow: { disposition: "issuer-undisclosed", assessment: null },
        rehypothecationCorrelation: { disposition: "issuer-undisclosed", assessment: null },
      });
    },
  );

  it.each([
    ["strategy-vault", true],
    ["savings-passthrough", false],
  ] as const)("does not waive custody for onchain %s with a tracked parent edge of %s", (variantKind, includeParentEdge) => {
    const fixed = fixedInputWithTrackedParent();
    const extension = wrapperExtension(fixed, variantKind, includeParentEdge);
    extension.assets.find((asset) => asset.assetId === "alpha")!.wrapperCustodyReview = {
      custodyModel: "onchain",
      providers: [{ providerKey: "wrapper-contract", role: "other", shareFraction: null }],
      segregation: "unknown",
      bankruptcyRemoteness: "unknown",
      rehypothecation: "unknown",
      knownUnknownExposureShare: null,
    };

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
    const asset = compiled.assets.find((asset) => asset.assetId === "alpha")!;
    if (asset.wrapperLocalFacts?.applicability !== "wrapper") throw new Error("Expected wrapper-local facts");
    expect(asset.wrapperLocalFacts.facts).toMatchObject({
      custodyEscrow: { disposition: "issuer-undisclosed", assessment: null },
      rehypothecationCorrelation: { disposition: "issuer-undisclosed", assessment: null },
    });
  });

  it("keeps an applicable strategy-vault custody review issuer-undisclosed when no profile is published", () => {
    const { facts } = wrapperFacts("strategy-vault");

    expect(facts.facts.custodyEscrow).toMatchObject({
      disposition: "issuer-undisclosed",
      assessment: null,
    });
  });

  it("deduplicates repeated leverage findings across distinct reserve slices", () => {
    const { fixed, extension, asset } = wrapperFacts("strategy-vault");
    const context = createAssetBuildContext(
      fixed,
      extension,
      extension.assets.find((candidate) => candidate.assetId === "alpha")!,
      "a".repeat(64),
    );
    const reserveExposures = (["leverage", "leverage"] as const).map((factor, index) => ({
      ...structuredClone(asset.reserveExposures[0]!),
      exposureKey: `alpha:reserve:${index}`,
      riskFactors: [factor],
      weight: 0.5,
    }));

    const facts = buildWrapperLocalFacts(context, {
      implementation: asset.implementation,
      dependencies: asset.dependencies,
      reserveStatus: asset.reserveStatus,
      reserveExposures,
      exitStatus: asset.exitStatus,
      exitRoutes: asset.exitRoutes,
      controlStatus: asset.controlStatus,
      controls: asset.controls,
      economicControlReview: asset.economicControlReview,
      peg: asset.peg,
      supply: asset.supply,
    });
    if (facts.applicability !== "wrapper") throw new Error("Expected wrapper-local facts");

    expect(facts.facts.leverage).toMatchObject({
      disposition: "reviewed",
      assessment: "high",
      signals: ["wrapper-leverage-factor:leverage"],
    });
  });

  it("preserves a reviewed high rehypothecation finding when allocation review is available", () => {
    const fixed = fixedInputWithTrackedParent();
    const extension = wrapperExtension(fixed, "savings-passthrough");
    const asset = extension.assets.find((candidate) => candidate.assetId === "alpha")!;
    asset.wrapperCustodyReview = {
      custodyModel: "unknown",
      providers: [{ providerKey: "reviewed-provider", role: "other", shareFraction: 1 }],
      segregation: "segregated",
      bankruptcyRemoteness: "structured",
      rehypothecation: "permitted",
      knownUnknownExposureShare: 0,
    };
    asset.wrapperAllocationReview = {
      assetId: "alpha",
      reviewedAt: "2026-08-23",
      expiresAt: "2026-09-23",
      reviewer: "test-fixture",
      custody: "fully-onchain-no-offchain-custodian",
      scopeKind: "whole-allocation",
      localLeverage: "no-borrowing-surface",
      capitalReuse: "none",
      rationale: "Fixture allocation would resolve an unavailable fact to none.",
      observations: [
        {
          chain: "ethereum",
          address: "0x0000000000000000000000000000000000000001",
          function: "fixture()",
          value: "none",
          block: 1,
        },
      ],
      sources: [{ label: "Fixture", url: "https://example.com/allocation" }],
    };

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
    const compiledAsset = compiled.assets.find((candidate) => candidate.assetId === "alpha")!;
    if (compiledAsset.wrapperLocalFacts?.applicability !== "wrapper") {
      throw new Error("Expected wrapper-local facts");
    }

    expect(compiledAsset.wrapperLocalFacts.facts.rehypothecationCorrelation).toMatchObject({
      disposition: "reviewed",
      assessment: "high",
      signals: ["wrapper-custody-provider-count:1", "wrapper-rehypothecation:permitted"],
    });
  });

  it("fails closed to issuer-undisclosed when the tracked parent edge is absent", () => {
    // Without a serial parent edge we cannot prove the wrapper is a direct
    // pass-through, so the conservative dispositions must survive. Compilation
    // must also still succeed: a missing edge is a registry-completeness
    // condition, and aborting here would take the asset's unrelated facts down
    // with it. An earlier assertion did exactly that, and a wM fixture lost its
    // whole supply observation, reporting missing-pillar-evidence instead of its
    // real bridge-route gap.
    const fixed = fixedInputWithTrackedParent();
    const extension = wrapperExtension(fixed, "pure-wrapper", false);
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
    const asset = compiled.assets[0]!;

    expect(asset.wrapperLocalFacts?.applicability).toBe("wrapper");
    if (asset.wrapperLocalFacts?.applicability !== "wrapper") return;
    for (const factKey of ["custodyEscrow", "leverage", "rehypothecationCorrelation"] as const) {
      expect(asset.wrapperLocalFacts.facts[factKey].disposition).not.toBe("not-applicable");
    }

    // The rest of the asset still compiled.
    expect(asset.supply).toBeDefined();
    expect(asset.assetId).toBe("alpha");
  });
});
