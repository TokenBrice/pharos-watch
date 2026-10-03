import { describe, expect, it } from "vitest";
import { compileReviewedControlScope, effectiveAuthoritySignatureRequirement, minimumWeightedSignatures, partialControlScopeSemantics, reviewedControlScopeSemantics } from "../safety-score-v9/control-scope";
import { applyMergedMintSignals } from "../safety-score-v9/control-mint-grade";
import { evaluateV9EconomicControl } from "../safety-score-v9/control";
import { deriveV9MintPosture } from "../safety-score-v9/control-primitives";
import { V9ControlExecutionScopeSchema, V9WeightedQuorumSchema, type V9ControlExecutionScope } from "../../types/safety-score-v9-control-scope";
import { V9_CANDIDATE_POLICY_V1, loadV9MethodologyPolicy } from "../safety-score-v9/policy";
import { buildV9DependencyEvaluationPlan } from "../safety-score-v9/dependencies";
import { minimalAsset } from "./safety-score-v9-facts.fixture-support";
import { boundedUnknown, makeDeploymentControl, makeEconomicControlArgs, makeEconomicControlFacts, makeReviewedMintInput } from "./safety-score-v9-fixtures.test-support";
import { reviewedScope, weightedQuorum, SCOPE_CLOCK, SCOPE_CONTROLLER } from "./safety-score-v9-control-scope.test-support";
const policy = V9_CANDIDATE_POLICY_V1.policy.semantic.control;
const compile = (scope = reviewedScope(), controller = SCOPE_CONTROLLER, clock = SCOPE_CLOCK) => compileReviewedControlScope(scope, controller, "alpha", clock, 90 * 86400);

