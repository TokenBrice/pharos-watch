import type { DependencyWeight, ReserveSlice, StablecoinMeta } from "../types";
import type { ReserveIntermediary } from "../types/reserves";
import { DependencyTypeSchema } from "../types/dependency-types";

export type DependencyDerivationBaseSource =
  | "live-reserve"
  | "live-unmapped"
  | "curated-reserve"
  | "manual"
  | "none";

export type DependencyDerivationSource = DependencyDerivationBaseSource | "variant";

export type DependencyRejectionReason =
  | {
      sliceIndex: number;
      reason: "no-match" | "expired" | "non-link" | "coinId-without-depType" |
        "reviewed-dependency-type-conflict" | "reviewed-dependency-identity-conflict";
      upstreamAssetId?: string;
      reviewedUpstreamAssetId?: string;
    }
  | {
      sliceIndex: -1;
      reason: "manual-collateral-not-in-reserves";
      manualDependencyIndex: number;
      upstreamAssetId: string;
      share: number;
    };

export type DerivedDependency = DependencyWeight & { intermediary?: ReserveIntermediary };

class DependencyDerivationError extends Error {
  readonly code = "manual-collateral-not-in-reserves";
  constructor(readonly rejectionReasons: DependencyRejectionReason[]) {
    super("Manual collateral dependencies must be represented by linked reserve identities");
    this.name = "DependencyDerivationError";
  }
}

export interface DerivedDependencySet {
  dependencies: DerivedDependency[];
  source: DependencyDerivationSource;
  baseSource: DependencyDerivationBaseSource;
  dependencyFromLive: boolean;
  mappedLiveReserveWeight: number | null;
  fallbackReason: DependencyFallbackReason | null;
  rejectionReasons: DependencyRejectionReason[];
  coinIdWithoutDepTypeCount: number;
}

export type DependencyFallbackReason =
  | "live-unmapped-to-curated-reserve"
  | "live-unmapped-to-manual"
  | "live-cycle-to-curated";

