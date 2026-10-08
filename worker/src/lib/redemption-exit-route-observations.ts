import { REDEMPTION_BACKSTOP_PROVIDER_IDS } from "@shared/lib/redemption-backstop-providers";
import { SAME_NOTIONAL_EXIT_REQUEST_POLICY } from "@shared/lib/redemption-backstop-scoring";
import { resolveV9RedemptionRouteCostBpsAtNotional } from "@shared/lib/redemption-backstop-configs/shared";
import { EXIT_ROUTE_SCORING_TABLES } from "@shared/lib/exit-route-scoring";
import { evaluatePhysicalToUsdExit } from "@shared/lib/physical-to-usd-exit";
import { PHYSICAL_TO_USD_EXIT_POLICY, resolveExitScoringRequest } from "@shared/lib/exit-route-scoring";
import { getRedemptionBackstopConfig, type RedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import type { ExitRouteObservation, ExitRouteOutput } from "@shared/types/market";
import type { LiveReserveRedemptionOutputValuation } from "@shared/types/live-reserves";
import { buildExitRouteCapacityPoint, mergeExitCurveRequests } from "@shared/lib/exit-route-capacity-point";
import type {
  RedemptionBackstopEntry,
  RedemptionCapacityProfile,
  RedemptionLiveCapacityKind,
  RedemptionLiveFreshnessKind,
} from "@shared/types/redemption";

import { LIVE_RESERVE_FRESHNESS_SEC } from "./live-reserves/store";
// Conservative documented ceilings for projecting a reviewed settlement model
// onto an observation horizon. Only "atomic" satisfies the same-notional
// request horizon; every other model is published as diagnostic evidence.
export const REDEMPTION_SETTLEMENT_HORIZON_CEILING_SEC: Record<
  RedemptionBackstopEntry["settlementModel"],
  number
> = {
  atomic: SAME_NOTIONAL_EXIT_REQUEST_POLICY.settlementHorizonSec,
  immediate: 3_600,
  "same-day": 86_400,
  days: 14 * 86_400,
  queued: 30 * 86_400,
};

// These rails carry separately reviewed end-to-end terms, rather than the
// asset's primary issuer/protocol review. A certificate alone is NOT an opt-out:
// it must supersede that review through admitted exact-source chronology.
const SEPARATELY_REVIEWED_REDEMPTION_RAILS = ["physical-to-usd"] as const;

export function usesPrimaryRedemptionReviewTerms(
  assetId: string,
  route: Pick<ExitRouteObservation, "routeId" | "physicalToUsd">,
): boolean {
  if (route.physicalToUsd === undefined) return true;
  for (const rail of SEPARATELY_REVIEWED_REDEMPTION_RAILS) {
    if (route.routeId === `${rail}:${assetId}`) return false;
  }
  return true;
}

interface BuildRedemptionExitRouteObservationInput {
  stablecoinId: string;
  config: RedemptionBackstopConfig;
  capacityProfile: RedemptionCapacityProfile | undefined;
  scoringCapacityUsd: number | null;
  supplyUsd: number | null;
  routeStatus: RedemptionBackstopEntry["routeStatus"];
  resolutionState: RedemptionBackstopEntry["resolutionState"];
  sourceMode: RedemptionBackstopEntry["sourceMode"];
  capacityConfidence: RedemptionBackstopEntry["capacityConfidence"];
  capacityKind?: RedemptionLiveCapacityKind;
  freshnessKind?: RedemptionLiveFreshnessKind;
  evidenceObservedAt?: number;
  settlementDelaySec?: number;
  settlementBoundUnproven?: true;
  resolvedFeeBps: number | null;
  outputValuation?: LiveReserveRedemptionOutputValuation | null;
  sharedResourceKey?: ExitRouteObservation["sharedResourceKey"];
  now: number;
}

function floorTimestampSec(timestamp: number | undefined): number | null {
  if (timestamp == null || !Number.isFinite(timestamp) || timestamp < 0) return null;
  return Math.floor(timestamp);
}

function reviewedAtSec(reviewedAt: string | undefined): number | null {
  if (!reviewedAt) return null;
  const timestamp = Date.parse(`${reviewedAt}T00:00:00.000Z`);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1_000) : null;
}

