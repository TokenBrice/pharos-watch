import type { V9AssetFactsBase } from "@shared/types/safety-score-v9-facts";
import type { V9ResolvedUpstreamExposure } from "./backing";
import { canonicalDomains, uniqueSorted } from "./primitives";
import { canonicalizeV9PublicReasons } from "./reasons";
import type { V9PillarReason, V9ProductionScoreTrace } from "./score";
import type { V9ResolvedDependencyInputs } from "./dependencies";
import type { V9EvaluatedAsset } from "./evaluate-asset";

export function canonicalReasons(reasons: readonly V9PillarReason[]): V9PillarReason[] {
  return canonicalizeV9PublicReasons(reasons);
}

export function projectV9ResolvedBackingExposure(
  exposureKey: string,
  dependency: V9ResolvedDependencyInputs["basket"][number],
  upstream: Pick<V9EvaluatedAsset, "backing" | "scoreInput"> | undefined,
  failureRootAssetIds: readonly string[],
): V9ResolvedUpstreamExposure {
  const backingReasons = canonicalReasons(upstream?.scoreInput.pillars.backing.reasons ?? []);
  const reasons =
    backingReasons.length > 0 &&
    backingReasons.every((reason) => reason.responsibility !== undefined)
      ? backingReasons.map(({ code, path, responsibility }) => ({
          code,
          path,
          responsibility,
        }))
      : undefined;
  return {
    exposureKey,
    upstreamAssetId: dependency.upstreamAssetId,
    score: dependency.score,
    evidenceLevel: upstream?.scoreInput.pillars.backing.evidenceLevel ?? "insufficient",
    reasonCodes: uniqueSorted(backingReasons.map((reason) => reason.code)),
    ...(reasons === undefined ? {} : { reasons }),
    failureDomains: canonicalDomains(upstream?.backing.failureDomains ?? []),
    failureRootAssetIds: uniqueSorted(failureRootAssetIds),
  };
}

export function resolvedBackingExposures(
  asset: V9AssetFactsBase,
  dependencyInputs: V9ResolvedDependencyInputs,
  evaluatedById: ReadonlyMap<string, V9EvaluatedAsset>,
  unavailabilityRootsById: ReadonlyMap<string, readonly string[]>,
): V9ResolvedUpstreamExposure[] {
  const basketByUpstream = new Map(
    dependencyInputs.basket.map((dependency) => [dependency.upstreamAssetId, dependency]),
  );
  // The availability materiality decision lives in backing, which aggregates by
  // the propagated terminal failure roots (VER2-001) under the shared
  // materiality predicate (VER2-010). This projection only carries the roots
  // and evidence; it no longer emits an availability reason code.
  return asset.reserveExposures.flatMap((exposure) => {
    if (exposure.trackedAssetId === null) return [];
    const dependency = basketByUpstream.get(exposure.trackedAssetId);
    if (!dependency) return [];
    const upstream = evaluatedById.get(dependency.upstreamAssetId);
    const unavailable = dependency.score === null;
    const failureRootAssetIds = unavailable
      ? (unavailabilityRootsById.get(dependency.upstreamAssetId) ?? [dependency.upstreamAssetId])
      : [dependency.upstreamAssetId];
    return [projectV9ResolvedBackingExposure(exposure.exposureKey, dependency, upstream, failureRootAssetIds)];
  });
}

export function resolveUnavailabilityRoots(
  asset: Pick<V9AssetFactsBase, "assetId">,
  resolved: V9ResolvedDependencyInputs,
  trace: V9ProductionScoreTrace,
  unavailabilityRootsById: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const unavailableUpstreamRoots = uniqueSorted(
    [...resolved.basket, ...resolved.serial]
      .filter((dependency) => dependency.score === null)
      .flatMap(
        (dependency) => unavailabilityRootsById.get(dependency.upstreamAssetId) ?? [dependency.upstreamAssetId],
      ),
  );
  return trace.finalScore !== null || unavailableUpstreamRoots.length === 0
    ? [asset.assetId]
    : unavailableUpstreamRoots;
}
