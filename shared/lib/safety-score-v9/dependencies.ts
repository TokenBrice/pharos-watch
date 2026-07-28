import {
  V9_DEPENDENCY_ECONOMIC_ROLE_VALUES,
  type DependencyType,
  type V9DependencyEconomicRole,
} from "../../types/dependency-types";
import type { V9FailureDomainRef } from "../../types/safety-score-v9-facts";
import { resolveChainId } from "../chains";
import { orderDependencyGraphNodes, type DependencyGraphEdge } from "../dependency-graph";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";
import { isV9MaterialShare } from "./backing";
import { deepFreeze } from "./primitives";

const V9_DEPENDENCY_PLAN_DIGEST_DOMAIN = "safety-score-v9.dependency-plan.v2";

const V9_DEPENDENCY_ECONOMIC_ROLES = V9_DEPENDENCY_ECONOMIC_ROLE_VALUES;
export type { V9DependencyEconomicRole } from "../../types/dependency-types";
export type V9DependencyScoreDimension = "final" | "backing" | "exit" | "access" | "control" | "oracle-nav";

export interface V9DependencyPlanningEdge {
  edgeKey: string;
  upstreamAssetId: string;
  dependencyType: DependencyType;
  /**
   * Explicit economic propagation role. `pathKind` remains a fact-gap concern;
   * the dependency planner does not infer economics from dependency labels.
   */
  economicRole: V9DependencyEconomicRole;
  weight: number;
  evidenceRefIds?: readonly string[];
  failureDomains: readonly V9FailureDomainRef[];
}

interface FailureDomainCarrier {
  failureDomains: readonly V9FailureDomainRef[];
}

export interface V9DependencyPlanningAsset {
  assetId: string;
  dependencies: { edges: readonly V9DependencyPlanningEdge[] };
  reserveExposures: readonly ({ exposureKey: string } & FailureDomainCarrier)[];
  exitRoutes: readonly ({ routeKey: string } & FailureDomainCarrier)[];
  controls: readonly ({ controlKey: string } & FailureDomainCarrier)[];
  peg: FailureDomainCarrier;
  supply: FailureDomainCarrier;
}

export interface V9DependencyPathPlan {
  assetId: string;
  upstreamAssetId: string;
  edgeKey: string;
  exposureKey: string;
  riskEventKey: string;
  dependencyType: DependencyType;
  role: V9DependencyEconomicRole;
  weight: number;
  evidenceRefIds: readonly string[];
  failureDomains: readonly V9FailureDomainRef[];
}

export interface V9SuppressedDependencyRole {
  assetId: string;
  upstreamAssetId: string;
  selectedEdgeKey: string;
  suppressedEdgeKey: string;
  selectedRole: V9DependencyEconomicRole;
  suppressedRole: V9DependencyEconomicRole;
  reason: "serial-role-dominates" | "duplicate-serial-role" | "duplicate-role";
}

export interface V9CommonModeMember {
  assetId: string;
  owner: "backing" | "exit" | "control" | "dependency" | "peg" | "supply";
  pathKey: string;
}

export interface V9CommonModeGroup {
  failureDomain: V9FailureDomainRef;
  members: readonly V9CommonModeMember[];
}

export interface V9DependencyEvaluationPlan {
  schemaVersion: 2;
  activeAssetIds: readonly string[];
  topologicalOrder: readonly string[];
  serialPaths: readonly V9DependencyPathPlan[];
  basketPaths: readonly V9DependencyPathPlan[];
  exitPaths: readonly V9DependencyPathPlan[];
  controlPaths: readonly V9DependencyPathPlan[];
  oracleNavPaths: readonly V9DependencyPathPlan[];
  suppressedRoles: readonly V9SuppressedDependencyRole[];
  cyclicComponents: readonly (readonly string[])[];
  serialCycleAssetIds: readonly string[];
  serialBlockedDescendants: readonly string[];
  commonModeGroups: readonly V9CommonModeGroup[];
  planDigest: string;
}

export interface V9UpstreamResult {
  assetId: string;
  /** Whole-asset final score. Serial claims inherit this exact result. */
  score: number | null;
  /** Raw backing-pillar score. Reserve and collateral baskets inherit this dimension only. */
  backingScore: number | null;
  /** Raw exit-pillar score. Exit dependencies require this and an access score. */
  exitScore?: number | null;
  /** Numeric projection of holder access risk for dependency inheritance. */
  accessScore?: number | null;
  /** Raw control-pillar score. Operator dependencies inherit this dimension only. */
  controlScore?: number | null;
  /** Reviewed oracle/NAV component score, separate from unrelated control components. */
  oracleNavScore?: number | null;
}

