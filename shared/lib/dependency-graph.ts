import { deriveEffectiveDependencies } from "./dependency-derivation";
import type { DependencyType, DependencyWeight, ReserveSlice, StablecoinMeta } from "../types/core";

export interface DependencyGraphEdge {
  from: string;
  to: string;
  weight: number;
  type: DependencyType;
}

export function buildDependencyGraphEdges(
  metas: readonly StablecoinMeta[],
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

export function buildDependencyGraphEdgesFromDependencies(
  metas: readonly Pick<StablecoinMeta, "id">[],
  dependenciesById: ReadonlyMap<string, readonly DependencyWeight[]>,
): DependencyGraphEdge[] {
  const edges: DependencyGraphEdge[] = [];

  for (const meta of metas) {
    for (const dep of dependenciesById.get(meta.id) ?? []) {
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
