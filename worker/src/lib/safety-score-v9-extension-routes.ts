import { resolvedExitRouteOutputAssetKeys } from "@shared/lib/exit-route-output";
import { isDexExitRouteCoverageComplete } from "@shared/lib/p4-exit-route-capacity";
import {
  getRedemptionBackstopConfig,
  resolveMoreConservativeRedemptionSettlement,
  resolveV9RedemptionRouteCostBpsAtNotional,
  type RedemptionBackstopConfig,
} from "@shared/lib/redemption-backstops";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import type { ExitRouteObservation } from "@shared/types/exit-route";
import {
  DEX_MEASURED_FRESHNESS_MAX_SEC,
  isDexMeasuredExecutionObservationHistoryMature,
} from "@shared/types/measured-execution";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import {
  deriveSupplyModelExitRouteObservation,
  REDEMPTION_SETTLEMENT_HORIZON_CEILING_SEC,
} from "./redemption-exit-route-observations";
import type { SafetyScoreV9FactSetExtensionV2 } from "./safety-score-v9-fact-set";
import type { ReportCardsFixedInput } from "./report-cards-fixed-input";

type ExtensionAsset = SafetyScoreV9FactSetExtensionV2["assets"][number];
type RetainedRoute = ExtensionAsset["retainedRoutes"][number];
type RouteReview = ExtensionAsset["routeReviews"][number];
type RouteOutputReview = NonNullable<RouteReview["output"]>;
type RouteValuation = NonNullable<RouteOutputReview["valuation"]>;
type RedemptionSettlementModel = RedemptionBackstopConfig["settlementModel"];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function capacityPoints(observation: ExitRouteObservation): RouteReview["executionCosts"] {
  const points = observation.capacityCurve ?? [
    {
      requestedNotionalUsd: observation.requestedNotionalUsd,
      maxCostBps: observation.maxCostBps,
      executableUsd: observation.executableUsd,
      completionRatio: observation.completionRatio,
    },
  ];
  // New measured points retain the defining quote's realized cost. Legacy
  // points omit it and keep the prior conservative request-bound behavior.
  return points
    .map((point) => ({
      requestedNotionalUsd: point.requestedNotionalUsd,
      maxCostBps: point.maxCostBps,
      executionCostBps: point.executionCostBps ?? point.maxCostBps,
    }))
    .sort((left, right) =>
      compareText(
        `${left.maxCostBps}:${left.requestedNotionalUsd}`,
        `${right.maxCostBps}:${right.requestedNotionalUsd}`,
      ),
    );
}

function trackedStablecoinValuation(
  fixedInput: Readonly<ReportCardsFixedInput>,
  trackedAssetId: string,
  observedAtSec: number,
): Pick<
  RouteValuation,
  "basis" | "unitValueUsd" | "expectedUnitValueUsd" | "confidence" | "observedAtSec" | "sourceId"
> | null {
  const peg = fixedInput.pegDataById[trackedAssetId];
  if (peg?.currentDeviationBps !== null && peg?.currentDeviationBps !== undefined) {
    const unitValueUsd = 1 + peg.currentDeviationBps / 10_000;
    if (!Number.isFinite(unitValueUsd) || unitValueUsd <= 0) return null;
    return {
      basis: "price",
      unitValueUsd,
      expectedUnitValueUsd: 1,
      confidence: "medium",
      observedAtSec: Math.min(peg.priceObservedAt ?? observedAtSec, observedAtSec),
      sourceId: "report-cards-peg-summary",
    };
  }

  const navPrice = fixedInput.navPriceById?.[trackedAssetId];
  if (!navPrice) return null;
  return {
    basis: "nav",
    unitValueUsd: navPrice.priceUsd,
    // A NAV product has no $1 fixed-peg expectation. Its own observed NAV is
    // both the current and expected output value, so this does not create a
    // synthetic depeg signal.
    expectedUnitValueUsd: navPrice.priceUsd,
    confidence: navPrice.confidence,
    observedAtSec: Math.min(navPrice.observedAtSec, observedAtSec),
    sourceId: navPrice.sourceId,
  };
}