export interface V9ResolvedRoleDependencyInput {
  assetId: string;
  upstreamAssetId: string;
  edgeKey: string;
  exposureKey: string;
  riskEventKey: string;
  dependencyType: DependencyType;
  role: V9DependencyEconomicRole;
  weight: number;
  inheritedDimensions: readonly V9DependencyScoreDimension[];
  unavailableDimensions: readonly V9DependencyScoreDimension[];
  score: number | null;
  boundedUnknown: boolean;
  cycleBlocked: boolean;
  evidenceRefIds: readonly string[];
  failureDomains: readonly V9FailureDomainRef[];
}

export interface V9ResolvedDependencyInputs {
  assetId: string;
  serial: readonly {
    upstreamAssetId: string;
    score: number | null;
    blocked: boolean;
  }[];
  basket: readonly {
    upstreamAssetId: string;
    weight: number;
    score: number | null;
    boundedUnknown: boolean;
  }[];
  /**
   * Versioned role trace. Optional only so retained hand-authored V1 fixtures
   * can be upgraded explicitly; the V2 resolver always emits this field.
   */
  roleInputs?: readonly V9ResolvedRoleDependencyInput[];
  /**
   * The policy-materialized role projections applied by the set evaluator.
   * Absent on retained/unit fixtures that have not passed through evaluation.
   */
  rolePillarProjections?: Readonly<Record<V9RoleDependencyTargetPillar, V9RoleDependencyPillarProjection>>;
  cycleBlocked: boolean;
}

export type V9RoleDependencyTargetPillar = "exit" | "control";

export interface V9RoleDependencyPropagationEvent {
  targetPillar: V9RoleDependencyTargetPillar;
  exposureKey: string;
  riskEventKey: string;
  roles: readonly Exclude<V9DependencyEconomicRole, "serial-claim" | "basket-exposure">[];
  edgeKeys: readonly string[];
  upstreamAssetIds: readonly string[];
  nominalExposureShare: number;
  exposureShare: number;
  inheritedScore: number | null;
  modeledLossPoints: number | null;
  boundedUnknown: boolean;
  cycleBlocked: boolean;
  unavailableDimensions: readonly V9DependencyScoreDimension[];
  evidenceRefIds: readonly string[];
  failureDomains: readonly V9FailureDomainRef[];
}

export interface V9RoleDependencyPillarProjection {
  targetPillar: V9RoleDependencyTargetPillar;
  limit: number | null;
  knownLossPoints: number;
  boundedUnknownLossPoints: number;
  unresolvedExposureShare: number;
  materialUnresolvedExposure: boolean;
  events: readonly V9RoleDependencyPropagationEvent[];
}

function canonicalPlanningDomain(domain: V9FailureDomainRef): V9FailureDomainRef {
  if (domain.kind !== "chain") return domain;
  return { kind: "chain", key: resolveChainId(domain.key) ?? domain.key.toLowerCase() };
}

function domainKey(domain: V9FailureDomainRef): string {
  const canonical = canonicalPlanningDomain(domain);
  return `${canonical.kind}:${canonical.key}`;
}

function canonicalPlanningDomains(domains: readonly V9FailureDomainRef[]): V9FailureDomainRef[] {
  return [
    ...new Map(
      domains.map((domain) => {
        const canonical = canonicalPlanningDomain(domain);
        return [domainKey(canonical), canonical];
      }),
    ).values(),
  ].sort((left, right) => domainKey(left).localeCompare(domainKey(right)));
}

function pathSortKey(path: V9DependencyPathPlan): string {
  return `${path.assetId}\u0000${path.exposureKey}\u0000${path.riskEventKey}\u0000${path.upstreamAssetId}\u0000${path.role}\u0000${path.dependencyType}\u0000${path.edgeKey}`;
}

function comparePath(left: V9DependencyPathPlan, right: V9DependencyPathPlan): number {
  return pathSortKey(left).localeCompare(pathSortKey(right));
}

const ROLE_ORDER = new Map<V9DependencyEconomicRole, number>(
  V9_DEPENDENCY_ECONOMIC_ROLES.map((role, index) => [role, index]),
);

function comparePlanningEdge(left: V9DependencyPlanningEdge, right: V9DependencyPlanningEdge): number {
  return (
    (ROLE_ORDER.get(left.economicRole) ?? Number.MAX_SAFE_INTEGER) -
      (ROLE_ORDER.get(right.economicRole) ?? Number.MAX_SAFE_INTEGER) ||
    right.weight - left.weight ||
    left.dependencyType.localeCompare(right.dependencyType) ||
    left.edgeKey.localeCompare(right.edgeKey)
  );
}

