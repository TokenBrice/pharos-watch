import { deriveEffectiveDependencies } from "./dependency-derivation";
import type { DependencyType, ReserveSlice, StablecoinMeta } from "../types/core";

export interface DependencyGraphEdge {
  from: string;
  to: string;
  weight: number;
  type: DependencyType;
}

export interface DuplicateDependencyEdge {
  key: string;
  count: number;
  edges: DependencyGraphEdge[];
}

export interface DependencyGraphDiagnostics {
  selfEdges: DependencyGraphEdge[];
  duplicateEdges: DuplicateDependencyEdge[];
  stronglyConnectedComponents: string[][];
}

export interface DependencyGraphOrder {
  order: string[];
  cyclicComponents: string[][];
}

function dependencyEdgeKey(edge: DependencyGraphEdge): string {
  return `${edge.from}->${edge.to}:${edge.type}`;
}

function sortEdges(edges: readonly DependencyGraphEdge[]): DependencyGraphEdge[] {
  return [...edges].sort(
    (left, right) =>
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to) ||
      left.type.localeCompare(right.type) ||
      left.weight - right.weight,
  );
}

/** Deterministic Tarjan diagnostics over dependency edges. */
export function diagnoseDependencyGraph(edges: readonly DependencyGraphEdge[]): DependencyGraphDiagnostics {
  const sortedEdges = sortEdges(edges);
  const grouped = new Map<string, DependencyGraphEdge[]>();
  const nodes = new Set<string>();
  const outgoing = new Map<string, Set<string>>();
  for (const edge of sortedEdges) {
    nodes.add(edge.from);
    nodes.add(edge.to);
    const key = dependencyEdgeKey(edge);
    grouped.set(key, [...(grouped.get(key) ?? []), edge]);
    const targets = outgoing.get(edge.from) ?? new Set<string>();
    targets.add(edge.to);
    outgoing.set(edge.from, targets);
  }

  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  function visit(node: string): void {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of [...(outgoing.get(node) ?? [])].sort()) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(target)!));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    if (component.length > 1) components.push(component.sort());
  }

  for (const node of [...nodes].sort()) {
    if (!indices.has(node)) visit(node);
  }

  return {
    selfEdges: sortedEdges.filter((edge) => edge.from === edge.to),
    duplicateEdges: [...grouped.entries()]
      .filter(([, group]) => group.length > 1)
      .map(([key, group]) => ({ key, count: group.length, edges: group })),
    stronglyConnectedComponents: components.sort((left, right) => left[0].localeCompare(right[0])),
  };
}

/**
 * Orders upstream nodes before their consumers. Cycles are diagnosed once by
 * Tarjan, collapsed into deterministic components, and returned for callers to
 * dispose according to their own methodology.
 */
export function orderDependencyGraphNodes(
  nodeIds: readonly string[],
  edges: readonly DependencyGraphEdge[],
): DependencyGraphOrder {
  const nodes = [...new Set([...nodeIds, ...edges.flatMap((edge) => [edge.from, edge.to])])].sort();
  const diagnostics = diagnoseDependencyGraph(edges);
  const cyclicComponents = [
    ...diagnostics.stronglyConnectedComponents,
    ...diagnostics.selfEdges.map((edge) => [edge.from]),
  ].sort((left, right) => left[0]!.localeCompare(right[0]!));
  const componentByNode = new Map<string, string>();
  const membersByComponent = new Map<string, string[]>();
  for (const component of cyclicComponents) {
    const members = [...component].sort();
    const key = `scc:${members.join(",")}`;
    membersByComponent.set(key, members);
    for (const member of members) componentByNode.set(member, key);
  }
  for (const node of nodes) {
    if (componentByNode.has(node)) continue;
    const key = `node:${node}`;
    componentByNode.set(node, key);
    membersByComponent.set(key, [node]);
  }

  const outgoing = new Map<string, Set<string>>();
  const indegree = new Map([...membersByComponent.keys()].map((key) => [key, 0]));
  for (const edge of edges) {
    const from = componentByNode.get(edge.from)!;
    const to = componentByNode.get(edge.to)!;
    if (from === to) continue;
    const targets = outgoing.get(from) ?? new Set<string>();
    if (!targets.has(to)) {
      targets.add(to);
      outgoing.set(from, targets);
      indegree.set(to, (indegree.get(to) ?? 0) + 1);
    }
  }

  const componentSortKey = (key: string) => membersByComponent.get(key)!.join("\u0000");
  const ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([key]) => key)
    .sort((left, right) => componentSortKey(left).localeCompare(componentSortKey(right)));
  const orderedComponents: string[] = [];
  while (ready.length > 0) {
    const component = ready.shift()!;
    orderedComponents.push(component);
    for (const target of [...(outgoing.get(component) ?? [])].sort((left, right) =>
      componentSortKey(left).localeCompare(componentSortKey(right)),
    )) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) {
        ready.push(target);
        ready.sort((left, right) => componentSortKey(left).localeCompare(componentSortKey(right)));
      }
    }
  }
  if (orderedComponents.length !== membersByComponent.size) {
    throw new Error("Dependency component graph remained cyclic after SCC collapse");
  }
  return {
    order: orderedComponents.flatMap((component) => membersByComponent.get(component)!),
    cyclicComponents,
  };
}

export function buildDependencyGraphEdges(
  metas: readonly Pick<StablecoinMeta, "id" | "variantOf" | "reserves" | "dependencies">[],
  options?: {
    liveReserveSlicesById?: ReadonlyMap<string, readonly ReserveSlice[]>;
  },
): DependencyGraphEdge[] {
  const edges: DependencyGraphEdge[] = [];

  for (const meta of metas) {
    const liveReserveSlices = options?.liveReserveSlicesById?.get(meta.id);
    const dependencies = deriveEffectiveDependencies(
      meta,
      liveReserveSlices != null ? { liveReserveSlices } : undefined,
    );
    for (const dep of dependencies) {
      if (dep.id === meta.id) continue;
      edges.push({
        from: dep.id,
        to: meta.id,
        weight: dep.weight,
        type: dep.type ?? "collateral",
      });
    }
  }

  return edges;
}

export function filterDependencyGraphEdgesToLive(
  edges: readonly DependencyGraphEdge[],
  liveIds: ReadonlySet<string>,
): DependencyGraphEdge[] {
  return edges.filter((edge) => liveIds.has(edge.from) && liveIds.has(edge.to));
}
