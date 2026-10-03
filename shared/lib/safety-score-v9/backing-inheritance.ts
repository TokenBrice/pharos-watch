import type { V9ReserveExposureFactV2 } from "../../types/safety-score-v9-facts";
import { clampScore } from "../math";
import { decimalSnap } from "./formula";
import { resolveV9ReasonTreatment } from "./policy";
import { gapsForV9Ids, type V9GapIndex } from "./gap-index";
import { canonicalDomains, canonicalUniqueBy, compareText, uniqueSorted } from "./primitives";
import {
  backingPolicy,
  SCORE_EPSILON,
  type ReserveEvaluation,
  type V9BackingAssetInput,
  type V9BackingEvaluationPolicy,
  type V9BackingFactorContribution,
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
      gapsForV9Ids(gapIndex, asset.reserveStatus.gapIds).map((gap) => ({
        causalKey: gap.gapId,
        responsibility: "causeProof" in gap ? gap.responsibility : "unresearched" as const,
        cause: "causeProof" in gap ? gap.causeProof.cause : "U" as const,
        causeGapIds: [gap.gapId],
      })),
      (attribution) => `${attribution.causalKey}\u0000${attribution.responsibility}`,
      (left, right) =>
        compareText(left.causalKey, right.causalKey) ||
        compareText(left.responsibility, right.responsibility),
      "last",
    ),
  ];
  const localBoundedCause = reserveGapAttributions.find((item) => item.cause === "C")?.cause
    ?? reserveGapAttributions.find((item) => item.cause === "U")?.cause ?? null;
  const residuals = weight >= 1 ? [] : asset.reserveResiduals ?? [{
    residualId: "unidentified", weight: 1 - weight, status: asset.reserveStatus,
  }];
  const residualFactors = residuals.map((residual): V9BackingFactorContribution => {
    const gaps = gapsForV9Ids(gapIndex, residual.status.gapIds);
    const causes = gaps.map((gap) => "causeProof" in gap ? gap.causeProof.cause : "U" as const);
    const cause = causes.includes("C") ? "C" : causes.includes("U") ? "U" : causes.includes("A") ? "A" : causes.includes("B") ? "B" : null;
    return {
      componentKey: `${componentKey}:residual:${residual.residualId}`,
      score: cause === "A" || cause === "B" ? null : backing.boundedUnknownQuality,
      normalizedWeight: residual.weight,
      effectiveScoringWeight: cause === "A" || cause === "B" ? 0 : residual.weight,
      cause,
      causeGapIds: gaps.map((gap) => gap.gapId).sort(compareText),
      scoringDisposition: cause === "A" ? "excluded-pipeline" as const : cause === "B" ? "excluded-uncurated" as const : cause === null ? "included" as const : "bounded-uncertainty" as const,
    };
  });
  const includedWeight = weight + residualFactors.reduce((sum, factor) => sum + factor.effectiveScoringWeight, 0);
  const score = clampScore(decimalSnap((inheritedQuality * weight +
    residualFactors.reduce((sum, factor) => sum + (factor.score ?? 0) * factor.effectiveScoringWeight, 0)) / includedWeight));
  if (score <= backing.boundedUnknownQuality + SCORE_EPSILON) return null;
  const cause = inherited.cause === "D" ? "D"
    : localBoundedCause ?? inherited.cause ?? residualFactors.find((factor) => factor.cause === "C" || factor.cause === "U")?.cause ?? null;
  const causeGapIds = uniqueSorted([
    ...(inherited.causeGapIds ?? []),
    ...reserveGapAttributions.filter((item) => item.cause === "C" || item.cause === "U").flatMap((item) => item.causeGapIds),
    ...residualFactors.flatMap((factor) => factor.causeGapIds),
  ]);
  const scoringDisposition = cause === "D" ? "measured-adverse" as const
    : cause === "C" || cause === "U" ? "bounded-uncertainty" as const : "included" as const;
  const factors = residualFactors.length === 0 ? undefined : [{
    componentKey, score: inheritedQuality, normalizedWeight: weight, effectiveScoringWeight: weight / includedWeight,
    cause: inherited.cause ?? null, causeGapIds: inherited.causeGapIds ?? [],
    scoringDisposition: inherited.cause === "D" ? "measured-adverse" as const : inherited.cause === "C" || inherited.cause === "U" ? "bounded-uncertainty" as const : "included" as const,
  }, ...residualFactors.map((factor) => ({ ...factor, effectiveScoringWeight: factor.effectiveScoringWeight / includedWeight }))];
  return {
    score,
    contributions: [
      {
        componentKey,
        source: "reserve-exposure",
        score,
        normalizedWeight: 1,
        weightedScore: score,
        cause, causeGapIds, scoringDisposition, factors,
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
        cause, causeGapIds, scoringDisposition, factors,
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
            treatment: resolveV9ReasonTreatment(policy, "partial-reserve-review", attribution?.cause ?? "U").treatment,
            ...(attribution === undefined
              ? {}
              : {
                  responsibility: attribution.responsibility,
                  causalKey: attribution.causalKey,
                  cause: attribution.cause,
                  causeGapIds: attribution.causeGapIds,
                }),
          }))
        : [],
    rateability: "rateable",
  };
}