function buildOutputReview(
  fixedInput: Readonly<ReportCardsFixedInput>,
  observation: ExitRouteObservation,
  sourceGenerationId: string,
): RouteOutputReview | null {
  const output = observation.output;
  if (output.kind !== "tracked-stablecoin" && output.kind !== "fiat" && output.kind !== "collateral") return null;
  // Collateral outputs without enumerated asset keys are still USD-normalized
  // by the producer at observation time, so they take the same reviewed par
  // valuation as the enumerated collateral branch under a generic key.
  const assetKeys =
    resolvedExitRouteOutputAssetKeys(output) ?? (output.kind === "collateral" ? ["collateral:mixed"] : null);
  if (assetKeys === null) return null;
  const observedAtSec = Math.min(observation.observedAt, fixedInput.clockSec);
  const shared = {
    sourceGenerationId,
    // Route output valuations are review-cadence evidence: they share the D11
    // 365-day window with the reviewed research classes, and the fact-set
    // already degrades a stale valuation to a stale output fact.
    maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC,
    url: null,
    contentSha256: null,
  } as const;
  let valuation: RouteValuation | null = null;
  if (output.kind === "fiat") {
    valuation = {
      basis: "reviewed-par",
      referenceAssetKey: assetKeys[0]!,
      unitValueUsd: 1,
      expectedUnitValueUsd: 1,
      sourceId: "safety-score-v9-extension-fiat-par",
      observedAtSec,
      confidence: "high",
      ...shared,
    };
  } else if (output.kind === "tracked-stablecoin" && assetKeys.length === 1) {
    const tracked =
      observation.outputUnitValueUsd !== undefined
        ? {
            basis: "price" as const,
            unitValueUsd: observation.outputUnitValueUsd,
            expectedUnitValueUsd: 1,
            confidence: "high" as const,
            observedAtSec,
            sourceId: "redemption-route-pinned-output-value",
          }
        : trackedStablecoinValuation(fixedInput, assetKeys[0]!, observedAtSec);
    if (tracked) {
      valuation = {
        referenceAssetKey: assetKeys[0]!,
        ...tracked,
        ...shared,
      };
    }
  } else if (output.kind === "tracked-stablecoin" && assetKeys.length > 1) {
    // A resolved stable basket values at the weakest component's observed
    // price — conservative without claiming basket weights. Every component
    // must carry a peg row; a partially-priced basket stays unresolved.
    const components = assetKeys.map((assetKey) => ({
      assetKey,
      tracked: trackedStablecoinValuation(fixedInput, assetKey, observedAtSec),
    }));
    if (components.every((component) => component.tracked !== null)) {
      const weakest = components.reduce((minimum, component) =>
        component.tracked!.unitValueUsd < minimum.tracked!.unitValueUsd ? component : minimum,
      );
      valuation = {
        referenceAssetKey: weakest.assetKey,
        ...weakest.tracked!,
        confidence: "medium",
        ...shared,
      };
    }
  } else if (output.kind === "collateral") {
    // The producer already values executable notional in USD at observation
    // time, so the collateral leg is USD-normalized with medium confidence.
    valuation = {
      basis: "price",
      referenceAssetKey: assetKeys[0]!,
      unitValueUsd: 1,
      expectedUnitValueUsd: 1,
      sourceId: "report-cards-dex-usd-normalized",
      observedAtSec,
      confidence: "medium",
      ...shared,
    };
  }
  return {
    kind: output.kind,
    assetKeys,
    basketWeights: [],
    valuation,
  };
}

function dexPhysicalResourceKeys(observation: ExitRouteObservation): string[] {
  const scope = observation.scope;
  if (scope.kind === "chain-contract") return [`pool:${scope.chain}:${scope.contractOrPoolId}`];
  if (scope.kind === "venue") return [`venue:${scope.venue}:${scope.protocol}`];
  if (scope.kind === "protocol") return [`protocol:${scope.protocol}${scope.chain ? `:${scope.chain}` : ""}`];
  return [`issuer:${scope.issuerId}`];
}

