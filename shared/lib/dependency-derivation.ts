import type { DependencyType, DependencyWeight, ReserveSlice, StablecoinMeta } from "../types";

function aggregateReserveDependencies(reserves: readonly ReserveSlice[]): DependencyWeight[] {
  const linked = reserves.filter((reserve): reserve is ReserveSlice & { coinId: string } => !!reserve.coinId);
  if (linked.length === 0) return [];

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

function injectVariantParent(
  dependencies: readonly DependencyWeight[],
  variantOf?: string,
): DependencyWeight[] {
  if (!variantOf) return [...dependencies];

  return [
    ...dependencies.filter((dependency) => dependency.id !== variantOf),
    { id: variantOf, weight: 1, type: "wrapper" },
  ];
}

/**
 * Derives dependency weights from curated reserve composition.
 * Reserve slices with `coinId` are converted to dependency entries, and
 * hand-curated `meta.dependencies` remain the fallback when reserves do not
 * provide linked upstream assets.
 */
export function deriveDependencies(meta: Pick<StablecoinMeta, "reserves" | "dependencies">): DependencyWeight[] {
  const reserves = meta.reserves;
  if (!reserves?.length) return meta.dependencies ?? [];

  const reserveDependencies = aggregateReserveDependencies(reserves);
  if (reserveDependencies.length === 0) return meta.dependencies ?? [];

  return reserveDependencies;
}

export function deriveEffectiveDependencies(
  meta: Pick<StablecoinMeta, "variantOf" | "reserves" | "dependencies">,
  options?: { liveReserveSlices?: readonly ReserveSlice[] },
): DependencyWeight[] {
  const dependencies = Array.isArray(options?.liveReserveSlices)
    ? aggregateReserveDependencies(options.liveReserveSlices)
    : deriveDependencies(meta);

  return injectVariantParent(dependencies, meta.variantOf);
}
