import { describe, expect, it } from "vitest";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import lorenzoMeta from "@shared/data/stablecoins/coins/susd1plus-lorenzo.json";
import { ParentBackingInheritanceSchema } from "@shared/types/stablecoin-meta-primitives";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import {
  makeV9CohortFixedInput,
  makeV9RoleExtension,
  makeV9TwoAssetFixedInput,
  type V9ExtensionDependencyEdge,
} from "../../test-helpers/v9-fixed-input";
import { normalizeFixedInput } from "../report-cards-fixed-input";
import wrapperLocalReviews from "@shared/data/safety-score-v9/wrapper-allocation-reviews-v1.json";
import { SafetyScoreV9WrapperLocalReviewSchema } from "@shared/types/safety-score-v9-wrapper-local-review";




describe("Safety Score V9 wrapper fact dispositions", () => {

  it.each(["accounting", "holder-entitlement"] as const)("rejects a %s review whose identity names a different holder instrument", (kind) => {
    const source = wrapperLocalReviews.localReviews.find((review) => review.kind === kind)!;
    expect(SafetyScoreV9WrapperLocalReviewSchema.safeParse({
      ...source, identity: { ...source.identity, assetId: "different-instrument" },
    }).success).toBe(false);
  });


  it("withholds reviewed mixed-book backing for any asset ID while preserving other wrappers' inheritance, caps, peg and supply", () => {
    const original = makeV9CohortFixedInput(["susd1plus-lorenzo"]);
    const parentHolding = {
      name: "Admitted parent token claim", pct: 100, risk: "low" as const,
      coinId: "alpha", depType: "wrapper" as const, assetClass: "stablecoin" as const,
      issuerOrObligor: "asset:alpha", liquidityHorizon: "immediate" as const,
    };
    const fixed = normalizeFixedInput({
      ...original, baseInputGenerationId: undefined,
      liveReserveMap: {
        ...original.liveReserveMap, beta: [parentHolding], "susd1plus-lorenzo": [parentHolding],
      },
    });
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

  it.each(["serial-claim", "basket-exposure"] as const)(
    "inherits %s Backing without fabricating wrapper applicability", (economicRole) => {
      const original = makeV9TwoAssetFixedInput({ omitAlphaReserve: true });
      const fixed = economicRole === "serial-claim" ? original : normalizeFixedInput({
        ...original, baseInputGenerationId: undefined,
        liveReserveMap: { ...original.liveReserveMap, alpha: [{
          name: "Admitted basket parent holding", pct: 100, risk: "low", coinId: "beta",
          depType: "collateral", assetClass: "stablecoin", issuerOrObligor: "asset:beta",
          liquidityHorizon: "immediate",
        }] },
      });
      const extension = makeV9RoleExtension(fixed, {
        alpha: [{
          upstreamAssetId: "beta", dependencyType: economicRole === "serial-claim" ? "mechanism" : "collateral",
          economicRole, weight: 1, failureDomains: [],
        }],
      });
      const alpha = extension.assets.find((asset) => asset.assetId === "alpha")!;
      alpha.variantKind = null;
      alpha.dependencies!.source = "curated-reserve";
      alpha.dependencies!.baseSource = "curated-reserve";
      const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
      const facts = compiled.assets.find((asset) => asset.assetId === "alpha")!;
      expect(facts.wrapperLocalFacts.applicability).not.toBe("wrapper");
      expect(facts.reserveExposures).toHaveLength(economicRole === "serial-claim" ? 0 : 1);
      const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1);
      const child = evaluated.assets.find((asset) => asset.assetId === "alpha")!;
      const parent = evaluated.assets.find((asset) => asset.assetId === "beta")!;
      if (economicRole === "serial-claim") expect(child.trace.wrapperParentLimit).toBeNull();
      else expect(child.trace.wrapperParentLimit).toMatchObject({ form: "pure", appliedDiscount: 3 });
      expect(child.backing.contributions).toContainEqual(expect.objectContaining({ upstreamAssetId: "beta" }));
      expect(child.backing.contributions.find(entry => entry.upstreamAssetId === "beta")!.evidenceRefIds)
        .toEqual(expect.arrayContaining(facts.dependencies.status.evidenceRefIds));
      expect(child.backing.contributions.some(entry => entry.source === "mechanism")).toBe(true);
      if (economicRole === "serial-claim") {
        expect(child.trace.finalScore!).toBeLessThanOrEqual(parent.trace.inheritableScore!);
        expect(child.dependencyInputs.serial).toContainEqual(expect.objectContaining({
          upstreamAssetId: "beta", score: parent.trace.inheritableScore,
        }));
      }
      // A variant label alone must not recreate this positive curated witness.
      alpha.dependencies!.source = "variant";
      const labelOnly = evaluateV9FactSet(
        compileSafetyScoreV9FactSetFromFixedInput(fixed, extension), V9_CANDIDATE_POLICY_V1,
      ).assets.find(asset => asset.assetId === "alpha")!;
      expect(labelOnly.backing.contributions.some(entry =>
        entry.componentKey.startsWith("reserve:inherited-backing:"))).toBe(false);
    },
  );











});

