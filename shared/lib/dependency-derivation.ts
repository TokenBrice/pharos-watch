import type { DependencyType, DependencyWeight, ReserveSlice, StablecoinMeta } from "../types";

export type DependencyDerivationBaseSource =
  | "live-reserve"
  | "live-unmapped"
  | "curated-reserve"
  | "manual"
  | "none";

export type DependencyDerivationSource = DependencyDerivationBaseSource | "variant";

export interface DependencyRejectionReason {
  sliceIndex: number;
  reason: "no-match" | "expired" | "non-link";
}

export interface DerivedDependencySet {
  dependencies: DependencyWeight[];
  source: DependencyDerivationSource;
  baseSource: DependencyDerivationBaseSource;
  dependencyFromLive: boolean;
  mappedLiveReserveWeight: number | null;
  fallbackReason: DependencyFallbackReason | null;
  rejectionReasons: DependencyRejectionReason[];
}

export type DependencyFallbackReason =
  | "live-unmapped-to-curated-reserve"
  | "live-unmapped-to-manual"
  | "live-cycle-to-curated";

function aggregateReserveDependencies(
  reserves: readonly ReserveSlice[],
  subjectId?: string,
): DependencyWeight[] {
  const linked = reserves.filter((reserve): reserve is ReserveSlice & { coinId: string } => !!reserve.coinId);
  if (linked.length === 0) return [];

  const aggregated = new Map<string, { id: string; weight: number; type: DependencyType }>();
  for (const reserve of linked) {
    if (reserve.coinId === subjectId) continue;
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
  const total = dependencies.reduce((sum, dependency) => sum + dependency.weight, 0);

  // Reserve adapters publish decimal percentages. Converting each slice to a
  // fraction before summing can put an exact 100% basket one ULP above 1,
  // which is not a real overweight condition but is outside FractionSchema.
  // Canonicalize only negligible boundary drift; material overweights remain
  // visible to the dependency validator and fail closed.
  if (Math.abs(total) <= 1e-12) return 0;
  if (Math.abs(total - 1) <= 1e-12) return 1;
  return total;
}

function injectStructuralDependencies(
  dependencies: readonly DependencyWeight[],
  meta: Pick<StablecoinMeta, "variantOf" | "dependencies" | "reserves">,
): DependencyWeight[] {
  // A variant is a serial claim on its parent. Its reserve view may expose the
  // parent's backing, but those slices are not an additional parallel path.
  const result: DependencyWeight[] = meta.variantOf
    ? [{ id: meta.variantOf, weight: 1, type: "wrapper" }]
    : [...dependencies];
  // Explicit wrapped-asset identities are serial claims, not basket weights.
  // A variant's reserve book is look-through backing, so its parent wins.
  if (!meta.variantOf) {
    for (const reserve of meta.reserves ?? []) {
      if (!reserve.coinId || reserve.depType !== "wrapper") continue;
      const existingIndex = result.findIndex(
        (candidate) => candidate.id === reserve.coinId && candidate.type === "wrapper",
      );
      const wrapper: DependencyWeight = { id: reserve.coinId, weight: 1, type: "wrapper" };
      if (existingIndex < 0) result.push(wrapper);
      else result[existingIndex] = wrapper;
    }
  }
  for (const dependency of meta.dependencies ?? []) {
    if ((dependency.type ?? "collateral") === "collateral") continue;
    if (meta.variantOf === dependency.id) continue;
    const existingIndex = result.findIndex(
      (candidate) => candidate.id === dependency.id && candidate.type === dependency.type,
    );
    // Explicit structural metadata is independent of reserve percentages.
    if (existingIndex < 0) result.push(dependency);
    else result[existingIndex] = dependency;
  }
  return result;
}

function resolveSource(
  baseSource: DependencyDerivationBaseSource,
  dependencies: readonly DependencyWeight[],
  variantOf?: string,
): DependencyDerivationSource {
  if (!variantOf) return baseSource;
  if (
    dependencies.some(
      (dependency) => dependency.id === variantOf && dependency.type === "wrapper",
    )
  ) {
    return "variant";
  }
  return baseSource;
}

/**
 * Derives dependency weights from curated reserve composition.
 * Reserve slices with `coinId` are converted to dependency entries, and
 * manual collateral weights remain the fallback when reserves have no links.
 * Manual structural relationships survive either composition source.
 */
export function deriveDependencies(
  meta: Pick<StablecoinMeta, "reserves" | "dependencies"> & Partial<Pick<StablecoinMeta, "id">>,
): DependencyWeight[] {
  const reserves = meta.reserves;
  if (!reserves?.length) return meta.dependencies ?? [];

  const reserveDependencies = aggregateReserveDependencies(reserves, meta.id);
  if (reserveDependencies.length === 0) return meta.dependencies ?? [];

  return injectStructuralDependencies(reserveDependencies, meta);
}

function deriveCuratedDependencySet(
  meta: Pick<StablecoinMeta, "variantOf" | "reserves" | "dependencies"> & Partial<Pick<StablecoinMeta, "id">>,
): DerivedDependencySet {
  const reserveDependencies = meta.reserves?.length
    ? aggregateReserveDependencies(meta.reserves, meta.id)
    : [];
  const manualDependencies = meta.dependencies ?? [];
  const baseDependencies = reserveDependencies.length > 0 ? reserveDependencies : manualDependencies;
  const baseSource: DependencyDerivationBaseSource = reserveDependencies.length > 0
    ? "curated-reserve"
    : manualDependencies.length > 0
      ? "manual"
      : "none";
  const dependencies = injectStructuralDependencies(baseDependencies, meta);

  return {
    dependencies,
    source: resolveSource(baseSource, dependencies, meta.variantOf),
    baseSource,
    dependencyFromLive: false,
    mappedLiveReserveWeight: null,
    fallbackReason: null,
    rejectionReasons: [],
  };
}

export function deriveEffectiveDependencySet(
  meta: Pick<StablecoinMeta, "variantOf" | "reserves" | "dependencies"> & Partial<Pick<StablecoinMeta, "id">>,
  options?: { liveReserveSlices?: readonly ReserveSlice[]; rejectionReasons?: readonly DependencyRejectionReason[] },
): DerivedDependencySet {
  if (Array.isArray(options?.liveReserveSlices)) {
    const liveDependencies = aggregateReserveDependencies(options.liveReserveSlices, meta.id);
    const mappedLiveReserveWeight = sumDependencyWeight(liveDependencies);
    const rejectionReasons = options.rejectionReasons
      ? [...options.rejectionReasons]
      : options.liveReserveSlices.flatMap((slice, sliceIndex) =>
          !slice.coinId || slice.coinId === meta.id ? [{ sliceIndex, reason: "no-match" as const }] : [],
        );

    // Select only reserve-derived weights here. Structural relationships are
    // applied afterward even when the live composition maps to no upstreams.
    const dependencies = injectStructuralDependencies(liveDependencies, meta);
    const baseSource: DependencyDerivationBaseSource = liveDependencies.length > 0
      ? "live-reserve"
      : "live-unmapped";

    return {
      dependencies,
      source: resolveSource(baseSource, dependencies, meta.variantOf),
      baseSource,
      dependencyFromLive: true,
      mappedLiveReserveWeight,
      fallbackReason: null,
      rejectionReasons,
    };
  }

  return deriveCuratedDependencySet(meta);
}

export function deriveEffectiveDependencies(
  meta: Pick<StablecoinMeta, "variantOf" | "reserves" | "dependencies"> & Partial<Pick<StablecoinMeta, "id">>,
  options?: { liveReserveSlices?: readonly ReserveSlice[] },
): DependencyWeight[] {
  return deriveEffectiveDependencySet(meta, options).dependencies;
}
