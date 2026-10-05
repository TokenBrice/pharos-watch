import { describe, expect, it } from "vitest";
import { compileReviewedControlScope, reviewedControlScopeSemantics } from "../safety-score-v9/control-scope";
import { V9ControlExecutionScopeSchema, type V9ControlExecutionScope } from "../../types/safety-score-v9-control-scope";
import { V9ControlCapabilitySchema } from "../../types/safety-score-v9-fact-input-primitives";
import { MintAuthorityProfileSchema } from "../../types/stablecoin-meta-control-schemas";
import { evaluateV9EconomicControl } from "../safety-score-v9/control";
import { makeDeploymentControl, makeEconomicControlArgs, makeEconomicControlFacts, makeReviewedMintInput } from "./safety-score-v9-fixtures.test-support";
import { reviewedScope, SCOPE_CLOCK, SCOPE_CONTROLLER } from "./safety-score-v9-control-scope.test-support";

function maximalScope(): V9ControlExecutionScope {
  const scope = reviewedScope();
  const path = scope.paths[0]!;
  path.capabilities = [...V9ControlCapabilitySchema.options];
  path.capSemantics = { kind: "unbounded", bound: null };
  path.claimImpairment = "unbounded";
  path.unavoidableDelaySec = 0;
  path.downstreamCallDomain = {
    kind: "conservative-maximal", controllerDeployment: SCOPE_CONTROLLER, executorDeployment: SCOPE_CONTROLLER,
    sourceDeployment: SCOPE_CONTROLLER, targets: "any-contract", calldata: "arbitrary-bytes", capabilities: "all-reachable",
    arbitraryCallVerified: true, sourceRuntimeCorrespondence: "verified", executorPin: { ...scope.pin },
    sourceRuntimeIdentity: scope.pin.runtimeIdentity, observedSourceRuntimeIdentity: scope.pin.runtimeIdentity,
    minimumDelaySec: 0, source: { url: "https://example.com/verified-executor", location: "execute: arbitrary destination.call(data)" },
  };
  return scope;
}
const compile = (scope: V9ControlExecutionScope, assetId = "alpha") => compileReviewedControlScope(scope, SCOPE_CONTROLLER, assetId, SCOPE_CLOCK, 90 * 86400);

