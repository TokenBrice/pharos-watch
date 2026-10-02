import { normalizeDeploymentId } from "../deployment-id";
import type { V9ControlExecutionScope, V9WeightedQuorum, V9ModuleImpact } from "../../types/safety-score-v9-control-scope";
import type { V9DeploymentControlFactV2 } from "../../types/safety-score-v9-facts";

export function minimumWeightedSignatures(quorum: V9WeightedQuorum): number | null {
  if (quorum.status !== "verified") return null;
  let sum = 0;
  const weights = quorum.signers.map((signer) => signer.weight).sort((a, b) => b - a);
  for (let index = 0; index < weights.length; index++) {
    sum += weights[index]!;
    if (sum >= quorum.quorum) return index + 1;
  }
  return null;
}
export function effectiveAuthoritySignatureRequirement(authority: V9DeploymentControlFactV2["authority"]): number | null {
  if (authority == null) return null;
  if (authority.model === "eoa") return 1;
  if (authority.model !== "multisig") return null;
  const weighted = authority.weightedQuorum;
  if (!weighted) return authority.threshold?.required ?? null;
  if (weighted.status !== "verified") return null;
  if (weighted.scheme === "xrpl") {
    if (weighted.masterKey === "enabled" || weighted.regularKey?.state === "enabled") return 1;
    if (weighted.masterKey !== "disabled" || weighted.regularKey?.state !== "absent") return null;
  }
  return minimumWeightedSignatures(weighted);
}
export function controlPathIsReachable(path: V9ControlExecutionScope["paths"][number], complete: boolean): boolean {
  return !complete || path.activation !== "disabled-final";
}

function controlPathAffectsLiability(path: V9ControlExecutionScope["paths"][number], scope: V9ControlExecutionScope, assetId: string, provenOnly = false): boolean {
  const pending = [path];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    if (!controlPathIsReachable(current, true)) continue;
    if (provenOnly && (current.reach === "unknown" || current.activation === "unknown")) continue;
    if (current.reach !== "other-liability" || current.affectedLiabilityIds.includes(assetId)) return true;
    for (const ref of [...current.controlRefs, ...current.reactivationRefs, ...current.permissionChangeRefs, ...current.upgradeRefs, ...current.bypassRefs]) {
      const target = scope.paths.find((candidate) => candidate.id === ref);
      if (!target) {
        if (!provenOnly) return true;
        continue;
      }
      pending.push(target);
    }
  }
  return false;
}
export function compileReviewedControlScope(scope: V9ControlExecutionScope | undefined, controllerDeployment: string, assetId: string, clockSec: number, maxAgeSec: number) {
  const diagnostics: string[] = [];
  if (!scope) return { complete: false, reviewed: false, paths: [], diagnostics: ["execution-scope-unreviewed"], moduleImpact: "unresolved" as V9ModuleImpact };
  if (scope.controllerDeployment !== normalizeDeploymentId(controllerDeployment)) diagnostics.push("execution-controller-mismatch");
  const reviewed = Date.parse(`${scope.reviewedAt}T00:00:00Z`) / 1000;
  const observed = Date.parse(`${scope.observedAt}T00:00:00Z`) / 1000;
  const expiry = Date.parse(`${scope.expiresAt}T00:00:00Z`) / 1000;
  if (reviewed > clockSec || observed > clockSec) diagnostics.push("execution-review-future");
  if (expiry < clockSec || clockSec - observed > maxAgeSec) diagnostics.push("execution-review-expired");
  if (scope.pin.runtimeIdentity !== scope.observedState.runtimeIdentity || scope.pin.signerIdentity !== scope.observedState.signerIdentity) diagnostics.push("execution-identity-changed");
  if (scope.inventory !== "complete" || scope.confidence !== "verified" || Object.values(scope.closure).some((closed) => !closed)) diagnostics.push("execution-inventory-incomplete");
  const complete = diagnostics.length === 0;
  const paths = scope.paths.filter((path) => controlPathIsReachable(path, complete) && (!complete || controlPathAffectsLiability(path, scope, assetId)));
  const reviewedScope = diagnostics.every((code) => code === "execution-inventory-incomplete");
  return { complete, reviewed: reviewedScope, paths, diagnostics, moduleImpact: deriveReviewedModuleImpact(reviewedScope ? scope : undefined, assetId, complete) };
}
export function deriveReviewedModuleImpact(scope: V9ControlExecutionScope | undefined, assetId: string, complete: boolean): V9ModuleImpact {
  const inventory = scope?.extensions;
  if (!scope || !inventory) return "unresolved";
  // A dated, runtime-bound path proves presence independently of inventory closure.
  if (scope.confidence !== "unknown") {
    for (const extension of inventory.entries) {
      for (const ref of extension.pathRefs) {
        const path = scope.paths.find((candidate) => candidate.id === ref);
        if (path && controlPathAffectsLiability(path, scope, assetId, true)) return "relevant";
      }
    }
  }
  if (!complete || !inventory.exhaustive || !inventory.paginationEnd || !inventory.sourceRuntimeCorrespondence) return "unresolved";
  if (inventory.entries.length === 0) return "not-applicable";
  for (const extension of inventory.entries) {
    if (!extension.mutableReachClosed || extension.pathRefs.length === 0) return "unresolved";
    for (const ref of extension.pathRefs) {
      const path = scope!.paths.find((candidate) => candidate.id === ref);
      if (!path || path.reach === "unknown") return "unresolved";
      if (controlPathAffectsLiability(path, scope!, assetId)) return "relevant";
    }
  }
  return "verified-noninterfering";
}
export function weightedReviewIsCurrent(weighted: V9WeightedQuorum, clockSec: number, maxAgeSec: number): boolean {
  const reviewSec = Date.parse(`${weighted.reviewedAt}T00:00:00Z`) / 1000;
  return weighted.status === "verified" && reviewSec <= clockSec && clockSec - reviewSec <= maxAgeSec && Date.parse(`${weighted.expiresAt}T00:00:00Z`) / 1000 >= clockSec;
}

