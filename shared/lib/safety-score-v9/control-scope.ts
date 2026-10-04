import { normalizeDeploymentId } from "../../types/deployment-id";
import { V9ControlExecutionScopeSchema, V1005ExecutionMemberSchema, type V9ControlExecutionScope, type V9WeightedQuorum, type V9ModuleImpact, type V1005AuthorityGraph, type V1005ExecutionCertificates, type V1005ExecutionMember } from "../../types/safety-score-v9-control-scope";
import type { V9DeploymentControlFactV2, V1005ProcessDiagnostic } from "../../types/safety-score-v9-facts";
import type { MintAuthorityProfile, StablecoinMeta } from "../../types/core";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";

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
function controlPathIsReachable(path: V9ControlExecutionScope["paths"][number], complete: boolean): boolean {
  return !complete || path.activation !== "disabled-final";
}

function controlPathAffectsLiability(path: V9ControlExecutionScope["paths"][number], scope: V9ControlExecutionScope, assetId: string, provenOnly = false, executionComplete = true): boolean {
  const pending = [path];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    if (!controlPathIsReachable(current, executionComplete)) continue;
    if (provenOnly && (current.reach === "unknown" || current.activation === "unknown")) continue;
    if (current.affectedLiabilityIds.includes(assetId) ||
        (current.reach !== "deployment" && current.reach !== "other-liability")) return true;
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
export interface V9ReviewedControlProjection {
  complete: boolean;
  reviewed: boolean;
  paths: V9ControlExecutionScope["paths"];
  provenPaths: V9ControlExecutionScope["paths"];
  diagnostics: string[];
  moduleImpact: V9ModuleImpact;
  scope?: V9ControlExecutionScope;
  processDiagnostics?: V1005ProcessDiagnostic[];
  authorityPaths?: ReadonlyMap<string, V1005AuthorityPathProjection>;
}
export function compileReviewedControlScope(scope: V9ControlExecutionScope | undefined, controllerDeployment: string, assetId: string, clockSec: number, maxAgeSec: number): V9ReviewedControlProjection {
  const diagnostics: string[] = [];
  if (!scope) return { complete: false, reviewed: false, paths: [], provenPaths: [], diagnostics: ["execution-scope-unreviewed"], moduleImpact: "unresolved" };
  if (scope.controllerDeployment !== normalizeDeploymentId(controllerDeployment)) diagnostics.push("execution-controller-mismatch");
  const reviewed = Date.parse(`${scope.reviewedAt}T00:00:00Z`) / 1000;
  const observed = Date.parse(`${scope.observedAt}T00:00:00Z`) / 1000;
  const expiry = Date.parse(`${scope.expiresAt}T00:00:00Z`) / 1000;
  if (reviewed > clockSec || observed > clockSec) diagnostics.push("execution-review-future");
  if (expiry < clockSec || clockSec - observed > maxAgeSec) diagnostics.push("execution-review-expired");
  if (scope.pin.runtimeIdentity !== scope.observedState.runtimeIdentity ||
      (!scope.authorityBinding && scope.pin.signerIdentity !== scope.observedState.signerIdentity)) diagnostics.push("execution-identity-changed");
  if (scope.inventory !== "complete" || scope.confidence !== "verified" || Object.values(scope.closure).some((closed) => !closed)) diagnostics.push("execution-inventory-incomplete");
  const complete = diagnostics.length === 0;
  const paths = scope.paths.filter((path) => controlPathIsReachable(path, complete) && (!complete || controlPathAffectsLiability(path, scope, assetId)));
  const reviewedScope = diagnostics.every((code) => code === "execution-inventory-incomplete");
  const provenPaths = reviewedScope && !complete && scope.confidence !== "unknown"
    ? paths.filter((path) => path.economicLossScope !== "unknown" && controlPathAffectsLiability(path, scope, assetId, true, complete))
    : [];
  return { scope, complete, reviewed: reviewedScope, paths, provenPaths, diagnostics, moduleImpact: deriveReviewedModuleImpact(reviewedScope ? scope : undefined, assetId, complete) };
}
function deriveReviewedModuleImpact(scope: V9ControlExecutionScope | undefined, assetId: string, complete: boolean): V9ModuleImpact {
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
  projection: Pick<V9ReviewedControlProjection, "provenPaths">,
): Pick<V9DeploymentControlFactV2, "capSemantics" | "claimImpairment"> {
  let capSemantics = legacy.capSemantics;
  let claimImpairment = legacy.claimImpairment;
  for (const path of projection.provenPaths) {
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

/** Canonical authority identity excludes descriptive evidence, dates and path coverage. */
export function computeV1005AuthorityStateHash(graph: Pick<V1005AuthorityGraph, "id" | "liabilityBookId" | "governorNodeId" | "nodes" | "edges">): `0x${string}` {
  const canonical = {
    v: 1, graphId: graph.id, liabilityBookId: graph.liabilityBookId, governorNodeId: graph.governorNodeId,
    nodes: [...graph.nodes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((node) => ({
      id: node.id, deployment: node.deployment, kind: node.kind, terminal: node.terminal,
      authorityCensusIds: [...node.authorityCensusIds].sort(), runtime: node.runtime,
    })),
    edges: [...graph.edges].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((edge) => ({
      id: edge.id, from: edge.from, to: edge.to, kind: edge.kind, selectors: [...edge.selectors].sort(),
      role: edge.role, activation: edge.activation, publicDelaySec: edge.publicDelaySec, calldataBound: edge.calldataBound,
    })),
  };
  return `0x${sha256Hex(stableJsonStringifyV1(canonical))}`;
}
export function sortV1005ProcessDiagnostics(rows: readonly V1005ProcessDiagnostic[]): V1005ProcessDiagnostic[] {
  const unique = new Map<string, V1005ProcessDiagnostic>();
  for (const row of rows) {
    const normalized = { ...row, evidenceRefIds: [...new Set(row.evidenceRefIds)].sort() };
    unique.set(stableJsonStringifyV1(normalized), normalized);
  }
  return [...unique.values()].sort((a, b) => {
    for (const key of ["gate", "code", "controlRef", "pathId", "classId", "memberRef", "field"] as const) {
      const left = a[key] ?? "", right = b[key] ?? "";
      if (left !== right) return left < right ? -1 : 1;
    }
    const left = stableJsonStringifyV1(a), right = stableJsonStringifyV1(b);
    return left === right ? 0 : left < right ? -1 : 1;
  });
}
export function v1005ReviewIsCurrent(review: V1005AuthorityGraph["review"], clockSec: number, maxAgeSec: number): boolean {
  const observed = Date.parse(`${review.observedAt}T00:00:00Z`) / 1000;
  const reviewed = Date.parse(`${review.reviewedAt}T00:00:00Z`) / 1000;
  return observed <= reviewed && reviewed <= clockSec && clockSec - observed <= maxAgeSec &&
    Date.parse(review.pin.timestamp) / 1000 <= clockSec && Date.parse(`${review.expiresAt}T00:00:00Z`) / 1000 >= clockSec;
}
export function v1005ProofIsClosed(certificates: V1005ExecutionCertificates | undefined, ref: string, pin?: V1005AuthorityGraph["review"]["pin"]): boolean {
  const proof = certificates?.proofs.find((row) => row.id === ref);
  return proof?.conclusion === "closed" && proof.evidenceRefIds.length > 0 &&
    proof.evidenceRefIds.every((id) => {
      const evidence = certificates!.evidence.find((row) => row.id === id);
      return evidence != null && !evidence.artificial && (pin == null || evidence.pin.chain === pin.chain &&
        evidence.pin.position === pin.position && evidence.pin.hash === pin.hash);
    });
}
export function v1005RuntimeIsMatched(runtime: V1005ExecutionMember["runtime"], certificates: V1005ExecutionCertificates, pin: V1005AuthorityGraph["review"]["pin"]): boolean {
  if (runtime.runtimeHash === null || !["exact", "metadata-normalized", "immutable-normalized"].includes(runtime.sourceRuntimeMatch) ||
      !v1005ProofIsClosed(certificates, runtime.matchProofRef, pin) || runtime.proxyKind === "unknown") return false;
  const matchProof = certificates.proofs.find((proof) => proof.id === runtime.matchProofRef);
  if (!matchProof?.evidenceRefIds.some((id) => certificates.evidence.some((row) => row.id === id && row.kind === "verified-source"))) return false;
  const hashes = [[runtime.deployment, runtime.runtimeHash], ...(runtime.proxyKind === "none" ? [] : [[runtime.implementation, runtime.implementationRuntimeHash]])];
  if (hashes.some(([deployment, hash]) => deployment == null || hash == null || !runtime.evidenceRefIds.some((id) => {
    const row = certificates.evidence.find((evidence) => evidence.id === id);
    return !row?.artificial && row?.pin.chain === pin.chain && row.pin.position === pin.position && row.pin.hash === pin.hash &&
      (row.deployment === deployment && row.readType === "code" && row.codeHash === hash ||
        deployment === runtime.deployment && row.readType === "read-bundle" && row.captureHash != null &&
        row.fieldReads?.some((field) => field.readType === "code" && field.target === "row-deployment" && field.returnKind === "code-hash" &&
          (field.field === "runtime.runtimeHash" || field.field === "codeHash" && certificates.classes.some((klass) =>
            klass.review.pin.chain === pin.chain && klass.review.pin.position === pin.position && klass.review.pin.hash === pin.hash &&
            klass.compactMembers?.some((member) => member.deployment === runtime.deployment && member.codeHash === hash && member.evidenceRefIds.includes(id))))));
  }))) return false;
  return runtime.normalization.every((row) => row.evidenceRefIds.every((id) => certificates.evidence.some((evidence) =>
    evidence.id === id && !evidence.artificial && evidence.pin.chain === pin.chain && evidence.pin.position === pin.position && evidence.pin.hash === pin.hash)));
}
export interface V1005AuthorityPathProjection {
  closed: boolean;
  governorRooted: boolean;
  publicDelaySec: number | null;
  provenanceClosed: boolean;
}

/** Resolve an explicit shared book only from the caller's immutable registry snapshot. */
export function resolveV1005MintAuthorityProfile(
  profile: MintAuthorityProfile, assetId: string, metaById: ReadonlyMap<string, Pick<StablecoinMeta, "mintAuthority" | "contracts" | "bridgeRouteRisk">>,
  clockSec: number, maxAgeSec: number,
): { profile: MintAuthorityProfile; diagnostics: readonly V1005ProcessDiagnostic[] } {
  const local = profile.executionCertificates, ref = local?.sharedBookRef;
  if (!ref) return { profile, diagnostics: [] };
  const diagnostic = (code: V1005ProcessDiagnostic["code"], field = "executionCertificates.sharedBookRef") => ({ profile, diagnostics: [{
    code, gate: "shared" as const, controlRef: null, pathId: null, classId: null, memberRef: null,
    field, evidenceRefIds: [],
  }] });
  const source = metaById.get(ref.assetId)?.mintAuthority, shared = source?.executionCertificates, graph = source?.authorityGraph;
  if (ref.assetId === assetId || !source || !shared || !graph || shared.sharedBookRef) return diagnostic("shared-book-unresolved");
  if (shared.liabilityBookId !== ref.liabilityBookId || local.liabilityBookId !== ref.liabilityBookId ||
      graph.liabilityBookId !== ref.liabilityBookId || graph.id !== ref.authorityGraphId || computeV1005AuthorityStateHash(graph) !== ref.authorityStateHash ||
      profile.authorityGraph && (profile.authorityGraph.id !== graph.id || computeV1005AuthorityStateHash(profile.authorityGraph) !== ref.authorityStateHash) ||
      profile.governedIssuance && stableJsonStringifyV1(profile.governedIssuance) !== stableJsonStringifyV1(source.governedIssuance) ||
      profile.operationalIssuance && stableJsonStringifyV1(profile.operationalIssuance) !== stableJsonStringifyV1(source.operationalIssuance)) return diagnostic("shared-book-mismatch");
  const reviewedAt = Date.parse(`${source.review.reviewedAt}T00:00:00Z`) / 1000;
  if (reviewedAt > clockSec || clockSec - reviewedAt > maxAgeSec || source.review.disposition === "unresolved" ||
      (source.review.unresolvedQuestions?.length ?? 0) > 0 ||
      [graph.review, ...shared.censuses.map((row) => row.review), ...shared.classes.map((row) => row.review)].some((review) => !v1005ReviewIsCurrent(review, clockSec, maxAgeSec))) return diagnostic("shared-book-stale");
  const nativeSelection = (metadata: Pick<StablecoinMeta, "contracts" | "bridgeRouteRisk"> | undefined, controls: MintAuthorityProfile["controls"]): string[] | null => {
    if (!metadata?.contracts?.length || metadata.bridgeRouteRisk?.confidence !== "verified" || !controls?.length ||
        controls.some((control) => !control.deploymentRefs?.length)) return null;
    const refs = [...new Set(controls.flatMap((control) => control.deploymentRefs!.map(normalizeDeploymentId)))].sort();
    const registered = new Set(metadata.contracts.map((contract) => normalizeDeploymentId(`${contract.chain}:${contract.address}`)));
    const native = new Set(metadata.bridgeRouteRisk.routes?.filter((route) => route.reviewDisposition === "reviewed" &&
      route.routeClass === "native" && route.issuanceModel === "native-issuance" && route.semantics === "native-mint")
      .map((route) => normalizeDeploymentId(`${route.destinationChain}:${route.contractAddress}`)));
    if (refs.length === 0 || refs.some((deployment) => !deployment || !registered.has(deployment) || !native.has(deployment)) ||
        controls.some((control) => stableJsonStringifyV1([...new Set(control.deploymentRefs!.map(normalizeDeploymentId))].sort()) !== stableJsonStringifyV1(refs))) return null;
    return refs;
  };
  const sourceSelection = nativeSelection(metaById.get(ref.assetId), source.controls);
  const targetSelection = nativeSelection(metaById.get(assetId), profile.controls);
  if (!sourceSelection || !targetSelection) return diagnostic("shared-book-unresolved", "executionCertificates.sharedBookRef.deploymentRefs");
  let mismatch = false;
  const merge = <T,>(sourceRows: readonly T[], localRows: readonly T[], key: (row: T) => string): T[] => {
    const rows = new Map(sourceRows.map((row) => [key(row), row]));
    if (rows.size !== sourceRows.length || new Set(localRows.map(key)).size !== localRows.length) mismatch = true;
    for (const row of localRows) {
      const id = key(row), existing = rows.get(id);
      if (existing && stableJsonStringifyV1(existing) !== stableJsonStringifyV1(row)) mismatch = true;
      else if (!existing) rows.set(id, row);
    }
    return [...rows.values()];
  };
  const id = (row: { id: string }) => row.id;
  const certificates: V1005ExecutionCertificates = { schemaVersion: 1, liabilityBookId: shared.liabilityBookId,
    evidence: merge(shared.evidence, local.evidence, id), proofs: merge(shared.proofs, local.proofs, id),
    censuses: merge(shared.censuses, local.censuses, id), classes: merge(shared.classes, local.classes, id),
    members: merge(shared.members, local.members, (row) => "memberRef" in row ? row.memberRef : row.deployment) };
  const sourceControls = source.controls!.map((control) => ({ ...control, deploymentRefs: targetSelection }));
  const localControls = profile.controls!.map((control) => ({ ...control, deploymentRefs: targetSelection }));
  const controls = merge(sourceControls, localControls, (control) => normalizeDeploymentId(`${control.chain ?? ""}:${control.address ?? ""}`) || control.label);
  if (mismatch) return diagnostic("shared-book-mismatch");
  return { profile: { ...profile, controls, executionCertificates: certificates, authorityGraph: graph,
    governedIssuance: profile.governedIssuance ?? source.governedIssuance,
    operationalIssuance: profile.operationalIssuance ?? source.operationalIssuance }, diagnostics: [] };
}

/** One expansion/census/graph pass per profile, reused by all emitted native facts. */
export function compileReviewedMintControlScopes(profile: MintAuthorityProfile, assetId: string, clockSec: number, maxAgeSec: number): readonly V9ReviewedControlProjection[] {
  const controls = profile.controls ?? [];
  const controlRefs = new Set(controls.map((control) => normalizeDeploymentId(`${control.chain ?? ""}:${control.address ?? ""}`)));
  const certificates = profile.executionCertificates;
  const graph = profile.authorityGraph;
  const process = profile.governedIssuance != null || profile.operationalIssuance != null || certificates?.sharedBookRef != null;
  const diagnostics: V1005ProcessDiagnostic[] = [];
  const add = (code: V1005ProcessDiagnostic["code"], field: string, controlRef: string | null = null, pathId: string | null = null, classId: string | null = null, memberRef: string | null = null, evidenceRefIds: string[] = []) => {
    diagnostics.push({ code, gate: "shared", controlRef, pathId, classId, memberRef, field, evidenceRefIds });
  };
  const classMap = new Map(certificates?.classes.map((row) => [row.id, row]));
  const resolvedMembers = certificates?.members.flatMap((row): V1005ExecutionMember[] => {
    if ("memberRef" in row) return [row];
    const klass = classMap.get(row.classId), template = klass?.memberTemplates?.find((entry) => entry.id === row.templateRef);
    if (!template || !klass?.pathBindingTemplates) {
      add("execution-class-unmatched", "memberTemplates.templateRef", row.deployment, null, row.classId, row.deployment); return [];
    }
    const { id: templateId, ...fields } = template;
    void templateId;
    const overrides = row.pathBindingOverrides ?? [];
    if (new Set(overrides.map((binding) => binding.templateId)).size !== overrides.length ||
        overrides.some((binding) => !klass.pathBindingTemplates!.some((base) => base.templateId === binding.templateId))) {
      add("execution-class-unmatched", "pathBindingOverrides", row.deployment, null, row.classId, row.deployment); return [];
    }
    const pathBindings = klass.pathBindingTemplates.map(({ targetIsMember, affectedIncludesMember, ...binding }) => ({
      ...binding, targetDeployment: targetIsMember ? row.deployment : binding.targetDeployment,
      affectedDeployments: affectedIncludesMember ? [...new Set([...binding.affectedDeployments, row.deployment])] : binding.affectedDeployments,
      ...overrides.find((override) => override.templateId === binding.templateId),
    }));
    const parsed = V1005ExecutionMemberSchema.safeParse({ ...fields, ...row.overrides, memberRef: row.deployment, classId: row.classId,
      runtime: { ...template.runtime, ...row.overrides?.runtime, deployment: row.deployment }, pathBindings });
    if (!parsed.success) { add("execution-class-unmatched", "memberTemplates.expansion", row.deployment, null, row.classId, row.deployment); return []; }
    return [parsed.data];
  }) ?? [];
  const memberMap = new Map(resolvedMembers.map((row) => [row.memberRef, row]));
  const censusMap = new Map(certificates?.censuses.map((row) => [row.id, row]));
  const nativeMembers = new Set(certificates?.censuses.filter((row) => row.kind !== "owner" && row.kind !== "admin").flatMap((row) => row.authoritativeMembers));
  const proofClosed = (ref: string, pin?: V1005AuthorityGraph["review"]["pin"]) => v1005ProofIsClosed(certificates, ref, pin);
  const proofReferencesExist = (ref: string) => certificates?.proofs.some((proof) => proof.id === ref &&
    proof.evidenceRefIds.every((id) => certificates.evidence.some((evidence) => evidence.id === id))) === true;
  if (process && !certificates) add("process-certificate-unavailable", "executionCertificates");
  if (certificates?.sharedBookRef) add("shared-book-unresolved", "executionCertificates.sharedBookRef");
  if (certificates) {
    for (const [field, rows] of [["evidence", certificates.evidence], ["proofs", certificates.proofs], ["censuses", certificates.censuses], ["classes", certificates.classes]] as const) {
      if (new Set(rows.map((row) => row.id)).size !== rows.length) add("graph-reference-unresolved", `executionCertificates.${field}`);
    }
    if (memberMap.size !== certificates.members.length) add("execution-class-unmatched", "executionCertificates.members");
    for (const klass of certificates.classes) {
      if (new Set(klass.paths.map((path) => path.id)).size !== klass.paths.length ||
          new Set(klass.memberTemplates?.map((template) => template.id)).size !== (klass.memberTemplates?.length ?? 0) ||
          new Set(klass.pathBindingTemplates?.map((binding) => binding.templateId)).size !== (klass.pathBindingTemplates?.length ?? 0)) add("execution-class-unmatched", "executionCertificates.classes.templates", null, null, klass.id);
      const declared = klass.compactMembers?.map((member) => member.deployment) ??
        resolvedMembers.filter((member) => member.classId === klass.id).map((member) => member.memberRef);
      for (const ref of klass.memberRefs) if (!declared.includes(ref)) add("execution-class-unmatched", "executionCertificates.classes.memberRefs", ref, null, klass.id, ref);
      for (const ref of declared) if (!klass.memberRefs.includes(ref)) add("execution-class-unmatched", "executionCertificates.members.classId", ref, null, klass.id, ref);
    }
  }
  const stateHash = graph ? computeV1005AuthorityStateHash(graph) : null;
  const projections = controls.map((control) => {
    const ref = normalizeDeploymentId(`${control.chain ?? ""}:${control.address ?? ""}`);
    let scope = control.executionScope;
    const classRef = control.executionClassRef;
    if (classRef) {
      const klass = classMap.get(classRef.classId), member = memberMap.get(classRef.memberRef);
      const before = diagnostics.length;
      if (!klass || !member || member.classId !== klass.id || member.memberRef !== ref || !klass.memberRefs.includes(ref)) {
        add("execution-class-unmatched", "executionClassRef", ref, null, classRef.classId, classRef.memberRef);
      } else if (certificates) {
        for (const review of [klass.review, member.review]) if (!v1005ReviewIsCurrent(review, clockSec, maxAgeSec)) add("review-expired", "executionClassRef.review", ref, null, klass.id, ref);
        if (!v1005RuntimeIsMatched(member.runtime, certificates, member.review.pin) || !klass.runtimeVariants.some((variant) =>
          variant.proxyKind === member.runtime.proxyKind && (variant.runtimeHash === member.runtime.runtimeHash ||
            variant.normalizedRuntimeHash != null && variant.normalizedRuntimeHash === member.runtime.normalizedRuntimeHash) &&
          (variant.proxyKind === "none" || variant.implementationRuntimeHash === member.runtime.implementationRuntimeHash ||
            variant.normalizedImplementationRuntimeHash != null && variant.normalizedImplementationRuntimeHash === member.runtime.normalizedImplementationRuntimeHash) &&
          proofClosed(variant.matchProofRef, klass.review.pin))) add(member.runtime.proxyKind === "none" ? "runtime-unmatched" : "implementation-unmatched", "executionClassRef.runtime", ref, null, klass.id, ref, member.runtime.evidenceRefIds);
        if (klass.invariants.some((id) => !proofClosed(id, klass.review.pin)) || Object.values(klass.closure).some((closed) => !closed)) add("economic-reach-unclosed", "executionClassRef.invariants", ref, null, klass.id, ref);
        for (const condition of klass.requiredConditions) {
          const observed = member.conditions.filter((row) => row.conditionId === condition.id);
          const value = observed[0]?.observedValue;
          const matched = observed.length === 1 && value != null && (condition.test.kind === "equal" ? value === condition.test.value :
            condition.test.kind === "one-of" ? condition.test.values.includes(value) : /^(0|[1-9][0-9]*)$/.test(value) &&
              BigInt(value) >= BigInt(condition.test.min) && BigInt(value) <= BigInt(condition.test.max));
          if (!matched || !proofClosed(condition.proofRef, klass.review.pin) || !proofClosed(observed[0]?.proofRef ?? "", member.review.pin)) add("instance-state-unmatched", `conditions.${condition.id}`, ref, null, klass.id, ref);
        }
        for (const id of member.censusIds) if (!censusMap.get(id)?.authoritativeMembers.includes(ref)) add("authority-census-incomplete", `censuses.${id}`, ref, null, klass.id, ref);
        if (member.pathBindings.length !== klass.paths.length || member.pathBindings.some((binding) => !klass.paths.some((path) => path.id === binding.templateId))) add("execution-class-unmatched", "pathBindings.inventory", ref, null, klass.id, ref);
        const paths = klass.paths.flatMap((template) => {
          const bindings = member.pathBindings.filter((binding) => binding.templateId === template.id);
          if (bindings.length !== 1 || !proofClosed(template.proofRef, klass.review.pin) || !proofClosed(bindings[0]?.proofRef ?? "", member.review.pin)) {
            add("execution-class-unmatched", "pathBindings", ref, template.id, klass.id, ref);
            return [];
          }
          const { proofRef: ignoredProof, ...path } = template;
          void ignoredProof;
          const binding = bindings[0]!;
          const authorityBinding = graph?.pathBindings.find((row) => row.path.controlRef === ref && row.path.pathId === template.id);
          if (!authorityBinding || stableJsonStringifyV1([...authorityBinding.authorityNodeIds].sort()) !== stableJsonStringifyV1([...binding.authorityNodeIds].sort()) ||
              stableJsonStringifyV1([...authorityBinding.provenanceNodeIds].sort()) !== stableJsonStringifyV1([...binding.provenanceNodeIds].sort())) {
            add("graph-reference-unresolved", "executionClassRef.pathBindings", ref, template.id, klass.id, ref);
          }
          return [{ ...path, targetDeployment: binding.targetDeployment, activation: binding.activation, unavoidableDelaySec: binding.unavoidableDelaySec,
            affectedLiabilityIds: binding.affectedLiabilityIds, affectedDeployments: binding.affectedDeployments }];
        });
        if (paths.length > 0) {
          const reviews = [klass.review, member.review, ...member.censusIds.flatMap((id) => censusMap.get(id)?.review ? [censusMap.get(id)!.review] : [])];
          const observedAt = reviews.map((review) => review.observedAt).sort()[0]!;
          const reviewedAt = reviews.map((review) => review.reviewedAt).sort().reverse()[0]!;
          const expiresAt = reviews.map((review) => review.expiresAt).sort()[0]!;
          const pin = { position: member.review.pin.position, hash: member.review.pin.hash, runtimeIdentity: member.runtime.runtimeHash ?? "unknown", signerIdentity: "typed-authority-graph" };
          const parsed = V9ControlExecutionScopeSchema.safeParse({
            controllerDeployment: ref, observedAt, reviewedAt, expiresAt, reviewer: member.review.reviewer,
            confidence: "verified", inventory: diagnostics.length === before ? "complete" : "partial",
            sources: member.runtime.evidenceRefIds.flatMap((id) => certificates.evidence.filter((row) => row.id === id).map((row) => ({ label: row.id, url: row.sourceUrl }))),
            pin, observedState: pin, closure: klass.closure, paths, extensions: member.extensions,
            ...(graph && stateHash ? { authorityBinding: { graphId: graph.id, authorityStateHash: stateHash, observedAuthorityStateHash: stateHash } } : {}),
          });
          if (parsed.success) scope = parsed.data;
          else add("execution-class-unmatched", "expandedScope", ref, null, klass.id, ref);
        }
      }
    }
    const projection = compileReviewedControlScope(scope, ref, assetId, clockSec, maxAgeSec);
    if (process && scope && (!scope.authorityBinding || scope.authorityBinding.graphId !== graph?.id ||
        scope.authorityBinding.authorityStateHash !== stateHash || scope.authorityBinding.observedAuthorityStateHash !== stateHash)) add("authority-state-mismatch", "authorityBinding", ref, null, classRef?.classId ?? null, nativeMembers.has(ref) ? ref : null);
    for (const reason of projection.diagnostics) {
      if (process) add(reason === "execution-review-expired" ? "review-expired" : reason === "execution-review-future" ? "review-future" :
        reason === "execution-identity-changed" ? "runtime-unmatched" : reason === "execution-inventory-incomplete" ? "economic-reach-unclosed" : "execution-scope-unreviewed", "executionScope", ref, null, classRef?.classId ?? null, nativeMembers.has(ref) ? ref : null);
    }
    return projection;
  });
  const compactMembers = new Map<string, { classId: string; evidenceRefIds: string[] }>();
  if (certificates) for (const klass of certificates.classes) {
    if (!klass.compactMembers) continue;
    const sourcePaths = (klass.sourcePathRefs ?? []).flatMap((ref) => {
      const projection = projections.find((row) => row.scope?.controllerDeployment === ref.controlRef);
      const path = projection?.scope?.paths.find((row) => row.id === ref.pathId);
      return projection && path ? [{ ref, projection, path }] : [];
    });
    if (!v1005ReviewIsCurrent(klass.review, clockSec, maxAgeSec) || klass.invariants.some((ref) => !proofClosed(ref, klass.review.pin)) ||
        sourcePaths.length !== klass.sourcePathRefs?.length || Object.values(klass.closure).some((value) => !value)) add("execution-class-unmatched", "compactMembers.sourcePathRefs", null, null, klass.id);
    for (const member of klass.compactMembers) {
      if (compactMembers.has(member.deployment) || memberMap.has(member.deployment)) add("authority-census-incomplete", "compactMembers.duplicate", null, null, klass.id, member.deployment);
      compactMembers.set(member.deployment, { classId: klass.id, evidenceRefIds: member.evidenceRefIds });
      const bindings = sourcePaths.filter(({ path }) => path.targetDeployment === member.deployment || path.affectedDeployments.includes(member.deployment));
      const ref = bindings[0]?.ref;
      const evidence = member.evidenceRefIds.flatMap((id) => certificates.evidence.filter((row) => row.id === id && !row.artificial && row.pin.hash === klass.review.pin.hash));
      const bundles = evidence.filter((row) => row.readType === "read-bundle" && row.captureHash != null);
      const codeRead = evidence.some((row) => row.deployment === member.deployment && row.readType === "code" && row.codeHash === member.codeHash &&
        (member.codeSize == null || row.codeSize === member.codeSize)) ||
        bundles.some((row) => row.fieldReads?.some((field) => field.field === "codeHash" && field.readType === "code" && field.target === "row-deployment"));
      const original = member.immutables.original;
      const variant = klass.runtimeVariants.find((runtime) => runtime.runtimeHash === member.codeHash ||
        original != null && runtime.deployment === original && runtime.proxyKind === "none");
      if (member.codeHash === null || !codeRead || !variant || !proofClosed(variant.matchProofRef, klass.review.pin)) add("runtime-unmatched", "compactMembers.codeHash", ref?.controlRef ?? null, ref?.pathId ?? null, klass.id, member.deployment, member.evidenceRefIds);
      if (bindings.length !== 1 || !bindings[0]?.projection.complete) add("authority-census-incomplete", "compactMembers.sourcePathRefs", ref?.controlRef ?? null, ref?.pathId ?? null, klass.id, member.deployment, member.evidenceRefIds);
      if (bindings.length === 1) {
        const { path } = bindings[0]!;
        if (!klass.paths.some((template) => template.entrypointKind === path.entrypointKind && template.callMode === path.callMode &&
          stableJsonStringifyV1([...template.entrypoints].sort()) === stableJsonStringifyV1([...path.entrypoints].sort()) &&
          stableJsonStringifyV1([...template.capabilities].sort()) === stableJsonStringifyV1([...path.capabilities].sort()) &&
          stableJsonStringifyV1(template.capSemantics) === stableJsonStringifyV1(path.capSemantics) &&
          template.claimImpairment === path.claimImpairment && template.economicLossScope === path.economicLossScope && template.reach === path.reach &&
          (["controlRefs", "reactivationRefs", "permissionChangeRefs", "upgradeRefs", "bypassRefs"] as const).every((field) =>
            stableJsonStringifyV1([...template[field]].sort()) === stableJsonStringifyV1([...path[field]].sort())) &&
          proofClosed(template.proofRef, klass.review.pin))) add("execution-class-unmatched", "compactMembers.sourcePathBehavior", ref!.controlRef, ref!.pathId, klass.id, member.deployment);
      }
      for (const condition of klass.requiredConditions) {
        const [table, key] = (condition.field ?? "").split(".");
        const observed = table === "immutables" ? member.immutables[key!] : table === "state" ? member.state[key!] : null;
        const value = typeof observed === "boolean" ? String(observed) : observed;
        const matched = typeof value === "string" && (condition.test.kind === "equal" ? value === condition.test.value :
          condition.test.kind === "one-of" ? condition.test.values.includes(value) : /^(0|[1-9][0-9]*)$/.test(value) &&
            BigInt(value) >= BigInt(condition.test.min) && BigInt(value) <= BigInt(condition.test.max));
        if (!matched || !proofClosed(condition.proofRef, klass.review.pin)) add("instance-state-unmatched", `compactMembers.${condition.field ?? condition.id}`, ref?.controlRef ?? null, ref?.pathId ?? null, klass.id, member.deployment, member.evidenceRefIds);
      }
      for (const key of Object.keys(member.state)) if (member.state[key] === null || !bundles.some((bundle) => bundle.fieldReads?.some((field) => field.field === `state.${key}`))) add("instance-state-unmatched", `compactMembers.state.${key}`, ref?.controlRef ?? null, ref?.pathId ?? null, klass.id, member.deployment, member.evidenceRefIds);
      for (const key of Object.keys(member.immutables)) if (member.immutables[key] === null || !bundles.some((bundle) => bundle.fieldReads?.some((field) => field.field === `immutables.${key}`)) &&
          !klass.requiredConditions.some((condition) => condition.field === `immutables.${key}` && proofClosed(condition.proofRef, klass.review.pin))) add("instance-state-unmatched", `compactMembers.immutables.${key}`, ref?.controlRef ?? null, ref?.pathId ?? null, klass.id, member.deployment, member.evidenceRefIds);
    }
  }
  if (certificates) {
    for (const census of certificates.censuses) {
      if (!v1005ReviewIsCurrent(census.review, clockSec, maxAgeSec) || census.coverage !== "complete" ||
          census.discovery.throughPosition !== census.review.pin.position || census.discovery.kind === "exhaustive-getter" && !census.discovery.paginationEnd ||
          !proofClosed(census.discovery.proofRef, census.review.pin) || !proofClosed(census.completenessProofRef, census.review.pin)) add("authority-census-incomplete", `censuses.${census.id}`);
      const compactClass = census.compactClassRef ? classMap.get(census.compactClassRef) : undefined;
      const compactAuthorized = compactClass?.compactMembers?.filter((member) => member.state.parent === census.targetDeployment && member.immutables.hub === census.targetDeployment).map((member) => member.deployment);
      const authorized = compactAuthorized ?? census.observations.filter((row) => row.authorized === true).map((row) => row.memberRef);
      if (census.compactClassRef && (!compactClass || census.observations.length !== 0 || !compactAuthorized)) add("authority-census-incomplete", `censuses.${census.id}.compactClassRef`);
      if (new Set(census.authoritativeMembers).size !== census.authoritativeMembers.length || authorized.length !== census.authoritativeMembers.length ||
          census.authoritativeMembers.some((ref) => !authorized.includes(ref)) || census.observations.some((row) => row.authorized === "unknown")) add("authority-census-incomplete", `censuses.${census.id}.observations`);
      if (census.kind === "owner" || census.kind === "admin") continue;
      for (const ref of census.authoritativeMembers) {
        const exact = projections.filter((_projection, index) => normalizeDeploymentId(`${controls[index]!.chain ?? ""}:${controls[index]!.address ?? ""}`) === ref);
        const candidates = exact.length > 0 ? exact : projections.filter((projection) =>
          projection.paths.some((path) => path.affectedDeployments.includes(ref)));
        const observation = census.observations.find((row) => row.memberRef === ref);
        const memberEvidence = observation?.evidenceRefIds.map((id) => certificates.evidence.find((row) => row.id === id));
        const hasRuntime = memberMap.has(ref) || compactMembers.has(ref) || memberEvidence?.some((row) => row?.deployment === ref && row.readType === "code" && row.codeHash != null && !row.artificial && row.pin.hash === census.review.pin.hash);
        if (candidates.length !== 1 || !candidates[0]?.complete || !hasRuntime) add(!hasRuntime ? "runtime-unmatched" : "authority-census-incomplete", `censuses.${census.id}.members`, candidates[0]?.scope?.controllerDeployment ?? null, null, memberMap.get(ref)?.classId ?? null, ref, observation?.evidenceRefIds ?? []);
      }
    }
  }
  const authorityPaths = new Map<string, V1005AuthorityPathProjection>();
  if (process && !graph) add("graph-reference-unresolved", "authorityGraph");
  if (graph && certificates) {
    if (!v1005ReviewIsCurrent(graph.review, clockSec, maxAgeSec) || !proofClosed(graph.closureProofRef, graph.review.pin) || graph.liabilityBookId !== certificates.liabilityBookId) add("economic-reach-unclosed", "authorityGraph.closureProofRef");
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    if (nodes.size !== graph.nodes.length || new Set(graph.edges.map((edge) => edge.id)).size !== graph.edges.length) add("graph-reference-unresolved", "authorityGraph.ids");
    if (new Set(graph.runtimeIdentities?.map((row) => row.id)).size !== (graph.runtimeIdentities?.length ?? 0)) add("graph-reference-unresolved", "authorityGraph.runtimeIdentities");
    if (nodes.get(graph.governorNodeId)?.kind !== "token-governor" || nodes.get(graph.governorNodeId)?.deployment !== profile.governedIssuance?.governorControlRef) add("governor-not-governance", "authorityGraph.governorNodeId");
    const authorityKinds: Record<string, true> = { owner: true, ward: true, role: true, admin: true, upgrade: true, delegatecall: true,
      "execution-hop": true, "vote-origin": true, reactivation: true, "permission-change": true, "envelope-raise": true };
    const isAuthorityEdge = (edge: V1005AuthorityGraph["edges"][number]) => authorityKinds[edge.kind] &&
      !(edge.kind === "vote-origin" && edge.from === graph.governorNodeId && nodes.get(edge.from)?.kind === "token-governor");
    const outgoing = new Map<string, typeof graph.edges>();
    for (const edge of graph.edges) {
      if (!nodes.has(edge.from) || !nodes.has(edge.to)) add("graph-reference-unresolved", `authorityGraph.edges.${edge.id}`);
      for (const ref of edge.pathRefs) if (!projections.some((projection) => projection.scope?.controllerDeployment === ref.controlRef &&
          projection.scope.paths.some((path) => path.id === ref.pathId))) add("graph-reference-unresolved", `authorityGraph.edges.${edge.id}.pathRefs`, ref.controlRef, ref.pathId);
      const list = outgoing.get(edge.from) ?? [];
      list.push(edge); outgoing.set(edge.from, list);
    }
    const incoming = new Map<string, typeof graph.edges>();
    for (const edge of graph.edges) {
      const list = incoming.get(edge.to) ?? [];
      list.push(edge); incoming.set(edge.to, list);
    }
    const governorCycleMembers = new Map<string, ReadonlySet<string>>();
    const certifiedGovernorCycle = (pathKey: string): ReadonlySet<string> => {
      const cached = governorCycleMembers.get(pathKey);
      if (cached) return cached;
      const applies = (edge: V1005AuthorityGraph["edges"][number]) => isAuthorityEdge(edge) &&
        edge.activation !== "disabled-final" && edge.pathRefs.some((ref) => `${ref.controlRef}#${ref.pathId}` === pathKey);
      const reachable = (reverse: boolean) => {
        const visited = new Set<string>(), pending = [graph.governorNodeId];
        while (pending.length) {
          const id = pending.pop()!;
          if (visited.has(id)) continue;
          visited.add(id);
          for (const edge of (reverse ? incoming : outgoing).get(id) ?? []) if (applies(edge)) {
            pending.push(reverse ? edge.from : edge.to);
          }
        }
        return visited;
      };
      const towardGovernor = reachable(true);
      const component = new Set([...reachable(false)].filter((id) => towardGovernor.has(id)));
      const governor = nodes.get(graph.governorNodeId);
      const closed = governor?.terminal && governor.kind === "token-governor" &&
        governor.deployment === profile.governedIssuance?.governorControlRef && component.size > 0 &&
        [...component].every((id) => {
          const node = nodes.get(id);
          return node && proofClosed(node.proofRef, graph.review.pin) && node.authorityCensusIds.length > 0 &&
            node.authorityCensusIds.every((id) => {
              const census = censusMap.get(id);
              return census?.coverage === "complete" && v1005ReviewIsCurrent(census.review, clockSec, maxAgeSec) &&
                proofClosed(census.discovery.proofRef, graph.review.pin) && proofClosed(census.completenessProofRef, graph.review.pin);
            });
        }) && graph.edges.every((edge) => !applies(edge) || !component.has(edge.from) || !component.has(edge.to) ||
          edge.activation !== "unknown" && proofClosed(edge.proofRef, graph.review.pin));
      const result = closed ? component : new Set<string>();
      governorCycleMembers.set(pathKey, result);
      return result;
    };
    const memo = new Map<string, { closed: boolean; governorRooted: boolean; publicDelaySec: number | null }>();
    const visiting = new Set<string>();
    const visit = (id: string, pathKey: string, pathRef: V1005AuthorityGraph["pathBindings"][number]["path"]): { closed: boolean; governorRooted: boolean; publicDelaySec: number | null } => {
      const memoKey = `${id}@${pathKey}`;
      const cached = memo.get(memoKey);
      if (cached) return cached;
      const node = nodes.get(id);
      const memberRef = node?.deployment && nativeMembers.has(node.deployment) ? node.deployment : null;
      if (!node || !proofReferencesExist(node.proofRef) || node.authorityCensusIds.some((ref) => !censusMap.has(ref))) {
        add("graph-reference-unresolved", `authorityGraph.nodes.${id}`, pathRef.controlRef, pathRef.pathId, null, memberRef);
        return { closed: false, governorRooted: false, publicDelaySec: null };
      }
      if (!proofClosed(node.proofRef, graph.review.pin)) {
        add("economic-reach-unclosed", `authorityGraph.nodes.${id}.proofRef`, pathRef.controlRef, pathRef.pathId, null, memberRef);
        return { closed: false, governorRooted: false, publicDelaySec: null };
      }
      if (node.runtime) {
        const identity = graph.runtimeIdentities?.find((row) => row.id === node.runtime!.ref);
        const runtime = identity && node.deployment ? { ...identity.identity, deployment: node.deployment, matchProofRef: identity.proofRef,
          evidenceRefIds: identity.evidenceRefIds, normalization: identity.identity.normalization.map((row) => ({ ...row, evidenceRefIds: identity.evidenceRefIds })) } : null;
        if (!identity || !runtime || identity.id !== `0x${sha256Hex(stableJsonStringifyV1(identity.identity))}` || !v1005RuntimeIsMatched(runtime, certificates, graph.review.pin)) {
          add("runtime-unmatched", `authorityGraph.nodes.${id}.runtime`, pathRef.controlRef, pathRef.pathId, null, memberRef, identity?.evidenceRefIds);
          return { closed: false, governorRooted: false, publicDelaySec: null };
        }
      } else if (node.kind === "contract" || node.kind === "timelock" || node.kind === "token-governor" || node.kind === "multisig" || node.kind === "fixed-program") {
        const member = node.deployment ? memberMap.get(node.deployment) : undefined;
        if (!member || !v1005RuntimeIsMatched(member.runtime, certificates, graph.review.pin)) {
          add("runtime-unmatched", `authorityGraph.nodes.${id}.runtime`, pathRef.controlRef, pathRef.pathId, member?.classId ?? null, memberRef, member?.runtime.evidenceRefIds);
          return { closed: false, governorRooted: false, publicDelaySec: null };
        }
      }
      if (visiting.has(memoKey)) {
        // A source-closed executable or governor-containing authority component closes the route's cycle.
        if (node.terminal && node.kind === "fixed-program") return { closed: true, governorRooted: false, publicDelaySec: 0 };
        if (certifiedGovernorCycle(pathKey).has(id)) return { closed: true, governorRooted: true, publicDelaySec: 0 };
        add("graph-cycle-unclosed", `authorityGraph.nodes.${id}`, pathRef.controlRef, pathRef.pathId, null, memberRef);
        return { closed: false, governorRooted: false, publicDelaySec: null };
      }
      visiting.add(memoKey);
      const alternatives = (outgoing.get(id) ?? []).filter((edge) => isAuthorityEdge(edge) && edge.activation !== "disabled-final" &&
        edge.pathRefs.some((ref) => `${ref.controlRef}#${ref.pathId}` === pathKey));
      let result: { closed: boolean; governorRooted: boolean; publicDelaySec: number | null };
      if (alternatives.length === 0) {
        result = { closed: node.terminal && node.kind !== "unknown", governorRooted: node.terminal && id === graph.governorNodeId && node.kind === "token-governor", publicDelaySec: 0 };
      } else {
        const routes = alternatives.map((edge) => {
          const root = visit(edge.to, pathKey, pathRef);
          const edgeClock = edge.publicDelaySec === 0 ? 0 : edge.publicDelaySec === null || edge.calldataBound !== true ? null : edge.publicDelaySec;
          if (!proofClosed(edge.proofRef, graph.review.pin) || edge.activation === "unknown") {
            add(proofReferencesExist(edge.proofRef) ? "economic-reach-unclosed" : "graph-reference-unresolved",
              `authorityGraph.edges.${edge.id}`, pathRef.controlRef, pathRef.pathId, null, memberRef);
          }
          return { ...root, closed: root.closed && edge.activation !== "unknown" && proofClosed(edge.proofRef, graph.review.pin), publicDelaySec: edgeClock === null ? null : Math.max(edgeClock, root.publicDelaySec ?? 0) };
        });
        result = { closed: routes.every((route) => route.closed), governorRooted: routes.every((route) => route.governorRooted),
          publicDelaySec: routes.some((route) => route.publicDelaySec === null) ? null : Math.min(...routes.map((route) => route.publicDelaySec!)) };
      }
      visiting.delete(memoKey); memo.set(memoKey, result);
      return result;
    };
    for (const binding of graph.pathBindings) {
      const key = `${binding.path.controlRef}#${binding.path.pathId}`;
      const index = projections.findIndex((projection) => projection.scope?.controllerDeployment === binding.path.controlRef);
      const path = projections[index]?.scope?.paths.find((row) => row.id === binding.path.pathId);
      if (path?.activation === "disabled-final" && projections[index]?.complete) continue;
      if (authorityPaths.has(key) || !path || !proofReferencesExist(binding.closureProofRef)) add("graph-reference-unresolved", "authorityGraph.pathBindings", binding.path.controlRef, binding.path.pathId);
      else if (!proofClosed(binding.closureProofRef, graph.review.pin)) add("economic-reach-unclosed", "authorityGraph.pathBindings.closureProofRef", binding.path.controlRef, binding.path.pathId);
      const roots = binding.authorityNodeIds.map((id) => visit(id, key, binding.path));
      const operational = profile.operationalIssuance?.paths.find((entry) => entry.path.controlRef === binding.path.controlRef && entry.path.pathId === binding.path.pathId);
      const closedMintBoundary = projections[index]?.complete && operational && "invariantProofRef" in operational &&
        (operational.kind === "bounded-stock" && path?.capSemantics.kind === "bounded" && path.capSemantics.bound != null ||
          operational.kind === "paired-accounting" && operational.externalAccountingTrust === "strategy-reported-assets") &&
        proofClosed(operational.invariantProofRef, graph.review.pin) && proofClosed(operational.economicReachProofRef, graph.review.pin);
      const provenancePending = [...binding.provenanceNodeIds], provenanceVisited = new Set<string>();
      let provenanceClosed = true;
      while (!closedMintBoundary && provenancePending.length) {
        const id = provenancePending.pop()!;
        if (provenanceVisited.has(id)) continue;
        provenanceVisited.add(id);
        const node = nodes.get(id);
        if (!node || !proofClosed(node.proofRef, graph.review.pin)) { provenanceClosed = false; continue; }
        for (const edge of outgoing.get(id) ?? []) if (!isAuthorityEdge(edge) && edge.activation !== "disabled-final" &&
            edge.pathRefs.some((ref) => `${ref.controlRef}#${ref.pathId}` === key)) {
          if (!proofClosed(edge.proofRef, graph.review.pin) || edge.activation === "unknown") provenanceClosed = false;
          provenancePending.push(edge.to);
        }
      }
      const closed = roots.length > 0 && roots.every((root) => root.closed) && proofClosed(binding.closureProofRef, graph.review.pin);
      const directTerminals = binding.authorityNodeIds.every((id) => nodes.get(id)?.terminal &&
        !(outgoing.get(id) ?? []).some((edge) => isAuthorityEdge(edge) && edge.activation !== "disabled-final" &&
          edge.pathRefs.some((ref) => `${ref.controlRef}#${ref.pathId}` === key)));
      authorityPaths.set(key, { closed, governorRooted: closed && roots.every((root) => root.governorRooted),
        publicDelaySec: !path || path.unavoidableDelaySec === null || roots.some((root) => root.publicDelaySec === null) ? null :
          Math.min(path.unavoidableDelaySec, directTerminals ? path.unavoidableDelaySec : Math.min(...roots.map((root) => root.publicDelaySec!))),
        provenanceClosed });
    }
    for (const projection of projections) for (const path of projection.paths) {
      const ref = projection.scope?.controllerDeployment ?? "";
      if (!authorityPaths.has(`${ref}#${path.id}`)) add("graph-reference-unresolved", "authorityGraph.pathBindings", ref, path.id);
    }
  }
  const sorted = sortV1005ProcessDiagnostics(diagnostics);
  return projections.map((projection, index) => {
    const control = controls[index]!;
    const ref = normalizeDeploymentId(`${control.chain ?? ""}:${control.address ?? ""}`);
    const own = sorted.filter((row) => row.controlRef === null || row.controlRef === ref || !controlRefs.has(row.controlRef));
    return { ...projection, processDiagnostics: own, authorityPaths };
  });
}
