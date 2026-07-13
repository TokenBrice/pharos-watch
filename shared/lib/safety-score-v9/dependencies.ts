import type { DependencyType } from "../../types/dependency-types";
import type { V9FailureDomainRef } from "../../types/safety-score-v9-facts";
import { orderDependencyGraphNodes, type DependencyGraphEdge } from "../dependency-graph";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";

const V9_DEPENDENCY_PLAN_DIGEST_DOMAIN = "safety-score-v9.dependency-plan.v1";

export interface V9DependencyPlanningEdge {
  edgeKey: string;
  upstreamAssetId: string;
  dependencyType: DependencyType;
  pathKind: "serial-dependency" | "collateral-exposure";
  weight: number;
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
  dependencyType: DependencyType;
  role: "serial-claim" | "basket-exposure";
  weight: number;
  failureDomains: readonly V9FailureDomainRef[];
}

export interface V9SuppressedDependencyRole {
  assetId: string;
  upstreamAssetId: string;
  selectedEdgeKey: string;
  suppressedEdgeKey: string;
  reason: "serial-role-dominates" | "duplicate-serial-role";
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
  schemaVersion: 1;
  activeAssetIds: readonly string[];
  topologicalOrder: readonly string[];
  serialPaths: readonly V9DependencyPathPlan[];
  basketPaths: readonly V9DependencyPathPlan[];
  suppressedRoles: readonly V9SuppressedDependencyRole[];
  cyclicComponents: readonly (readonly string[])[];
  serialBlockedDescendants: readonly string[];
  commonModeGroups: readonly V9CommonModeGroup[];
  planDigest: string;
}

export interface V9UpstreamResult {
  assetId: string;
  score: number | null;
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
  cycleBlocked: boolean;
}

function domainKey(domain: V9FailureDomainRef): string {
  return `${domain.kind}:${domain.key}`;
}

function pathSortKey(path: V9DependencyPathPlan): string {
  return `${path.assetId}\u0000${path.upstreamAssetId}\u0000${path.dependencyType}\u0000${path.edgeKey}`;
}

function comparePath(left: V9DependencyPathPlan, right: V9DependencyPathPlan): number {
  return pathSortKey(left).localeCompare(pathSortKey(right));
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
      const edges = [...rawEdges].sort(
        (left, right) =>
          (left.pathKind === right.pathKind ? 0 : left.pathKind === "serial-dependency" ? -1 : 1) ||
          (left.dependencyType === right.dependencyType
            ? 0
            : left.dependencyType === "wrapper"
              ? -1
              : left.dependencyType === "mechanism"
                ? -1
                : 1) ||
          left.edgeKey.localeCompare(right.edgeKey),
      );
      const selected = edges[0]!;
      paths.push({
        assetId: asset.assetId,
        upstreamAssetId,
        edgeKey: selected.edgeKey,
        dependencyType: selected.dependencyType,
        role: selected.pathKind === "serial-dependency" ? "serial-claim" : "basket-exposure",
        weight: selected.weight,
        failureDomains: [...selected.failureDomains].sort((left, right) => domainKey(left).localeCompare(domainKey(right))),
      });
      for (const edge of edges.slice(1)) {
        suppressed.push({
          assetId: asset.assetId,
          upstreamAssetId,
          selectedEdgeKey: selected.edgeKey,
          suppressedEdgeKey: edge.edgeKey,
          reason:
            selected.pathKind === "serial-dependency" && edge.pathKind === "collateral-exposure"
              ? "serial-role-dominates"
              : "duplicate-serial-role",
        });
      }
    }
  }
  return { paths: paths.sort(comparePath), suppressed };
}