describe("V10 exact authority scope", () => {
  it("keeps chain-qualified identity and rejects changed runtime/signers, stale and future review relief", () => {
    expect(compile().complete).toBe(true);
    expect(compile(reviewedScope(), SCOPE_CONTROLLER.replace("ethereum", "arbitrum")).complete).toBe(false);
    for (const changed of [{ runtimeIdentity: "runtime-b" }, { signerIdentity: "signers-b" }]) {
      const scope = reviewedScope(); scope.observedState = { ...scope.observedState, ...changed };
      expect(compile(scope).complete).toBe(false);
    }
    expect(compile(reviewedScope(), SCOPE_CONTROLLER, Date.parse("2026-11-01") / 1000).complete).toBe(false);
    expect(compile(reviewedScope(), SCOPE_CONTROLLER, Date.parse("2026-09-30") / 1000).complete).toBe(false);
  });

  it("preserves legacy posture for partial equivalent facts and retains newly verified adverse reach", () => {
    const scope = reviewedScope({ inventory: "partial", confidence: "partial" });
    const legacy = makeDeploymentControl("mint", "mint", { capSemantics: scope.paths[0]!.capSemantics, claimImpairment: "bounded", authority: { authorityKey: SCOPE_CONTROLLER, model: "contract", threshold: null } });
    const mint = makeReviewedMintInput(legacy.controlKey);
    const partial = { ...legacy, executionScope: scope, executionScopeComplete: false, ...partialControlScopeSemantics(legacy, compile(scope)) };
    const evaluate = (control: typeof legacy) => evaluateV9EconomicControl(makeEconomicControlArgs({ facts: makeEconomicControlFacts([control]), mint }));
    expect(evaluate(partial).score).toBe(evaluate(legacy).score);
    expect(evaluate(partial).reasons).toEqual(evaluate(legacy).reasons);
    scope.paths[0]!.capSemantics = { kind: "unbounded", bound: null };
    scope.paths[0]!.claimImpairment = "unbounded";
    const adverse = { ...partial, ...partialControlScopeSemantics(legacy, compile(scope)) };
    expect(deriveV9MintPosture(adverse, mint, false, policy.governedIssuance)).toBe("unbounded-unreconciled");
    expect(evaluate(adverse).score).toBeLessThan(evaluate(legacy).score!);
    scope.paths[0]!.activation = "disabled-final";
    const disabledPartial = { ...partial, ...partialControlScopeSemantics(legacy, compile(scope)) };
    expect(deriveV9MintPosture(disabledPartial, mint, false, policy.governedIssuance)).toBe("unbounded-unreconciled");
    expect(evaluate(disabledPartial).score).toBe(evaluate(adverse).score);
    scope.inventory = "complete"; scope.confidence = "verified";
    expect(reviewedControlScopeSemantics(compile(scope).paths).claimImpairment).toBe("none");
  });

  it("removes only certified final-disabled issuance and keeps disabled-reactivatable and partial remainders", () => {
    const scope = reviewedScope(); scope.paths[0]!.activation = "disabled-final";
    expect(compile(scope).paths).toEqual([]);
    scope.inventory = "partial"; scope.confidence = "partial";
    expect(compile(scope).paths.map((path) => path.id)).toEqual(["issuance"]);
    scope.paths[0]!.activation = "disabled-reactivatable";
    expect(compile(scope).paths[0]!.capabilities).toContain("mint");
    scope.paths[0]!.reactivationRefs = ["missing-admin"];
    expect(V9ControlExecutionScopeSchema.safeParse(scope).success).toBe(false);
  });

  it("requires fixed counterfactual initialization while retaining latent mint", () => {
    const scope = reviewedScope(); const path = scope.paths[0]!;
    path.activation = "counterfactual";
    path.counterfactual = { factoryDeployment: "ethereum:0x2222222222222222222222222222222222222222", factoryRuntimeIdentity: "factory-runtime", runtimeIdentity: "safe-runtime", create2Address: SCOPE_CONTROLLER, create2Salt: `0x${"00".repeat(32)}`, initializerCalldata: "0x1234", initializationIdentity: "fixed-init", fixedInitialization: true, owners: ["0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444", "0x5555555555555555555555555555555555555555"], threshold: 2, modules: [], fallbackHandler: null, accountStatePin: scope.pin };
    expect(compile(V9ControlExecutionScopeSchema.parse(scope)).paths[0]!.capabilities).toContain("mint");
    expect(V9ControlExecutionScopeSchema.safeParse({ ...scope, paths: [{ ...path, counterfactual: { ...path.counterfactual, fixedInitialization: false } }] }).success).toBe(false);
    path.counterfactual.factoryDeployment = path.counterfactual.factoryDeployment.replace("ethereum", "base");
    expect(V9ControlExecutionScopeSchema.safeParse(scope).success).toBe(false);
  });

  it("waives module presence only after exhaustive noninterference, not absence credit", () => {
    const scope = reviewedScope();
    const other: V9ControlExecutionScope["paths"][number] = { ...scope.paths[0]!, id: "other-product", reach: "other-liability", affectedLiabilityIds: ["beta"] };
    scope.paths.push(other);
    scope.extensions!.entries = [{ deployment: "ethereum:0x2222222222222222222222222222222222222222", runtimeIdentity: "module-runtime", kind: "module", pathRefs: [other.id], mutableReachClosed: true }];
    const proof = compile(scope);
    const moduleCreditPolicy = structuredClone(policy);
    moduleCreditPolicy.mintMergedSignals.modulesOrGuardsAdjustment.noneDetectedCredit = 1;
    const control = makeDeploymentControl("mint", "mint", { executionScope: scope, executionScopeComplete: proof.complete, moduleImpact: proof.moduleImpact, modulesOrGuards: "present", authority: { authorityKey: SCOPE_CONTROLLER, model: "contract", threshold: null } });
    expect(proof.moduleImpact).toBe("verified-noninterfering");
    expect(applyMergedMintSignals(70, control, undefined, moduleCreditPolicy)).toBe(70);
    expect(applyMergedMintSignals(70, { ...control, modulesOrGuards: "none-detected" }, undefined, moduleCreditPolicy)).toBeGreaterThan(70);
    other.reach = "root"; other.affectedLiabilityIds = ["alpha"];
    const relevant = compile(scope);
    expect(applyMergedMintSignals(70, { ...control, moduleImpact: relevant.moduleImpact }, undefined, policy)).toBeLessThan(70);
    scope.extensions!.exhaustive = false;
    expect(compile(scope).moduleImpact).toBe("relevant");
  });

  it("recognizes proven module reach before partial inventory and mutable-closure guards", () => {
    const scope = reviewedScope({ inventory: "partial", confidence: "partial" });
    scope.closure.mutableTargets = false;
    scope.extensions = {
      exhaustive: false, paginationEnd: null, sourceRuntimeCorrespondence: false,
      entries: [
        { deployment: "ethereum:0x2222222222222222222222222222222222222222", runtimeIdentity: "unsearched-module-runtime", kind: "module", pathRefs: [], mutableReachClosed: false },
        { deployment: "ethereum:0x3333333333333333333333333333333333333333", runtimeIdentity: "proven-module-runtime", kind: "module", pathRefs: ["issuance"], mutableReachClosed: false },
      ],
    };
    const proof = compile(scope);
    expect(proof.complete).toBe(false);
    expect(proof.moduleImpact).toBe("relevant");
    const control = makeDeploymentControl("mint", "mint", { executionScope: scope, executionScopeComplete: proof.complete, moduleImpact: proof.moduleImpact, modulesOrGuards: "present" });
    expect(applyMergedMintSignals(70, control, undefined, policy)).toBeLessThan(applyMergedMintSignals(70, { ...control, modulesOrGuards: "unknown" }, undefined, policy));
    expect(applyMergedMintSignals(70, control, undefined, policy)).toBe(applyMergedMintSignals(70, { ...control, moduleImpact: "unresolved" }, undefined, policy));
    expect(compile(scope, SCOPE_CONTROLLER, Date.parse("2026-11-01") / 1000).moduleImpact).toBe("unresolved");
    expect(compile(scope, SCOPE_CONTROLLER, Date.parse("2026-09-30") / 1000).moduleImpact).toBe("unresolved");
    expect(compile(scope, SCOPE_CONTROLLER.replace("ethereum", "arbitrum")).moduleImpact).toBe("unresolved");
    for (const changed of [{ runtimeIdentity: "runtime-b" }, { signerIdentity: "signers-b" }]) {
      expect(compile({ ...scope, observedState: { ...scope.observedState, ...changed } }).moduleImpact).toBe("unresolved");
    }
  });

  it("keeps partial inventories without positively proven module reach unresolved and score-neutral", () => {
    const scope = reviewedScope({ inventory: "partial", confidence: "partial" });
    scope.extensions!.entries = [{ deployment: "ethereum:0x2222222222222222222222222222222222222222", runtimeIdentity: "module-runtime", kind: "module", pathRefs: ["issuance"], mutableReachClosed: false }];
    const path = scope.paths[0]!;
    for (const reach of ["unknown", "other-liability"] as const) {
      path.reach = reach; path.affectedLiabilityIds = ["beta"];
      const proof = compile(scope);
      expect(proof.moduleImpact).toBe("unresolved");
      const legacy = makeDeploymentControl("mint", "mint", { modulesOrGuards: "unknown" });
      expect(applyMergedMintSignals(70, { ...legacy, executionScope: scope, executionScopeComplete: proof.complete, moduleImpact: proof.moduleImpact }, undefined, policy)).toBe(applyMergedMintSignals(70, legacy, undefined, policy));
    }
    path.reach = "root"; path.activation = "unknown";
    expect(compile(scope).moduleImpact).toBe("unresolved");
    path.activation = "disabled-final";
    expect(compile(scope).moduleImpact).toBe("unresolved");
    path.activation = "active"; scope.confidence = "unknown";
    expect(compile(scope).moduleImpact).toBe("unresolved");
    scope.extensions!.entries = [];
    expect(compile(scope).moduleImpact).toBe("unresolved");
  });

  it("does not mistake unknown transitive reach for positive module proof", () => {
    const scope = reviewedScope({ inventory: "partial", confidence: "partial" });
    const other = { ...scope.paths[0]!, id: "other-product", reach: "other-liability" as const, affectedLiabilityIds: ["beta"], upgradeRefs: ["issuance"] };
    scope.paths.push(other);
    scope.extensions!.entries = [{ deployment: "ethereum:0x2222222222222222222222222222222222222222", runtimeIdentity: "module-runtime", kind: "module", pathRefs: [other.id], mutableReachClosed: false }];
    scope.paths[0]!.reach = "unknown";
    expect(compile(scope).moduleImpact).toBe("unresolved");
    scope.paths[0]!.reach = "root";
    expect(compile(scope).moduleImpact).toBe("relevant");
  });

  it("excludes another liability's deployment paths unless a proved reference reaches this liability", () => {
    const scope = reviewedScope();
    scope.paths[0]!.reach = "deployment";
    scope.paths[0]!.affectedLiabilityIds = ["beta"];
    scope.extensions!.entries = [{ deployment: SCOPE_CONTROLLER, runtimeIdentity: "module-runtime", kind: "module", pathRefs: ["issuance"], mutableReachClosed: true }];
    const proof = compile(V9ControlExecutionScopeSchema.parse(scope));
    const control = makeDeploymentControl("mint", "mint", { executionScope: scope, executionScopeComplete: proof.complete, modulesOrGuards: "present", moduleImpact: proof.moduleImpact });
    expect(proof.paths).toEqual([]);
    expect(proof.moduleImpact).toBe("verified-noninterfering");
    expect(applyMergedMintSignals(85, control, undefined, policy)).toBe(85);
    scope.paths.push({ ...scope.paths[0]!, id: "alpha-mint", reach: "root", affectedLiabilityIds: ["alpha"] });
    scope.paths[0]!.upgradeRefs = ["alpha-mint"];
    const linked = compile(V9ControlExecutionScopeSchema.parse(scope));
    expect(linked.paths.map((path) => path.id)).toEqual(["issuance", "alpha-mint"]);
    expect(linked.moduleImpact).toBe("relevant");
    expect(applyMergedMintSignals(85, { ...control, moduleImpact: linked.moduleImpact }, undefined, policy)).toBeLessThan(85);
  });

  it.each(["cap", "claim"] as const)("retains independently proved unbounded %s beside adjacent uncertainty", (adverseField) => {
    const known = makeDeploymentControl("mint", "mint", {
      authority: { authorityKey: SCOPE_CONTROLLER, model: "contract", threshold: null },
      capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
    });
    const adjacentUnknown = { ...known, status: boundedUnknown(),
      ...(adverseField === "cap" ? { claimImpairment: "unknown" as const } : { capSemantics: { kind: "unknown" as const, bound: null } }),
    };
    const mint = makeReviewedMintInput(known.controlKey);
    const evaluate = (control: typeof known, review = mint) => evaluateV9EconomicControl(makeEconomicControlArgs({ facts: makeEconomicControlFacts([control]), mint: review }));
    const baseline = evaluate(known);
    for (const review of [mint, { ...mint, status: boundedUnknown() }]) {
      const result = evaluate(adjacentUnknown, review);
      expect(deriveV9MintPosture(adjacentUnknown, review, false, policy.governedIssuance)).toBe("unbounded-unreconciled");
      expect(result.structuralFailures).toContainEqual(expect.objectContaining({ kind: "centralized-mint", severity: "high" }));
      expect(result.score).toBe(baseline.score);
      expect(result.reasons.map((reason) => reason.code)).toContain(adverseField === "cap" ? "unknown-control-mint-ability" : "unknown-control-cap-authority");
    }
    expect(deriveV9MintPosture({ ...adjacentUnknown, economicLossScope: "unknown" }, mint, false, policy.governedIssuance)).toBe("unknown");
  });

  it("retains reconciled but unsupervised adverse mint evidence without clearing aggregate uncertainty", () => {
    const control = makeDeploymentControl("mint", "mint", {
      capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unknown",
      status: boundedUnknown(), authority: { authorityKey: SCOPE_CONTROLLER, model: "eoa", threshold: null },
    });
    const mint = { ...makeReviewedMintInput(control.controlKey), reconciliation: "continuous" as const, status: boundedUnknown() };
    const result = evaluateV9EconomicControl(makeEconomicControlArgs({ facts: makeEconomicControlFacts([control]), mint }));
    expect(result.structuralFailures).toContainEqual(expect.objectContaining({ kind: "centralized-mint", severity: "high" }));
    expect(result.reasons.map((reason) => reason.code)).toContain("unknown-control-mint-ability");
    const reconciliationUnknown = { ...mint, reconciliation: "unknown" as const };
    const unknownResult = evaluateV9EconomicControl(makeEconomicControlArgs({
      facts: makeEconomicControlFacts([control]), mint: reconciliationUnknown,
    }));
    expect(result.score).toBe(unknownResult.score);
    expect(result.components).toContainEqual(expect.objectContaining({
      kind: "mint", posture: "unbounded-reconciled", score: 52,
    }));
  });

  it("does not let a friendly reviewed mint authority erase another unreviewed authority on the deployment", () => {
    const friendly = makeDeploymentControl("mint:friendly", "mint");
    const unknown = makeDeploymentControl("mint:unreviewed", "mint", { authority: null, capSemantics: { kind: "unknown", bound: null }, claimImpairment: "unknown", economicLossScope: "unknown" });
    const mint = makeReviewedMintInput(friendly.controlKey);
    expect(deriveV9MintPosture(unknown, mint, false, policy.governedIssuance)).toBe("unknown");
    const result = evaluateV9EconomicControl(makeEconomicControlArgs({ facts: makeEconomicControlFacts([friendly, unknown]), mint }));
    expect(result.components.some((component) => component.posture === "unknown" && component.controlKeys.includes(unknown.controlKey))).toBe(true);
  });

  it("removes only completely excluded no-risk controls from the common-mode census", () => {
    const asset = minimalAsset("alpha");
    const scope = reviewedScope();
    const control = makeDeploymentControl("mint", "mint", { executionScope: scope, executionScopeComplete: true, capabilities: [], claimImpairment: "none", economicLossScope: "access-only", failureDomains: [{ kind: "mint-control", key: SCOPE_CONTROLLER }] });
    const pair = [ { ...asset, assetId: "alpha", controls: [control] }, { ...asset, assetId: "beta", controls: [{ ...control, controlKey: "mint:beta", executionScopeComplete: false }] } ];
    expect(buildV9DependencyEvaluationPlan({ activeAssetIds: ["alpha", "beta"], assets: pair }).commonModeGroups.some((group) => group.failureDomain.key === SCOPE_CONTROLLER)).toBe(false);
    for (const capabilities of [[], ["mint"], ["upgrade"]] as const) {
      pair[0]!.controls = [{ ...control, executionScopeComplete: capabilities.length > 0, capabilities: [...capabilities] }];
      expect(buildV9DependencyEvaluationPlan({ activeAssetIds: ["alpha", "beta"], assets: pair }).commonModeGroups.some((group) => group.failureDomain.key === SCOPE_CONTROLLER)).toBe(true);
    }
  });
});
describe("V10 weighted cryptographic quorum", () => {
  it("maps EUROP to one signature and RLUSD-style 24/1 weight quorum to two", () => {
    expect(minimumWeightedSignatures(weightedQuorum())).toBe(1);
    const row = weightedQuorum([...Array<number>(8).fill(24), ...Array<number>(18).fill(1)], 25);
    expect(minimumWeightedSignatures(row)).toBe(2);
    expect(minimumWeightedSignatures({ ...row, signers: [...row.signers].reverse() })).toBe(2);
    expect(minimumWeightedSignatures({ ...row, quorum: 24 })).toBe(1);
    const authority = { authorityKey: row.deployment, model: "multisig" as const, threshold: null, weightedQuorum: row };
    expect(effectiveAuthoritySignatureRequirement(authority)).toBe(2);
    expect(effectiveAuthoritySignatureRequirement({ ...authority, weightedQuorum: { ...row, masterKey: "enabled" } })).toBe(1);
    expect(effectiveAuthoritySignatureRequirement({ ...authority, weightedQuorum: { ...row, regularKey: { state: "enabled", address: row.signers[0]!.account } } })).toBe(1);
    expect(effectiveAuthoritySignatureRequirement({ ...authority, weightedQuorum: { ...row, masterKey: "unknown" } })).toBeNull();
  });
  it("retains weighted EVM quorum seven as three signatures and monotonic thresholds", () => {
    const base = weightedQuorum();
    const { masterKey: _masterKey, regularKey: _regularKey, ...review } = base;
    const row = V9WeightedQuorumSchema.parse({ ...review, totalWeight: undefined, scheme: "contract", deployment: SCOPE_CONTROLLER, quorum: 7, signers: [3, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1].map((weight, index) => ({ weight, account: `0x${(index + 2).toString(16).padStart(40, "0")}` })) });
    expect(minimumWeightedSignatures(row)).toBe(3);
    expect(minimumWeightedSignatures({ ...row, quorum: 6 })).toBe(2);
    expect(minimumWeightedSignatures({ ...row, signers: row.signers.map((signer, index) => index === 0 ? { ...signer, weight: 7 } : signer) })).toBe(1);
    expect(minimumWeightedSignatures({ ...row, status: "unknown" })).toBeNull();
  });
  it("rejects duplicates/unattainable quorum and awards no majority or four-plus credit", () => {
    const row = weightedQuorum([1, 1, 1, 1, 1, 1], 4);
    expect(V9WeightedQuorumSchema.safeParse({ ...row, signers: [row.signers[0], row.signers[0]] }).success).toBe(false);
    expect(V9WeightedQuorumSchema.safeParse({ ...row, quorum: 7 }).success).toBe(false);
    const control = makeDeploymentControl("mint", "mint", { delaySec: 0, modulesOrGuards: "unknown", authority: { authorityKey: row.deployment, model: "multisig", threshold: null, weightedQuorum: row } });
    expect(applyMergedMintSignals(70, control, undefined, policy)).toBe(70 + policy.mintMergedSignals.multisigQuorumAdjustment.thresholdThreePlus);
    expect(applyMergedMintSignals(70, { ...control, authority: { ...control.authority!, weightedQuorum: weightedQuorum() } }, undefined, policy)).toBeLessThan(70);
  });
  it("includes scope admission and amount policy in semantic identity", () => {
    const changed = structuredClone(V9_CANDIDATE_POLICY_V1.policy);
    changed.semantic.control.exactScope.issuedCurrencyAmount.maxInputLength += 1;
    expect(loadV9MethodologyPolicy(changed).semanticDigest).not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
    const reordered = structuredClone(V9_CANDIDATE_POLICY_V1.policy);
    reordered.semantic.control.exactScope.activationStates.reverse();
    expect(loadV9MethodologyPolicy(reordered).semanticDigest).toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
  });
});
