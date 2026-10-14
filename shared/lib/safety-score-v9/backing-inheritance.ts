import type { V9ReserveExposureFactV2 } from "../../types/safety-score-v9-facts";
import { clampScore } from "../math";
import { decimalSnap } from "./formula";
import { evaluateV1019LenderBook, v1019LenderMarketQuality } from "./lender-book";
import { lenderMarketKey } from "./lender-book-registry";
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
export function verifiedLiveInheritedExposures(
  asset: Pick<V9BackingAssetInput, "reserveStatus" | "reserveExposures" | "reserveResiduals">,
  inherited: Pick<V9InheritedStablecoinBacking, "parentAssetId">,
  allowCompleteMultiSlice = false,
): readonly V9ReserveExposureFactV2[] | undefined {
  const exposures = asset.reserveExposures;
  if (
    asset.reserveStatus.applicability.state !== "required" ||
    asset.reserveStatus.observationState !== "known" ||
    exposures.length === 0 ||
    exposures.some(exposure =>
      exposure.provenance !== "live" ||
      exposure.status.applicability.state !== "required" ||
      exposure.status.observationState !== "known" ||
      exposure.trackedAssetId !== inherited.parentAssetId ||
      !Number.isFinite(exposure.weight) || exposure.weight < 0)
  ) return undefined;
  const weight = exposures.reduce((sum, exposure) => sum + exposure.weight, 0);
  if (exposures.length === 1) {
    return weight >= V9_WRAPPER_INHERITANCE_MIN_PARENT_WEIGHT ? exposures : undefined;
  }
  return allowCompleteMultiSlice &&
    Math.abs(weight - 1) <= SCORE_EPSILON &&
    (asset.reserveResiduals ?? []).every(residual => residual.weight === 0)
    ? exposures : undefined;
}

/**
 * Reserve evaluation for a stablecoin-collateralized wrapper: the whole reserve
 * is one tracked, rated parent, so the reserve score is the parent's backing
 * pillar. Wrapper-local accounting, control, and withdrawal risk belong in the
 * wrapper's own pillars; incomplete local review is handled once by the
 * fact-aware parent limit. Concentration is intentionally NOT re-penalized —
 * the parent's backing pillar already prices its own internal diversification.
 * Non-lender inheritance still defers to the generic path at the unknown floor.
 * An admitted lender book instead retains even a very weak inherited quality:
 * generic fallback must not erase the measured allocation haircut.
 */