function aggregateReserveDependencies(
  reserves: readonly ReserveSlice[],
  subjectId?: string,
): DerivedDependency[] {
  const linked = reserves.filter((reserve): reserve is ReserveSlice & { coinId: string } =>
    !!reserve.coinId && !!reserve.depType && reserve.pct > 0,
  );
  if (linked.length === 0) return [];

  const aggregated = new Map<string, DerivedDependency>();
  for (const reserve of linked) {
    if (reserve.coinId === subjectId) continue;
    const type = reserve.depType!;
    const key = `${reserve.coinId}::${type}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.weight += reserve.pct / 100;
      // One edge cannot claim a bridge/vault route for only part of its share.
      // Retain an annotation only when every merged slice has the same route.
      if (
        existing.intermediary?.kind !== reserve.intermediary?.kind ||
        existing.intermediary?.label !== reserve.intermediary?.label ||
        existing.intermediary?.chain !== reserve.intermediary?.chain ||
        existing.intermediary?.contract !== reserve.intermediary?.contract ||
        existing.intermediary?.verified !== reserve.intermediary?.verified ||
        existing.intermediary?.sourceUrl !== reserve.intermediary?.sourceUrl
      ) delete existing.intermediary;
      continue;
    }
    aggregated.set(key, {
      id: reserve.coinId, weight: reserve.pct / 100, type,
      ...(reserve.intermediary ? { intermediary: reserve.intermediary } : {}),
    });
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
  if (Math.abs(total - 1) <= 1e-12) return 1;
  return total;
}

function injectStructuralDependencies(
  dependencies: readonly DerivedDependency[],
  meta: Pick<StablecoinMeta, "variantOf" | "dependencies" | "reserves">,
): DerivedDependency[] {
  const variantReserveClaims = meta.variantOf
    ? (meta.reserves ?? []).filter((reserve) =>
        reserve.coinId === meta.variantOf && reserve.depType === "wrapper" && reserve.pct > 0,
      )
    : [];
  const variantIntermediary = variantReserveClaims.length === 1
    ? variantReserveClaims[0]!.intermediary
    : undefined;
  // A variant is a serial claim on its parent. Its reserve view may expose the
  // parent's backing, but those slices are not an additional parallel path.
  const result: DerivedDependency[] = meta.variantOf
    ? [{
        id: meta.variantOf, weight: 1, type: "wrapper",
        ...(variantIntermediary ? { intermediary: variantIntermediary } : {}),
      }]
    : [...dependencies];
  // Explicit wrapped-asset identities are serial claims, not basket weights.
  // A variant's reserve book is look-through backing, so its parent wins.
  if (!meta.variantOf) {
    for (const dependency of aggregateReserveDependencies(meta.reserves ?? [])) {
      if (dependency.type !== "wrapper") continue;
      const existingIndex = result.findIndex(
        (candidate) => candidate.id === dependency.id && candidate.type === "wrapper",
      );
      if (existingIndex < 0) result.push({ ...dependency, weight: 1 });
      else result[existingIndex] = { ...result[existingIndex], weight: 1 };
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

function mixedSourceRejections(
  dependencies: readonly DependencyWeight[],
  reserveDependencies: readonly DependencyWeight[],
): DependencyRejectionReason[] {
  if (reserveDependencies.length === 0) return [];
  const reserveIds = new Set(reserveDependencies.map((dependency) => dependency.id));
  return dependencies.flatMap((dependency, manualDependencyIndex) =>
    (dependency.type ?? "collateral") === "collateral" && !reserveIds.has(dependency.id)
      ? [{
          sliceIndex: -1 as const,
          reason: "manual-collateral-not-in-reserves" as const,
          manualDependencyIndex,
          upstreamAssetId: dependency.id,
          share: dependency.weight,
        }]
      : [],
  );
}
/**
 * Derives dependency weights from curated reserve composition.
 * Reserve slices with `coinId` are converted to dependency entries, and
 * manual collateral weights remain the fallback when reserves have no links.
 * Manual structural relationships survive either composition source.
 */
export function deriveDependencies(
  meta: Pick<StablecoinMeta, "reserves" | "dependencies"> & Partial<Pick<StablecoinMeta, "id">>,
): DerivedDependency[] {
  const reserves = meta.reserves;
  if (!reserves?.length) return meta.dependencies ?? [];

  const reserveDependencies = aggregateReserveDependencies(reserves, meta.id);
  if (reserveDependencies.length === 0) return meta.dependencies ?? [];
  const rejectionReasons = mixedSourceRejections(meta.dependencies ?? [], reserveDependencies);
  if (rejectionReasons.length > 0) throw new DependencyDerivationError(rejectionReasons);

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
    rejectionReasons: mixedSourceRejections(manualDependencies, reserveDependencies),
    coinIdWithoutDepTypeCount: (meta.reserves ?? []).filter((slice) => slice.coinId && !slice.depType).length,
  };
}

function reviewedTypeForLiveIdentity(
  slice: ReserveSlice,
  meta: Pick<StablecoinMeta, "reserves"> & Partial<Pick<StablecoinMeta, "liveReservesConfig">>,
): ReserveSlice["depType"] {
  const types = new Set<NonNullable<ReserveSlice["depType"]>>();
  for (const reviewed of meta.reserves ?? []) {
    if (reviewed.coinId === slice.coinId && reviewed.depType) types.add(reviewed.depType);
  }
  // Adapter identity declarations are authored evidence too. This covers
  // cached native rows whose current reserve sidecar no longer has that row.
  function collect(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if ("coinId" in value && value.coinId === slice.coinId && "depType" in value) {
      const parsed = DependencyTypeSchema.safeParse(value.depType);
      if (parsed.success) types.add(parsed.data);
    }
    for (const child of Object.values(value)) collect(child);
  }
  collect(meta.liveReservesConfig?.params);
  // Never choose between conflicting reviewed kinds.
  return types.size === 1 ? types.values().next().value : undefined;
}

export function deriveEffectiveDependencySet(
  meta: Pick<StablecoinMeta, "variantOf" | "reserves" | "dependencies"> & Partial<Pick<StablecoinMeta, "id" | "liveReservesConfig">>,
  options?: { liveReserveSlices?: readonly ReserveSlice[]; rejectionReasons?: readonly DependencyRejectionReason[] },
): DerivedDependencySet {
  if (Array.isArray(options?.liveReserveSlices)) {
    const liveSlices = options.liveReserveSlices.some((slice) => slice.coinId && !slice.depType)
      ? options.liveReserveSlices.map((slice) => {
          if (!slice.coinId || slice.depType) return slice;
          const depType = reviewedTypeForLiveIdentity(slice, meta);
          return depType ? { ...slice, depType } : slice;
        })
      : options.liveReserveSlices;
    const liveDependencies = aggregateReserveDependencies(liveSlices, meta.id);
    const mappedLiveReserveWeight = sumDependencyWeight(liveDependencies);
    const rejectionReasons: DependencyRejectionReason[] = options.rejectionReasons
      ? [...options.rejectionReasons]
      : options.liveReserveSlices.flatMap((slice, sliceIndex) =>
          !slice.coinId || slice.coinId === meta.id ? [{ sliceIndex, reason: "no-match" as const }] : [],
        );
    const missingTypes = liveSlices.flatMap((slice, sliceIndex) =>
      slice.coinId && !slice.depType
        ? [{ sliceIndex, reason: "coinId-without-depType" as const, upstreamAssetId: slice.coinId }]
        : [],
    );
    rejectionReasons.push(...missingTypes.filter((missing) => !rejectionReasons.some(
      (existing) => existing.sliceIndex === missing.sliceIndex && existing.reason === missing.reason,
    )));
    rejectionReasons.push(...mixedSourceRejections(meta.dependencies ?? [], liveDependencies));

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
      coinIdWithoutDepTypeCount: missingTypes.length,
    };
  }

  return deriveCuratedDependencySet(meta);
}

export function deriveEffectiveDependencies(
  meta: Pick<StablecoinMeta, "variantOf" | "reserves" | "dependencies"> & Partial<Pick<StablecoinMeta, "id" | "liveReservesConfig">>,
  options?: { liveReserveSlices?: readonly ReserveSlice[] },
): DerivedDependency[] {
  return deriveEffectiveDependencySet(meta, options).dependencies;
}