function resolveRouteEvidence(input: BuildRedemptionExitRouteObservationInput): {
  evidenceKind: ExitRouteObservation["evidenceKind"];
  confidence: ExitRouteObservation["confidence"];
  observedAt: number;
  supportsScoring: boolean;
  capacityEvidenceTier: NonNullable<ExitRouteObservation["capacityEvidenceTier"]>;
} {
  const liveDirect = input.capacityKind === "live-direct" || input.capacityKind === "live-direct-bounded";
  const directFreshness =
    input.freshnessKind === "verified-source-timestamp" ||
    input.freshnessKind === "same-run-onchain" ||
    input.freshnessKind === "same-run-api";
  const observedAt = floorTimestampSec(input.evidenceObservedAt);
  const now = floorTimestampSec(input.now);
  const freshClock = observedAt !== null && now !== null && observedAt <= now &&
    now - observedAt <= LIVE_RESERVE_FRESHNESS_SEC;
  const liveProxy = input.capacityKind === "live-queue" || input.capacityKind === "live-proxy-validated";
  if (liveProxy && input.sourceMode === "dynamic" && directFreshness && freshClock) {
    return {
      evidenceKind: input.freshnessKind === "same-run-onchain" ? "onchain-contract-state" : "live-reserve-state",
      confidence: "high", capacityEvidenceTier: "live-queue-proxy", observedAt, supportsScoring: true,
    };
  }
  if (liveDirect && input.sourceMode === "dynamic" && directFreshness) {
    return {
      evidenceKind: input.freshnessKind === "same-run-onchain" ? "onchain-contract-state" : "live-reserve-state",
      confidence: "high",
      capacityEvidenceTier: freshClock ? "live-direct" : "unknown",
      observedAt: floorTimestampSec(input.evidenceObservedAt) ?? 0,
      supportsScoring: freshClock,
    };
  }

  const reviewTimestamp = reviewedAtSec(input.config.reviewedAt);
  const hasReviewedTerms = reviewTimestamp != null && (input.config.docs?.length ?? 0) > 0;
  if (input.capacityConfidence === "documented-bound" && hasReviewedTerms) {
    return {
      evidenceKind: "documented-terms",
      confidence: "medium",
      capacityEvidenceTier: "documented",
      // The observation time is when the evidence was read, not when the
      // terms were reviewed: a same-run direct read carries its own
      // timestamp, and only evidence without one falls back to the review.
      observedAt: (directFreshness ? floorTimestampSec(input.evidenceObservedAt) : null)
        ?? reviewTimestamp,
      supportsScoring: true,
    };
  }

  return {
    evidenceKind: hasReviewedTerms ? "documented-terms" : "manual-review",
    confidence: input.capacityConfidence === "heuristic" ? "low" : "unknown",
    capacityEvidenceTier: input.capacityConfidence === "heuristic" ? "heuristic" : "unknown",
    observedAt: reviewTimestamp ?? floorTimestampSec(input.evidenceObservedAt) ?? 0,
    supportsScoring: false,
  };
}

