import { REDEMPTION_BACKSTOP_PROVIDER_IDS } from "@shared/lib/redemption-backstop-providers";
import { SAME_NOTIONAL_EXIT_REQUEST_POLICY } from "@shared/lib/redemption-backstop-scoring";
import { getRedemptionBackstopConfig, type RedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { ExitRouteObservation, ExitRouteOutput } from "@shared/types/market";
import type { LiveReserveRedemptionOutputValuation } from "@shared/types/live-reserves";
import { buildExitRouteCapacityPoint } from "@shared/lib/exit-route-capacity-point";
import type {
  RedemptionBackstopEntry,
  RedemptionCapacityProfile,
  RedemptionLiveCapacityKind,
  RedemptionLiveFreshnessKind,
} from "@shared/types/redemption";

const REDEMPTION_CAPACITY_CURVE_REQUESTS_USD = [100_000, 1_000_000, 5_000_000, 25_000_000] as const;

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
  sourceTimestamp?: number;
  settlementDelaySec?: number;
  settlementBoundUnproven?: true;
  resolvedFeeBps: number | null;
  outputValuation?: LiveReserveRedemptionOutputValuation | null;
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
} {
  const liveDirect = input.capacityKind === "live-direct" || input.capacityKind === "live-direct-bounded";
  const directFreshness =
    input.freshnessKind === "verified-source-timestamp" ||
    input.freshnessKind === "same-run-onchain" ||
    input.freshnessKind === "same-run-api";
  if (liveDirect && input.sourceMode === "dynamic" && directFreshness) {
    return {
      evidenceKind: input.freshnessKind === "same-run-onchain" ? "onchain-contract-state" : "live-reserve-state",
      confidence: "high",
      observedAt: floorTimestampSec(input.sourceTimestamp) ?? floorTimestampSec(input.now) ?? 0,
      supportsScoring: true,
    };
  }

  const reviewTimestamp = reviewedAtSec(input.config.reviewedAt);
  const hasReviewedTerms = reviewTimestamp != null && (input.config.docs?.length ?? 0) > 0;
  if (input.capacityConfidence === "documented-bound" && hasReviewedTerms) {
    return {
      evidenceKind: "documented-terms",
      confidence: "medium",
      observedAt: reviewTimestamp,
      supportsScoring: true,
    };
  }

  return {
    evidenceKind: hasReviewedTerms ? "documented-terms" : "manual-review",
    confidence: input.capacityConfidence === "heuristic" ? "low" : "unknown",
    observedAt: reviewTimestamp ?? floorTimestampSec(input.sourceTimestamp) ?? floorTimestampSec(input.now) ?? 0,
    supportsScoring: false,
  };
}