function compareSuppressedRole(left: V9SuppressedDependencyRole, right: V9SuppressedDependencyRole): number {
  return (
    left.assetId.localeCompare(right.assetId) ||
    left.upstreamAssetId.localeCompare(right.upstreamAssetId) ||
    left.selectedRole.localeCompare(right.selectedRole) ||
    left.selectedEdgeKey.localeCompare(right.selectedEdgeKey) ||
    left.suppressedRole.localeCompare(right.suppressedRole) ||
    left.suppressedEdgeKey.localeCompare(right.suppressedEdgeKey)
  );
}

function coalescedPath(
  assetId: string,
  upstreamAssetId: string,
  edges: readonly V9DependencyPlanningEdge[],
  additionalFailureDomains: readonly V9FailureDomainRef[] = [],
  additionalEvidenceRefIds: readonly string[] = [],
): V9DependencyPathPlan {
  const ordered = [...edges].sort(comparePlanningEdge);
  const selected = ordered[0]!;
  const failureDomains = canonicalPlanningDomains([
    ...ordered.flatMap((edge) => edge.failureDomains),
    ...additionalFailureDomains,
  ]);
  return {
    assetId,
    upstreamAssetId,
    edgeKey: selected.edgeKey,
    // An authored edge is the stable holder slice. Equal upstream/provider
    // labels do not prove that two edges cover the same holders.
    exposureKey: selected.edgeKey,
    riskEventKey: `dependency-event:${failureDomains.map(domainKey).join("+") || selected.edgeKey}`,
    dependencyType: selected.dependencyType,
    role: selected.economicRole,
    weight: selected.economicRole === "serial-claim" ? 1 : Math.max(...ordered.map((edge) => edge.weight)),
    evidenceRefIds: [
      ...new Set([...ordered.flatMap((edge) => edge.evidenceRefIds ?? []), ...additionalEvidenceRefIds]),
    ].sort(),
    failureDomains,
  };
}