function resolveOutput(
  stablecoinId: string,
  config: Pick<
    RedemptionBackstopConfig,
    "routeFamily" | "outputAssetType" | "outputAssets" | "unresolvedOutputAssetKeys" | "physicalCommodityDelivery"
  >,
  outputValuation?: LiveReserveRedemptionOutputValuation | null,
): ExitRouteOutput {
  const meta = WORKER_TRACKED_META_BY_ID.get(stablecoinId);
  // Explicit unresolved identities override variantOf and issuer peg currency.
  // Alternative payouts must not silently become the parent token or fiat.
  if (config.unresolvedOutputAssetKeys?.length && !config.outputAssets?.length && config.outputAssetType !== "stable-basket") {
    return { kind: "unresolved-asset", assetKeys: [...config.unresolvedOutputAssetKeys] };
  }
  if (config.outputAssetType === "physical-commodity-delivery" && config.physicalCommodityDelivery) {
    return {
      kind: "physical-commodity-delivery",
      assetKeys: [`commodity:${config.physicalCommodityDelivery.commodity.toLowerCase()}`],
      sameNotionalEligible: false,
      ...(config.physicalCommodityDelivery.deliveryTermsUnbounded
        ? { unboundedDeliveryCap: EXIT_ROUTE_SCORING_TABLES.unboundedDeliveryCap }
        : {}),
    };
  }
  if (config.outputAssetType === "physical-commodity-delivery") return { kind: "unresolved-asset" };
  // Commodity issuer routes deliver physical metal, not fiat. Keeping them on
  // the offchain fiat branch would let buildOutputReview assign an implied
  // $1 par valuation to GOLD/SILVER even though no USD output valuation was
  // published. Leave the physical output unresolved until the producer has a
  // real, priceable output identity and valuation.
  if (config.routeFamily === "offchain-issuer" && config.outputAssetType === "bluechip-collateral") {
    return {
      kind: "unresolved-asset",
      ...(config.unresolvedOutputAssetKeys?.length
        ? { assetKeys: [...config.unresolvedOutputAssetKeys] }
        : {}),
    };
  }
  if (
    config.routeFamily === "offchain-issuer" &&
    !(config.outputAssets?.length &&
      (config.outputAssetType === "stable-single" || config.outputAssetType === "stable-basket"))
  ) {
    return { kind: "fiat", ...(meta?.flags.pegCurrency ? { currency: meta.flags.pegCurrency } : {}) };
  }
  if (config.outputAssetType === "stable-single") {
    const outputId = config.outputAssets?.[0] ?? meta?.variantOf;
    return outputId
      ? { kind: "tracked-stablecoin", trackedAssetIds: [outputId] }
      : {
          kind: "unresolved-asset",
          ...(config.unresolvedOutputAssetKeys?.length
            ? { assetKeys: [...config.unresolvedOutputAssetKeys] }
            : {}),
        };
  }
  if (config.outputAssetType === "stable-basket") {
    const configuredAssetIds = [...(config.outputAssets ?? config.unresolvedOutputAssetKeys ?? [])].sort();
    const valuationAssetIds = outputValuation?.basketWeights.map((weight) => weight.assetId).sort() ?? [];
    const valuationMatches =
      configuredAssetIds.length > 0 &&
      configuredAssetIds.length === valuationAssetIds.length &&
      configuredAssetIds.every((assetId, index) => assetId === valuationAssetIds[index]);
    if (!config.outputAssets?.length) {
      return {
        kind: "unresolved-basket",
        ...(config.unresolvedOutputAssetKeys?.length
          ? { assetKeys: [...config.unresolvedOutputAssetKeys] }
          : {}),
        ...(valuationMatches
          ? {
              basketWeights: outputValuation!.basketWeights.map((weight) => ({
                assetId: weight.assetId,
                weight: weight.weight,
              })),
            }
          : {}),
      };
    }
    return {
      kind: "tracked-stablecoin",
      trackedAssetIds: [...config.outputAssets],
      ...(valuationMatches
        ? {
            basketWeights: outputValuation!.basketWeights.map((weight) => ({
              assetId: weight.assetId,
              weight: weight.weight,
            })),
          }
        : {}),
    };
  }
  if (config.outputAssetType === "bluechip-collateral" || config.outputAssetType === "mixed-collateral") {
    return config.outputAssets?.length
      ? { kind: "collateral", assetKeys: [...config.outputAssets] }
      : { kind: "collateral" };
  }
  return {
    kind: "unresolved-asset",
    ...(config.unresolvedOutputAssetKeys?.length
      ? { assetKeys: [...config.unresolvedOutputAssetKeys] }
      : {}),
  };
}

function resolveScopeAndCommonModes(
  stablecoinId: string,
  routeFamily: RedemptionBackstopConfig["routeFamily"],
): { scope: ExitRouteObservation["scope"]; commonModeKeys: string[] } {
  const meta = WORKER_TRACKED_META_BY_ID.get(stablecoinId);
  const chain = meta?.contracts?.length === 1 ? meta.contracts[0]!.chain : undefined;
  return {
    scope:
      routeFamily === "offchain-issuer"
        ? { kind: "issuer", issuerId: stablecoinId }
        : { kind: "protocol", protocol: meta?.protocolSlug ?? stablecoinId, ...(chain ? { chain } : {}) },
    commonModeKeys: [
      routeFamily === "offchain-issuer" ? `issuer:${stablecoinId}` : `protocol:${meta?.protocolSlug ?? stablecoinId}`,
      ...(meta?.variantOf ? [`parent:${meta.variantOf}`] : []),
      ...(chain ? [`chain:${chain}`] : []),
    ],
  };
}


