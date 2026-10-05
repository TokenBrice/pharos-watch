import { describe, expect, it } from "vitest";
import type { MintAuthorityProfile } from "@shared/types";
import stkGhoAuthority from "@shared/data/stablecoins/domains/mint-authority/stkgho-umbrella-aave.json";
import lorenzoMeta from "@shared/data/stablecoins/coins/susd1plus-lorenzo.json";
import { ParentBackingInheritanceSchema } from "@shared/types/stablecoin-meta-schemas";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import type { AssetExtension, SafetyScoreV9FactSetExtensionV2 } from "../safety-score-v9/fact-set-schema";
import { createAssetBuildContext } from "../safety-score-v9/fact-set-context";
import { normalizeSafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import { buildWrapperLocalFacts } from "../safety-score-v9/fact-set-wrapper";
import type { V9ExitRouteFactV2 } from "@shared/types/safety-score-v9-facts";
import { computeV9FactSetDigest } from "@shared/lib/safety-score-v9/facts";
import { buildSafetyScoreV9RouteReviews } from "../safety-score-v9/extension-routes";
import { makeV9RoleExtension, makeV9TwoAssetFixedInput, makeV9QueuedRedemptionFixedInput, v9Status } from "../../test-helpers/v9-fixed-input";
import { alphaMeta, localControl, metaMap, rebuildFixed, type FixedInput } from "./safety-score-v9-fact-set.test-support";

interface WrapperFixture {
  fixed: FixedInput;
  extension: SafetyScoreV9FactSetExtensionV2;
  wrapper: AssetExtension;
}

function wrapperFixture(variantKind: "strategy-vault" | "risk-absorption" | "savings-passthrough"): WrapperFixture {
  const draft = makeV9TwoAssetFixedInput({ clockSec: Date.parse("2026-10-02T00:00:00Z") / 1_000 });
  draft.aggregateCirculatingById.beta = structuredClone(draft.aggregateCirculatingById.alpha!);
  draft.liveReserveMap.alpha = [{
    name: "Direct parent receipt",
    pct: 100,
    risk: "low",
    coinId: "beta",
    depType: "wrapper",
    assetClass: "protocol-position",
    issuerOrObligor: "asset:beta",
    riskFactors: ["smart-contract"],
    liquidityHorizon: "immediate",
  }];
  const fixed = rebuildFixed(draft);
  const extension = makeV9RoleExtension(fixed, {
    alpha: [{ upstreamAssetId: "beta", dependencyType: "wrapper", economicRole: "serial-claim", weight: 1, failureDomains: [] }],
  });
  const wrapper = extension.assets.find((asset) => asset.assetId === "alpha")!;
  wrapper.variantKind = variantKind;
  wrapper.dependencies!.source = "variant";
  return { fixed, extension, wrapper };
}

function compile(fixture: WrapperFixture, unwindRoute?: (route: V9ExitRouteFactV2) => V9ExitRouteFactV2 | V9ExitRouteFactV2[]) {
  let factSet = structuredClone(compileSafetyScoreV9FactSetFromFixedInput(fixture.fixed, fixture.extension));
  const asset = factSet.assets.find((candidate) => candidate.assetId === "alpha")!;
  if (unwindRoute) {
    const route = unwindRoute(structuredClone(asset.exitRoutes[0]!));
    const context = createAssetBuildContext(normalizeSafetyScoreV9CompilerInput(fixture.fixed), fixture.extension, fixture.wrapper, "a".repeat(64));
    asset.wrapperLocalFacts = buildWrapperLocalFacts(
      context,
      { ...asset, exitRoutes: Array.isArray(route) ? route : [route] },
    );
    asset.gaps = [
      ...asset.gaps.filter((gap) => !gap.gapId.startsWith("alpha:gap:wrapper-local:")),
      ...context.gaps.values(),
    ].sort((left, right) => left.gapId.localeCompare(right.gapId));
    asset.evidence = [...new Map([
      ...asset.evidence.map((evidence) => [evidence.evidenceId, evidence] as const),
      ...context.evidence,
    ]).values()].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
    factSet = { ...factSet, v9FactSetDigest: computeV9FactSetDigest(factSet) };
  }
  if (asset.wrapperLocalFacts.applicability !== "wrapper") throw new Error("Expected wrapper facts");
  const evaluated = evaluateV9FactSet(factSet, V9_CANDIDATE_POLICY_V1);
  return { asset, facts: asset.wrapperLocalFacts, card: evaluated.assets.find((candidate) => candidate.assetId === "alpha")! };
}

function directAllocationFixture() {
  const fixture = wrapperFixture("strategy-vault");
  fixture.wrapper.wrapperCustodyReview = {
    custodyModel: "institutional-unregulated",
    providers: [{ providerKey: "parent-custody-undisclosed", role: "custodian", shareFraction: null }],
    segregation: "unknown",
    bankruptcyRemoteness: "unknown",
    rehypothecation: "unknown",
    knownUnknownExposureShare: 1,
  };
  fixture.wrapper.wrapperAllocationReview = {
    assetId: "alpha",
    reviewedAt: "2026-10-01",
    expiresAt: "2026-11-01",
    reviewer: "fixture",
    custody: "fully-onchain-no-offchain-custodian",
    scopeKind: "whole-allocation",
    localLeverage: "no-borrowing-surface",
    capitalReuse: "none",
    rationale: "The wrapper holds only its tracked parent token; custody uncertainty belongs upstream.",
    observations: [{ chain: "ethereum", address: "0x1111111111111111111111111111111111111111", function: "asset()/totalAssets()/balanceOf(wrapper)", value: "parent; assets=balance", block: 1 }],
    sources: [{ label: "Fixture source", url: "https://example.com/direct-allocation" }],
  };
  return fixture;
}

function immutableRootFixture() {
  const fixture = wrapperFixture("strategy-vault");
  const asset = structuredClone(compileSafetyScoreV9FactSetFromFixedInput(fixture.fixed, fixture.extension).assets
    .find((candidate) => candidate.assetId === "alpha")!);
  const address = "0x1111111111111111111111111111111111111111";
  fixture.wrapper.allocationScopeIdentityReview = {
    assetId: "alpha",
    registeredDeploymentKeys: [`ethereum:${address}`],
    deployments: [{
      chain: "ethereum", address, codeKind: "immutable", block: 123,
      observedAtSec: fixture.fixed.clockSec - 100,
      sourceUrl: "https://example.com/exact-immutable-root",
    }],
  };
  asset.economicControlReview.mint.status = v9Status("missing", "v9.control.mint-review");
  asset.economicControlReview.mint.upgrade = { state: "immutable", controlKey: null };
  const build = () => {
    const context = createAssetBuildContext(
      normalizeSafetyScoreV9CompilerInput(fixture.fixed), fixture.extension, fixture.wrapper, "a".repeat(64),
    );
    const facts = buildWrapperLocalFacts(context, asset);
    if (facts.applicability !== "wrapper") throw new Error("Expected wrapper facts");
    return { context, facts };
  };
  return { ...fixture, asset, build };
}

describe("independent immutable wrapper roots", () => {
  it("admits current exhaustive root identity without changing aggregate mint or any other local dimension", () => {
    const fixture = immutableRootFixture();
    const review = fixture.wrapper.allocationScopeIdentityReview!;
    delete fixture.wrapper.allocationScopeIdentityReview;
    const before = fixture.build();
    fixture.wrapper.allocationScopeIdentityReview = review;
    const mintBefore = structuredClone(fixture.asset.economicControlReview.mint);
    const { context, facts } = fixture.build();
    expect(facts.facts.contractMutability).toMatchObject({
      disposition: "reviewed", assessment: "none",
    });
    expect(context.gaps.has("alpha:gap:wrapper-local:contractMutability")).toBe(false);
    const { contractMutability: _before, ...otherBefore } = before.facts.facts;
    const { contractMutability: _after, ...otherAfter } = facts.facts;
    expect(otherAfter).toEqual(otherBefore);
    expect(fixture.asset.economicControlReview.mint).toEqual(mintBefore);
    const evidence = context.evidence.get(facts.facts.contractMutability.evidenceRefIds[0]!)!;
    expect(evidence).toMatchObject({
      sourceId: "safety-score-v9.wrapper-immutable-root-identity",
      sourceGenerationId: fixture.extension.sources.researchOverlays.generationId,
      observedAtSec: review.deployments[0]!.observedAtSec,
      url: review.deployments[0]!.sourceUrl,
      freshness: {
        state: "current",
        maxAgeSec: V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec,
      },
    });
    expect(evidence.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    "missing", "empty", "stale", "future", "partial", "proxy", "changed-implementation",
    "unmatched-roster", "duplicate-roster", "duplicate-deployment", "wrong-asset", "missing-source",
  ] as const)("does not admit %s identity despite an immutable aggregate enum", (rejection) => {
    const fixture = immutableRootFixture();
    const review = fixture.wrapper.allocationScopeIdentityReview!;
    const deployment = review.deployments[0]!;
    const maxAgeSec = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec;
    switch (rejection) {
      case "missing": delete fixture.wrapper.allocationScopeIdentityReview; break;
      case "empty": review.registeredDeploymentKeys = []; review.deployments = []; break;
      case "stale": deployment.observedAtSec = fixture.fixed.clockSec - maxAgeSec - 1; break;
      case "future": deployment.observedAtSec = fixture.fixed.clockSec + 1; break;
      case "partial": review.registeredDeploymentKeys.push(`base:${deployment.address}`); break;
      case "proxy":
      case "changed-implementation":
        review.deployments[0] = {
          ...deployment, codeKind: "proxy",
          implementation: rejection === "proxy" ? deployment.address : "0x2222222222222222222222222222222222222222",
        };
        break;
      case "unmatched-roster": review.registeredDeploymentKeys[0] = `base:${deployment.address}`; break;
      case "duplicate-roster": review.registeredDeploymentKeys.push(review.registeredDeploymentKeys[0]!); break;
      case "duplicate-deployment": review.deployments.push({ ...deployment }); break;
      case "wrong-asset": review.assetId = "beta"; break;
      case "missing-source": deployment.sourceUrl = ""; break;
    }
    const { context, facts } = fixture.build();
    expect(facts.facts.contractMutability).toMatchObject({ disposition: "unresearched", assessment: null });
    expect(context.gaps.has("alpha:gap:wrapper-local:contractMutability")).toBe(true);
    expect([...context.evidence.values()].some((evidence) =>
      evidence.sourceId === "safety-score-v9.wrapper-immutable-root-identity")).toBe(false);
  });

  it("uses the policy freshness budget inclusively and admits every exact immutable deployment", () => {
    const fixture = immutableRootFixture();
    const review = fixture.wrapper.allocationScopeIdentityReview!;
    const deployment = review.deployments[0]!;
    deployment.observedAtSec = fixture.fixed.clockSec -
      V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec;
    review.registeredDeploymentKeys.push(`base:${deployment.address}`);
    review.deployments.push({ ...deployment, chain: "base", block: 456 });
    const { facts } = fixture.build();
    expect(facts.facts.contractMutability).toMatchObject({ disposition: "reviewed", assessment: "none" });
    expect(facts.facts.contractMutability.evidenceRefIds).toHaveLength(2);
  });

  it("does not override a changed aggregate upgrade implementation with retained immutable identity", () => {
    const fixture = immutableRootFixture();
    fixture.asset.economicControlReview.mint.upgrade = { state: "reviewed", controlKey: "changed:upgrade" };
    expect(fixture.build().facts.facts.contractMutability.assessment).toBeNull();
  });

  it("leaves the existing known-aggregate upgrade path unchanged", () => {
    const fixture = immutableRootFixture();
    delete fixture.wrapper.allocationScopeIdentityReview;
    fixture.asset.economicControlReview.mint.status = v9Status();
    const { context, facts } = fixture.build();
    expect(facts.facts.contractMutability).toMatchObject({
      disposition: "reviewed", assessment: "none", signals: ["wrapper-upgrade-state:immutable"],
    });
    expect([...context.evidence.values()].some((evidence) =>
      evidence.sourceId === "safety-score-v9.wrapper-immutable-root-identity")).toBe(false);
  });
});

const slashingControl = () => localControl({
  controlKey: "umbrella:slashing",
  controlKind: "governance",
  capabilities: ["parameter-change"],
  capSemantics: { kind: "not-applicable", bound: null },
  claimImpairment: "bounded",
  economicLossScope: "reserve-claim",
});

const unknownConfigurationControl = () => localControl({
  controlKey: "umbrella:unknown-configuration-authority",
  controlKind: "governance",
  capabilities: ["parameter-change"],
  capSemantics: { kind: "not-applicable", bound: null },
  claimImpairment: "bounded",
  economicLossScope: "reserve-claim",
  authority: null,
});

describe("wrapper-local loss absorption and custody scope", () => {
  it("prices known risk-absorption controls at the moderate holder-loss floor without parent credit", () => {
    const fixture = wrapperFixture("risk-absorption");
    fixture.wrapper.controlReview = { state: "reviewed-controls", controls: [slashingControl()] };
    const { facts, card } = compile(fixture);
    expect(facts.facts.lossAbsorptionEmergencyControls).toMatchObject({ disposition: "reviewed", assessment: "moderate" });
    expect(facts.facts.lossAbsorptionEmergencyControls.signals).toContain("wrapper-holder-bears-protocol-loss-absorption");
    expect(card.trace.wrapperParentLimit).toMatchObject({ riskTransfer: { requestedCredit: 0, appliedCredit: 0 } });
    expect(card.trace.wrapperParentLimit?.adjustments).toContainEqual(expect.objectContaining({ factKey: "lossAbsorptionEmergencyControls", assessment: "moderate", discountPoints: 1.4 }));
    expect(card.trace.wrapperParentLimit!.limit).toBeLessThanOrEqual(card.trace.wrapperParentLimit!.parentScore);
  });

  it("keeps the worst local control and unknown configuration authority gap", () => {
    const fixture = wrapperFixture("risk-absorption");
    fixture.wrapper.controlReview = {
      state: "partially-reviewed-controls",
      rationale: "Slashing is reviewed; configuration authority is unresolved.",
      controls: [slashingControl(), unknownConfigurationControl(), localControl({ controlKey: "umbrella:upgrade", controlKind: "upgrade", capabilities: ["upgrade"], claimImpairment: "unbounded", economicLossScope: "global-claim" })],
    };
    const { asset, facts, card } = compile(fixture);
    expect(facts.facts.lossAbsorptionEmergencyControls).toMatchObject({ disposition: "reviewed", assessment: "high" });
    expect(asset.gaps).toContainEqual(expect.objectContaining({ reasonCode: "unresolved-control-identity", path: { kind: "local-component", componentKey: "control:umbrella:unknown-configuration-authority" } }));
    expect(card.control.reasons).toContainEqual(expect.objectContaining({ code: "unresolved-control-identity", path: expect.stringContaining("umbrella:unknown-configuration-authority") }));
  });

  it("does not let bridge-only inventory establish local loss controls", () => {
    const fixture = wrapperFixture("risk-absorption");
    fixture.wrapper.controlReview = { state: "reviewed-controls", controls: [localControl({ controlKind: "bridge" })] };
    expect(compile(fixture).facts.facts.lossAbsorptionEmergencyControls).toMatchObject({ disposition: "unresearched", assessment: null });
  });

  it.each(["controller-owner", "inherited-domain"] as const)(
    "does not double-charge a parent emergency control attributed by %s",
    (attribution) => {
      const fixture = wrapperFixture("strategy-vault");
      const inherited = localControl({
        controlKey: "parent:gateway",
        controlKind: "mint",
        capabilities: ["mint"],
        claimImpairment: "unbounded",
        economicLossScope: "global-claim",
        ...(attribution === "controller-owner"
          ? { controllerAssetId: "beta" }
          : { failureDomains: [{ kind: "mint-control", key: "asset:beta" }] }),
      });
      fixture.wrapper.controlReview = { state: "reviewed-controls", controls: [inherited] };
      const parentOnly = compile(fixture);
      expect(parentOnly.facts.facts.lossAbsorptionEmergencyControls.assessment).toBeNull();
      expect(parentOnly.card.trace.wrapperParentLimit?.adjustments).not.toContainEqual(
        expect.objectContaining({ factKey: "lossAbsorptionEmergencyControls", discountPoints: 2.8 }),
      );

      fixture.wrapper.controlReview.controls.push(localControl({
        controlKey: "wrapper:emergency",
        controlKind: "governance",
        claimImpairment: "unbounded",
        economicLossScope: "global-claim",
      }));
      const local = compile(fixture);
      expect(local.facts.facts.lossAbsorptionEmergencyControls).toMatchObject({
        disposition: "reviewed", assessment: "high",
      });
      expect(local.facts.facts.lossAbsorptionEmergencyControls.signals).toContain("unbounded-claim-control:wrapper:emergency");
      expect(local.facts.facts.lossAbsorptionEmergencyControls.signals).not.toContain("unbounded-claim-control:parent:gateway");
      expect(local.card.trace.wrapperParentLimit?.adjustments).toContainEqual(
        expect.objectContaining({ factKey: "lossAbsorptionEmergencyControls", discountPoints: 2.8 }),
      );
    },
  );

  it.each(["noneligible", "documented-model", "lower-bound"] as const)(
    "keeps %s partial unwind capacity uncertain instead of measured adverse",
    (observation) => {
      const fixture = wrapperFixture("strategy-vault");
      const { facts, card } = compile(fixture, (route) => ({
        ...route,
        ...(observation === "documented-model"
          ? { lane: "redemption", routeFamily: "issuer-redemption", evidenceKind: "documented-terms" }
          : {}),
        scoreEligible: observation !== "noneligible",
        coverageClass: observation === "lower-bound" ? "exact-lower-bound" : "exact-complete",
        capacityCurve: route.capacityCurve.map((point) => ({
          ...point, executableUsd: point.requestedNotionalUsd * 0.5228, completionRatio: 0.5228,
        })),
      }));
      expect(facts.facts.measuredUnwind.assessment).toBeNull();
      expect(facts.facts.measuredUnwind.disposition).not.toBe("reviewed");
      expect(card.trace.wrapperParentLimit?.adjustments).not.toContainEqual(
        expect.objectContaining({ factKey: "measuredUnwind", assessment: "moderate" }),
      );
    },
  );

  it("does not mistake a thin observed market for whole-wrapper exhaustion while another route is modeled", () => {
    const fixture = wrapperFixture("strategy-vault");
    const { facts } = compile(fixture, (route) => [
      {
        ...route, scoreEligible: true, coverageClass: "exact-complete",
        capacityCurve: route.capacityCurve.map((point) => ({
          ...point, executableUsd: point.requestedNotionalUsd * 0.1, completionRatio: 0.1,
        })),
      },
      {
        ...route, routeKey: "redemption:modeled", lane: "redemption",
        routeFamily: "issuer-redemption", evidenceKind: "documented-terms",
        scoreEligible: false, coverageClass: "modelled-terms-lower-bound",
      },
    ]);
    expect(facts.facts.measuredUnwind).toMatchObject({
      disposition: "unresearched", assessment: null,
    });
  });

  it("retains the charge for a genuinely observed exact-complete partial unwind", () => {
    const fixture = wrapperFixture("strategy-vault");
    const { facts, card } = compile(fixture, (route) => ({
      ...route, scoreEligible: true, coverageClass: "exact-complete",
      capacityCurve: route.capacityCurve.map((point) => ({
        ...point, executableUsd: point.requestedNotionalUsd * 0.5228, completionRatio: 0.5228,
      })),
    }));
    expect(facts.facts.measuredUnwind).toMatchObject({ disposition: "reviewed", assessment: "moderate" });
    expect(card.trace.wrapperParentLimit?.adjustments).toContainEqual(
      expect.objectContaining({ factKey: "measuredUnwind", assessment: "moderate", discountPoints: 1.75 }),
    );
  });

  it("keeps a published but unquantified formula fee bounded, not issuer-undisclosed or cost-admitted", () => {
    const fixture = wrapperFixture("strategy-vault");
    const entry = structuredClone(makeV9QueuedRedemptionFixedInput().redemptionBackstopMap.alpha!);
    entry.feeConfidence = "formula";
    entry.feeModelKind = "formula";
    entry.feeBps = null;
    entry.feeDescription = "Early redemption fee declines linearly from 3.5% to 0.1%.";
    const observation = entry.capacityProfile!.exitRouteObservations![0]!;
    observation.feeEvidence = "undisclosed-reviewed";
    observation.scoreEligible = false;
    observation.observedAt = fixture.fixed.clockSec - 60;
    entry.updatedAt = observation.observedAt;
    fixture.fixed.redemptionBackstopMap.alpha = entry;
    fixture.fixed.redemptionGenerationId = "redemption:fixture";
    fixture.fixed.redemptionStale = false;
    fixture.fixed.inputFreshness.redemptionBackstops = {
      updatedAt: observation.observedAt, ageSeconds: 60, stale: false,
    };
    fixture.fixed = rebuildFixed(fixture.fixed);
    fixture.wrapper.routeReviews = buildSafetyScoreV9RouteReviews(fixture.fixed, "alpha");
    const { asset, facts, card } = compile(fixture);
    const redemption = asset.exitRoutes.find((route) => route.lane === "redemption")!;
    expect(redemption).toMatchObject({ feeEvidence: "disclosed-unquantified", scoreEligible: false });
    expect(facts.facts.withdrawalTerms).toMatchObject({ disposition: "reviewed", assessment: "high" });
    expect(card.exit.routes.find((route) => route.routeKey === redemption.routeKey)).toMatchObject({
      included: true, exclusionReason: null, feeEvidence: "disclosed-unquantified",
      components: { cost: V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedCostScore },
    });
    expect(card.trace.wrapperParentLimit?.adjustments).not.toContainEqual(
      expect.objectContaining({ factKey: "withdrawalTerms", disposition: "issuer-undisclosed" }),
    );
  });

  it.each(["discretionary", "queued"] as const)(
    "keeps known %s withdrawal restrictions charged when only formula fee quantification is missing",
    (restriction) => {
      const fixture = wrapperFixture("savings-passthrough");
      fixture.wrapper.variantKind = "pure-wrapper";
      const routeWithTerms = (route: V9ExitRouteFactV2): V9ExitRouteFactV2 => ({
        ...route,
        lane: "redemption", routeFamily: "issuer-redemption",
        evidenceKind: "documented-terms", scoreEligible: false,
        holderAccess: restriction === "discretionary" ? "issuer-only" : "permissionless",
        executionModel: restriction,
        executionCertainty: restriction === "discretionary" ? "discretionary" : "bounded",
        settlementModel: restriction === "queued" ? "queued" : "atomic",
        settlementSlaSec: restriction === "queued" ? 14 * 86_400 : null,
      });
      const quantified = compile(fixture, routeWithTerms);
      const unquantified = compile(fixture, (route) => ({
        ...routeWithTerms(route), feeEvidence: "disclosed-unquantified",
      }));
      const assessment = restriction === "discretionary" ? "critical" : "high";
      expect(unquantified.facts.facts.withdrawalTerms).toMatchObject({
        disposition: "reviewed", assessment,
      });
      const before = quantified.card.trace.wrapperParentLimit!;
      const after = unquantified.card.trace.wrapperParentLimit!;
      expect(after.adjustments.find((adjustment) => adjustment.factKey === "withdrawalTerms"))
        .toEqual(before.adjustments.find((adjustment) => adjustment.factKey === "withdrawalTerms"));
      expect(after.appliedDiscount).toBe(before.appliedDiscount);
      expect(after.limit).toBe(before.limit);
    },
  );

  it("keeps savings receipts outside local loss absorption", () => {
    const fixture = wrapperFixture("savings-passthrough");
    fixture.wrapper.controlReview = { state: "reviewed-controls", controls: [slashingControl()] };
    expect(compile(fixture).facts.facts.lossAbsorptionEmergencyControls).toMatchObject({ disposition: "not-applicable", assessment: null });
  });

  it("retains the addressed stkGHO slashing owner and reviewed role holders through existing control intake", () => {
    const fixture = wrapperFixture("risk-absorption");
    const profile = structuredClone(stkGhoAuthority.mintAuthority) as MintAuthorityProfile;
    profile.inheritedFrom = "beta";
    profile.review.reviewedAt = "2026-10-01";
    const baseline = buildSafetyScoreV9BaselineExtension(fixture.fixed, {
      metaById: metaMap(
        alphaMeta({ variantKind: "risk-absorption", variantOf: "beta", mintAuthority: profile }),
        alphaMeta({ id: "beta" }),
      ),
    });
    fixture.wrapper.controlReview = baseline.assets.find((asset) => asset.assetId === "alpha")!.controlReview;
    const { asset, facts } = compile(fixture);
    const owner = asset.controls.find((control) => control.authority?.authorityKey === "ethereum:0xd400fc38ed4732893174325693a63c30ee3881a8")!;
    expect(owner.capabilities).not.toContain("mint");
    expect(facts.facts.lossAbsorptionEmergencyControls).toMatchObject({ disposition: "reviewed" });
    expect(["moderate", "high", "critical"]).toContain(facts.facts.lossAbsorptionEmergencyControls.assessment);
    expect(asset.gaps).not.toContainEqual(expect.objectContaining({ reasonCode: "unresolved-control-identity" }));
  });

  it("does not duplicate upstream-only custody uncertainty in a reviewed direct single-parent allocation", () => {
    const fixture = directAllocationFixture();
    const before = compile(fixture);
    fixture.wrapper.wrapperCustodyReview!.knownUnknownExposureShare = 0;
    const after = compile(fixture);
    expect(before.facts.facts.strategyComplexity).toMatchObject({ disposition: "reviewed", assessment: "moderate" });
    expect(before.card.trace.wrapperParentLimit?.adjustments).toContainEqual(expect.objectContaining({ factKey: "strategyComplexity", assessment: "moderate", discountPoints: 0.7 }));
    expect(before.card.trace.wrapperParentLimit?.parentScore).toBe(after.card.trace.wrapperParentLimit?.parentScore);
    expect(before.card.trace.wrapperParentLimit?.limit).toBe(after.card.trace.wrapperParentLimit?.limit);
    expect(before.card.trace.wrapperParentLimit!.limit).toBeLessThanOrEqual(before.card.trace.wrapperParentLimit!.parentScore);
  });

  it.each(["absent", "expired", "future", "local-reuse", "mixed-book", "local-private-credit"] as const)(
    "keeps local complexity high with %s direct-parent scope proof",
    (scenario) => {
      const fixture = directAllocationFixture();
      const allocationReview = fixture.wrapper.wrapperAllocationReview;
      if (allocationReview?.scopeKind !== "whole-allocation") throw new Error("Expected whole-allocation review");
      if (scenario === "absent") fixture.wrapper.wrapperAllocationReview = null;
      else if (scenario === "expired") allocationReview.expiresAt = "2026-10-02";
      else if (scenario === "future") allocationReview.reviewedAt = "2026-10-03";
      else if (scenario === "local-reuse") allocationReview.capitalReuse = "multi-strategy-reuse";
      else {
        fixture.fixed.liveReserveMap.alpha![0]!.coinId = undefined;
        fixture.fixed.liveReserveMap.alpha![0]!.assetClass = scenario === "local-private-credit" ? "private-credit" : "cash";
        fixture.fixed = rebuildFixed(fixture.fixed);
      }
      const { facts, card } = compile(fixture);
      expect(facts.facts.strategyComplexity).toMatchObject({ disposition: "reviewed", assessment: "high" });
      expect(card.trace.wrapperParentLimit?.adjustments).toContainEqual(expect.objectContaining({ factKey: "strategyComplexity", assessment: "high", discountPoints: 1.4 }));
    },
  );
  it("carries the reviewed catalog inheritance boundary and its source evidence into published wrapper facts", () => {
    const fixture = wrapperFixture("strategy-vault");
    const review = ParentBackingInheritanceSchema.parse(lorenzoMeta.parentBackingInheritance);
    const baseline = buildSafetyScoreV9BaselineExtension(fixture.fixed, {
      metaById: metaMap(
        alphaMeta({ variantKind: "strategy-vault", variantOf: "beta", parentBackingInheritance: review }),
        alphaMeta({ id: "beta" }),
      ),
    });
    const projected = baseline.assets.find((asset) => asset.assetId === "alpha")!;
    fixture.wrapper.parentBackingInheritance = projected.parentBackingInheritance;
    fixture.wrapper.researchEvidence = projected.researchEvidence;
    fixture.wrapper.componentEvidence = projected.componentEvidence;
    const factSet = compileSafetyScoreV9FactSetFromFixedInput(fixture.fixed, fixture.extension);
    const asset = factSet.assets.find((asset) => asset.assetId === "alpha")!;
    if (asset.wrapperLocalFacts.applicability !== "wrapper") throw new Error("Expected wrapper facts");
    const withholding = asset.wrapperLocalFacts.parentBackingInheritance!;
    expect(withholding).toMatchObject({ state: "withheld", reason: review.reason });
    expect(withholding.evidenceRefIds.map((id) => asset.evidence.find((evidence) => evidence.evidenceId === id)?.url).sort())
      .toEqual(review.sources.map((source) => source.url).sort());
    const evaluated = evaluateV9FactSet(factSet, V9_CANDIDATE_POLICY_V1).assets.find((asset) => asset.assetId === "alpha")!;
    expect(evaluated.backing.contributions.some((entry) => entry.componentKey.startsWith("reserve:inherited-backing:")))
      .toBe(false);
  });

  it("keeps privileged NAV pricing locally high risk while giving standard external pricing only moderate risk", () => {
    const fixture = wrapperFixture("savings-passthrough");
    fixture.wrapper.pegReference = { referenceKind: "nav", referenceKey: "share-nav", failureDomains: [] };
    const oracle = fixture.wrapper.economicControlReview!.oracle;
    oracle.status = v9Status("known", "v9.control.oracle-review");
    oracle.tier = "privileged-internal-pricing";
    const privileged = compile(fixture);
    oracle.tier = "standard-external";
    const external = compile(fixture);
    expect(privileged.facts.facts.shareAccountingNavOracle).toMatchObject({ disposition: "reviewed", assessment: "high" });
    expect(external.facts.facts.shareAccountingNavOracle).toMatchObject({ disposition: "reviewed", assessment: "moderate" });
    const privilegedDiscount = privileged.card.trace.wrapperParentLimit!.adjustments
      .find((adjustment) => adjustment.factKey === "shareAccountingNavOracle")!.discountPoints;
    const externalDiscount = external.card.trace.wrapperParentLimit!.adjustments
      .find((adjustment) => adjustment.factKey === "shareAccountingNavOracle")!.discountPoints;
    expect(privilegedDiscount).toBeGreaterThan(externalDiscount);
  });

  it.each(["complete-custody", "current-allocation"] as const)(
    "scopes corroborated direct onchain custody upstream with %s",
    (scenario) => {
      const fixture = directAllocationFixture();
      fixture.wrapper.variantKind = "savings-passthrough";
      fixture.wrapper.wrapperCustodyReview!.custodyModel = "onchain";
      if (scenario === "complete-custody") {
        fixture.wrapper.wrapperAllocationReview = null;
        fixture.wrapper.wrapperCustodyReview!.segregation = "segregated";
        fixture.wrapper.wrapperCustodyReview!.bankruptcyRemoteness = "structured";
        fixture.wrapper.wrapperCustodyReview!.knownUnknownExposureShare = 0;
        fixture.wrapper.wrapperCustodyReview!.rehypothecation = "prohibited";
      }
      expect(compile(fixture).facts.facts.custodyEscrow).toMatchObject({ disposition: "not-applicable", assessment: null });
    },
  );

  it.each(["absent-allocation", "expired-allocation", "future-allocation", "unknown-share", "unknown-segregation", "unknown-bankruptcy"] as const)(
    "keeps direct onchain custody conservative with %s corroboration",
    (scenario) => {
      const fixture = directAllocationFixture();
      const allocationReview = fixture.wrapper.wrapperAllocationReview;
      if (allocationReview?.scopeKind !== "whole-allocation") throw new Error("Expected whole-allocation review");
      fixture.wrapper.variantKind = "savings-passthrough";
      fixture.wrapper.wrapperCustodyReview!.custodyModel = "onchain";
      if (scenario === "expired-allocation") allocationReview.expiresAt = "2026-10-02";
      else if (scenario === "future-allocation") allocationReview.reviewedAt = "2026-10-03";
      else {
        fixture.wrapper.wrapperAllocationReview = null;
        if (scenario !== "absent-allocation") {
          fixture.wrapper.wrapperCustodyReview!.segregation = scenario === "unknown-segregation" ? "unknown" : "segregated";
          fixture.wrapper.wrapperCustodyReview!.bankruptcyRemoteness = scenario === "unknown-bankruptcy" ? "unknown" : "structured";
          fixture.wrapper.wrapperCustodyReview!.knownUnknownExposureShare = scenario === "unknown-share" ? null : 0;
        }
      }
      const { facts, card } = compile(fixture);
      expect(facts.facts.custodyEscrow).toMatchObject({ disposition: "unresearched", assessment: null });
      expect(card.trace.wrapperParentLimit!.missingFacts).toContainEqual(expect.objectContaining({
        factClass: "custodyEscrow", disposition: "unresearched", cause: "U",
        causeGapIds: ["alpha:gap:wrapper-local:custodyEscrow"],
      }));
      expect(card.trace.wrapperParentLimit!.treatment).toBe("fallback-discount");
    },
  );
});
