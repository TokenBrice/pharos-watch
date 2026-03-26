import { deriveDependencies } from "./reserve-templates";
import type { DependencyType, StablecoinMeta } from "../types/core";

export interface DependencyGraphEdge {
  from: string;
  to: string;
  weight: number;
  type: DependencyType;
}

export function buildDependencyGraphEdges(
  metas: readonly StablecoinMeta[],
): DependencyGraphEdge[] {
  const edges: DependencyGraphEdge[] = [];

  for (const meta of metas) {
    for (const dep of deriveDependencies(meta)) {
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

export function collectDependencyGraphIds(
  edges: readonly Pick<DependencyGraphEdge, "from" | "to">[],
): Set<string> {
  const ids = new Set<string>();
  for (const edge of edges) {
    ids.add(edge.from);
    ids.add(edge.to);
  }
  return ids;
}