/**
 * Projects an existing reviewed redemption capacity into P4's common request.
 * Eventual, daily, queued, stale, or cost-unbounded evidence remains visible
 * through the legacy profile but is intentionally not published as immediate
 * score-eligible capacity.
 */
export function buildRedemptionExitRouteObservation(
  input: BuildRedemptionExitRouteObservationInput,
): ExitRouteObservation | null {
  const modeledExitSizeUsd = input.capacityProfile?.modeledExitSizeUsd;
  if (
    !input.capacityProfile ||
    modeledExitSizeUsd == null ||
    !Number.isFinite(modeledExitSizeUsd) ||
    modeledExitSizeUsd <= 0 ||
    (input.scoringCapacityUsd == null && !input.settlementBoundUnproven) ||
    (input.scoringCapacityUsd != null &&
      (!Number.isFinite(input.scoringCapacityUsd) || input.scoringCapacityUsd < 0))
  ) {
    return null;
  }

  const evidence = resolveRouteEvidence(input);
  const routeIsImmediate =
    input.capacityProfile.scoringHorizon === "immediate" &&
    (input.config.settlementModel === "atomic" || input.config.settlementModel === "immediate");
  const mainCostBps = resolveV9RedemptionRouteCostBpsAtNotional(
    input.config,
    modeledExitSizeUsd,
    input.resolvedFeeBps,
  );
  const configuredOutputAssetIds = [
    ...(input.config.outputAssets ?? input.config.unresolvedOutputAssetKeys ?? []),
  ].sort();
  const candidateValuationAssetIds =
    input.outputValuation?.basketWeights.map((weight) => weight.assetId).sort() ?? [];
  const outputValuation =
    input.config.outputAssetType === "stable-basket" &&
    input.outputValuation &&
    configuredOutputAssetIds.length > 0 &&
    configuredOutputAssetIds.length === candidateValuationAssetIds.length &&
    configuredOutputAssetIds.every((assetId, index) => assetId === candidateValuationAssetIds[index])
      ? input.outputValuation
      : null;
  const outputExpectedUnitValueUsd = outputValuation?.expectedUnitValueUsd ?? 1;
  const allInCostBps =
    mainCostBps != null && outputValuation
      ? mainCostBps +
        Math.max(0, (1 - outputValuation.unitValueUsd / outputExpectedUnitValueUsd) * 10_000)
      : null;
  // Retain a reviewed modeled capacity without asserting a measured fee or
  // certifying execution inside the request budget.
  const boundedUnknownFee =
    mainCostBps === null &&
    evidence.supportsScoring &&
    input.config.costModel.kind === "dynamic-or-unclear";
  const scoreEligible =
    input.config.outputAssetType !== "physical-commodity-delivery" &&
    !input.settlementBoundUnproven &&
    input.resolutionState === "resolved" &&
    input.routeStatus === "open" &&
    routeIsImmediate &&
    evidence.supportsScoring &&
    mainCostBps != null &&
    mainCostBps <= SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps &&
    (allInCostBps == null || allInCostBps <= SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps);
  const maxCurveRequest = input.supplyUsd != null && input.supplyUsd > 0 ? input.supplyUsd : modeledExitSizeUsd;
  const requests = mergeExitCurveRequests(modeledExitSizeUsd, maxCurveRequest);
  const scoringCapacityUsd = input.scoringCapacityUsd;
  const capacityCurve =
    scoringCapacityUsd == null
      ? undefined
      : requests.map((request) => {
          const costBps = resolveV9RedemptionRouteCostBpsAtNotional(
            input.config,
            request,
            input.resolvedFeeBps,
          );
          const point = buildExitRouteCapacityPoint({
            requestedNotionalUsd: request,
            maxCostBps: SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps,
            capacityUsd: scoringCapacityUsd,
            admitted: (costBps != null && costBps <= SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps)
              || boundedUnknownFee,
          }, { clampNegativeCapacity: true, usdDecimals: null, ratioDecimals: null });
          if (costBps !== null) point.executionCostBps = costBps;
          return point;
        });
  const point = capacityCurve?.find((candidate) => candidate.requestedNotionalUsd === modeledExitSizeUsd) ?? {
    requestedNotionalUsd: modeledExitSizeUsd,
    maxCostBps: SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps,
    executableUsd: 0,
    completionRatio: 0,
  };
  const { scope, commonModeKeys } = resolveScopeAndCommonModes(input.stablecoinId, input.config.routeFamily);
  // A live same-run settlement delay is the observed horizon (R6); the
  // reviewed model's ceiling is the fallback when no positive integer live
  // delay exists (the exit-route contract requires a positive integer horizon,
  // and a zero delay is an instant route, not a horizon).
  const settlementHorizonSec =
    input.settlementDelaySec != null &&
    Number.isSafeInteger(input.settlementDelaySec) &&
    input.settlementDelaySec > 0
      ? input.settlementDelaySec
      : REDEMPTION_SETTLEMENT_HORIZON_CEILING_SEC[input.config.settlementModel];

  return {
    routeId: `redemption:${input.stablecoinId}:${input.config.routeFamily}`,
    routeFamily: input.config.routeFamily === "offchain-issuer" ? "issuer-redemption" : "protocol-redemption",
    scope,
    ...point,
    ...(input.settlementBoundUnproven ? { settlementBoundUnproven: true } : {}),
    settlementHorizonSec,
    output: resolveOutput(input.stablecoinId, input.config, outputValuation),
    evidenceKind: evidence.evidenceKind,
    capacityEvidenceTier: evidence.capacityEvidenceTier,
    ...(boundedUnknownFee
      ? { feeEvidence: input.config.costModel.kind === "dynamic-or-unclear" &&
          input.config.costModel.confidence === "formula"
            ? "disclosed-unquantified" as const
            : "undisclosed-reviewed" as const }
      : {}),
    ...(outputValuation && mainCostBps != null && allInCostBps != null
      ? {
          executionCostBps: mainCostBps,
          outputUnitValueUsd: outputValuation.unitValueUsd,
          outputExpectedUnitValueUsd,
          outputUnitValueSourceId: outputValuation.sourceId,
          outputUnitValueObservedAt: outputValuation.observedAt,
          allInCostBps,
        }
      : {}),
    confidence: evidence.confidence,
    scoreEligible,
    observedAt: evidence.observedAt,
    freshnessSeconds: Math.max(0, (floorTimestampSec(input.now) ?? 0) - evidence.observedAt),
    commonModeKeys,
    ...(input.sharedResourceKey ? { sharedResourceKey: input.sharedResourceKey } : {}),
    ...(capacityCurve ? { capacityCurve } : {}),
  };
}