function dexCoverageClass(fixedInput: Readonly<ReportCardsFixedInput>, assetId: string): RouteReview["coverageClass"] {
  const coverage = fixedInput.dexLiqMap[assetId]?.exitRouteObservationCoverage;
  if (isDexExitRouteCoverageComplete(coverage)) {
    return "exact-complete";
  }
  return "exact-lower-bound";
}

function buildDexRouteReview(
  fixedInput: Readonly<ReportCardsFixedInput>,
  assetId: string,
  observation: ExitRouteObservation,
): RouteReview {
  const observationHistory = observation.observationHistory;
  const matureMeasuredHistory =
    observation.evidenceKind === "measured-executable-depth" &&
    observation.confidence === "high" &&
    isDexMeasuredExecutionObservationHistoryMature(observationHistory) &&
    observationHistory != null &&
    fixedInput.clockSec - observationHistory.observationWindowEndedAt <= DEX_MEASURED_FRESHNESS_MAX_SEC &&
    observationHistory.observationWindowEndedAt <= fixedInput.clockSec + 60;
  return {
    lane: "dex",
    routeId: observation.routeId,
    holderAccess: "permissionless",
    executionModel: "market-depth",
    executionCertainty: "bounded",
    // A realized quote is still a single-cycle observation until the producer
    // repeats it. Operational LKG preserves a mature history because only
    // successful complete cycles enter the conservative statistic.
    modelConfidence: matureMeasuredHistory ? "high" : "medium",
    coverageClass: dexCoverageClass(fixedInput, assetId),
    capacityScoringHorizon: "immediate",
    settlementModel: "atomic",
    settlementSlaSec: 0,
    queueDepthUsd: null,
    dailyLimitUsd: null,
    minRedeemUsd: null,
    physicalResourceKeys: dexPhysicalResourceKeys(observation),
    executionCosts: capacityPoints(observation),
    output: buildOutputReview(fixedInput, observation, fixedInput.dexGenerationId),
    failureDomains: [],
  };
}

function redemptionHolderAccess(entry: RedemptionBackstopEntry): RouteReview["holderAccess"] {
  if (entry.accessModel === "permissionless-onchain") return "permissionless";
  if (entry.accessModel === "whitelisted-onchain" || entry.holderEligibility === "whitelisted-primary") {
    return "allowlisted";
  }
  if (entry.accessModel === "issuer-api") {
    if (entry.holderEligibility === "any-holder") return "retail-open";
    if (entry.holderEligibility === "verified-customer") return "institutional-eligible";
    if (entry.holderEligibility === "issuer-discretionary") return "issuer-only";
    return "unknown";
  }
  if (entry.accessModel === "manual") return "issuer-only";
  return "unknown";
}

function redemptionExecutionModel(entry: RedemptionBackstopEntry): RouteReview["executionModel"] {
  if (entry.queueEnabled) return "queued";
  if (entry.executionModel === "deterministic-onchain" || entry.executionModel === "deterministic-basket") {
    return "deterministic";
  }
  if (entry.executionModel === "rules-based-nav") return "deterministic";
  if (entry.executionModel === "opaque") return "discretionary";
  return "unknown";
}

function redemptionExecutionCertainty(
  entry: RedemptionBackstopEntry,
  modelConfidence: RouteReview["modelConfidence"],
): RouteReview["executionCertainty"] {
  if (entry.executionModel === "opaque") return "discretionary";
  if (modelConfidence === "high") return "bounded";
  if (modelConfidence === "medium") return "conditional";
  return "discretionary";
}

function redemptionCoverageClass(
  entry: RedemptionBackstopEntry,
  observation: ExitRouteObservation,
): RouteReview["coverageClass"] {
  const requiresCurrentOpenAttribution =
    observation.scoreEligible &&
    entry.sourceMode === "dynamic" &&
    (entry.capacityKind === "live-direct" || entry.capacityKind === "live-direct-bounded") &&
    (entry.settlementModel === "atomic" || entry.settlementModel === "immediate");
  const hasCurrentOpenAttribution =
    entry.routeStatus === "open" &&
    (entry.routeStatusSource === "onchain" || entry.routeStatusSource === "protocol-api");
  return requiresCurrentOpenAttribution && !hasCurrentOpenAttribution ? "diagnostic" : "exact-lower-bound";
}

