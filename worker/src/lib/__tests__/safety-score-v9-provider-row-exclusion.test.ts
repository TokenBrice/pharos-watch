import { afterEach, describe, expect, it } from "vitest";
import reviews from "@shared/data/safety-score-v9/supply-attribution-reviews-v1.json";
import { ReviewedProviderRowExclusionSchema } from "@shared/types/safety-score-v9-supply-attribution";
import { unresolvedDeploymentCohort } from "@shared/lib/safety-score-v9/control-bridge-join";
import type { V9EconomicControlAssetFacts } from "@shared/lib/safety-score-v9/control-primitives";
import type { BridgeRouteRiskProfile } from "@shared/types/core";
import { buildSafetyScoreV9SupplyReview } from "../safety-score-v9/extension-supply";
import type { SafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import type { SafetyScoreV9FactSetExtensionV2 } from "../safety-score-v9/fact-set-schema";
import { evaluateV9EconomicControlAssetFacts } from "@shared/lib/safety-score-v9/control";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { boundedUnknown, makeDeploymentControl, makeEconomicControlFacts, noBridgeReview, noMintReview, noOracleReview, requiredKnown } from "@shared/lib/__tests__/safety-score-v9-fixtures.test-support";
import { adaptBridgeReview } from "../safety-score-v9/extension-bridge";
import { ReviewEvidenceBuilder, type V9ExtensionRegistryMeta } from "../safety-score-v9/extension-shared";

const original = structuredClone(reviews.providerRowExclusionReviews);
afterEach(() => { reviews.providerRowExclusionReviews = structuredClone(original); });
const profile = { routes: [{ id: "ethereum:native", reviewDisposition: "reviewed", routeClass: "native", issuanceModel: "native-issuance" }] } as unknown as BridgeRouteRiskProfile;
function input() {
  return {
    clockSec: original[0]!.reviewedAtSec + 1,
    aggregateCirculatingById: { "frax-frax": { circulating: { peggedUSD: 100 } } },
    chainCirculatingById: { "frax-frax": { Ethereum: { current: 70 }, Fraxtal: { current: 10 }, Optimism: { current: 20 } } },
  } as unknown as SafetyScoreV9CompilerInput;
}
function build(fixedInput = input(), risk = profile) { return buildSafetyScoreV9SupplyReview(fixedInput, "frax-frax", risk)!; }
function cohort(review: NonNullable<SafetyScoreV9FactSetExtensionV2["assets"][number]["supplyReview"]>) {
  return unresolvedDeploymentCohort({ assetId: "frax-frax", supply: {
    ...review, status: { applicability: { state: "required" }, observationState: "known" },
  } } as unknown as V9EconomicControlAssetFacts, []).share;
}

describe("reviewed attribution-only provider-row exclusion", () => {
  it("admits verified FRAX identity and removes only its unresolved numerator over the unchanged aggregate", () => {
    expect(ReviewedProviderRowExclusionSchema.safeParse(original[0]).success).toBe(true);
    const fixed = input();
    const snapshot = JSON.stringify(fixed);
    const admitted = build(fixed);
    reviews.providerRowExclusionReviews = [];
    const baseline = build(fixed);
    expect(cohort(baseline)).toBeCloseTo(0.3);
    expect(cohort(admitted)).toBeCloseTo(0.2);
    const { providerRowExclusions, ...unchanged } = admitted;
    expect(unchanged).toEqual(baseline);
    expect(providerRowExclusions).toEqual([expect.objectContaining({ supplyShare: 0.1, deploymentRouteKey: "unmatched-chain:frax-frax:fraxtal" })]);
    expect(JSON.stringify(fixed)).toBe(snapshot);
    expect(fixed.aggregateCirculatingById["frax-frax"]).toEqual({ circulating: { peggedUSD: 100 } });
    expect(admitted.selectedBridgeRoutes.find(row => row.deploymentRouteKey.endsWith(":optimism"))!.supplyShare).toBe(0.2);
  });

  it("uses the admitted cohort consistently through the asset control evaluator across the full-ceiling threshold", () => {
    const fixed = input();
    fixed.chainCirculatingById["frax-frax"] = { Ethereum: { current: 80 }, Fraxtal: { current: 10 }, Optimism: { current: 10 } };
    const supply = build(fixed);
    const controls = supply.selectedBridgeRoutes.filter(row => row.reviewState === "unmatched").map(row =>
      makeDeploymentControl(`bridge:${row.deploymentRouteKey}`, "bridge", {
        deploymentKey: row.deploymentRouteKey, scope: "deployment", economicLossScope: "deployment",
        materialSupplyShare: row.supplyShare, status: boundedUnknown(row.deploymentRouteKey),
      }));
    const facts = {
      ...makeEconomicControlFacts(controls), assetId: "frax-frax", controlStatus: boundedUnknown("controls"),
      supply: { ...supply, status: requiredKnown("supply") },
    };
    const review = { assetId: facts.assetId, mint: noMintReview(), oracle: noOracleReview(), bridge: noBridgeReview() };
    const admitted = evaluateV9EconomicControlAssetFacts(facts, review, V9_CANDIDATE_POLICY_V1);
    const { providerRowExclusions: _exclusions, ...baselineSupply } = facts.supply;
    const baseline = evaluateV9EconomicControlAssetFacts({ ...facts, supply: baselineSupply }, review, V9_CANDIDATE_POLICY_V1);
    expect(unresolvedDeploymentCohort(facts, controls).share).toBeCloseTo(0.1);
    expect(unresolvedDeploymentCohort({ ...facts, supply: baselineSupply }, controls).share).toBeCloseTo(0.2);
    expect(baseline.reasons).toContainEqual(expect.objectContaining({ code: "unresolved-control-identity", path: "controls", controlKey: null }));
    expect(admitted.reasons).not.toContainEqual(expect.objectContaining({ code: "unresolved-control-identity", path: "controls", controlKey: null }));
    expect(admitted.controlFacts).toEqual(baseline.controlFacts);
  });

  it.each([false, true])("excludes foreign supply from bridge numerators, retaining genuine rows (unreviewed route: %s)", (unreviewed) => {
    const fixed = input();
    const foreignUsd = unreviewed ? 16 : 10.09;
    fixed.chainCirculatingById["frax-frax"] = { Ethereum: { current: 98 - foreignUsd }, Fraxtal: { current: foreignUsd }, Optimism: { current: 2 } };
    const risk = { ...profile, confidence: "verified", reviewedAt: "2026-10-01", routes: [
      ...profile.routes!, ...(unreviewed ? [{
        id: `fraxtal:${original[0]!.contractAddress}`, contractAddress: original[0]!.contractAddress,
        reviewDisposition: "unreviewed", routeClass: "canonical", issuanceModel: "bridge-representation", riskTier: "opaque-or-unknown",
      }] : []),
    ] } as BridgeRouteRiskProfile;
    const supply = build(fixed, risk);
    const { providerRowExclusions: _exclusions, ...baselineSupply } = supply;
    const meta = { id: "frax-frax", bridgeRouteRisk: risk } as V9ExtensionRegistryMeta;
    const adapt = (review: NonNullable<SafetyScoreV9FactSetExtensionV2["assets"][number]["supplyReview"]>) =>
      adaptBridgeReview(meta, review, 3, new ReviewEvidenceBuilder(meta.id, fixed.clockSec), fixed.clockSec);
    const baselineBridge = adapt(baselineSupply);
    const admittedBridge = adapt(supply);
    const controls = baselineBridge.controls.map(overlay => makeDeploymentControl(overlay.controlKey, overlay.controlKind, {
      ...overlay, status: boundedUnknown(overlay.controlKey),
    }));
    const facts = {
      ...makeEconomicControlFacts(controls), assetId: meta.id, controlStatus: boundedUnknown("controls"),
      supply: { ...supply, status: requiredKnown("supply") },
    };
    const review = { assetId: meta.id, mint: noMintReview(), oracle: noOracleReview(), bridge: baselineBridge.review };
    const baseline = evaluateV9EconomicControlAssetFacts({ ...facts, supply: { ...baselineSupply, status: requiredKnown("supply") } }, review, V9_CANDIDATE_POLICY_V1);
    const admitted = evaluateV9EconomicControlAssetFacts(facts, review, V9_CANDIDATE_POLICY_V1);
    expect(baseline.reasons).toContainEqual(expect.objectContaining({
      code: unreviewed ? "runtime-bridge-materiality-unavailable" : "material-bridge-supply-unmatched",
    }));
    expect(admitted.reasons).not.toContainEqual(expect.objectContaining({ code: "material-bridge-supply-unmatched", path: "bridge:supply" }));
    expect(admitted.reasons).not.toContainEqual(expect.objectContaining({ code: "runtime-bridge-materiality-unavailable" }));
    expect(admittedBridge.review.status.observationState).toBe("known");
    expect(admittedBridge.review.diagnostics?.unprovenRouteJoins).toEqual([]);
    expect(admittedBridge.controls).toEqual(baselineBridge.controls);
    expect(unresolvedDeploymentCohort(facts, facts.controls).share).toBeCloseTo(0.02);
    expect(facts.supply.unknownRouteSupplyShare).toBeCloseTo(unreviewed ? 0.02 : 0.1209);
    expect(facts.supply.unreviewedRouteSupplyShare).toBeCloseTo(unreviewed ? 0.16 : 0);
    expect(facts.supply.selectedBridgeRoutes.find(row => row.deploymentRouteKey.endsWith(":optimism"))).toMatchObject({ supplyShare: 0.02, supplyUsd: 2 });
  });

  it.each([
    ["label mismatch", { providerChainLabel: "fraxtal" }],
    ["target mismatch", { belongsToAssetId: "usdc-circle" }],
    ["contract mismatch", { contractAddress: "0xff000000000000000000000000000000000001fd" }],
    ["malformed proof", { reviewer: "" }],
    ["future review", { reviewedAtSec: original[0]!.reviewedAtSec + 2 }],
    ["expired review", { expiresAtSec: original[0]!.reviewedAtSec + 1 }],
  ])("ignores %s with a byte-identical absent-record outcome", (_name, patch) => {
    Object.assign(reviews.providerRowExclusionReviews[0]!, patch);
    const rejected = JSON.stringify(build());
    reviews.providerRowExclusionReviews = [];
    expect(rejected).toBe(JSON.stringify(build()));
  });

  it("does not renormalise a provider partition that differs from the aggregate", () => {
    const fixed = input();
    fixed.aggregateCirculatingById["frax-frax"] = { circulating: { peggedUSD: 120 }, observedAtSec: null };
    const rejected = JSON.stringify(build(fixed));
    reviews.providerRowExclusionReviews = [];
    expect(rejected).toBe(JSON.stringify(build(fixed)));
    expect(fixed.aggregateCirculatingById["frax-frax"]).toEqual({ circulating: { peggedUSD: 120 }, observedAtSec: null });
  });

  it("admits a policy-tolerated conservation tail without renormalising facts or the aggregate denominator", () => {
    const fixed = input();
    const aggregate = 100 + 1e-8;
    fixed.aggregateCirculatingById["frax-frax"] = { circulating: { peggedUSD: aggregate }, observedAtSec: null };
    const captured = JSON.stringify(fixed);
    const admitted = build(fixed);
    expect(cohort(admitted)).toBeCloseTo(0.2);
    expect(admitted.providerRowExclusions![0]!.supplyShare).toBe(10 / aggregate);
    const { providerRowExclusions: _exclusions, ...unchanged } = admitted;
    reviews.providerRowExclusionReviews = [];
    expect(unchanged).toEqual(build(fixed));
    expect(JSON.stringify(fixed)).toBe(captured);
  });

  it("retains an asset's own same-chain legacy deployment instead of excluding its route", () => {
    const legacyProfile = { routes: [...profile.routes!, { id: "fraxtal:0xff000000000000000000000000000000000001fd", reviewDisposition: "unreviewed", routeClass: "canonical", issuanceModel: "bridge-representation" }] } as unknown as BridgeRouteRiskProfile;
    const retained = build(input(), legacyProfile);
    expect(retained.providerRowExclusions).toBeUndefined();
    expect(cohort(retained)).toBeCloseTo(0.3);
    expect(retained.selectedBridgeRoutes.find(row => row.deploymentRouteKey.includes("0xff"))).toMatchObject({ supplyUsd: 10, supplyShare: 0.1, reviewState: "selected-unresolved" });
  });
});