/**
 * Derives an explicitly-bounded exit-route observation from a published
 * full-supply redemption row that quantified no immediate capacity. The
 * observation carries only what the row's own reviewed model states: capacity
 * bounded by the documented full-supply basis, documented-terms evidence at
 * the review timestamp, and a cost bound only when the documented fee model is
 * a fixed bps fee. Atomic settlement projects onto the same-notional request as
 * a `protocol`/`issuer-redemption` route; every slower settlement model is
 * published as `eventual-redemption` evidence that is never fact-level
 * score-eligible (the schema forbids a score-eligible eventual/null-SLA route).
 *
 * The exit pillar now credits these `eventual-redemption` rows above zero at
 * evaluation time, discounted by settlement speed, precisely because this
 * derivation only emits after hard-gating on `resolved` status, an `open`
 * route, documented terms, and a documented full-supply basis. That guard is
 * the reliability contract the exit-eval credit depends on: an impaired,
 * closed, or undocumented row returns null here and earns no credit downstream.
 *
 * Works purely from the published entry so the runtime producer and the V9
 * shadow extension derive byte-identical observations from the same row.
 */
export function deriveSupplyModelExitRouteObservation(
  entry: RedemptionBackstopEntry,
  now: number,
): ExitRouteObservation | null {
  const profile = entry.capacityProfile;
  const eventualUsd = profile?.eventualUsd;
  const modeledExitSizeUsd = profile?.modeledExitSizeUsd;
  // scoringUsd == 0 is still "no immediate capacity" — only a positive
  // scoring figure means the producer already quantified an immediate bound.
  const hasQuantifiedImmediateCapacity =
    profile?.scoringUsd != null && Number.isFinite(profile.scoringUsd) && profile.scoringUsd > 0;
  if (
    entry.provider !== REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_FULL_MODEL ||
    !profile ||
    hasQuantifiedImmediateCapacity ||
    (profile.exitRouteObservations?.length ?? 0) > 0 ||
    entry.resolutionState !== "resolved" ||
    entry.routeStatus !== "open" ||
    entry.capacityConfidence !== "documented-bound" ||
    eventualUsd == null ||
    !Number.isFinite(eventualUsd) ||
    eventualUsd <= 0 ||
    modeledExitSizeUsd == null ||
    !Number.isFinite(modeledExitSizeUsd) ||
    modeledExitSizeUsd <= 0
  ) {
    return null;
  }
  const reviewTimestamp = reviewedAtSec(entry.docs?.reviewedAt);
  if (reviewTimestamp === null) return null;

  // Only "atomic" satisfies the 300s same-notional horizon and projects onto a
  // top-tier redemption family; every slower model is carried as reliable
  // `eventual-redemption` evidence (settlementHorizonSec below encodes its
  // speed) that the exit pillar credits at a settlement-discounted rate.
  const routeFamily: ExitRouteObservation["routeFamily"] =
    entry.settlementModel === "atomic"
      ? entry.routeFamily === "offchain-issuer"
        ? "issuer-redemption"
        : "protocol-redemption"
      : "eventual-redemption";
  // A defensible cost bound is a documented fixed-bps fee on the published row,
  // or (T1, owner ruling 2026-07-22 R3/R4) a reviewed documented ceiling
  // (`feeBpsMax`) on the same static config that already supplies this route's
  // output composition. Formula and documented-variable fees
  // without a stated ceiling remain cost-unbounded. Preserve modeled capacity,
  // but distinguish disclosed terms from issuer non-disclosure; neither proves
  // a same-notional execution cost bound.
  const staticConfig = getRedemptionBackstopConfig(entry.stablecoinId);
  const feeBoundBps =
    entry.feeModelKind === "fixed-bps" && entry.feeBps != null
      ? entry.feeBps
      : entry.feeModelKind === "documented-variable" && staticConfig?.costModel.feeBpsMax != null
        ? staticConfig.costModel.feeBpsMax
        : null;
  const withinCost = feeBoundBps != null && feeBoundBps <= SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps;
  const boundedUnknownFee =
    feeBoundBps === null &&
    (
      entry.feeModelKind === "undisclosed-reviewed" ||
      entry.feeModelKind === "documented-variable" ||
      entry.feeModelKind === "formula"
    );
  const requests = mergeExitCurveRequests(modeledExitSizeUsd, eventualUsd);
  const capacityCurve = requests.map((request) =>
    buildExitRouteCapacityPoint({
      requestedNotionalUsd: request,
      maxCostBps: SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps,
      capacityUsd: eventualUsd,
      admitted: withinCost || boundedUnknownFee,
    }, { clampNegativeCapacity: true, usdDecimals: null, ratioDecimals: null }),
  );
  const point = capacityCurve.find((candidate) => candidate.requestedNotionalUsd === modeledExitSizeUsd)!;
  const { scope, commonModeKeys } = resolveScopeAndCommonModes(entry.stablecoinId, entry.routeFamily);

  return {
    routeId: `redemption:${entry.stablecoinId}:${entry.routeFamily}`,
    routeFamily,
    scope,
    ...point,
    settlementHorizonSec: REDEMPTION_SETTLEMENT_HORIZON_CEILING_SEC[entry.settlementModel],
    // Published rows do not carry outputAssets; the reviewed static config of
    // the same code version supplies the documented output composition.
    output: resolveOutput(entry.stablecoinId, {
      routeFamily: entry.routeFamily,
      outputAssetType: entry.outputAssetType,
      outputAssets: getRedemptionBackstopConfig(entry.stablecoinId)?.outputAssets,
      physicalCommodityDelivery: staticConfig?.physicalCommodityDelivery,
      unresolvedOutputAssetKeys:
        getRedemptionBackstopConfig(entry.stablecoinId)?.unresolvedOutputAssetKeys,
    }),
    evidenceKind: "documented-terms",
    ...(boundedUnknownFee
      ? { feeEvidence: entry.feeConfidence === "formula" &&
          (entry.feeModelKind === "formula" || entry.feeModelKind === "documented-variable")
          ? "disclosed-unquantified" as const
          : "undisclosed-reviewed" as const }
      : {}),
    confidence: "medium",
    scoreEligible: entry.outputAssetType !== "physical-commodity-delivery" && routeFamily !== "eventual-redemption" && withinCost,
    observedAt: reviewTimestamp,
    freshnessSeconds: Math.max(0, (floorTimestampSec(now) ?? 0) - reviewTimestamp),
    commonModeKeys,
    capacityCurve,
  };
}