/** Conservative route aggregation keeps every reachable path's impairment. */
export function reviewedControlScopeSemantics(paths: readonly V9ControlExecutionScope["paths"][number][]): Pick<V9DeploymentControlFactV2, "capSemantics" | "claimImpairment"> {
  const claims = paths.map((path) => path.claimImpairment);
  const claimImpairment = claims.includes("unbounded") ? "unbounded" : claims.includes("unknown") ? "unknown" : claims.includes("bounded") ? "bounded" : "none";
  const caps = paths.map((path) => path.capSemantics);
  if (caps.some((cap) => cap.kind === "unbounded")) return { capSemantics: { kind: "unbounded", bound: null }, claimImpairment };
  if (caps.some((cap) => cap.kind === "unknown")) return { capSemantics: { kind: "unknown", bound: null }, claimImpairment };
  if (caps.some((cap) => cap.kind === "raiseable")) return { capSemantics: { kind: "raiseable", bound: null }, claimImpairment };
  const bounded = caps.filter((cap) => cap.kind === "bounded");
  if (bounded.length > 0) {
    const first = bounded[0]!.bound;
    if (!first || bounded.some((cap) => !cap.bound || cap.bound.unit !== first.unit)) return { capSemantics: { kind: "unbounded", bound: null }, claimImpairment };
    return { capSemantics: { kind: "bounded", bound: { unit: first.unit, amount: Math.max(...bounded.map((cap) => cap.bound!.amount)) } }, claimImpairment };
  }
  return { capSemantics: { kind: caps.some((cap) => cap.kind === "collateral-gated") ? "collateral-gated" : "not-applicable", bound: null }, claimImpairment };
}

/** Partial inventories can establish adverse reach, never absence or missing evidence. */
export function partialControlScopeSemantics(
  legacy: Pick<V9DeploymentControlFactV2, "capSemantics" | "claimImpairment">,
  paths: readonly V9ControlExecutionScope["paths"][number][],
): Pick<V9DeploymentControlFactV2, "capSemantics" | "claimImpairment"> {
  let capSemantics = legacy.capSemantics;
  let claimImpairment = legacy.claimImpairment;
  for (const path of paths) {
    if (path.claimImpairment === "unbounded" ||
        (path.claimImpairment === "bounded" && claimImpairment === "none")) {
      claimImpairment = path.claimImpairment;
    }
    if (path.capSemantics.kind === "unbounded" ||
        (path.capSemantics.kind === "raiseable" &&
          ["not-applicable", "bounded", "collateral-gated"].includes(capSemantics.kind))) {
      capSemantics = path.capSemantics;
    }
  }
  return { capSemantics, claimImpairment };
}
