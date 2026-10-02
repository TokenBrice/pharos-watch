import { afterEach, describe, expect, it, vi } from "vitest";
import reviews from "@shared/data/safety-score-v9/supply-attribution-reviews-v1.json";
import { ReviewedProviderRowExclusionSchema } from "@shared/types/safety-score-v9-supply-attribution";
import { unresolvedDeploymentCohort } from "@shared/lib/safety-score-v9/control-bridge-join";
import type { V9EconomicControlAssetFacts } from "@shared/lib/safety-score-v9/control-primitives";
import type { BridgeRouteRiskProfile } from "@shared/types/core";
import type { SafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import type { SafetyScoreV9FactSetExtensionV2 } from "../safety-score-v9/fact-set-schema";
import { evaluateV9EconomicControlAssetFacts } from "@shared/lib/safety-score-v9/control";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { boundedUnknown, makeDeploymentControl, makeEconomicControlFacts, noBridgeReview, noMintReview, noOracleReview, requiredKnown } from "@shared/lib/__tests__/safety-score-v9-fixtures.test-support";
import { adaptBridgeReview } from "../safety-score-v9/extension-bridge";
import { ReviewEvidenceBuilder, type V9ExtensionRegistryMeta } from "../safety-score-v9/extension-shared";

const original = structuredClone(reviews.providerRowExclusionReviews);
const registryPath = "@shared/data/safety-score-v9/supply-attribution-reviews-v1.json";
let authoredExclusions = structuredClone(original);
afterEach(() => {
  authoredExclusions = structuredClone(original);
  vi.doUnmock(registryPath);
  vi.resetModules();
});
const profile = { routes: [{ id: "ethereum:native", reviewDisposition: "reviewed", routeClass: "native", issuanceModel: "native-issuance" }] } as unknown as BridgeRouteRiskProfile;
function input() {
  return {
    clockSec: original[0]!.reviewedAtSec + 1,
    aggregateCirculatingById: { "frax-frax": { circulating: { peggedUSD: 100 } } },
    chainCirculatingById: { "frax-frax": { Ethereum: { current: 70 }, Fraxtal: { current: 10 }, Optimism: { current: 20 } } },
  } as unknown as SafetyScoreV9CompilerInput;
}
async function build(fixedInput = input(), risk = profile) {
  vi.resetModules();
  vi.doMock(registryPath, () => ({ default: { ...reviews, providerRowExclusionReviews: authoredExclusions } }));
  // Cold-import each registry fixture: a static import would retain the previously admitted evidence.
  const { buildSafetyScoreV9SupplyReview } = await import("../safety-score-v9/extension-supply");
  return buildSafetyScoreV9SupplyReview(fixedInput, "frax-frax", risk)!;
}
function cohort(review: NonNullable<SafetyScoreV9FactSetExtensionV2["assets"][number]["supplyReview"]>) {
  return unresolvedDeploymentCohort({ assetId: "frax-frax", supply: {
    ...review, status: { applicability: { state: "required" }, observationState: "known" },
  } } as unknown as V9EconomicControlAssetFacts, []).share;
}

describe("reviewed attribution-only provider-row exclusion", () => {
  it("admits verified FRAX identity and removes only its unresolved numerator over the unchanged aggregate", async () => {
    expect(ReviewedProviderRowExclusionSchema.safeParse(original[0]).success).toBe(true);
    const fixed = input();
    const snapshot = JSON.stringify(fixed);
    const admitted = await build(fixed);
    authoredExclusions = [];
    const baseline = await build(fixed);
    expect(cohort(baseline)).toBeCloseTo(0.3);
    expect(cohort(admitted)).toBeCloseTo(0.2);
    const { providerRowExclusions, ...unchanged } = admitted;
    expect(unchanged).toEqual(baseline);
    expect(providerRowExclusions).toEqual([expect.objectContaining({ supplyShare: 0.1, deploymentRouteKey: "unmatched-chain:frax-frax:fraxtal" })]);
    expect(JSON.stringify(fixed)).toBe(snapshot);
    expect(fixed.aggregateCirculatingById["frax-frax"]).toEqual({ circulating: { peggedUSD: 100 } });
    expect(admitted.selectedBridgeRoutes.find(row => row.deploymentRouteKey.endsWith(":optimism"))!.supplyShare).toBe(0.2);
  });

  it("uses the admitted cohort consistently through the asset control evaluator across the full-ceiling threshold", async () => {
    const fixed = input();
    fixed.chainCirculatingById["frax-frax"] = { Ethereum: { current: 80 }, Fraxtal: { current: 10 }, Optimism: { current: 10 } };
    const supply = await build(fixed);
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

  it.each([false, true])("excludes foreign supply from bridge numerators, retaining genuine rows (unreviewed route: %s)", async (unreviewed) => {
    const fixed = input();
    const foreignUsd = unreviewed ? 16 : 10.09;
    fixed.chainCirculatingById["frax-frax"] = { Ethereum: { current: 98 - foreignUsd }, Fraxtal: { current: foreignUsd }, Optimism: { current: 2 } };
    const risk = { ...profile, confidence: "verified", reviewedAt: "2026-10-01", routes: [
      ...profile.routes!, ...(unreviewed ? [{
        id: `fraxtal:${original[0]!.contractAddress}`, contractAddress: original[0]!.contractAddress,
        reviewDisposition: "unreviewed", routeClass: "canonical", issuanceModel: "bridge-representation", riskTier: "opaque-or-unknown",
      }] : []),
    ] } as BridgeRouteRiskProfile;
    const supply = await build(fixed, risk);
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
    ["future review", { reviewedAtSec: original[0]!.reviewedAtSec + 2 }],
    ["expired review", { expiresAtSec: original[0]!.reviewedAtSec + 1 }],
  ])("ignores %s with a byte-identical absent-record outcome", async (_name, patch) => {
    Object.assign(authoredExclusions[0]!, patch);
    const rejected = JSON.stringify(await build());
    authoredExclusions = [];
    expect(rejected).toBe(JSON.stringify(await build()));
  });

  it("quarantines malformed proof with the exact evidence path", async () => {
    authoredExclusions[0]!.reviewer = "";
    await expect(build()).rejects.toMatchObject({
      name: "ReviewedRegistryEntryError",
      path: "supplyAttribution.providerRowExclusionReviews.0.reviewer",
    });
  });

  it("does not renormalise a provider partition that differs from the aggregate", async () => {
    const fixed = input();
    fixed.aggregateCirculatingById["frax-frax"] = { circulating: { peggedUSD: 120 }, observedAtSec: null };
    const rejected = JSON.stringify(await build(fixed));
    authoredExclusions = [];
    expect(rejected).toBe(JSON.stringify(await build(fixed)));
    expect(fixed.aggregateCirculatingById["frax-frax"]).toEqual({ circulating: { peggedUSD: 120 }, observedAtSec: null });
  });

  it("admits a policy-tolerated conservation tail without renormalising facts or the aggregate denominator", async () => {
    const fixed = input();
    const aggregate = 100 + 1e-8;
    fixed.aggregateCirculatingById["frax-frax"] = { circulating: { peggedUSD: aggregate }, observedAtSec: null };
    const captured = JSON.stringify(fixed);
    const admitted = await build(fixed);
    expect(cohort(admitted)).toBeCloseTo(0.2);
    expect(admitted.providerRowExclusions![0]!.supplyShare).toBe(10 / aggregate);
    const { providerRowExclusions: _exclusions, ...unchanged } = admitted;
    authoredExclusions = [];
    expect(unchanged).toEqual(await build(fixed));
    expect(JSON.stringify(fixed)).toBe(captured);
  });

  it("retains an asset's own same-chain legacy deployment instead of excluding its route", async () => {
    const legacyProfile = { routes: [...profile.routes!, { id: "fraxtal:0xff000000000000000000000000000000000001fd", reviewDisposition: "unreviewed", routeClass: "canonical", issuanceModel: "bridge-representation" }] } as unknown as BridgeRouteRiskProfile;
    const retained = await build(input(), legacyProfile);
    expect(retained.providerRowExclusions).toBeUndefined();
    expect(cohort(retained)).toBeCloseTo(0.3);
    expect(retained.selectedBridgeRoutes.find(row => row.deploymentRouteKey.includes("0xff"))).toMatchObject({ supplyUsd: 10, supplyShare: 0.1, reviewState: "selected-unresolved" });
  });
});