/** Safety-only composed capability; legacy physical delivery stays diagnostic. */
export function buildPhysicalToUsdExitObservation(input: {
  assetId: string;
  config: RedemptionBackstopConfig;
  supplyUsd: number | null;
  reference: { usdPerTroyOunce: number; observedAtSec: number };
  clockSec: number;
  routeOpen: boolean;
}): ExitRouteObservation | null {
  const terms = input.config.physicalToUsd;
  const request = resolveExitScoringRequest("stress-grid", input.supplyUsd, EXIT_ROUTE_SCORING_TABLES.request);
  if (!terms || !request) return null;
  const physical = evaluatePhysicalToUsdExit(terms, input.reference, request.requestedNotionalUsd, input.clockSec);
  const cash = terms.bestEffortIssuerCashOut
    ? evaluatePhysicalToUsdExit(terms, input.reference, request.requestedNotionalUsd, input.clockSec, "best-effort-issuer-cash-out")
    : null;
  const trace = physical.rejectionReason === null ? physical : cash?.rejectionReason === null ? cash : physical;
  const selected = input.routeOpen ? trace : { ...trace, rejectionReason: "physical-route-not-open" };
  const admitted = selected.rejectionReason === null;
  const capacityCurve = EXIT_ROUTE_SCORING_TABLES.request.notionalGridUsd.map((notional) => {
    const value = evaluatePhysicalToUsdExit(terms, input.reference, notional, input.clockSec, selected.branch);
    const executableUsd = input.routeOpen && value.rejectionReason === null ? value.grossUsd! : 0;
    return { requestedNotionalUsd: notional, maxCostBps: PHYSICAL_TO_USD_EXIT_POLICY.maxCostBps,
      executableUsd, completionRatio: executableUsd / notional,
      ...(executableUsd > 0 ? { executionCostBps: Math.min(PHYSICAL_TO_USD_EXIT_POLICY.maxCostBps, value.costBps!) } : {}) };
  });
  const point = capacityCurve.find((candidate) => candidate.requestedNotionalUsd === request.requestedNotionalUsd)!;
  const { scope, commonModeKeys } = resolveScopeAndCommonModes(input.assetId, "offchain-issuer");
  return {
    routeId: `physical-to-usd:${input.assetId}`,
    routeFamily: "issuer-redemption", scope,
    ...point, capacityCurve,
    settlementHorizonSec: Math.max(1, selected.maximumSettlementSec ?? 1),
    output: { kind: "fiat", currency: "USD" },
    evidenceKind: "documented-terms", confidence: "medium", modelConfidence: selected.modelConfidence,
    scoreEligible: false,
    observedAt: input.clockSec, freshnessSeconds: 0, commonModeKeys,
    ...(admitted ? { executionCostBps: point.executionCostBps, allInCostBps: point.executionCostBps } : {}),
    physicalToUsd: selected,
  };
}