function redemptionReviewTerms(entry: RedemptionBackstopEntry): {
  settlementModel: RedemptionSettlementModel;
  settlementDelaySec: number | undefined;
  settlementHorizonSec: number;
  minRedeemUsd: number | null;
} {
  const reviewed = getRedemptionBackstopConfig(entry.stablecoinId)?.v9RouteReviewTerms;
  const settlementModel = reviewed?.settlementModel
    ? resolveMoreConservativeRedemptionSettlement(entry.settlementModel, reviewed.settlementModel)
    : entry.settlementModel;
  const settlementDelaySec =
    settlementModel === entry.settlementModel ? entry.settlementDelaySec : undefined;
  const minimums = [entry.minRedeemUsd, reviewed?.minRedeemUsd].filter(
    (value): value is number => value != null,
  );
  return {
    settlementModel,
    settlementDelaySec,
    settlementHorizonSec: Math.max(
      REDEMPTION_SETTLEMENT_HORIZON_CEILING_SEC[settlementModel],
      settlementDelaySec ?? 0,
    ),
    minRedeemUsd: minimums.length > 0 ? Math.max(...minimums) : null,
  };
}

function redemptionSettlement(
  settlementModel: RedemptionSettlementModel,
  settlementDelaySec: number | undefined,
): {
  settlementModel: RouteReview["settlementModel"];
  settlementSlaSec: number | null;
} {
  switch (settlementModel) {
    case "atomic":
      return { settlementModel: "atomic", settlementSlaSec: settlementDelaySec ?? 0 };
    case "immediate":
      return { settlementModel: "bounded-delay", settlementSlaSec: settlementDelaySec ?? 3_600 };
    case "same-day":
      return { settlementModel: "same-day", settlementSlaSec: settlementDelaySec ?? 86_400 };
    case "days":
      return { settlementModel: "bounded-delay", settlementSlaSec: settlementDelaySec ?? null };
    case "queued":
      return { settlementModel: "queued", settlementSlaSec: settlementDelaySec ?? null };
  }
}

function redemptionExecutionCosts(
  entry: RedemptionBackstopEntry,
  observation: ExitRouteObservation,
): RouteReview["executionCosts"] {
  const config = getRedemptionBackstopConfig(entry.stablecoinId);
  const points = observation.capacityCurve ?? [
    {
      requestedNotionalUsd: observation.requestedNotionalUsd,
      maxCostBps: observation.maxCostBps,
      executableUsd: observation.executableUsd,
      completionRatio: observation.completionRatio,
    },
  ];
  return points
    .map((point) => {
      const reviewedCostBps =
        observation.executionCostBps ??
        (config
          ? resolveV9RedemptionRouteCostBpsAtNotional(config, point.requestedNotionalUsd, entry.feeBps)
          : entry.feeBps !== null && Number.isFinite(entry.feeBps)
            ? entry.feeBps
            : null);
      return {
        requestedNotionalUsd: point.requestedNotionalUsd,
        maxCostBps: point.maxCostBps,
        executionCostBps: reviewedCostBps ?? point.maxCostBps,
      };
    })
    .sort((left, right) =>
      compareText(
        `${left.maxCostBps}:${left.requestedNotionalUsd}`,
        `${right.maxCostBps}:${right.requestedNotionalUsd}`,
      ),
    );
}