describe("conservative maximal execution reach", () => {
  it("compiles verified arbitrary execution complete, global and adverse for every liability", () => {
    const scope = V9ControlExecutionScopeSchema.parse(maximalScope());
    for (const asset of ["alpha", "another-liability"]) {
      const result = compile(scope, asset);
      expect(result.complete).toBe(true);
      expect(result.paths[0]).toMatchObject({ reach: "root", economicLossScope: "global-claim", claimImpairment: "unbounded", unavoidableDelaySec: 0 });
      expect(result.paths[0]!.capabilities).toEqual(V9ControlCapabilitySchema.options);
      expect(reviewedControlScopeSemantics(result.paths)).toEqual({ capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded" });
      expect(result.moduleImpact).toBe("unresolved");
    }
  });

  it("rejects unverified, changed or misbound executor proof even for unparsed compiler callers", () => {
    const changes = [
      { arbitraryCallVerified: false }, { sourceRuntimeCorrespondence: "unknown" },
      { controllerDeployment: SCOPE_CONTROLLER.replace("1111", "2222") },
      { executorDeployment: SCOPE_CONTROLLER.replace("ethereum", "base") },
      { observedSourceRuntimeIdentity: "changed-runtime" },
      { executorPin: { ...maximalScope().pin, hash: "different-block" } },
      { executorPin: { ...maximalScope().pin, runtimeIdentity: "changed-executor" } },
      { executorPin: { ...maximalScope().pin, signerIdentity: "changed-controller" } },
      { executorPin: undefined }, { source: {} }, { sourceRuntimeIdentity: "" },
    ];
    for (const change of changes) {
      const scope = maximalScope();
      Object.assign(scope.paths[0]!.downstreamCallDomain!, change);
      expect(V9ControlExecutionScopeSchema.safeParse(scope).success).toBe(false);
      expect(compile(scope)).toMatchObject({ complete: false, reviewed: false, provenPaths: [], diagnostics: ["execution-maximal-domain-unverified"] });
    }
  });

  it("cannot narrow capabilities, impairment, economic reach, activation or minimum delay", () => {
    const changes = [
      { capabilities: ["parameter-change"] }, { capSemantics: { kind: "bounded", bound: { amount: 1, unit: "supply-fraction" } } },
      { claimImpairment: "none" }, { economicLossScope: "deployment" },
      { reach: "other-liability", affectedLiabilityIds: ["beta"] }, { activation: "disabled-final" }, { unavoidableDelaySec: 86400 },
    ];
    for (const change of changes) {
      const scope = maximalScope();
      Object.assign(scope.paths[0]!, change);
      expect(V9ControlExecutionScopeSchema.safeParse(scope).success).toBe(false);
      expect(compile(scope).complete).toBe(false);
    }
    const exclusions = maximalScope();
    Object.assign(exclusions.paths[0]!.downstreamCallDomain!, { excludedTargets: [SCOPE_CONTROLLER] });
    expect(V9ControlExecutionScopeSchema.safeParse(exclusions).success).toBe(false);
  });

  it("keeps authoring delay at the fastest controller path and binds the exact controller", () => {
    const scope = maximalScope();
    const controlSchema = MintAuthorityProfileSchema.shape.controls.unwrap().element;
    const control = {
      chain: "ethereum", address: SCOPE_CONTROLLER.slice("ethereum:".length), label: "Reviewed arbitrary executor",
      role: "other", authorityType: "eoa", directMintAbility: "parameter-only", timelockDelaySec: 0, executionScope: scope,
    };
    expect(controlSchema.safeParse(control).success).toBe(true);
    scope.paths[0]!.unavoidableDelaySec = 86400;
    scope.paths[0]!.downstreamCallDomain!.minimumDelaySec = 86400;
    expect(controlSchema.safeParse(control).success).toBe(false);
    expect(controlSchema.safeParse({ ...control, executionScope: maximalScope(), address: "0x2222222222222222222222222222222222222222" }).success).toBe(false);
  });

  it("accepts a separately runtime-bound EIP-7702 implementation without conflating it with the root account", () => {
    const scope = maximalScope();
    const domain = scope.paths[0]!.downstreamCallDomain!;
    domain.sourceDeployment = "ethereum:0x2222222222222222222222222222222222222222";
    domain.sourceRuntimeIdentity = domain.observedSourceRuntimeIdentity = "implementation-runtime";
    expect(compile(V9ControlExecutionScopeSchema.parse(scope)).complete).toBe(true);
    domain.observedSourceRuntimeIdentity = "changed-implementation";
    expect(compile(scope).complete).toBe(false);
  });

  it("retains partial closure and stale evidence instead of certifying an arbitrary-call label", () => {
    const scope = maximalScope();
    scope.inventory = "partial"; scope.confidence = "partial"; scope.closure.permissions = false;
    const result = compile(V9ControlExecutionScopeSchema.parse(scope));
    expect(result.complete).toBe(false);
    expect(result.provenPaths).toHaveLength(1);
    expect(result.provenPaths[0]!.claimImpairment).toBe("unbounded");
    scope.extensions!.entries = [{ deployment: SCOPE_CONTROLLER, runtimeIdentity: "extension-runtime", kind: "module", pathRefs: ["issuance"], mutableReachClosed: false }];
    scope.confidence = "unknown";
    expect(compile(V9ControlExecutionScopeSchema.parse(scope)).moduleImpact).toBe("unresolved");
    expect(compileReviewedControlScope(maximalScope(), SCOPE_CONTROLLER, "alpha", Date.parse("2026-11-01") / 1000, 90 * 86400).complete).toBe(false);
  });

  it("keeps the worst case when mixed with exact benign paths and grants no noninterference credit", () => {
    const scope = maximalScope();
    const benign = { ...reviewedScope().paths[0]!, id: "benign", reach: "other-liability" as const, affectedLiabilityIds: ["beta"], claimImpairment: "none" as const, unavoidableDelaySec: 86400 };
    scope.paths.push(benign);
    scope.extensions!.entries = [{ deployment: SCOPE_CONTROLLER, runtimeIdentity: "extension-runtime", kind: "module", pathRefs: ["benign"], mutableReachClosed: true }];
    const result = compile(V9ControlExecutionScopeSchema.parse(scope));
    expect(result.complete).toBe(true);
    expect(result.paths.map((path) => path.id)).toEqual(["issuance"]);
    expect(result.moduleImpact).toBe("relevant");
    expect(reviewedControlScopeSemantics(result.paths).claimImpairment).toBe("unbounded");
    const unknown = makeDeploymentControl("mint", "mint", { capSemantics: { kind: "unknown", bound: null }, claimImpairment: "unknown", authority: { authorityKey: SCOPE_CONTROLLER, model: "contract", threshold: null } });
    const mint = makeReviewedMintInput(unknown.controlKey);
    const adverse = { ...unknown, executionScope: scope, executionScopeComplete: true, capabilities: result.paths[0]!.capabilities, ...reviewedControlScopeSemantics(result.paths) };
    const adverseScore = evaluateV9EconomicControl(makeEconomicControlArgs({ facts: makeEconomicControlFacts([adverse]), mint })).score;
    const unknownScore = evaluateV9EconomicControl(makeEconomicControlArgs({ facts: makeEconomicControlFacts([unknown]), mint })).score;
    expect(adverseScore).toBeLessThanOrEqual(unknownScore!);
  });
});
