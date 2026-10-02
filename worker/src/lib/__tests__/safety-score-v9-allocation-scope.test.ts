import { describe, expect, it } from "vitest";
import { evaluateV9FactSet, type V9EvaluatedAsset } from "@shared/lib/safety-score-v9/evaluate-set";
import { loadV9MethodologyPolicy, V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import type { V9ScopedAllocationClaim } from "@shared/types/safety-score-v9-allocation";
import type { CompiledV9FactSetV3, V9AssetFactsV3 } from "@shared/types/safety-score-v9-facts";
import type { AssetExtension, SafetyScoreV9FactSetExtensionV2 } from "../safety-score-v9/fact-set-schema";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { buildAllocationScopeFacts, resolveAllocationDimensionCoverage } from "../safety-score-v9/fact-set-allocation";
import { createAssetBuildContext } from "../safety-score-v9/fact-set-context";
import { normalizeSafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import { makeV9RoleExtension, makeV9TwoAssetFixedInput } from "../../test-helpers/v9-fixed-input";
import { rebuildFixed, type FixedInput } from "./safety-score-v9-fact-set.test-support";

interface AllocationFixture {
  fixed: FixedInput;
  extension: SafetyScoreV9FactSetExtensionV2;
  asset: AssetExtension;
  claim: V9ScopedAllocationClaim;
}
interface CompiledAllocationFixture {
  factSet: Readonly<CompiledV9FactSetV3>;
  asset: V9AssetFactsV3;
  card: V9EvaluatedAsset;
}

function fixture(privateCredit = false, wrapper = true): AllocationFixture {
  const clockSec = Date.parse("2026-10-02T10:00:00Z") / 1000;
  const draft = makeV9TwoAssetFixedInput({ clockSec });
  draft.aggregateCirculatingById.beta = structuredClone(draft.aggregateCirculatingById.alpha!);
  draft.liveReserveMap.alpha = [{ sourceKey: "fixture:position", name: "Economic parent position", pct: 100, risk: "low", coinId: "beta", depType: wrapper ? "wrapper" : "collateral", assetClass: privateCredit ? "private-credit" : "protocol-position", issuerOrObligor: "asset:beta", riskFactors: ["smart-contract"], liquidityHorizon: "immediate" }];
  const fixed = rebuildFixed(draft);
  const extension = makeV9RoleExtension(fixed, { alpha: [{ upstreamAssetId: "beta", dependencyType: wrapper ? "wrapper" : "collateral", economicRole: wrapper ? "serial-claim" : "basket-exposure", weight: 1, failureDomains: [] }] });
  const asset = extension.assets.find((row) => row.assetId === "alpha")!;
  if (wrapper) { asset.variantKind = "strategy-vault"; asset.dependencies!.source = "variant"; }
  asset.wrapperCustodyReview = { custodyModel: privateCredit ? "institutional-unregulated" : "onchain", providers: [], segregation: "segregated", bankruptcyRemoteness: "structured", rehypothecation: "prohibited", knownUnknownExposureShare: privateCredit ? 1 : 0 };
  const deployment = { codeKind: "proxy" as const, chain: "ethereum", address: "0x1111111111111111111111111111111111111111", implementation: "0x2222222222222222222222222222222222222222", observedAtSec: clockSec - 300, block: 100, sourceUrl: "https://example.com/code" };
  asset.allocationScopeIdentityReview = { assetId: "alpha", registeredDeploymentKeys: [`ethereum:${deployment.address}`], deployments: [{ ...deployment }] };
  extension.assets.find((row) => row.assetId === "beta")!.allocationScopeIdentityReview = {
    assetId: "beta", registeredDeploymentKeys: ["ethereum:0x4444444444444444444444444444444444444444"], deployments: [],
  };
  const claim: V9ScopedAllocationClaim = {
    claimKey: "contract-borrowing", dimension: "leverage", layer: "contract", target: { kind: "deployment", deployment, reachableTargets: [deployment], reachableSetComplete: true },
    coverage: { kind: "whole-dimension", denominator: "accepted-reserve-envelope", reserveSourceKeys: ["fixture:position"], shareFraction: 1 },
    disposition: "reviewed", statement: "no-borrowing-surface", rationale: "Pinned complete contract code only; no legal-entity borrowing inference.",
    reviewedAt: new Date((clockSec - 200) * 1000).toISOString(), observedAtSec: clockSec - 300, expiresAtSec: clockSec + 1000,
    sources: [{ label: "Exact verified code", url: "https://example.com/code" }],
    observations: [{ sourceUrl: "https://example.com/code", observedAtSec: clockSec - 300, description: "Complete root and reachable manager source" }],
  };
  asset.wrapperAllocationReview = { scopeKind: "per-dimension", assetId: "alpha", reviewer: "fixture", rationale: "Dimension-specific proof", claims: [claim] };
  return { fixed, extension, asset, claim };
}

function compile(input: AllocationFixture): CompiledAllocationFixture {
  const factSet = compileSafetyScoreV9FactSetFromFixedInput(input.fixed, input.extension);
  const asset = factSet.assets.find((row) => row.assetId === "alpha")!;
  const evaluated = evaluateV9FactSet(factSet, V9_CANDIDATE_POLICY_V1);
  const card = evaluated.assets.find((row) => row.assetId === "alpha")!;
  return { factSet, asset, card };
}

function wrapperFacts(input: CompiledAllocationFixture) {
  if (input.asset.wrapperLocalFacts.applicability !== "wrapper") throw new Error("Expected wrapper");
  return input.asset.wrapperLocalFacts;
}

function legalBorrowing(input: AllocationFixture, layer: "borrower-spv" | "lender-of-record", statement: V9ScopedAllocationClaim["statement"]): V9ScopedAllocationClaim {
  return { ...input.claim, claimKey: `entity-borrowing:${layer}`, layer, statement,
    target: { kind: "reserve-leg", sourceKey: "fixture:position", providerOrEntity: `Reviewed entity ${layer}`, applicability: "whole-book", conditions: "Executed contracts cover every accepted reserve leg and all borrowing and pledge surfaces" } };
}

describe("dimension-scoped allocation consumer boundaries", () => {
  it("gives complete contract-only leverage relief but prices a complete adverse contract statement", () => {
    const benign = fixture();
    const relief = compile(benign);
    expect(wrapperFacts(relief).facts.leverage).toMatchObject({ disposition: "reviewed", assessment: "none" });
    expect(relief.card.trace.wrapperParentLimit?.missingFacts).not.toContainEqual(expect.objectContaining({ factClass: "leverage" }));
    const adverse = fixture();
    adverse.claim.statement = "unbounded-or-above-2x";
    const penalty = compile(adverse);
    expect(wrapperFacts(penalty).facts.leverage).toMatchObject({ disposition: "reviewed", assessment: "critical" });
    expect(penalty.card.trace.wrapperParentLimit?.adjustments).toContainEqual(expect.objectContaining({ factKey: "leverage", discountPoints: 4 }));
    expect(penalty.card.trace.wrapperParentLimit!.limit).toBeLessThanOrEqual(relief.card.trace.wrapperParentLimit!.limit);
  });
  it("does not let native receipt structural absence hide complete proved local borrowing", () => {
    const benign = fixture();
    benign.asset.variantKind = "savings-passthrough";
    expect(wrapperFacts(compile(benign)).facts.leverage.disposition).toBe("not-applicable");
    const adverse = fixture();
    adverse.asset.variantKind = "savings-passthrough";
    adverse.claim.statement = "unbounded-or-above-2x";
    const result = compile(adverse);
    expect(wrapperFacts(result).facts.leverage).toMatchObject({ disposition: "reviewed", assessment: "critical" });
    expect(result.card.trace.wrapperParentLimit?.adjustments).toContainEqual(expect.objectContaining({ factKey: "leverage", discountPoints: 4 }));
  });
  it("does not turn no contract borrowing into no entity leverage or A3 parent-only complexity relief", () => {
    const input = fixture(true);
    const result = compile(input);
    expect(result.asset.allocationScopeFacts).toContainEqual(expect.objectContaining({ claimKey: "contract-borrowing", admitted: true, assessment: "none" }));
    expect(result.asset.allocationScopeFacts).toContainEqual(expect.objectContaining({ claimKey: "required:leverage:borrower-spv", admitted: false, rejectionReason: "required-scope-unresolved", disposition: "integration-missing" }));
    expect(wrapperFacts(result).facts.leverage.disposition).toBe("issuer-undisclosed");
    expect(wrapperFacts(result).facts.strategyComplexity).toMatchObject({ assessment: "high" });
    expect(result.card.trace.wrapperParentLimit?.missingFacts).toContainEqual(expect.objectContaining({ factClass: "leverage" }));
  });
  it("does not use scoped borrowing/reuse statements as A3 whole-allocation proof over an unknown legal book", () => {
    const input = fixture();
    input.asset.wrapperCustodyReview!.custodyModel = "institutional-unregulated";
    input.asset.wrapperCustodyReview!.knownUnknownExposureShare = 1;
    if (input.asset.wrapperAllocationReview?.scopeKind !== "per-dimension") throw new Error("Expected scopes");
    input.asset.wrapperAllocationReview.claims.push({
      ...input.claim, claimKey: "contract-reuse", dimension: "rehypothecationCorrelation", statement: "none",
    });
    const result = compile(input);
    expect(wrapperFacts(result).facts.strategyComplexity).toMatchObject({ disposition: "reviewed", assessment: "high" });
    expect(wrapperFacts(result).facts.custodyEscrow.disposition).toBe("issuer-undisclosed");
    expect(result.card.trace.wrapperParentLimit?.missingFacts).toContainEqual(expect.objectContaining({ factClass: "leverage" }));
  });
  it("resolves a complete mixed leverage dimension at the worst entity assessment", () => {
    const input = fixture(true);
    if (input.asset.wrapperAllocationReview?.scopeKind !== "per-dimension") throw new Error("Expected scopes");
    input.asset.wrapperAllocationReview.claims.push(legalBorrowing(input, "borrower-spv", "no-borrowing-surface"), legalBorrowing(input, "lender-of-record", "unbounded-or-above-2x"));
    const result = compile(input);
    expect(wrapperFacts(result).facts.leverage).toMatchObject({ disposition: "reviewed", assessment: "critical" });
    expect(result.card.trace.wrapperParentLimit?.adjustments).toContainEqual(expect.objectContaining({ factKey: "leverage", assessment: "critical", discountPoints: 4 }));
    expect(wrapperFacts(result).facts.custodyEscrow.disposition).toBe("issuer-undisclosed");
  });
  it("preserves known adverse reserve leverage when complete scoped evidence says no local borrowing", () => {
    const input = fixture();
    const riskFactors = input.fixed.liveReserveMap.alpha![0]!.riskFactors;
    if (!riskFactors) throw new Error("Expected fixture reserve risk factors");
    riskFactors.push("leverage");
    input.fixed = rebuildFixed(input.fixed);
    const result = compile(input);
    expect(wrapperFacts(result).facts.leverage).toMatchObject({ disposition: "reviewed", assessment: "high" });
    expect(result.card.trace.wrapperParentLimit?.adjustments).toContainEqual(expect.objectContaining({ factKey: "leverage", assessment: "high" }));
  });
  it("retains conditional escrow identity with null allocation without improving custody or reuse", () => {
    const input = fixture(true);
    const before = compile(input);
    if (input.asset.wrapperAllocationReview?.scopeKind !== "per-dimension") throw new Error("Expected scopes");
    input.asset.wrapperAllocationReview.claims.push({ ...input.claim, claimKey: "conditional-escrow-provider", dimension: "providerIdentity", layer: "immediate-custodian", statement: "provider-identified", coverage: { kind: "conditional", condition: "Where escrow is appointed", shareFraction: null }, target: { kind: "reserve-leg", sourceKey: null, providerOrEntity: "Wilmington Trust", applicability: "conditional", conditions: "Executed per-series appointments only" } });
    const after = compile(input);
    expect(after.asset.allocationScopeFacts).toContainEqual(expect.objectContaining({ claimKey: "conditional-escrow-provider", admitted: true, assessment: null, coverage: { kind: "conditional", condition: "Where escrow is appointed", shareFraction: null } }));
    expect(wrapperFacts(after).facts.custodyEscrow.disposition).toBe(wrapperFacts(before).facts.custodyEscrow.disposition);
    expect(after.card.trace.wrapperParentLimit?.limit).toBe(before.card.trace.wrapperParentLimit?.limit);
  });
  it.each(["implementation", "chain", "future", "expiry", "missing-coverage", "date-only"] as const)("rejects %s scope without favorable aggregate credit or needless quarantine", (fault) => {
    const input = fixture();
    if (input.claim.target.kind !== "deployment") throw new Error("Expected deployment");
    if (fault === "implementation") input.asset.allocationScopeIdentityReview!.deployments[0] = { ...input.claim.target.deployment, codeKind: "proxy", implementation: "0x3333333333333333333333333333333333333333" };
    if (fault === "chain") {
      input.asset.allocationScopeIdentityReview!.deployments[0]!.chain = "arbitrum";
      input.asset.allocationScopeIdentityReview!.registeredDeploymentKeys = ["arbitrum:0x1111111111111111111111111111111111111111"];
    }
    if (fault === "future") { input.claim.observedAtSec = input.fixed.clockSec + 10; input.claim.reviewedAt = new Date((input.fixed.clockSec + 11) * 1000).toISOString(); }
    if (fault === "expiry") input.claim.expiresAtSec = input.fixed.clockSec;
    if (fault === "missing-coverage") input.claim.coverage = { kind: "whole-dimension", denominator: "accepted-reserve-envelope", reserveSourceKeys: ["fixture:missing"], shareFraction: 1 };
    if (fault === "date-only") {
      input.claim.reviewedAt = "2026-10-02";
      input.claim.expiresAtSec = input.fixed.clockSec + 86_400;
    }
    const result = compile(input);
    const fact = result.asset.allocationScopeFacts!.find((row) => row.claimKey === input.claim.claimKey)!;
    expect(fact.admitted).toBe(false);
    expect(fact.assessment).toBeNull();
    expect(wrapperFacts(result).facts.leverage.disposition).toBe("issuer-undisclosed");
    expect(result.asset.allocationScopeFacts).toContainEqual(expect.objectContaining({ claimKey: "required:leverage:contract", disposition: "integration-missing" }));
    expect(result.card.trace.wrapperParentLimit?.missingFacts).toContainEqual(expect.objectContaining({ factClass: "leverage" }));
  });
  it.each(["implementation", "missing", "code-kind", "chain", "expired", "future", "source", "block"] as const)("rejects reachable manager %s without whole-dimension relief", (fault) => {
    const input = fixture();
    if (input.claim.target.kind !== "deployment") throw new Error("Expected deployment");
    const root = input.claim.target.deployment;
    const manager = { ...root, codeKind: "proxy" as const, address: "0x3333333333333333333333333333333333333333",
      implementation: "0x4444444444444444444444444444444444444444" };
    input.claim.target.reachableTargets.push(manager);
    const current = { ...manager };
    input.asset.allocationScopeIdentityReview!.registeredDeploymentKeys.push(`${manager.chain}:${manager.address}`);
    if (fault !== "missing") input.asset.allocationScopeIdentityReview!.deployments.push(current);
    if (fault === "implementation") current.implementation = "0x5555555555555555555555555555555555555555";
    if (fault === "code-kind") input.asset.allocationScopeIdentityReview!.deployments[1] = {
      codeKind: "immutable", chain: manager.chain, address: manager.address, observedAtSec: manager.observedAtSec, block: manager.block, sourceUrl: manager.sourceUrl,
    };
    if (fault === "chain") {
      current.chain = "arbitrum";
      input.asset.allocationScopeIdentityReview!.registeredDeploymentKeys[1] = `arbitrum:${manager.address}`;
    }
    if (fault === "expired") current.observedAtSec = input.fixed.clockSec - V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec - 1;
    if (fault === "future") current.observedAtSec = input.fixed.clockSec + 1;
    if (fault === "source") current.sourceUrl = "https://example.com/unbound";
    if (fault === "block") current.block++;
    const result = compile(input);
    expect(result.asset.allocationScopeFacts).toContainEqual(expect.objectContaining({ claimKey: input.claim.claimKey, admitted: false, assessment: null, rejectionReason: "identity-unmatched" }));
    expect(wrapperFacts(result).facts.leverage.disposition).toBe("issuer-undisclosed");
    expect(result.card.trace.wrapperParentLimit?.missingFacts).toContainEqual(expect.objectContaining({ factClass: "leverage" }));
  });

  it("admits an exactly matched root and manager reachable roster", () => {
    const input = fixture();
    if (input.claim.target.kind !== "deployment") throw new Error("Expected deployment");
    const manager = { ...input.claim.target.deployment, address: "0x3333333333333333333333333333333333333333" };
    input.claim.target.reachableTargets.push(manager);
    input.asset.allocationScopeIdentityReview!.registeredDeploymentKeys.push(`${manager.chain}:${manager.address}`);
    input.asset.allocationScopeIdentityReview!.deployments.push({ ...manager });
    expect(wrapperFacts(compile(input)).facts.leverage).toMatchObject({ disposition: "reviewed", assessment: "none" });
  });

  it("admits just before expiry and rejects overlapping whole-book proofs", () => {
    const input = fixture();
    input.claim.expiresAtSec = input.fixed.clockSec + 1;
    expect(wrapperFacts(compile(input)).facts.leverage).toMatchObject({ disposition: "reviewed", assessment: "none" });
    if (input.asset.wrapperAllocationReview?.scopeKind !== "per-dimension") throw new Error("Expected scopes");
    input.asset.wrapperAllocationReview.claims.push({ ...input.claim, claimKey: "duplicate-book-proof" });
    const result = compile(input);
    expect(wrapperFacts(result).facts.leverage.disposition).toBe("issuer-undisclosed");
    expect(result.asset.allocationScopeFacts).toContainEqual(expect.objectContaining({ claimKey: "contract-borrowing", rejectionReason: "overlapping-scope" }));
  });
  it("admits non-wrapper parent basket context without manufacturing a wrapper or a second penalty", () => {
    const input = fixture(false, false);
    const before = compile(input);
    const edge = before.asset.dependencies.edges[0]!;
    input.claim.dimension = "holderClaim";
    input.claim.layer = "parent";
    input.claim.disposition = "inherited-parent";
    input.claim.statement = "parent-risk-carried";
    input.claim.coverage = { kind: "scope-only", shareFraction: null };
    input.claim.target = { kind: "parent-claim", upstreamAssetId: "beta", edgeKey: edge.edgeKey, inheritedRisk: "Upstream reserve issuer terms apply to this basket exposure, not immediate custody or direct holder rights" };
    const after = compile(input);
    expect(after.asset.allocationScopeFacts).toContainEqual(expect.objectContaining({ admitted: true, disposition: "inherited-parent", assessment: null }));
    expect(after.asset.wrapperLocalFacts.applicability).toBe("not-wrapper");
    expect(after.card.trace.wrapperParentLimit).toBeNull();
    expect(after.card.trace.finalScore).toBe(before.card.trace.finalScore);
  });
  it("burn/mint idle-token custody does not clear holder legal scope or change parent and unwind limits", () => {
    const input = fixture(true);
    input.asset.variantKind = "savings-passthrough";
    const before = compile(input);
    input.claim.dimension = "custodyEscrow";
    input.claim.disposition = "not-applicable";
    input.claim.statement = "idle-token-custody-absent";
    input.claim.coverage = { kind: "scope-only", shareFraction: null };
    if (input.claim.target.kind !== "deployment") throw new Error("Expected deployment");
    input.claim.target.idleCustodyProof = { mechanism: "burn-parent-mint-parent", upstreamAssetId: "beta", parentTokenAddress: "0x4444444444444444444444444444444444444444", burnSourceUrl: "https://example.com/code", mintSourceUrl: "https://example.com/code" };
    const after = compile(input);
    expect(after.asset.allocationScopeFacts).toContainEqual(expect.objectContaining({ claimKey: "contract-borrowing", admitted: true, disposition: "not-applicable" }));
    expect(wrapperFacts(after).facts.custodyEscrow.disposition).toBe("issuer-undisclosed");
    expect(wrapperFacts(after).facts.measuredUnwind).toEqual(wrapperFacts(before).facts.measuredUnwind);
    expect(after.card.trace.wrapperParentLimit?.limit).toBe(before.card.trace.wrapperParentLimit?.limit);
    input.claim.target.idleCustodyProof.parentTokenAddress = "0x5555555555555555555555555555555555555555";
    const missing = compile(input);
    expect(missing.asset.allocationScopeFacts).toContainEqual(expect.objectContaining({ claimKey: "contract-borrowing", admitted: false, rejectionReason: "parent-claim-unmatched" }));
    input.claim.target.idleCustodyProof.parentTokenAddress = "0x4444444444444444444444444444444444444444";
    input.extension.assets.find((row) => row.assetId === "beta")!.admissionQuarantine = {
      code: "fact-validation-failed", path: "researchEvidence", message: "Required parent input is unavailable",
    };
    const nrParent = compile(input);
    expect(nrParent.card.trace.finalScore).toBeNull();
    expect(wrapperFacts(nrParent).facts.custodyEscrow.disposition).toBe("issuer-undisclosed");
  });
  it("quarantines malformed claim bytes per asset while valid peers remain evaluated", () => {
    const input = fixture();
    const clean = compile(input);
    const invalid = structuredClone(input.extension) as unknown as { assets: { assetId: string; wrapperAllocationReview?: { claims: { target: unknown }[] } }[] };
    invalid.assets.find((row) => row.assetId === "alpha")!.wrapperAllocationReview!.claims[0]!.target = { kind: "deployment" };
    const factSet = compileSafetyScoreV9FactSetFromFixedInput(input.fixed, invalid);
    const result = evaluateV9FactSet(factSet, V9_CANDIDATE_POLICY_V1);
    expect(result.assets.find((row) => row.assetId === "alpha")!.trace.finalScore).toBeNull();
    const cleanBeta = evaluateV9FactSet(clean.factSet, V9_CANDIDATE_POLICY_V1).assets.find((row) => row.assetId === "beta")!;
    expect(cleanBeta.trace.finalScore).not.toBeNull();
    expect(result.assets.find((row) => row.assetId === "beta")!.trace.finalScore).toBe(cleanBeta.trace.finalScore);
  });
  it("policy required-layer and assessment clones change actual admitted scoped resolution", () => {
    const input = fixture();
    const compiled = compile(input).asset;
    const context = createAssetBuildContext(normalizeSafetyScoreV9CompilerInput(input.fixed), input.extension, input.asset, "a".repeat(64));
    const factInput = { dependencies: compiled.dependencies, reserveStatus: compiled.reserveStatus, reserveExposures: compiled.reserveExposures };
    const baseline = buildAllocationScopeFacts(context, factInput);
    expect(resolveAllocationDimensionCoverage(baseline, "leverage")).toMatchObject({ complete: true, assessment: "none" });
    const requiredPolicy = structuredClone(V9_CANDIDATE_POLICY_V1.policy);
    requiredPolicy.semantic.formula.wrapperAllocationScope.requiredScopes.contractOnly.leverage.push("lender-of-record");
    const moreRequired = buildAllocationScopeFacts(context, factInput, loadV9MethodologyPolicy(requiredPolicy));
    expect(resolveAllocationDimensionCoverage(moreRequired, "leverage").complete).toBe(false);
    const riskPolicy = structuredClone(V9_CANDIDATE_POLICY_V1.policy);
    riskPolicy.semantic.formula.wrapperAllocationScope.leverageAssessments["no-borrowing-surface"] = "high";
    const repriced = buildAllocationScopeFacts(createAssetBuildContext(context.fixedInput, input.extension, input.asset, "a".repeat(64)), factInput, loadV9MethodologyPolicy(riskPolicy));
    expect(resolveAllocationDimensionCoverage(repriced, "leverage")).toMatchObject({ complete: true, assessment: "high" });
  });
});
