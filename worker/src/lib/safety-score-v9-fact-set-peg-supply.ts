import { resolveChainId } from "@shared/lib/chains";
import { isV9RepresentationGroupRoute } from "@shared/lib/safety-score-v9/facts";
import { deriveV9WindowedPegScore } from "@shared/lib/safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import {
  createV9EvidenceReference,
  createV9FactStatus,
  notApplicableV9Fact,
  requiredV9Applicability,
} from "@shared/lib/safety-score-v9/evidence";
import { compareText, domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { getCirculatingRaw } from "@shared/lib/supply";
import { SUPPLEMENTAL_RESTORE_MAX_AGE_SEC } from "../cron/sync-stablecoins/shared";
import type {
  V9AssetFactsV2,
  V9FactStatusV2,
} from "@shared/types/safety-score-v9-facts";
import {
  addEvidence,
  missingLocalFact,
  researchEvidence,
  stableFailureDomains,
  type AssetBuildContext,
} from "./safety-score-v9-fact-set-context";
import {
  safetyScoreV9ChainRows,
  safetyScoreV9ChainSupplyMaxAgeSec,
  safetyScoreV9ChainSupplyObservedAtSec,
} from "./safety-score-v9-supply-attribution";

export function deriveSafetyScoreV9PegScore(
  peg: { pegScore: number | null; activeDepeg: boolean; lastEventAt: number | null },
  clockSec: number,
): number | null {
  return deriveV9WindowedPegScore({
    pegScore: peg.pegScore,
    activeDepeg: peg.activeDepeg,
    lastEventAt: peg.lastEventAt,
    clockSec,
    windowSec: V9_CANDIDATE_POLICY_V1.policy.semantic.formula.pegHistoryWindowSec,
    quietHistoryFloor: V9_CANDIDATE_POLICY_V1.policy.semantic.formula.pegQuietHistoryFloor,
  });
}

export function buildPeg(context: AssetBuildContext): V9AssetFactsV2["peg"] {
  const peg = context.fixedInput.pegDataById[context.asset.assetId];
  const reference = context.asset.pegReference;
  const unresolvedReference =
    reference?.referenceKind === "other" && reference.referenceKey.startsWith("unresolved:peg-reference:");
  const pegReferenceMarker = ":peg-reference:";
  const pegReferenceMarkerIndex = reference?.referenceKey.lastIndexOf(pegReferenceMarker) ?? -1;
  const configuredReferenceId =
    !unresolvedReference && reference !== null && pegReferenceMarkerIndex >= 0
      ? reference.referenceKey.slice(pegReferenceMarkerIndex + pegReferenceMarker.length)
      : null;
  const source = context.extension.sources.peg;
  const pegKey = reference
    ? `peg:${reference.referenceKind}:${reference.referenceKey}`
    : `peg:unresolved:${context.asset.assetId}`;
  const activeDepegAssetId = configuredReferenceId ?? context.asset.assetId;
  const activeDepegBps = context.fixedInput.activeDepegPeakBpsById[activeDepegAssetId] ?? null;
  if (reference?.referenceKind === "nav" && configuredReferenceId !== null && activeDepegBps !== null) {
    const evidenceId = addEvidence(
      context,
      createV9EvidenceReference(
        {
          evidenceId: `${context.asset.assetId}:peg-reference-active-depeg`,
          sourceId: "report-cards-active-depeg-peak",
          sourceGenerationId: source.generationId,
          disposition: "observed",
          observedAtSec: source.observedAtSec,
          contentSha256: domainDigest("safety-score-v9.peg-reference-active-depeg.v1", {
            pegReferenceId: configuredReferenceId,
            activeDepegBps,
          }),
          maxAgeSec: source.maxAgeSec,
        },
        context.fixedInput.clockSec,
      ),
    );
    return {
      status: createV9FactStatus({
        applicability: requiredV9Applicability("v9.peg.current"),
        observationState: "known",
        evidenceRefIds: [evidenceId],
      }),
      pegKey,
      sourceGenerationId: source.generationId,
      referenceKind: reference.referenceKind,
      referenceKey: reference.referenceKey,
      methodologyVersion: context.fixedInput.methodologyVersion,
      // Part A carries only the inherited active-depeg peak. A neutral score
      // preserves the child's pre-existing peg multiplier; parent peg-score
      // inheritance is the separately reviewed Part B change.
      pegScore: 100,
      currentDeviationBps: 0,
      activeDepeg: true,
      activeDepegBps,
      trackingSpanDays: null,
      failureDomains: reference.failureDomains,
    };
  }
  if (reference?.referenceKind === "nav") {
    // Pure NAV tokens have no fixed peg by design (v8 pure NAV carve-over):
    // the peg fact is a known not-applicable review, and the formula skips
    // the peg multiplier for pegApplicable=false assets.
    return {
      status: createV9FactStatus({
        applicability: notApplicableV9Fact(
          "v9.peg.current",
          "Pure NAV token: the unit tracks fund NAV by design, so no fixed peg reference exists to deviate from.",
        ),
        observationState: "known",
        evidenceRefIds: [researchEvidence(context)],
      }),
      pegKey,
      sourceGenerationId: source.generationId,
      referenceKind: reference.referenceKind,
      referenceKey: reference.referenceKey,
      methodologyVersion: context.fixedInput.methodologyVersion,
      pegScore: null,
      currentDeviationBps: null,
      activeDepeg: null,
      activeDepegBps: null,
      trackingSpanDays: null,
      failureDomains: reference.failureDomains,
    };
  }
  if (!peg) {
    return {
      status: missingLocalFact(context, {
        componentKey: "peg",
        reasonCode: "missing-peg-input",
        ownerDomain: "peg",
        responsibility: "producer-failed",
        policyRuleId: "v9.peg.current",
        message: "No peg fact exists for the asset in the exact fixed input.",
      }).status,
      pegKey,
      sourceGenerationId: source.generationId,
      referenceKind: reference?.referenceKind ?? "other",
      referenceKey: reference?.referenceKey ?? `unresolved:${context.asset.assetId}`,
      methodologyVersion: context.fixedInput.methodologyVersion,
      pegScore: null,
      currentDeviationBps: null,
      activeDepeg: null,
      activeDepegBps: null,
      trackingSpanDays: null,
      failureDomains: reference?.failureDomains ?? [],
    };
  }
  const observedAtSec = peg.priceObservedAt ?? source.observedAtSec;
  const evidenceId = addEvidence(
    context,
    createV9EvidenceReference(
      {
        evidenceId: `${context.asset.assetId}:peg`,
        sourceId: peg.priceSource ?? "report-cards-peg-summary",
        sourceGenerationId: source.generationId,
        disposition: "observed",
        observedAtSec,
        contentSha256: domainDigest("safety-score-v9.peg-fact.v1", peg),
        maxAgeSec: source.maxAgeSec,
      },
      context.fixedInput.clockSec,
    ),
  );
  const evidence = context.evidence.get(evidenceId)!;
  const activeDepeg = configuredReferenceId === null ? peg.activeDepeg : activeDepegBps !== null;
  const pegScore = deriveSafetyScoreV9PegScore(peg, context.fixedInput.clockSec);
  const quietPegObservation =
    reference !== null &&
    !unresolvedReference &&
    pegScore !== null &&
    peg.currentDeviationBps === null &&
    activeDepeg === false &&
    peg.eventCount === 0 &&
    peg.worstDeviationBps === null;
  const complete =
    reference !== null &&
    !unresolvedReference &&
    pegScore !== null &&
    (peg.currentDeviationBps !== null || quietPegObservation) &&
    (!activeDepeg || activeDepegBps !== null);
  const hasPartialActiveDepegEvidence =
    reference !== null &&
    !unresolvedReference &&
    pegScore !== null &&
    activeDepeg &&
    activeDepegBps !== null;
  // Owner ruling 2026-07-27: a deviation withheld solely by the $1M supply
  // floor is deliberate methodology (deviation fails closed on thin supply),
  // not a failed feed. The ceiling treatment is byte-identical to
  // missing-peg-input (same peg-unverified named cap), so only the public
  // classification changes: measured-structural instead of missing data.
  const supplyFloorWithheld =
    reference !== null &&
    !unresolvedReference &&
    pegScore !== null &&
    peg.currentDeviationBps === null &&
    peg.depegEventCoverageLimited === true &&
    !activeDepeg;
  // Owner ruling 2026-07-29 (P4, nxusd-nereus): when the producer reports that
  // no usable price observation exists AND the asset's tracked record already
  // holds adverse peg evidence, the null deviation is neither a feed failure
  // nor a quiet observation - it is unobservable, and the only thing Pharos has
  // measured about this peg is adverse. The deviation is still never coerced to
  // zero: a clean record with no usable price stays on the quiet path, and the
  // DEX quote is never admitted as a price source.
  const priceUnavailableWithAdverseRecord =
    reference !== null &&
    !unresolvedReference &&
    pegScore !== null &&
    peg.currentDeviationBps === null &&
    peg.currentPriceUnavailable === true &&
    (activeDepeg || peg.eventCount > 0 || peg.worstDeviationBps !== null);
  let status: V9FactStatusV2;
  if (evidence.freshness.state === "stale") {
    status = missingLocalFact(context, {
      componentKey: "peg",
      reasonCode: "missing-peg-input",
      ownerDomain: "peg",
      responsibility: "producer-failed",
      policyRuleId: "v9.peg.current",
      message: "The last-known peg observation is stale.",
      observationState: "stale",
      evidenceRefIds: [evidenceId],
    }).status;
  } else if (!complete) {
    status = missingLocalFact(context, {
      componentKey: "peg",
      reasonCode:
        reference === null || unresolvedReference
          ? "missing-applicable-peg"
          : supplyFloorWithheld
            ? "peg-supply-floor-withheld"
            : priceUnavailableWithAdverseRecord
              ? "peg-price-unavailable-adverse-history"
              : "missing-peg-input",
      ownerDomain: "peg",
      responsibility:
        reference === null || unresolvedReference
          ? "integration-missing"
          : supplyFloorWithheld || priceUnavailableWithAdverseRecord
            ? "measured-adverse"
            : "producer-failed",
      policyRuleId: "v9.peg.current",
      message: supplyFloorWithheld
        ? "Peg deviation is withheld by the $1M supply floor: below it, deviation fails closed by methodology design."
        : priceUnavailableWithAdverseRecord
          ? "No usable price observation exists for this asset and its tracked peg record is adverse, so the current deviation is unobservable rather than at peg."
          : unresolvedReference
            ? `The configured peg reference ${reference?.referenceKey ?? "unknown"} could not be resolved; child peg metrics are withheld.`
            : "The peg row lacks an explicit reference, score, deviation, or active-depeg peak.",
      observationState: "bounded-unknown",
      evidenceRefIds: [evidenceId],
    }).status;
  } else {
    status = createV9FactStatus({
      applicability: requiredV9Applicability("v9.peg.current"),
      observationState: "known",
      evidenceRefIds: [evidenceId],
    });
  }
  return {
    status,
    pegKey,
    sourceGenerationId: source.generationId,
    referenceKind: reference?.referenceKind ?? "other",
    referenceKey: reference?.referenceKey ?? `unresolved:${context.asset.assetId}`,
    methodologyVersion: peg.methodologyVersion,
    pegScore: complete || hasPartialActiveDepegEvidence ? pegScore : null,
    // The v8 peg summary reports signed deviation; the v9 peg fact carries the
    // magnitude per its nonnegative schema contract.
    currentDeviationBps: complete ? Math.abs(peg.currentDeviationBps ?? 0) : null,
    activeDepeg: complete ? activeDepeg : hasPartialActiveDepegEvidence ? true : null,
    activeDepegBps: (complete && activeDepeg) || hasPartialActiveDepegEvidence ? activeDepegBps : null,
    trackingSpanDays: peg.trackingSpanDays,
    failureDomains: reference?.failureDomains ?? [],
  };
}

/**
 * Supply fact for assets that carry no usable per-chain circulating breakdown.
 * The supplemental/fallback intake lanes (coingecko-fallback,
 * onchain-total-supply, zephyr-scanner) populate only the top-level circulating
 * bucket, so reading the per-chain map alone discards a real, already
 * USD-denominated figure.
 *
 * Per-chain attribution normally does not exist for these assets, so
 * `chainDistribution` stays empty rather than being synthesized. A narrowly
 * admitted exact raw-unit partition may still carry reviewed bridge-route USD
 * shares; it does not claim a provider-sourced chain distribution.
 */
function buildAggregateSupply(context: AssetBuildContext): V9AssetFactsV2["supply"] {
  const source = context.extension.sources.chainSupply;
  const aggregate = context.fixedInput.aggregateCirculatingById[context.asset.assetId];
  // DefiLlama list circulating values are already USD-denominated across all peg
  // types, so this is a plain sum — never a price multiplication.
  const circulatingUsd = aggregate ? getCirculatingRaw(aggregate) : 0;
  if (circulatingUsd <= 0) {
    return {
      status: missingLocalFact(context, {
        componentKey: "chain-supply",
        reasonCode: "missing-pillar-evidence",
        ownerDomain: "evidence",
        responsibility: "producer-failed",
        policyRuleId: "v9.supply.current",
        message: "No USD-denominated chain circulating rows are present in the exact fixed input.",
      }).status,
      sourceGenerationId: source.generationId,
      sourceKind: "usd-denominated-circulating",
      circulatingUnits: null,
      referencePriceUsd: null,
      circulatingUsd: null,
      chainDistribution: null,
      selectedBridgeRoutes: [],
      selectedRouteSupplyShare: null,
      unknownRouteSupplyShare: null,
      unreviewedRouteSupplyShare: null,
      failureDomains: [],
    };
  }
  // Supplemental supply is carried forward run-over-run and preserves its
  // original observation time, so it ages independently of the chain-supply
  // lane. It therefore takes the intake lane's own 7-day carry-forward ceiling
  // rather than the per-chain lane's ~30-minute cron freshness, which would
  // stale out every legitimately carried-forward asset. Where the intake lane
  // records no observation time there is nothing to age against, so the fact
  // falls back to the capture's own observation time.
  const observedAtSec = aggregate?.observedAtSec ?? source.observedAtSec;
  const evidenceId = addEvidence(
    context,
    createV9EvidenceReference(
      {
        evidenceId: `${context.asset.assetId}:aggregate-supply`,
        sourceId: "report-cards-aggregate-circulating",
        sourceGenerationId: source.generationId,
        disposition: "observed",
        observedAtSec,
        contentSha256: domainDigest("safety-score-v9.aggregate-supply.v1", aggregate),
        maxAgeSec: SUPPLEMENTAL_RESTORE_MAX_AGE_SEC,
      },
      context.fixedInput.clockSec,
    ),
  );
  const evidence = context.evidence.get(evidenceId)!;
  // Aggregate-only supply may carry the legacy "unknown=1, no rows" review
  // sentinel. It is not a route partition and must remain omitted. Only an
  // explicit non-empty exact partition can enrich this fact shape.
  const review = context.asset.supplyReview?.selectedBridgeRoutes.length
    ? context.asset.supplyReview
    : null;
  if (review !== null) {
    assertSupplyReviewSharesReconcile(context.asset.assetId, circulatingUsd, review);
    const routeSupplyUsd = review.selectedBridgeRoutes.reduce((sum, route) => sum + route.supplyUsd, 0);
    const toleranceUsd = Math.max(0.000001, circulatingUsd * 1e-12);
    if (Math.abs(routeSupplyUsd - circulatingUsd) > toleranceUsd) {
      throw new Error(
        `Aggregate bridge supply rows do not conserve for ${context.asset.assetId}: ` +
          `route rows sum to ${routeSupplyUsd} over ${circulatingUsd} circulating USD`,
      );
    }
  }
  const status =
    evidence.freshness.state === "stale"
      ? missingLocalFact(context, {
          componentKey: "chain-supply",
          reasonCode: "missing-pillar-evidence",
          ownerDomain: "evidence",
          responsibility: "producer-failed",
          policyRuleId: "v9.supply.current",
          message: "The aggregate circulating observation is past the supplemental carry-forward ceiling.",
          observationState: "stale",
          evidenceRefIds: [evidenceId],
        }).status
      : createV9FactStatus({
          applicability: requiredV9Applicability("v9.supply.current"),
          observationState: "known",
          evidenceRefIds: [evidenceId],
        });
  return {
    status,
    sourceGenerationId: source.generationId,
    sourceKind: "aggregate-circulating",
    circulatingUnits: null,
    referencePriceUsd: null,
    circulatingUsd,
    chainDistribution: null,
    selectedBridgeRoutes: review?.selectedBridgeRoutes ?? [],
    selectedRouteSupplyShare: review?.selectedRouteSupplyShare ?? null,
    unknownRouteSupplyShare: review?.unknownRouteSupplyShare ?? null,
    unreviewedRouteSupplyShare: review?.unreviewedRouteSupplyShare ?? null,
    failureDomains: stableFailureDomains(review?.failureDomains ?? []),
  };
}

function assertSupplyReviewSharesReconcile(
  assetId: string,
  circulatingUsd: number,
  review: NonNullable<AssetBuildContext["asset"]["supplyReview"]>,
): void {
  const shareSum =
    (review.selectedRouteSupplyShare ?? 0) +
    (review.unreviewedRouteSupplyShare ?? 0) +
    (review.unknownRouteSupplyShare ?? 0);
  const rowShareSum = review.selectedBridgeRoutes.reduce((sum, route) => sum + route.supplyShare, 0);
  const reviewedRowShare = review.selectedBridgeRoutes.reduce(
    (sum, route) => sum + (route.reviewState === "selected-reviewed" ? route.supplyShare : 0),
    0,
  );
  const unresolvedRowShare = review.selectedBridgeRoutes.reduce(
    (sum, route) => sum + (route.reviewState === "selected-unresolved" ? route.supplyShare : 0),
    0,
  );
  const unmatchedRowShare = review.selectedBridgeRoutes.reduce(
    (sum, route) => sum + (route.reviewState === "unmatched" ? route.supplyShare : 0),
    0,
  );
  const carriesExplicitUnmatchedRows = review.selectedBridgeRoutes.some((route) => route.reviewState === "unmatched");
  if (circulatingUsd > 0 && Math.abs(shareSum - 1) > 0.000001) {
    throw new Error(
      `Bridge supply shares do not reconcile for ${assetId}: ` +
        `selected+unreviewed+unknown=${shareSum} must conserve to 1 over positive circulating supply`,
    );
  }
  const expectedRowShare = carriesExplicitUnmatchedRows
    ? shareSum
    : (review.selectedRouteSupplyShare ?? 0) + (review.unreviewedRouteSupplyShare ?? 0);
  if (circulatingUsd > 0 && Math.abs(rowShareSum - expectedRowShare) > 0.000001) {
    throw new Error(
      `Bridge supply rows do not reconcile for ${assetId}: ` +
        `route rows sum to ${rowShareSum} but the represented aggregate claims ${expectedRowShare}`,
    );
  }
  const categoryClaims: Array<readonly [string, number, number]> = [
    ["reviewed", reviewedRowShare, review.selectedRouteSupplyShare ?? 0],
    ["unresolved", unresolvedRowShare, review.unreviewedRouteSupplyShare ?? 0],
  ];
  if (carriesExplicitUnmatchedRows) {
    categoryClaims.push(["unmatched", unmatchedRowShare, review.unknownRouteSupplyShare ?? 0]);
  }
  for (const [label, rowShare, claimedShare] of categoryClaims) {
    if (circulatingUsd > 0 && Math.abs(rowShare - claimedShare) > 0.000001) {
      throw new Error(
        `Bridge supply ${label} rows do not reconcile for ${assetId}: ` +
          `rows sum to ${rowShare} but the aggregate claims ${claimedShare}`,
      );
    }
  }
}

export function buildSupply(context: AssetBuildContext): V9AssetFactsV2["supply"] {
  const source = context.extension.sources.chainSupply;
  const v9Attribution =
    context.fixedInput.safetyScoreV9SupplyAttributionById[context.asset.assetId];
  const chainRows = safetyScoreV9ChainRows(context.fixedInput, context.asset.assetId);
  const chains = Object.keys(chainRows).sort(compareText);
  const circulatingUsd = chains.reduce((sum, chain) => sum + chainRows[chain]!.current, 0);
  // A per-chain map that is present but sums to zero carries no more supply
  // information than an absent one, and the aggregate bucket may still hold a
  // real figure. Both cases route to the aggregate fallback; a zero-summing map
  // would otherwise produce a zero-denominator distribution and leave assets
  // like a7a5-old-vector unobserved despite a published circulating supply.
  if (chains.length === 0 || circulatingUsd <= 0) {
    return buildAggregateSupply(context);
  }
  const evidenceId = addEvidence(
    context,
    createV9EvidenceReference(
      {
        evidenceId: `${context.asset.assetId}:chain-supply`,
        sourceId:
          v9Attribution === undefined
            ? "report-cards-chain-circulating"
            : v9Attribution.model === "canonical-lock-mint-partition-v1" ||
                v9Attribution.model ===
                  "canonical-lock-mint-group-partition-v2"
              ? "safety-score-v9-lock-mint-attribution"
              : "safety-score-v9-reviewed-deployment-attribution",
        sourceGenerationId: source.generationId,
        disposition: "observed",
        observedAtSec: safetyScoreV9ChainSupplyObservedAtSec(
          context.fixedInput,
          context.asset.assetId,
          source.observedAtSec,
        ),
        contentSha256: domainDigest("safety-score-v9.chain-supply.v1", chainRows),
        maxAgeSec: safetyScoreV9ChainSupplyMaxAgeSec(
          context.fixedInput,
          context.asset.assetId,
          source.maxAgeSec,
        ),
      },
      context.fixedInput.clockSec,
    ),
  );
  const evidence = context.evidence.get(evidenceId)!;
  const review = context.asset.supplyReview;
  const supplyByChainId = new Map<string, number>();
  let unattributedSupplyUsd = 0;
  for (const chain of chains) {
    const supplyUsd = chainRows[chain]!.current;
    const chainId = resolveChainId(chain);
    if (chainId === null) {
      unattributedSupplyUsd += supplyUsd;
      continue;
    }
    supplyByChainId.set(chainId, (supplyByChainId.get(chainId) ?? 0) + supplyUsd);
  }
  const chainDistribution = {
    chains: [...supplyByChainId.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([chainId, supplyUsd]) => ({
        chainId,
        supplyUsd,
        supplyShare: circulatingUsd > 0 ? supplyUsd / circulatingUsd : 0,
      })),
    unattributedSupplyUsd,
    unattributedSupplyShare: circulatingUsd > 0 ? unattributedSupplyUsd / circulatingUsd : 0,
  };
  let status: V9FactStatusV2;
  if (evidence.freshness.state === "stale") {
    status = missingLocalFact(context, {
      componentKey: "chain-supply",
      reasonCode: "missing-pillar-evidence",
      ownerDomain: "evidence",
      responsibility: "producer-failed",
      policyRuleId: "v9.supply.current",
      message: "The chain supply observation is stale.",
      observationState: "stale",
      evidenceRefIds: [evidenceId],
    }).status;
  } else if (review === null) {
    status = missingLocalFact(context, {
      componentKey: "bridge-materiality",
      reasonCode: "runtime-bridge-materiality-unavailable",
      ownerDomain: "control",
      responsibility: "integration-missing",
      policyRuleId: "v9.supply.bridge-materiality",
      message: "Circulating USD is known, but bridge-route materiality has not been reviewed.",
      observationState: "bounded-unknown",
      evidenceRefIds: [evidenceId],
    }).status;
  } else {
    // A known supply fact asserts the route-review accounting covers the whole
    // circulating base: reviewed-selected + selected-unresolved + unknown must
    // conserve to 1, and the selected rows must reconcile to those shares.
    // Accepting under-accounted shares silently suppresses the
    // material-bridge-supply-unmatched control reason (VER-007).
    assertSupplyReviewSharesReconcile(context.asset.assetId, circulatingUsd, review);
    status = createV9FactStatus({
      applicability: requiredV9Applicability("v9.supply.current"),
      observationState: "known",
      evidenceRefIds: [evidenceId],
    });
  }
  return {
    status,
    sourceGenerationId: source.generationId,
    sourceKind: "usd-denominated-circulating",
    circulatingUnits: null,
    referencePriceUsd: null,
    circulatingUsd,
    chainDistribution,
    selectedBridgeRoutes: review?.selectedBridgeRoutes ?? [],
    selectedRouteSupplyShare: review?.selectedRouteSupplyShare ?? null,
    unknownRouteSupplyShare: review?.unknownRouteSupplyShare ?? null,
    unreviewedRouteSupplyShare: review?.unreviewedRouteSupplyShare ?? null,
    failureDomains: stableFailureDomains([
      ...chains.flatMap((chain) =>
        isV9RepresentationGroupRoute(chain)
          ? []
          : [{
              kind: "chain" as const,
              key: resolveChainId(chain) ?? chain.toLowerCase(),
            }],
      ),
      ...(review?.failureDomains ?? []),
    ]),
  };
}