function buildRedemptionRouteReview(
  fixedInput: Readonly<ReportCardsFixedInput>,
  entry: RedemptionBackstopEntry,
  observation: ExitRouteObservation,
): RouteReview {
  const scope = observation.scope;
  const modelConfidence = observation.modelConfidence ?? entry.modelConfidence;
  const reviewedTerms = redemptionReviewTerms(entry);
  const physicalResourceKeys =
    scope.kind === "issuer"
      ? [`issuer:${scope.issuerId}`]
      : scope.kind === "protocol"
        ? [`protocol:${scope.protocol}${scope.chain ? `:${scope.chain}` : ""}`]
        : dexPhysicalResourceKeys(observation);
  return {
    lane: "redemption",
    routeId: observation.routeId,
    holderAccess: redemptionHolderAccess(entry),
    executionModel: redemptionExecutionModel(entry),
    executionCertainty: redemptionExecutionCertainty(entry, modelConfidence),
    modelConfidence,
    coverageClass: redemptionCoverageClass(entry, observation),
    capacityScoringHorizon: entry.capacityProfile?.scoringHorizon ?? "unknown",
    ...redemptionSettlement(reviewedTerms.settlementModel, reviewedTerms.settlementDelaySec),
    settlementHorizonSec: Math.max(observation.settlementHorizonSec, reviewedTerms.settlementHorizonSec),
    queueDepthUsd: entry.queueDepthUsd ?? null,
    dailyLimitUsd: entry.dailyLimitUsd ?? null,
    minRedeemUsd: reviewedTerms.minRedeemUsd,
    physicalResourceKeys,
    executionCosts: redemptionExecutionCosts(entry, observation),
    output: buildOutputReview(fixedInput, observation, fixedInput.redemptionGenerationId),
    failureDomains: [],
  };
}

/**
 * Projects the exact captured DEX and redemption observations into reviewed v9
 * route semantics. Every semantic value is carried or conservatively bounded
 * from the capturing producer's own reviewed model; nothing is upgraded past
 * what the observation source states.
 */
export function buildSafetyScoreV9RouteReviews(
  fixedInput: Readonly<ReportCardsFixedInput>,
  assetId: string,
): RouteReview[] {
  const reviews: RouteReview[] = [];
  const seenResources = new Set<string>();
  const dexObservations = [...(fixedInput.dexLiqMap[assetId]?.exitRouteObservations ?? [])].sort((left, right) =>
    compareText(left.routeId, right.routeId),
  );
  for (const observation of dexObservations) {
    const review = buildDexRouteReview(fixedInput, assetId, observation);
    // A physical pool may only back one score-bearing route; further
    // observations of the same pool stay diagnostic.
    const reused = review.physicalResourceKeys.some((key) => seenResources.has(key));
    for (const key of review.physicalResourceKeys) seenResources.add(key);
    reviews.push(reused ? { ...review, coverageClass: "diagnostic" } : review);
  }
  const redemption = fixedInput.redemptionBackstopMap[assetId];
  for (const observation of redemption?.capacityProfile?.exitRouteObservations ?? []) {
    reviews.push(buildRedemptionRouteReview(fixedInput, redemption!, observation));
  }
  for (const retained of buildSafetyScoreV9RetainedRedemptionRoutes(fixedInput, assetId)) {
    reviews.push(buildRedemptionRouteReview(fixedInput, redemption!, retained.observation));
  }
  return reviews.sort((left, right) => compareText(`${left.lane}:${left.routeId}`, `${right.lane}:${right.routeId}`));
}

/**
 * Derives same-notional route evidence for captured full-supply redemption
 * rows that predate the producer emitting observations itself. The derivation
 * is the producer's own (shared function over the published row), so a later
 * capture that carries the observation natively replaces this retained route
 * byte-for-byte and the derivation no-ops.
 */
export function buildSafetyScoreV9RetainedRedemptionRoutes(
  fixedInput: Readonly<ReportCardsFixedInput>,
  assetId: string,
): RetainedRoute[] {
  const redemption = fixedInput.redemptionBackstopMap[assetId];
  if (!redemption || (redemption.capacityProfile?.exitRouteObservations?.length ?? 0) > 0) return [];
  const observation = deriveSupplyModelExitRouteObservation(redemption, fixedInput.clockSec);
  if (!observation) return [];
  return [{ lane: "redemption", observation, disposition: "observed", rejection: null }];
}
