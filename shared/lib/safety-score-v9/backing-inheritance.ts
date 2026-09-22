import type { V9ReserveExposureFactV2 } from "../../types/safety-score-v9-facts";
import { clampScore } from "../math";
import { decimalSnap } from "./formula";
import { resolveV9ReasonPolicy } from "./policy";
import { gapsForV9Ids, type V9GapIndex } from "./gap-index";
import { canonicalDomains, canonicalUniqueBy, compareText, uniqueSorted } from "./primitives";
import {
  backingPolicy,
  SCORE_EPSILON,
  type ReserveEvaluation,
  type V9BackingAssetInput,
  type V9BackingEvaluationPolicy,
  type V9InheritedStablecoinBacking,
} from "./backing-primitives";

/** Minimum mapped single-parent weight for a wrapper to qualify as ~100% backed. */
export const V9_WRAPPER_INHERITANCE_MIN_PARENT_WEIGHT = 0.99;
export function verifiedLiveInheritedExposure(
  asset: V9BackingAssetInput,
  inherited: V9InheritedStablecoinBacking,
): V9ReserveExposureFactV2 | undefined {
  if (
    asset.reserveStatus.applicability.state !== "required" ||
    asset.reserveStatus.observationState !== "known" ||
    asset.reserveExposures.length !== 1
  ) {
    return undefined;
  }
  const exposure = asset.reserveExposures[0]!;
  return exposure.provenance === "live" &&
    exposure.status.applicability.state === "required" &&
    exposure.status.observationState === "known" &&
    exposure.trackedAssetId === inherited.parentAssetId &&
    exposure.weight >= V9_WRAPPER_INHERITANCE_MIN_PARENT_WEIGHT
    ? exposure
    : undefined;
}

/**
 * Reserve evaluation for a stablecoin-collateralized wrapper: the whole reserve
 * is one tracked, rated parent, so the reserve score is the parent's backing
 * pillar. Wrapper-local accounting, control, and withdrawal risk belong in the
 * wrapper's own pillars; incomplete local review is handled once by the
 * fact-aware parent limit. Concentration is intentionally NOT re-penalized —
 * the parent's backing pillar already prices its own internal diversification.
 * Returns null (defer to the generic path) when the inherited quality does not
 * exceed the bounded-unknown floor: a weak parent is no evidence to credit above
 * the fail-closed baseline.
 */
export function inheritedStablecoinReserveEvaluation(
  asset: V9BackingAssetInput,
  inherited: V9InheritedStablecoinBacking,
  policy: V9BackingEvaluationPolicy,
  gapIndex: V9GapIndex,
): ReserveEvaluation | null {
  const backing = backingPolicy(policy);
  const weight = Math.max(0, Math.min(1, inherited.weight));
  const inheritedQuality = clampScore(inherited.parentBackingScore);
  // Any sub-1 residual stays at the fail-closed bounded-unknown quality.
  const score = clampScore(decimalSnap(inheritedQuality * weight + backing.boundedUnknownQuality * (1 - weight)));
  if (score <= backing.boundedUnknownQuality + SCORE_EPSILON) return null;
  const liveExposure = verifiedLiveInheritedExposure(asset, inherited);
  const evidenceRefIds = uniqueSorted([
    ...asset.reserveStatus.evidenceRefIds,
    ...(liveExposure?.status.evidenceRefIds ?? []),
  ]);
  const failureDomains = canonicalDomains(inherited.failureDomains);
  const componentKey = `reserve:inherited-backing:${inherited.parentAssetId}`;
  const observationState = liveExposure === undefined ? "bounded-unknown" : "known";
  const provenance = liveExposure?.provenance ?? null;
  const reserveGapAttributions = [
    ...canonicalUniqueBy(
      gapsForV9Ids(gapIndex, asset.reserveStatus.gapIds).flatMap((gap) =>
        "responsibility" in gap
          ? [{ causalKey: gap.gapId, responsibility: gap.responsibility }]
          : [],
      ),
      (attribution) => `${attribution.causalKey}\u0000${attribution.responsibility}`,
      (left, right) =>
        compareText(left.causalKey, right.causalKey) ||
        compareText(left.responsibility, right.responsibility),
      "last",
    ),
  ];
  return {
    score,
    contributions: [
      {
        componentKey,
        source: "reserve-exposure",
        score,
        normalizedWeight: 1,
        weightedScore: score,
        observationState,
        provenance,
        evidenceRefIds,
        failureDomains,
        upstreamAssetId: inherited.parentAssetId,
      },
      {
        componentKey: "reserve:concentration",
        source: "reserve-concentration",
        score,
        normalizedWeight: backing.reserve.concentrationWeight,
        weightedScore: score * backing.reserve.concentrationWeight,
        observationState,
        provenance,
        evidenceRefIds,
        failureDomains,
        upstreamAssetId: null,
      },
    ],
    structuralReasons: [],
    unresolved:
      liveExposure === undefined
        ? (reserveGapAttributions.length > 0
            ? reserveGapAttributions
            : [undefined]
          ).map((attribution) => ({
            code: "partial-reserve-review",
            pathKey: componentKey,
            gapIds: [],
            treatment: resolveV9ReasonPolicy(policy, "partial-reserve-review").reason.defaultTreatment,
            ...(attribution === undefined
              ? {}
              : {
                  responsibility: attribution.responsibility,
                  causalKey: attribution.causalKey,
                }),
          }))
        : [],
    rateability: "rateable",
  };
}