function selectDependencyRoles(assets: readonly V9DependencyPlanningAsset[]): {
  paths: V9DependencyPathPlan[];
  suppressed: V9SuppressedDependencyRole[];
} {
  const paths: V9DependencyPathPlan[] = [];
  const suppressed: V9SuppressedDependencyRole[] = [];
  for (const asset of [...assets].sort((left, right) => left.assetId.localeCompare(right.assetId))) {
    const byUpstream = new Map<string, V9DependencyPlanningEdge[]>();
    for (const edge of asset.dependencies.edges) {
      byUpstream.set(edge.upstreamAssetId, [...(byUpstream.get(edge.upstreamAssetId) ?? []), edge]);
    }
    for (const [upstreamAssetId, rawEdges] of [...byUpstream.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const edges = [...rawEdges].sort(comparePlanningEdge);
      const serialEdges = edges.filter((edge) => edge.economicRole === "serial-claim");
      if (serialEdges.length > 0) {
        const path = coalescedPath(
          asset.assetId,
          upstreamAssetId,
          serialEdges,
          edges.filter((edge) => edge.economicRole !== "serial-claim").flatMap((edge) => edge.failureDomains),
          edges.filter((edge) => edge.economicRole !== "serial-claim").flatMap((edge) => edge.evidenceRefIds ?? []),
        );
        paths.push(path);
        for (const edge of edges.filter((edge) => edge.edgeKey !== path.edgeKey)) {
          suppressed.push({
            assetId: asset.assetId,
            upstreamAssetId,
            selectedEdgeKey: path.edgeKey,
            suppressedEdgeKey: edge.edgeKey,
            selectedRole: path.role,
            suppressedRole: edge.economicRole,
            reason: edge.economicRole === "serial-claim" ? "duplicate-serial-role" : "serial-role-dominates",
          });
        }
        continue;
      }

      const byRoleAndEdge = new Map<string, V9DependencyPlanningEdge[]>();
      for (const edge of edges) {
        const key = `${edge.economicRole}\u0000${edge.edgeKey}`;
        byRoleAndEdge.set(key, [...(byRoleAndEdge.get(key) ?? []), edge]);
      }
      for (const role of V9_DEPENDENCY_ECONOMIC_ROLES.filter((candidate) => candidate !== "serial-claim")) {
        const edgeGroups = [...byRoleAndEdge.entries()]
          .filter(([key]) => key.startsWith(`${role}\u0000`))
          .sort(([left], [right]) => left.localeCompare(right));
        for (const [, roleEdges] of edgeGroups) {
          const path = coalescedPath(asset.assetId, upstreamAssetId, roleEdges);
          paths.push(path);
          for (const edge of roleEdges.slice(1)) {
            suppressed.push({
              assetId: asset.assetId,
              upstreamAssetId,
              selectedEdgeKey: path.edgeKey,
              suppressedEdgeKey: edge.edgeKey,
              selectedRole: path.role,
              suppressedRole: edge.economicRole,
              reason: "duplicate-role",
            });
          }
        }
      }
    }
  }
  return { paths: paths.sort(comparePath), suppressed: suppressed.sort(compareSuppressedRole) };
}

function collectCommonModes(
  assets: readonly V9DependencyPlanningAsset[],
  selectedPaths: readonly V9DependencyPathPlan[],
): V9CommonModeGroup[] {
  const groups = new Map<string, { failureDomain: V9FailureDomainRef; members: V9CommonModeMember[] }>();
  const add = (domain: V9FailureDomainRef, member: V9CommonModeMember) => {
    const canonical = canonicalPlanningDomain(domain);
    const key = domainKey(canonical);
    const group = groups.get(key) ?? { failureDomain: canonical, members: [] };
    if (!group.members.some((candidate) => stableJsonStringifyV1(candidate) === stableJsonStringifyV1(member))) {
      group.members.push(member);
    }
    groups.set(key, group);
  };
  for (const path of selectedPaths) {
    for (const domain of path.failureDomains) {
      add(domain, { assetId: path.assetId, owner: "dependency", pathKey: path.edgeKey });
    }
  }
  for (const asset of assets) {
    for (const exposure of asset.reserveExposures) {
      for (const domain of exposure.failureDomains) {
        add(domain, { assetId: asset.assetId, owner: "backing", pathKey: exposure.exposureKey });
      }
    }
    for (const route of asset.exitRoutes) {
      for (const domain of route.failureDomains) {
        add(domain, { assetId: asset.assetId, owner: "exit", pathKey: route.routeKey });
      }
    }
    for (const control of asset.controls) {
      for (const domain of control.failureDomains) {
        add(domain, { assetId: asset.assetId, owner: "control", pathKey: control.controlKey });
      }
    }
    for (const domain of asset.peg.failureDomains) {
      add(domain, { assetId: asset.assetId, owner: "peg", pathKey: "peg" });
    }
    for (const domain of asset.supply.failureDomains) {
      add(domain, { assetId: asset.assetId, owner: "supply", pathKey: "supply" });
    }
  }
  return [...groups.values()]
    .map((group) => ({
      failureDomain: group.failureDomain,
      members: [...group.members].sort(
        (left, right) =>
          left.assetId.localeCompare(right.assetId) ||
          left.owner.localeCompare(right.owner) ||
          left.pathKey.localeCompare(right.pathKey),
      ),
    }))
    .filter((group) => group.members.length >= 2)
    .sort((left, right) => domainKey(left.failureDomain).localeCompare(domainKey(right.failureDomain)));
}

function serialDescendantsOfCycles(
  serialCycleMembers: ReadonlySet<string>,
  serialPaths: readonly V9DependencyPathPlan[],
): string[] {
  const blocked = new Set(serialCycleMembers);
  let changed = true;
  while (changed) {
    changed = false;
    for (const path of serialPaths) {
      if (!blocked.has(path.upstreamAssetId) || blocked.has(path.assetId)) continue;
      blocked.add(path.assetId);
      changed = true;
    }
  }
  return [...blocked].filter((assetId) => !serialCycleMembers.has(assetId)).sort();
}

function serialCycleMembers(
  cyclicComponents: readonly (readonly string[])[],
  serialPaths: readonly V9DependencyPathPlan[],
): string[] {
  const componentIndex = new Map<string, number>();
  for (const [index, component] of cyclicComponents.entries()) {
    for (const assetId of component) componentIndex.set(assetId, index);
  }
  const serialComponentIndexes = new Set<number>();
  for (const path of serialPaths) {
    const assetComponent = componentIndex.get(path.assetId);
    if (assetComponent !== undefined && assetComponent === componentIndex.get(path.upstreamAssetId)) {
      serialComponentIndexes.add(assetComponent);
    }
  }
  return cyclicComponents
    .flatMap((component, index) => (serialComponentIndexes.has(index) ? component : []))
    .sort();
}

function projectPlanDigest(plan: Omit<V9DependencyEvaluationPlan, "planDigest">): string {
  return sha256Hex(stableJsonStringifyV1({ domain: V9_DEPENDENCY_PLAN_DIGEST_DOMAIN, plan }));
}

function assertValidPlanningEdge(assetId: string, edge: V9DependencyPlanningEdge): void {
  if (!edge.edgeKey.trim()) throw new Error(`Safety Score v9 dependency edge for ${assetId} has no key`);
  if (!edge.upstreamAssetId.trim()) {
    throw new Error(`Safety Score v9 dependency ${edge.edgeKey} for ${assetId} has no upstream asset`);
  }
  if (!V9_DEPENDENCY_ECONOMIC_ROLES.includes(edge.economicRole)) {
    throw new Error(`Safety Score v9 dependency ${edge.edgeKey} for ${assetId} has no supported economic role`);
  }
  if (!Number.isFinite(edge.weight) || edge.weight <= 0 || edge.weight > 1) {
    throw new Error(`Safety Score v9 dependency ${edge.edgeKey} for ${assetId} has invalid materiality`);
  }
  if (edge.economicRole === "serial-claim" && edge.weight !== 1) {
    throw new Error(`Safety Score v9 serial dependency ${edge.edgeKey} for ${assetId} must cover the whole claim`);
  }
  if (
    (edge.economicRole === "exit-dependency" ||
      edge.economicRole === "control-operator" ||
      edge.economicRole === "oracle-nav") &&
    edge.failureDomains.length === 0
  ) {
    throw new Error(`Safety Score v9 role dependency ${edge.edgeKey} for ${assetId} requires a failure domain`);
  }
  if (
    (edge.economicRole === "exit-dependency" ||
      edge.economicRole === "control-operator" ||
      edge.economicRole === "oracle-nav") &&
    (edge.evidenceRefIds?.length ?? 0) === 0
  ) {
    throw new Error(`Safety Score v9 role dependency ${edge.edgeKey} for ${assetId} requires evidence attribution`);
  }
}

export function buildV9DependencyEvaluationPlan(args: {
  activeAssetIds: readonly string[];
  assets: readonly V9DependencyPlanningAsset[];
}): Readonly<V9DependencyEvaluationPlan> {
  const activeAssetIds = [...new Set(args.activeAssetIds)].sort();
  const assetIds = [...args.assets].map((asset) => asset.assetId).sort();
  if (JSON.stringify(activeAssetIds) !== JSON.stringify(assetIds)) {
    throw new Error("Safety Score v9 dependency planner requires the exact active asset set");
  }
  const activeSet = new Set(activeAssetIds);
  for (const asset of args.assets) {
    const edgeKeys = new Set<string>();
    for (const edge of asset.dependencies.edges) {
      assertValidPlanningEdge(asset.assetId, edge);
      if (edgeKeys.has(edge.edgeKey)) {
        throw new Error(`Duplicate Safety Score v9 dependency edge ${edge.edgeKey} for ${asset.assetId}`);
      }
      edgeKeys.add(edge.edgeKey);
      if (!activeSet.has(edge.upstreamAssetId) || edge.upstreamAssetId === asset.assetId) {
        throw new Error(`Invalid Safety Score v9 dependency ${edge.edgeKey} for ${asset.assetId}`);
      }
    }
  }
  const { paths, suppressed } = selectDependencyRoles(args.assets);
  const serialPaths = paths.filter((path) => path.role === "serial-claim");
  const basketPaths = paths.filter((path) => path.role === "basket-exposure");
  const exitPaths = paths.filter((path) => path.role === "exit-dependency");
  const controlPaths = paths.filter((path) => path.role === "control-operator");
  const oracleNavPaths = paths.filter((path) => path.role === "oracle-nav");
  const graphEdgeByPair = new Map<string, DependencyGraphEdge>();
  for (const path of paths) {
    const key = `${path.upstreamAssetId}\u0000${path.assetId}`;
    const previous = graphEdgeByPair.get(key);
    graphEdgeByPair.set(key, {
      from: path.upstreamAssetId,
      to: path.assetId,
      weight: Math.max(previous?.weight ?? 0, path.weight),
      type:
        previous === undefined || path.dependencyType.localeCompare(previous.type) < 0
          ? path.dependencyType
          : previous.type,
    });
  }
  const graphEdges = [...graphEdgeByPair.values()];
  const order = orderDependencyGraphNodes(activeAssetIds, graphEdges);
  const serialCycleAssetIds = serialCycleMembers(order.cyclicComponents, serialPaths);
  const serialCycleMemberSet = new Set(serialCycleAssetIds);
  const core: Omit<V9DependencyEvaluationPlan, "planDigest"> = {
    schemaVersion: 2,
    activeAssetIds,
    topologicalOrder: order.order,
    serialPaths,
    basketPaths,
    exitPaths,
    controlPaths,
    oracleNavPaths,
    suppressedRoles: suppressed,
    cyclicComponents: order.cyclicComponents,
    serialCycleAssetIds,
    serialBlockedDescendants: serialDescendantsOfCycles(serialCycleMemberSet, serialPaths),
    commonModeGroups: collectCommonModes(args.assets, paths),
  };
  return deepFreeze({ ...core, planDigest: projectPlanDigest(core) }) as Readonly<V9DependencyEvaluationPlan>;
}

export function resolveV9DependencyInputs(
  plan: V9DependencyEvaluationPlan,
  upstreamResults: readonly V9UpstreamResult[],
): V9ResolvedDependencyInputs[] {
  const resultById = new Map<string, V9UpstreamResult>();
  for (const result of upstreamResults) {
    if (resultById.has(result.assetId)) {
      throw new Error(`Duplicate Safety Score v9 upstream result ${result.assetId}`);
    }
    for (const [dimension, score] of [
      ["final", result.score],
      ["backing", result.backingScore],
      ["exit", result.exitScore],
      ["access", result.accessScore],
      ["control", result.controlScore],
      ["oracle-nav", result.oracleNavScore],
    ] as const) {
      if (score !== undefined && score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) {
        throw new Error(`Safety Score v9 upstream ${result.assetId} has invalid ${dimension} score`);
      }
    }
    resultById.set(result.assetId, result);
  }

  const componentByAssetId = new Map<string, number>();
  for (const [index, component] of plan.cyclicComponents.entries()) {
    for (const assetId of component) componentByAssetId.set(assetId, index);
  }
  const serialCycleMembers = new Set(plan.serialCycleAssetIds);
  const serialBlocked = new Set(plan.serialBlockedDescendants);
  const paths = [
    ...plan.serialPaths,
    ...plan.basketPaths,
    ...plan.exitPaths,
    ...plan.controlPaths,
    ...plan.oracleNavPaths,
  ].sort(comparePath);
  const inheritedDimensions = (role: V9DependencyEconomicRole): readonly V9DependencyScoreDimension[] => {
    if (role === "serial-claim") return ["final"];
    if (role === "basket-exposure") return ["backing"];
    if (role === "exit-dependency") return ["exit", "access"];
    if (role === "control-operator") return ["control"];
    return ["oracle-nav"];
  };
  const scoreForDimension = (
    result: V9UpstreamResult | undefined,
    dimension: V9DependencyScoreDimension,
  ): number | null => {
    if (!result) return null;
    if (dimension === "final") return result.score;
    if (dimension === "backing") return result.backingScore;
    if (dimension === "exit") return result.exitScore ?? null;
    if (dimension === "access") return result.accessScore ?? null;
    if (dimension === "control") return result.controlScore ?? null;
    return result.oracleNavScore ?? null;
  };
  const roleInputs = paths.map((path): V9ResolvedRoleDependencyInput => {
    const dimensions = inheritedDimensions(path.role);
    const result = resultById.get(path.upstreamAssetId);
    const sameCycle =
      componentByAssetId.has(path.assetId) &&
      componentByAssetId.get(path.assetId) === componentByAssetId.get(path.upstreamAssetId);
    const cycleBlocked =
      sameCycle || (path.role === "serial-claim" && (serialCycleMembers.has(path.assetId) || serialBlocked.has(path.assetId)));
    const unavailableDimensions = cycleBlocked
      ? [...dimensions]
      : dimensions.filter((dimension) => scoreForDimension(result, dimension) === null);
    const scores = dimensions.map((dimension) => scoreForDimension(result, dimension));
    return {
      assetId: path.assetId,
      upstreamAssetId: path.upstreamAssetId,
      edgeKey: path.edgeKey,
      exposureKey: path.exposureKey,
      riskEventKey: path.riskEventKey,
      dependencyType: path.dependencyType,
      role: path.role,
      weight: path.weight,
      inheritedDimensions: dimensions,
      unavailableDimensions,
      score: cycleBlocked || unavailableDimensions.length > 0 ? null : Math.min(...(scores as number[])),
      boundedUnknown: cycleBlocked || unavailableDimensions.length > 0,
      cycleBlocked,
      evidenceRefIds: path.evidenceRefIds,
      failureDomains: path.failureDomains,
    };
  });
  const roleInputsByAssetId = new Map<string, V9ResolvedRoleDependencyInput[]>();
  for (const input of roleInputs) {
    roleInputsByAssetId.set(input.assetId, [...(roleInputsByAssetId.get(input.assetId) ?? []), input]);
  }

  return plan.topologicalOrder.map((assetId) => ({
    assetId,
    serial: (roleInputsByAssetId.get(assetId) ?? [])
      .filter((input) => input.role === "serial-claim")
      .map((input) => ({
        upstreamAssetId: input.upstreamAssetId,
        score: input.score,
        blocked: input.boundedUnknown,
      })),
    basket: (roleInputsByAssetId.get(assetId) ?? [])
      .filter((input) => input.role === "basket-exposure")
      .map((input) => ({
        upstreamAssetId: input.upstreamAssetId,
        weight: input.weight,
        score: input.score,
        boundedUnknown: input.boundedUnknown,
      })),
    roleInputs: roleInputsByAssetId.get(assetId) ?? [],
    cycleBlocked: serialCycleMembers.has(assetId) || serialBlocked.has(assetId),
  }));
}

function roleTargetPillar(role: V9DependencyEconomicRole): V9RoleDependencyTargetPillar | null {
  if (role === "exit-dependency") return "exit";
  if (role === "control-operator" || role === "oracle-nav") return "control";
  return null;
}

/**
 * Projects role-specific dependency results into exposure-weighted pillar
 * limits. Edge identity defines the holder slice; a shared operator, oracle, or
 * rail does not prove that separate edges cover the same holders. Multiple
 * events on one explicit slice contribute only their worst modeled loss.
 * Unknown dimensions leave the affected pillar limit null and expose their
 * conservative materiality.
 */
export function projectV9RoleDependencyPillarLimits(
  resolved: V9ResolvedDependencyInputs,
  options: { unresolvedMaterialityThreshold?: number } = {},
): Readonly<Record<V9RoleDependencyTargetPillar, V9RoleDependencyPillarProjection>> {
  const unresolvedMaterialityThreshold = options.unresolvedMaterialityThreshold ?? 0;
  if (
    !Number.isFinite(unresolvedMaterialityThreshold) ||
    unresolvedMaterialityThreshold < 0 ||
    unresolvedMaterialityThreshold > 1
  ) {
    throw new Error("Safety Score v9 dependency unresolved materiality threshold must be between 0 and 1");
  }
  const inputs = [...(resolved.roleInputs ?? [])]
    .filter((input) => roleTargetPillar(input.role) !== null)
    .sort(
      (left, right) =>
        roleTargetPillar(left.role)!.localeCompare(roleTargetPillar(right.role)!) ||
        left.edgeKey.localeCompare(right.edgeKey) ||
        left.upstreamAssetId.localeCompare(right.upstreamAssetId),
    );
  type EventGroup = {
    targetPillar: V9RoleDependencyTargetPillar;
    exposureKey: string;
    riskEventKey: string;
    inputs: V9ResolvedRoleDependencyInput[];
  };
  const eventGroups = new Map<string, EventGroup>();
  for (const input of inputs) {
    const targetPillar = roleTargetPillar(input.role)!;
    const key = `${targetPillar}\u0000${input.exposureKey}\u0000${input.riskEventKey}`;
    const group = eventGroups.get(key) ?? {
      targetPillar,
      exposureKey: input.exposureKey,
      riskEventKey: input.riskEventKey,
      inputs: [],
    };
    group.inputs.push(input);
    eventGroups.set(key, group);
  }

  const dimensionOrder: readonly V9DependencyScoreDimension[] = [
    "final",
    "backing",
    "exit",
    "access",
    "control",
    "oracle-nav",
  ];
  type UnallocatedEvent = Omit<V9RoleDependencyPropagationEvent, "exposureShare">;
  const eventCandidates = [...eventGroups.values()]
    .map((group): UnallocatedEvent => {
      const groupInputs = [...group.inputs].sort(
        (left, right) => left.edgeKey.localeCompare(right.edgeKey) || left.upstreamAssetId.localeCompare(right.upstreamAssetId),
      );
      const boundedUnknown = groupInputs.some((input) => input.boundedUnknown || input.score === null);
      const selected = boundedUnknown
        ? [...groupInputs].sort(
            (left, right) =>
              right.weight - left.weight ||
              left.edgeKey.localeCompare(right.edgeKey) ||
              left.upstreamAssetId.localeCompare(right.upstreamAssetId),
          )[0]!
        : [...groupInputs].sort(
            (left, right) =>
              right.weight * (100 - (right.score as number)) -
                left.weight * (100 - (left.score as number)) ||
              left.edgeKey.localeCompare(right.edgeKey) ||
              left.upstreamAssetId.localeCompare(right.upstreamAssetId),
          )[0]!;
      const nominalExposureShare = selected.weight;
      const inheritedScore = boundedUnknown ? null : selected.score;
      return {
        targetPillar: group.targetPillar,
        exposureKey: group.exposureKey,
        riskEventKey: group.riskEventKey,
        roles: [
          ...new Set(
            groupInputs.map(
              (input) =>
                input.role as Exclude<V9DependencyEconomicRole, "serial-claim" | "basket-exposure">,
            ),
          ),
        ].sort((left, right) => (ROLE_ORDER.get(left) ?? 0) - (ROLE_ORDER.get(right) ?? 0)),
        edgeKeys: [...new Set(groupInputs.map((input) => input.edgeKey))].sort(),
        upstreamAssetIds: [...new Set(groupInputs.map((input) => input.upstreamAssetId))].sort(),
        nominalExposureShare,
        inheritedScore,
        modeledLossPoints: inheritedScore === null ? null : nominalExposureShare * (100 - inheritedScore),
        boundedUnknown,
        cycleBlocked: groupInputs.some((input) => input.cycleBlocked),
        unavailableDimensions: dimensionOrder.filter((dimension) =>
          groupInputs.some((input) => input.unavailableDimensions.includes(dimension)),
        ),
        evidenceRefIds: [...new Set(groupInputs.flatMap((input) => input.evidenceRefIds))].sort(),
        failureDomains: canonicalPlanningDomains(groupInputs.flatMap((input) => input.failureDomains)),
      };
    })
    .sort(
      (left, right) =>
        left.targetPillar.localeCompare(right.targetPillar) ||
        left.exposureKey.localeCompare(right.exposureKey) ||
        left.riskEventKey.localeCompare(right.riskEventKey),
    );
  const selectedEvents = [...new Map(
    (["exit", "control"] as const).flatMap((targetPillar) => {
      const byExposure = new Map<string, UnallocatedEvent[]>();
      for (const event of eventCandidates.filter((candidate) => candidate.targetPillar === targetPillar)) {
        byExposure.set(event.exposureKey, [...(byExposure.get(event.exposureKey) ?? []), event]);
      }
      return [...byExposure.entries()].map(([exposureKey, candidates]) => {
        const selected = [...candidates].sort(
          (left, right) =>
            (right.boundedUnknown ? right.nominalExposureShare * 100 : right.modeledLossPoints ?? 0) -
              (left.boundedUnknown ? left.nominalExposureShare * 100 : left.modeledLossPoints ?? 0) ||
            Number(right.boundedUnknown) - Number(left.boundedUnknown) ||
            left.riskEventKey.localeCompare(right.riskEventKey),
        )[0]!;
        return [`${targetPillar}\u0000${exposureKey}`, selected] as const;
      });
    }),
  ).values()];
  const normalizationByPillar = new Map<V9RoleDependencyTargetPillar, number>();
  for (const targetPillar of ["exit", "control"] as const) {
    const maximumNominalShareByExposure = new Map<string, number>();
    for (const event of eventCandidates.filter((candidate) => candidate.targetPillar === targetPillar)) {
      maximumNominalShareByExposure.set(
        event.exposureKey,
        Math.max(maximumNominalShareByExposure.get(event.exposureKey) ?? 0, event.nominalExposureShare),
      );
    }
    const totalNominalShare = [...maximumNominalShareByExposure.values()].reduce(
      (sum, share) => sum + share,
      0,
    );
    normalizationByPillar.set(targetPillar, totalNominalShare > 1 ? 1 / totalNominalShare : 1);
  }
  const events = selectedEvents
    .map((event): V9RoleDependencyPropagationEvent => {
      const exposureShare = event.nominalExposureShare * normalizationByPillar.get(event.targetPillar)!;
      return {
        ...event,
        exposureShare,
        modeledLossPoints:
          event.inheritedScore === null ? null : exposureShare * (100 - event.inheritedScore),
      };
    })
    .sort(
      (left, right) =>
        left.targetPillar.localeCompare(right.targetPillar) ||
        left.exposureKey.localeCompare(right.exposureKey) ||
        left.riskEventKey.localeCompare(right.riskEventKey),
    );

  const project = (targetPillar: V9RoleDependencyTargetPillar): V9RoleDependencyPillarProjection => {
    const pillarEvents = events.filter((event) => event.targetPillar === targetPillar);
    const knownLossPoints = Math.min(
      100,
      pillarEvents.reduce((sum, event) => sum + (event.modeledLossPoints ?? 0), 0),
    );
    const unresolvedExposureShare = Math.min(
      1,
      pillarEvents.reduce((sum, event) => sum + (event.boundedUnknown ? event.exposureShare : 0), 0),
    );
    const materialUnresolvedExposure =
      unresolvedExposureShare > 0 &&
      isV9MaterialShare(unresolvedExposureShare, unresolvedMaterialityThreshold);
    const boundedUnknownLossPoints = unresolvedExposureShare * 100;
    return {
      targetPillar,
      limit: materialUnresolvedExposure
        ? null
        : Math.max(0, 100 - knownLossPoints - boundedUnknownLossPoints),
      knownLossPoints,
      boundedUnknownLossPoints,
      unresolvedExposureShare,
      materialUnresolvedExposure,
      events: pillarEvents,
    };
  };
  return deepFreeze({ exit: project("exit"), control: project("control") });
}