export function inheritedStablecoinReserveEvaluation(
  asset: V9BackingAssetInput,
  inherited: V9InheritedStablecoinBacking,
  policy: V9BackingEvaluationPolicy,
  gapIndex: V9GapIndex,
): ReserveEvaluation | null {
  const backing = backingPolicy(policy);
  const weight = Math.max(0, Math.min(1, inherited.weight));
  const lenderEvaluation = asset.lenderBook === undefined || asset.lenderBook.observation?.assetId !== asset.assetId ? null
    : evaluateV1019LenderBook(asset.lenderBook, inherited.parentBackingScore, policy);
  const inheritedQuality = lenderEvaluation?.reserveQuality ?? clampScore(inherited.parentBackingScore);
  const liveExposures = verifiedLiveInheritedExposures(asset, inherited,
    backing.lenderCollateralBook.admittedAssets.some(row => row.assetId === asset.assetId));
  const evidenceRefIds = uniqueSorted([
    ...asset.reserveStatus.evidenceRefIds,
    ...(liveExposures?.flatMap(exposure => exposure.status.evidenceRefIds) ?? []),
    ...(asset.lenderBook?.status.evidenceRefIds ?? []),
  ]);
  const failureDomains = canonicalDomains(inherited.failureDomains);
  const componentKey = `reserve:inherited-backing:${inherited.parentAssetId}`;
  const observationState = liveExposures === undefined ? "bounded-unknown" : "known";
  const provenance = liveExposures === undefined ? null : "live";
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
  if (lenderEvaluation === null && score <= backing.boundedUnknownQuality + SCORE_EPSILON) return null;
  const lenderFactors: V9BackingFactorContribution[] = [];
  if (lenderEvaluation !== null && asset.lenderBook?.observation?.status === "ok") {
    const limiting = lenderEvaluation.deploymentQualities.find(row => row.reserveQuality === lenderEvaluation.reserveQuality)!;
    const deployment = asset.lenderBook.observation.deployments.find(row => `${row.chain}:${row.vault}` === limiting.deploymentKey)!;
    const total = Number(BigInt(deployment.realAssetsRaw ?? deployment.totalAssetsRaw));
    const idleWeight = Number(BigInt(deployment.idleAssetsRaw)) / total * weight;
    const parentCause = inherited.cause ?? null;
    const disposition = (factorCause: V9BackingFactorContribution["cause"]): V9BackingFactorContribution["scoringDisposition"] =>
      factorCause === "D" ? "measured-adverse" : factorCause === "C" || factorCause === "U" ? "bounded-uncertainty" : "included";
    lenderFactors.push({
      componentKey: `${componentKey}:lender-book:${limiting.deploymentKey}:idle`,
      score: inherited.parentBackingScore, normalizedWeight: idleWeight, effectiveScoringWeight: idleWeight / includedWeight,
      cause: parentCause, causeGapIds: inherited.causeGapIds ?? [], scoringDisposition: disposition(parentCause),
    });
    const collaterals = new Map(asset.lenderBook.collaterals.map(row => [row.marketKey, row]));
    for (const market of deployment.markets) {
      const marketKey = lenderMarketKey(deployment.chain, market.morpho, market.marketId, market.account);
      const collateral = collaterals.get(marketKey)!;
      const marketWeight = Number(BigInt(market.includedAssetsRaw)) / total * weight;
      const factorCause = parentCause === "D" || collateral.sourceCause === "D" ? "D"
        : parentCause === "C" || collateral.sourceCause === "C" ? "C"
        : parentCause === "U" || collateral.sourceCause === "U" ? "U" : null;
      const quality = v1019LenderMarketQuality(market, collateral.quality, backing.lenderCollateralBook.transmissionExponent);
      lenderFactors.push({
        componentKey: `${componentKey}:lender-book:${limiting.deploymentKey}:${marketKey}:${market.collateralToken}:${collateral.collateralClass}:${collateral.qualitySource}:${collateral.acceptedPublicationGenerationId ?? "class"}`,
        score: inherited.parentBackingScore * quality / 100,
        normalizedWeight: marketWeight, effectiveScoringWeight: marketWeight / includedWeight,
        cause: factorCause, causeGapIds: uniqueSorted([...(inherited.causeGapIds ?? []), ...collateral.sourceGapIds]),
        scoringDisposition: disposition(factorCause),
      });
    }
  } else if (asset.lenderBook !== undefined) {
    const gaps = gapsForV9Ids(gapIndex, asset.lenderBook.status.gapIds);
    const causes = gaps.map(gap => "causeProof" in gap ? gap.causeProof.cause : "U" as const);
    const diagnosticCause = causes.includes("A") ? "A" : causes.includes("B") ? "B"
      : asset.lenderBook.status.gapIds.length > 0 ? "U" : null;
    lenderFactors.push({
      componentKey: `${componentKey}:lender-book:unavailable`,
      score: null, normalizedWeight: 0, effectiveScoringWeight: 0, cause: diagnosticCause,
      causeGapIds: asset.lenderBook.status.gapIds,
      // No-attempt legacy U has no numeric book to price; it is not an A proof.
      scoringDisposition: diagnosticCause === "A" ? "excluded-pipeline" : diagnosticCause === "B" ? "excluded-uncurated" : "not-applicable",
    });
  }
  if (asset.lenderBook?.acceptedSourceStatus) {
    const status = asset.lenderBook.acceptedSourceStatus;
    const gaps = gapsForV9Ids(gapIndex, status.gapIds);
    const causes = gaps.map(gap => "causeProof" in gap ? gap.causeProof.cause : "U" as const);
    const diagnosticCause = causes.includes("A") ? "A" : causes.includes("B") ? "B" : status.gapIds.length > 0 ? "U" : null;
    lenderFactors.push({
      componentKey: `${componentKey}:lender-book:accepted-source`,
      score: null, normalizedWeight: 0, effectiveScoringWeight: 0, cause: diagnosticCause,
      causeGapIds: status.gapIds,
      scoringDisposition: diagnosticCause === "A" ? "excluded-pipeline" : diagnosticCause === "B" ? "excluded-uncurated" : "not-applicable",
    });
  }
  const contributingLenderFactors = lenderFactors.filter(factor => factor.effectiveScoringWeight > 0);
  const cause = inherited.cause === "D" || contributingLenderFactors.some(factor => factor.cause === "D") ? "D"
    : localBoundedCause ?? inherited.cause ?? contributingLenderFactors.find(factor => factor.cause === "C")?.cause
      ?? contributingLenderFactors.find(factor => factor.cause === "U")?.cause
      ?? residualFactors.find((factor) => factor.cause === "C" || factor.cause === "U")?.cause ?? null;
  const causeGapIds = uniqueSorted([
    ...(inherited.causeGapIds ?? []),
    ...reserveGapAttributions.filter((item) => item.cause === "C" || item.cause === "U").flatMap((item) => item.causeGapIds),
    ...residualFactors.flatMap((factor) => factor.causeGapIds),
    ...lenderFactors.flatMap(factor => factor.causeGapIds),
  ]);
  const scoringDisposition = cause === "D" ? "measured-adverse" as const
    : cause === "C" || cause === "U" ? "bounded-uncertainty" as const : "included" as const;
  const parentFactors: V9BackingFactorContribution[] = lenderEvaluation === null ? [{
    componentKey, score: inheritedQuality, normalizedWeight: weight, effectiveScoringWeight: weight / includedWeight,
    cause: inherited.cause ?? null, causeGapIds: inherited.causeGapIds ?? [],
    scoringDisposition: inherited.cause === "D" ? "measured-adverse" as const : inherited.cause === "C" || inherited.cause === "U" ? "bounded-uncertainty" as const : "included" as const,
  }] : [];
  const factors = lenderFactors.length === 0 && residualFactors.length === 0 ? undefined : [
    ...parentFactors, ...lenderFactors,
    ...residualFactors.map((factor) => ({ ...factor, effectiveScoringWeight: factor.effectiveScoringWeight / includedWeight })),
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
      liveExposures === undefined
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