function resolveOutput(
  stablecoinId: string,
  config: Pick<
    RedemptionBackstopConfig,
    "routeFamily" | "outputAssetType" | "outputAssets" | "unresolvedOutputAssetKeys"
  >,
  outputValuation?: LiveReserveRedemptionOutputValuation | null,
): ExitRouteOutput {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (config.routeFamily === "offchain-issuer") {
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
    if (!config.outputAssets?.length) {
      return {
        kind: "unresolved-basket",
        ...(config.unresolvedOutputAssetKeys?.length
          ? { assetKeys: [...config.unresolvedOutputAssetKeys] }
          : {}),
      };
    }
    const configuredAssetIds = [...config.outputAssets].sort();
    const valuationAssetIds = outputValuation?.basketWeights.map((weight) => weight.assetId).sort() ?? [];
    const valuationMatches =
      configuredAssetIds.length === valuationAssetIds.length &&
      configuredAssetIds.every((assetId, index) => assetId === valuationAssetIds[index]);
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
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
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

function resolveCostBps(
  config: RedemptionBackstopConfig,
  resolvedFeeBps: number | null,
  requestedNotionalUsd: number,
): number | null {
  const cost = config.costModel;
  const variableFeeBps =
    cost.stressFeeBps ??
    cost.feeBpsMax ??
    resolvedFeeBps ??
    (cost.kind === "fee-bps" ? cost.feeBps : (cost.feeBpsMin ?? null));
  const fixedCostUsd = (cost.flatFeeUsd ?? 0) + (cost.gasOrBridgeCostUsd ?? 0);
  if (variableFeeBps == null && fixedCostUsd === 0 && cost.minFeeUsd == null) return null;
  const variableFeeUsd = Math.max(((variableFeeBps ?? 0) * requestedNotionalUsd) / 10_000, cost.minFeeUsd ?? 0);
  return ((variableFeeUsd + fixedCostUsd) / requestedNotionalUsd) * 10_000;
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
  const mainCostBps = resolveCostBps(input.config, input.resolvedFeeBps, modeledExitSizeUsd);
  const configuredOutputAssetIds = [...(input.config.outputAssets ?? [])].sort();
  const candidateValuationAssetIds =
    input.outputValuation?.basketWeights.map((weight) => weight.assetId).sort() ?? [];
  const outputValuation =
    input.config.outputAssetType === "stable-basket" &&
    input.outputValuation &&
    configuredOutputAssetIds.length === candidateValuationAssetIds.length &&
    configuredOutputAssetIds.every((assetId, index) => assetId === candidateValuationAssetIds[index])
      ? input.outputValuation
      : null;
  const allInCostBps =
    mainCostBps != null && outputValuation
      ? mainCostBps + Math.max(0, (1 - outputValuation.unitValueUsd) * 10_000)
      : null;
  // A reviewed route with a documented but unbounded fee still proves that the
  // capacity exists. Preserve that capacity and let V9's explicit
  // undisclosed-fee ceiling bound its score instead of converting uncertainty
  // about cost into a false zero-liquidity observation.
  const boundedUnknownFee =
    mainCostBps === null &&
    evidence.supportsScoring &&
    input.config.costModel.kind === "dynamic-or-unclear";
  const scoreEligible =
    !input.settlementBoundUnproven &&
    input.resolutionState === "resolved" &&
    input.routeStatus === "open" &&
    routeIsImmediate &&
    evidence.supportsScoring &&
    mainCostBps != null &&
    mainCostBps <= SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps &&
    (allInCostBps == null || allInCostBps <= SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps);
  const maxCurveRequest = input.supplyUsd != null && input.supplyUsd > 0 ? input.supplyUsd : modeledExitSizeUsd;
  const requests = [...new Set([...REDEMPTION_CAPACITY_CURVE_REQUESTS_USD, modeledExitSizeUsd])]
    .filter((request) => request <= Math.max(modeledExitSizeUsd, maxCurveRequest))
    .sort((left, right) => left - right);
  const scoringCapacityUsd = input.scoringCapacityUsd;
  const capacityCurve =
    scoringCapacityUsd == null
      ? undefined
      : requests.map((request) => {
          const costBps = resolveCostBps(input.config, input.resolvedFeeBps, request);
          return buildExitRouteCapacityPoint({
            requestedNotionalUsd: request,
            maxCostBps: SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps,
            capacityUsd: scoringCapacityUsd,
            admitted: (costBps != null && costBps <= SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps)
              || boundedUnknownFee,
          }, { clampNegativeCapacity: true, usdDecimals: null, ratioDecimals: null });
        });
  const point = capacityCurve?.find((candidate) => candidate.requestedNotionalUsd === modeledExitSizeUsd) ?? {
    requestedNotionalUsd: modeledExitSizeUsd,
    maxCostBps: SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps,
    executableUsd: 0,
    completionRatio: 0,
  };
  const { scope, commonModeKeys } = resolveScopeAndCommonModes(input.stablecoinId, input.config.routeFamily);
  const settlementHorizonSec = Math.max(
    REDEMPTION_SETTLEMENT_HORIZON_CEILING_SEC[input.config.settlementModel],
    input.settlementDelaySec ?? 0,
  );

  return {
    routeId: `redemption:${input.stablecoinId}:${input.config.routeFamily}`,
    routeFamily: input.config.routeFamily === "offchain-issuer" ? "issuer-redemption" : "protocol-redemption",
    scope,
    ...point,
    ...(input.settlementBoundUnproven ? { settlementBoundUnproven: true } : {}),
    settlementHorizonSec,
    output: resolveOutput(input.stablecoinId, input.config, outputValuation),
    evidenceKind: evidence.evidenceKind,
    ...(boundedUnknownFee ? { feeEvidence: "undisclosed-reviewed" as const } : {}),
    ...(outputValuation && mainCostBps != null && allInCostBps != null
      ? {
          executionCostBps: mainCostBps,
          outputUnitValueUsd: outputValuation.unitValueUsd,
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
  // output composition — both producer and shadow read the identical registry,
  // so derivations stay byte-identical. Formula and documented-variable fees
  // without a stated ceiling remain cost-unbounded: they preserve the reviewed
  // capacity but stay non-score-eligible and carry the same bounded-unknown fee
  // marker as an `undisclosed-reviewed` route (SIM-EXIT-L2). The exit policy,
  // rather than the producer, then bounds all such credit via
  // `semantic.exit.undisclosedFeeRouteScoreCeiling`.
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
  const requests = [...new Set([...REDEMPTION_CAPACITY_CURVE_REQUESTS_USD, modeledExitSizeUsd])]
    .filter((request) => request <= Math.max(modeledExitSizeUsd, eventualUsd))
    .sort((left, right) => left - right);
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
      unresolvedOutputAssetKeys:
        getRedemptionBackstopConfig(entry.stablecoinId)?.unresolvedOutputAssetKeys,
    }),
    evidenceKind: "documented-terms",
    ...(boundedUnknownFee ? { feeEvidence: "undisclosed-reviewed" as const } : {}),
    confidence: "medium",
    scoreEligible: routeFamily !== "eventual-redemption" && withinCost,
    observedAt: reviewTimestamp,
    freshnessSeconds: Math.max(0, (floorTimestampSec(now) ?? 0) - reviewTimestamp),
    commonModeKeys,
    capacityCurve,
  };
}
