import type { DependencyType, DependencyWeight, ReserveSlice, StablecoinMeta } from "../types";

export type DependencyDerivationBaseSource =
  | "live-reserve"
  | "live-unmapped"
  | "curated-reserve"
  | "manual"
  | "none";

export type DependencyDerivationSource = DependencyDerivationBaseSource | "variant";

export interface DerivedDependencySet {
  dependencies: DependencyWeight[];
  source: DependencyDerivationSource;
  baseSource: DependencyDerivationBaseSource;
  dependencyFromLive: boolean;
  mappedLiveReserveWeight: number | null;
}

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

function sumDependencyWeight(dependencies: readonly DependencyWeight[]): number {
  return dependencies.reduce((sum, dependency) => sum + dependency.weight, 0);
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

function resolveSource(
  baseSource: DependencyDerivationBaseSource,
  dependencies: readonly DependencyWeight[],
  variantOf?: string,
): DependencyDerivationSource {
  if (!variantOf) return baseSource;
  if (
    dependencies.length === 1
    && dependencies[0].id === variantOf
    && (dependencies[0].type ?? "collateral") === "wrapper"
  ) {
    return "variant";
  }
  return baseSource;
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

function deriveCuratedDependencySet(
  meta: Pick<StablecoinMeta, "variantOf" | "reserves" | "dependencies">,
  mappedLiveReserveWeight: number | null = null,
): DerivedDependencySet {
  const reserveDependencies = meta.reserves?.length
    ? aggregateReserveDependencies(meta.reserves)
    : [];
  const manualDependencies = meta.dependencies ?? [];
  const baseDependencies = reserveDependencies.length > 0 ? reserveDependencies : manualDependencies;
  const baseSource: DependencyDerivationBaseSource = reserveDependencies.length > 0
    ? "curated-reserve"
    : manualDependencies.length > 0
      ? "manual"
      : "none";
  const dependencies = injectVariantParent(baseDependencies, meta.variantOf);

  return {
    dependencies,
    source: resolveSource(baseSource, dependencies, meta.variantOf),
    baseSource,
    dependencyFromLive: false,
    mappedLiveReserveWeight,
  };
}

export function deriveEffectiveDependencySet(
  meta: Pick<StablecoinMeta, "variantOf" | "reserves" | "dependencies">,
  options?: { liveReserveSlices?: readonly ReserveSlice[] },
): DerivedDependencySet {
  if (Array.isArray(options?.liveReserveSlices)) {
    const liveDependencies = aggregateReserveDependencies(options.liveReserveSlices);
    const mappedLiveReserveWeight = sumDependencyWeight(liveDependencies);

    if (liveDependencies.length === 0) {
      const fallbackSet = deriveCuratedDependencySet(meta, mappedLiveReserveWeight);
      if (fallbackSet.dependencies.length > 0) return fallbackSet;

      return {
        dependencies: [],
        source: "live-unmapped",
        baseSource: "live-unmapped",
        dependencyFromLive: true,
        mappedLiveReserveWeight,
      };
    }

    const dependencies = injectVariantParent(liveDependencies, meta.variantOf);
    const baseSource: DependencyDerivationBaseSource = "live-reserve";

    return {
      dependencies,
      source: resolveSource(baseSource, dependencies, meta.variantOf),
      baseSource,
      dependencyFromLive: true,
      mappedLiveReserveWeight,
    };
  }

  return deriveCuratedDependencySet(meta);
}

export function deriveEffectiveDependencies(
  meta: Pick<StablecoinMeta, "variantOf" | "reserves" | "dependencies">,
  options?: { liveReserveSlices?: readonly ReserveSlice[] },
): DependencyWeight[] {
  return deriveEffectiveDependencySet(meta, options).dependencies;
}
