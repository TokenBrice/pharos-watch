import { describe, expect, it, vi } from "vitest";
import { makeAsset } from "../__shared/fixtures";
import { mergeSourceRiskGoldenFixtures } from "@shared/test-utils/yield-source-risk-golden-fixtures";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../../lib/safety-score-v9/fact-set";
import { createReportCardsFixedInput } from "../../lib/report-cards-fixed-input";
import { makeV9FixedInput, v9RouteReview } from "../v9-fixed-input-core";
import { makeV9Extension, makeV9RoleExtension, v9ExtensionRoleEdge } from "../v9-fixed-input-extensions";
import { makeV9TwoAssetFixedInput, withV9WmReviewedDeploymentAttribution } from "../v9-fixed-input-variants";
import { mockRegistry } from "../cron/mock-registry";

describe("makeAsset", () => {
  it("builds without reading the wall clock", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(9_999_999_999_000);

    makeAsset();
    expect(now).not.toHaveBeenCalled();

    now.mockRestore();
  });
});

describe("V9 fixture isolation and coherence", () => {
  it("isolates mechanism components within and across role clones and later builds", () => {
    const extension = makeV9RoleExtension(makeV9TwoAssetFixedInput(), {});
    const review = extension.assets[0]!.mechanismRiskReview;
    if (review?.archetype !== "fiat-cash") throw new Error(`unexpected archetype ${review?.archetype}`);
    review.claimAndSegregation.status.evidenceRefIds.push("changed");
    review.claimAndSegregation.failureDomains[0]!.key = "changed";
    const clonedReview = extension.assets[1]!.mechanismRiskReview;
    if (clonedReview?.archetype !== "fiat-cash") throw new Error(`unexpected archetype ${clonedReview?.archetype}`);
    const laterReview = makeV9Extension().assets[0]!.mechanismRiskReview!;
    if (laterReview.archetype !== "fiat-cash") throw new Error(`unexpected archetype ${laterReview.archetype}`);
    for (const peer of [
      review.custodyContinuity,
      review.assuranceAndReconciliation,
      clonedReview.claimAndSegregation,
      laterReview.claimAndSegregation,
    ]) {
      expect(peer.status.evidenceRefIds).not.toContain("changed");
      expect(peer.failureDomains[0]!.key).toBe("issuer:alpha");
    }
  });

  it.each([undefined, 49_950])("keeps custom-clock role evidence fresh (observation %s)", (observedAtSec) => {
    const fixed = makeV9TwoAssetFixedInput({ clockSec: 50_000 });
    const selectedTime = observedAtSec ?? 49_900;
    const extension = makeV9RoleExtension(fixed, {
      alpha: [v9ExtensionRoleEdge("beta", "exit-dependency")],
    }, observedAtSec);
    expect(extension.registryFingerprint).toBe(fixed.registryFingerprint);
    expect(extension.compiledAtSec).toBe(50_001);
    expect(extension.sources.chainSupply.observedAtSec).toBe(selectedTime);
    expect(extension.assets[0]!.researchEvidence![0]!.observedAtSec).toBe(selectedTime);
    for (const asset of extension.assets) {
      const output = asset.routeReviews[0]!.output;
      if (output === null) throw new Error("expected route output");
      expect(output.valuation!.observedAtSec).toBe(selectedTime);
    }
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
    expect(compiled.assets[0]!.evidence.find((evidence) => evidence.sourceId === "fixture.role-dependencies")!.freshness.state)
      .toBe("current");
  });

  it("uses the selected chain in both observed and reviewed failure domains", () => {
    const fixed = makeV9FixedInput({ routeChain: "arbitrum" });
    const observation = fixed.dexLiqMap.alpha!.exitRouteObservations![0]!;
    expect(observation.commonModeKeys).toContain("chain:arbitrum");
    expect(observation.commonModeKeys).not.toContain("chain:ethereum");
    expect(v9RouteReview("dex:primary", 9_900, "arbitrum").failureDomains).toContainEqual({
      kind: "chain", key: "arbitrum",
    });
    expect(makeV9Extension({ routeChain: "arbitrum" }).assets[0]!.routeReviews[0]!.failureDomains)
      .toContainEqual({ kind: "chain", key: "arbitrum" });
  });

  it("preserves another asset's attribution when attaching wM evidence", () => {
    const fixed = withV9WmReviewedDeploymentAttribution(makeV9FixedInput({
      assetId: "wm-m0", clockSec: 1_800_000_000,
      aggregateCirculating: { peggedUSD: 87_020_618.58982982 },
    }));
    const other = {
      model: "canonical-lock-mint-partition-v1" as const,
      observedAtSec: fixed.clockSec - 100,
      currentSupplyUsdByChain: { ethereum: 60, arbitrum: 40 },
    };
    fixed.activeAssetIds.push("beta");
    fixed.dexLiqMap.beta = structuredClone(fixed.dexLiqMap["wm-m0"]!);
    fixed.resolvedBlacklistStatuses.beta = fixed.resolvedBlacklistStatuses["wm-m0"]!;
    fixed.aggregateCirculatingById.beta = {
      ...fixed.aggregateCirculatingById["wm-m0"]!,
      circulating: { peggedUSD: 100 },
    };
    fixed.safetyScoreV9SupplyAttributionById = { beta: other };
    const { baseInputGenerationId: _generation, ...draft } = fixed;
    const enriched = withV9WmReviewedDeploymentAttribution(createReportCardsFixedInput(draft));
    expect(enriched.safetyScoreV9SupplyAttributionById!.beta).toEqual(other);
    expect(enriched.safetyScoreV9SupplyAttributionById!["wm-m0"]).toBeDefined();
  });
});

it("keeps frozen registry identities readable but never active", () => {
  const frozen = { id: "archived", name: "Archived coin" };
  const registry = mockRegistry({ stablecoins: [{ id: "live" }], frozenStablecoins: [frozen] });
  expect(registry.READABLE_STABLECOINS).toContainEqual(frozen);
  expect(registry.READABLE_IDS.has("archived")).toBe(true);
  expect(registry.READABLE_META_BY_ID.get("archived")).toEqual(frozen);
  expect(registry.ACTIVE_IDS.has("archived")).toBe(false);
  expect(registry.ACTIVE_META_BY_ID.has("archived")).toBe(false);
  expect(registry.ACTIVE_STABLECOINS).toEqual([{ id: "live" }]);
});

describe("golden risk evidence merge", () => {
  it("preserves additive inputs and flags regardless of label order", () => {
    const expected = { sourceRiskPenalty: 1.65 };
    const forward = mergeSourceRiskGoldenFixtures(["reward-heavy", "stale-source-age"], expected);
    const reverse = mergeSourceRiskGoldenFixtures(["stale-source-age", "reward-heavy"], expected);
    for (const risk of [forward, reverse]) {
      expect(risk).toMatchObject({ rewardShare: 0.9, sourceAgeSeconds: 25_200, sourceRiskPenalty: 1.65 });
      expect(risk.investabilityFlags).toEqual(expect.arrayContaining(["reward-heavy", "stale-source-age"]));
    }
  });

  it("rejects an empty selection instead of returning an incomplete risk", () => {
    expect(() => mergeSourceRiskGoldenFixtures([], { sourceRiskPenalty: 1 })).toThrow();
  });
});
