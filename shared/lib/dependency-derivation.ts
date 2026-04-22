import type { DependencyType, DependencyWeight, StablecoinMeta } from "../types";

/**
 * Derives dependency weights from curated reserve composition.
 * Reserve slices with `coinId` are converted to dependency entries, and
 * hand-curated `meta.dependencies` remain the fallback when reserves do not
 * provide linked upstream assets.
 */
export function deriveDependencies(meta: Pick<StablecoinMeta, "reserves" | "dependencies">): DependencyWeight[] {
  const reserves = meta.reserves;
  if (!reserves?.length) return meta.dependencies ?? [];

  const linked = reserves.filter((reserve): reserve is typeof reserve & { coinId: string } => !!reserve.coinId);
  if (linked.length === 0) return meta.dependencies ?? [];

  const aggregated = new Map<string, { id: string; weight: number; type: DependencyType }>();
  for (const reserve of linked) {
    const type: DependencyType = reserve.depType ?? "collateral";
    const key = `${reserve.coinId}::${type}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.weight += reserve.pct / 100;
      continue;
    }
    aggregated.set(key, { id: reserve.coinId, weight: reserve.pct / 100, type });
  }

  return Array.from(aggregated.values());
}