function collectCommonModes(assets: readonly V9DependencyPlanningAsset[]): V9CommonModeGroup[] {
  const groups = new Map<string, { failureDomain: V9FailureDomainRef; members: V9CommonModeMember[] }>();
  const add = (domain: V9FailureDomainRef, member: V9CommonModeMember) => {
    const key = domainKey(domain);
    const group = groups.get(key) ?? { failureDomain: domain, members: [] };
    if (!group.members.some((candidate) => stableJsonStringifyV1(candidate) === stableJsonStringifyV1(member))) {
      group.members.push(member);
    }
    groups.set(key, group);
  };
  for (const asset of assets) {
    for (const edge of asset.dependencies.edges) {
      for (const domain of edge.failureDomains) {
        add(domain, { assetId: asset.assetId, owner: "dependency", pathKey: edge.edgeKey });
      }
    }
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
  cycleMembers: ReadonlySet<string>,
  serialPaths: readonly V9DependencyPathPlan[],
): string[] {
  const blocked = new Set(cycleMembers);
  let changed = true;
  while (changed) {
    changed = false;
    for (const path of serialPaths) {
      if (!blocked.has(path.upstreamAssetId) || blocked.has(path.assetId)) continue;
      blocked.add(path.assetId);
      changed = true;
    }
  }
  return [...blocked].filter((assetId) => !cycleMembers.has(assetId)).sort();
}

function projectPlanDigest(plan: Omit<V9DependencyEvaluationPlan, "planDigest">): string {
  return sha256Hex(stableJsonStringifyV1({ domain: V9_DEPENDENCY_PLAN_DIGEST_DOMAIN, plan }));
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
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
    for (const edge of asset.dependencies.edges) {
      if (!activeSet.has(edge.upstreamAssetId) || edge.upstreamAssetId === asset.assetId) {
        throw new Error(`Invalid Safety Score v9 dependency ${edge.edgeKey} for ${asset.assetId}`);
      }
    }
  }
  const { paths, suppressed } = selectDependencyRoles(args.assets);
  const serialPaths = paths.filter((path) => path.role === "serial-claim");
  const basketPaths = paths.filter((path) => path.role === "basket-exposure");
  const graphEdges: DependencyGraphEdge[] = paths.map((path) => ({
    from: path.upstreamAssetId,
    to: path.assetId,
    weight: path.weight,
    type: path.dependencyType,
  }));
  const order = orderDependencyGraphNodes(activeAssetIds, graphEdges);
  const cycleMembers = new Set(order.cyclicComponents.flat());
  const core: Omit<V9DependencyEvaluationPlan, "planDigest"> = {
    schemaVersion: 1,
    activeAssetIds,
    topologicalOrder: order.order,
    serialPaths,
    basketPaths,
    suppressedRoles: suppressed,
    cyclicComponents: order.cyclicComponents,
    serialBlockedDescendants: serialDescendantsOfCycles(cycleMembers, serialPaths),
    commonModeGroups: collectCommonModes(args.assets),
  };
  return deepFreeze({ ...core, planDigest: projectPlanDigest(core) }) as Readonly<V9DependencyEvaluationPlan>;
}

export function resolveV9DependencyInputs(
  plan: V9DependencyEvaluationPlan,
  upstreamResults: readonly V9UpstreamResult[],
): V9ResolvedDependencyInputs[] {
  const resultById = new Map(upstreamResults.map((result) => [result.assetId, result]));
  const cycleMembers = new Set(plan.cyclicComponents.flat());
  const serialBlocked = new Set(plan.serialBlockedDescendants);
  return plan.topologicalOrder.map((assetId) => ({
    assetId,
    serial: plan.serialPaths
      .filter((path) => path.assetId === assetId)
      .map((path) => ({
        upstreamAssetId: path.upstreamAssetId,
        score: resultById.get(path.upstreamAssetId)?.score ?? null,
        blocked:
          cycleMembers.has(path.upstreamAssetId) ||
          serialBlocked.has(path.upstreamAssetId) ||
          (resultById.get(path.upstreamAssetId)?.score ?? null) === null,
      })),
    basket: plan.basketPaths
      .filter((path) => path.assetId === assetId)
      .map((path) => ({
        upstreamAssetId: path.upstreamAssetId,
        weight: path.weight,
        score: resultById.get(path.upstreamAssetId)?.score ?? null,
        boundedUnknown: (resultById.get(path.upstreamAssetId)?.score ?? null) === null,
      })),
    cycleBlocked: cycleMembers.has(assetId) || serialBlocked.has(assetId),
  }));
}
