import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { getExecutableRedemptionObserver, observeExecutableRedemptionRoute } from "../../cron/reserve-adapters/executable-redemption-observers";
import { resolveCoinContractAddress } from "../../cron/reserve-adapters/evm";
import { observeReviewedExitExecutionRoutes } from "../exit-execution/runtime";
import {
  deriveModelConfidenceWithDetails,
  deriveModelConfidence,
  resolveCapacitySemantics,
} from "@shared/lib/redemption-backstop-confidence";
import {
  applyCapacityConstraintScoreEffects,
  computeCapacityScore,
  computeModeledExitSizeUsd,
  computeRedemptionBackstopScore,
  isStrongLiveDirectRoute,
  REDEMPTION_ACCESS_SCORES,
  REDEMPTION_EXECUTION_SCORES,
  computeRedemptionOutputAssetQuality,
  REDEMPTION_SETTLEMENT_SCORES,
} from "@shared/lib/redemption-backstop-scoring";
import {
  getRedemptionBackstopConfig,
  resolveReviewedRedemptionSettlement,
  type RedemptionBackstopConfig,
} from "@shared/lib/redemption-backstops";
import { resolveDefaultHolderEligibility } from "@shared/lib/redemption-backstop-configs/shared";
import { resolveReviewedRouteSuspension } from "@shared/lib/redemption-route-suspension";
import { REDEMPTION_BACKSTOP_PROVIDER_IDS } from "@shared/lib/redemption-backstop-providers";
import { REDEMPTION_BACKSTOP_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import type { StablecoinData } from "@shared/types/market";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import { getLatestSuccessfulReserveSnapshotMetadata, type ReserveSnapshotMetadataRecord } from "../live-reserves/store";
import {
  resolveCapacityBasis,
  resolveRedemptionCapacity,
  type RedemptionBackstopBuildOptions,
} from "./capacity";
import { mergeRedemptionRouteStatus, type RedemptionRouteStatusEvidence } from "./route-status";
import { resolveRedemptionStaticFields } from "./cost";
import {
  readRedemptionBackstopLiveMetadata,
  type RedemptionBackstopLiveMetadata,
} from "./live-metadata";
import {
  buildRedemptionExitRouteObservation,
  deriveSupplyModelExitRouteObservation,
} from "../redemption-exit-route-observations";
import { buildFpiControllerV9ExitRouteObservation } from "../fpi-controller-redemption-route";
import { buildSfrxusdCrosschainV9ExitRouteObservation } from "../sfrxusd-crosschain-redemption-route";
import { deriveCurrentPegObservationMap } from "../current-peg-observations";
import type { RedemptionFiatReferenceContext } from "@shared/lib/redemption-fiat-reference";

// Complete the disclosure join only after a snapshot has collected every
// success/failure row. The local index captures states, not mutable row references.
export function applyOutputDependencyResolution(
  entries: readonly RedemptionBackstopEntry[],
  configs: ReadonlyMap<string, Pick<RedemptionBackstopConfig, "outputAssets"> | null | undefined>,
): RedemptionBackstopEntry[] {
  const resolutionById = new Map<string, RedemptionBackstopEntry["resolutionState"]>();
  for (const entry of entries) {
    resolutionById.set(entry.stablecoinId, entry.resolutionState);
  }
  return entries.map((entry) => {
    const outputAssets = configs.get(entry.stablecoinId)?.outputAssets;
    const unresolvedDependencyId = outputAssets?.find((id) => {
      if (id.startsWith("asset:")) return false;
      const state = resolutionById.get(id);
      return state != null && state !== "resolved";
    });
    if (unresolvedDependencyId) {
      return {
        ...entry,
        outputDependencyResolution: {
          stablecoinId: unresolvedDependencyId,
          resolutionState: resolutionById.get(unresolvedDependencyId)!,
        },
      };
    }
    if (!entry.outputDependencyResolution) return entry;
    const { outputDependencyResolution: _previousDisclosure, ...withoutDisclosure } = entry;
    return withoutDisclosure;
  });
}

function resolveStaticFields(
  stablecoinId: string,
  config: RedemptionBackstopConfig,
  reserveSnapshotMetadata?: ReserveSnapshotMetadataRecord | null,
  now = Math.floor(Date.now() / 1000),
  liveMetadata?: RedemptionBackstopLiveMetadata,
  fiatReferences?: RedemptionFiatReferenceContext,
) {
  const settlementModel = resolveReviewedRedemptionSettlement(config, now);
  const accessScore = REDEMPTION_ACCESS_SCORES[config.accessModel];
  const settlementScore = REDEMPTION_SETTLEMENT_SCORES[settlementModel];
  const executionCertaintyScore = REDEMPTION_EXECUTION_SCORES[config.executionModel];
  const outputAssetQualityScore = computeRedemptionOutputAssetQuality(
    config.outputAssetType,
    config.physicalCommodityDelivery?.deliveryTermsUnbounded,
  );
  return resolveRedemptionStaticFields(
    stablecoinId,
    { ...config, settlementModel },
    {
      accessScore,
      settlementScore,
      executionCertaintyScore,
      outputAssetQualityScore,
    },
    reserveSnapshotMetadata,
    now,
    liveMetadata,
    fiatReferences,
  );
}

export async function resolveRedemptionBackstopEntry(
  db: D1Database,
  asset: StablecoinData,
  dexLiquidityScore: number | null,
  now = Math.floor(Date.now() / 1000),
  options: RedemptionBackstopBuildOptions = {},
): Promise<RedemptionBackstopEntry | null> {
  const config = getRedemptionBackstopConfig(asset.id);
  if (!config) return null;

  return buildRedemptionBackstopEntry(
    db,
    asset.id,
    config,
    getCirculatingRawOrNull(asset),
    dexLiquidityScore,
    now,
    options,
  );
}

export async function buildRedemptionBackstopEntry(
  db: D1Database,
  stablecoinId: string,
  config: RedemptionBackstopConfig,
  supplyUsd: number | null,
  dexLiquidityScore: number | null,
  now = Math.floor(Date.now() / 1000),
  options: RedemptionBackstopBuildOptions = {},
): Promise<RedemptionBackstopEntry> {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("Redemption run aborted");
  const observerModel = config.capacityModel.kind === "executable-observer" ? config.capacityModel : null;
  const descriptor = observerModel ? getExecutableRedemptionObserver(observerModel.observerId) : null;
  if (observerModel && (!descriptor || descriptor.coinId !== stablecoinId || descriptor.sourceLane !== "direct" ||
      observerModel.requiredOutputAssetKeys.length !== descriptor.outputAssetKeys.length ||
      !observerModel.requiredOutputAssetKeys.every((key) => descriptor.outputAssetKeys.includes(key)))) {
    throw new Error(`${stablecoinId} executable observer registry mismatch`);
  }
  const reserveSnapshotMetadata = observerModel
    ? null
    : options.reserveSnapshotMetadata !== undefined
      ? options.reserveSnapshotMetadata
      : await getLatestSuccessfulReserveSnapshotMetadata(db, stablecoinId);
  const meta = descriptor ? WORKER_TRACKED_META_BY_ID.get(stablecoinId) : null;
  const contractAddress = descriptor && meta ? resolveCoinContractAddress(meta, descriptor.chain) : null;
  if (descriptor && (!contractAddress || contractAddress.toLowerCase() !== descriptor.inputContract.toLowerCase())) {
    throw new Error(`${stablecoinId} executable observer tracked contract mismatch`);
  }
  const directObservation = descriptor && contractAddress
    ? options.executableRedemptionObservation ?? await observeExecutableRedemptionRoute(
        stablecoinId, contractAddress, options.signal ?? new AbortController().signal,
        options.adapterContext, { rpcOptions: options.rpcOptions, nowSec: now }, descriptor.observerId,
      )
    : null;
  if (observerModel && !directObservation) throw new Error(`${stablecoinId} executable observer unavailable`);
  const cache = options.stablecoinsCache;
  const outputKey = observerModel?.requiredOutputAssetKeys.length === 1 ? observerModel.requiredOutputAssetKeys[0] : null;
  const outputAsset = cache?.kind === "ok" && outputKey
    ? cache.payload.peggedAssets.find((asset) => asset.id === outputKey)
    : null;
  const outputPrice = outputAsset?.price;
  const executableObserverValuation = options.executableObserverValuation ?? (
    cache?.kind === "ok" && outputKey && typeof outputPrice === "number" && Number.isFinite(outputPrice) &&
    outputPrice > 0 && Number.isSafeInteger(cache.updatedAt) && cache.updatedAt > 0 &&
    cache.updatedAt <= now && now - cache.updatedAt <= STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC
      ? { outputAssetKey: outputKey, priceUsd: outputPrice, observedAt: cache.updatedAt }
      : null
  );
  let observedLiveMetadata = observerModel
    ? readRedemptionBackstopLiveMetadata(stablecoinId, null, now)
    : options.redemptionLiveMetadata ?? readRedemptionBackstopLiveMetadata(stablecoinId, reserveSnapshotMetadata, now);
  if (directObservation) {
    observedLiveMetadata = {
      ...observedLiveMetadata,
      canUseFee: directObservation.feeBps != null,
      feeReason: directObservation.feeBps == null ? "redemption-fee-unavailable" : null,
      redemptionFeeBps: directObservation.feeBps,
      routeStatus: directObservation.routeStatus,
      routeStatusSource: directObservation.routeStatusSource,
      routeStatusReason: directObservation.routeStatusReason,
      liveHolderEligibility: directObservation.holderEligibility,
      outputAssetKeys: directObservation.outputAssetKeys,
    };
  }
  const requiredOutputKeys = observerModel?.requiredOutputAssetKeys ?? (
    config.capacityModel.kind === "reserve-sync-metadata" ? config.capacityModel.requiredOutputAssetKeys : undefined
  );
  const observedOutputKeys = observedLiveMetadata.outputAssetKeys;
  const outputBound = !requiredOutputKeys || (
    Array.isArray(observedOutputKeys) &&
    observedOutputKeys.length === requiredOutputKeys.length &&
    requiredOutputKeys.every((key) => observedOutputKeys.includes(key))
  );
  // Source-owned adverse route observations are separate from favorable payout
  // terms; rejecting a positive claim must not hide an observed pause.
  const preserveAdverseStatus = observedLiveMetadata.routeStatus != null &&
    observedLiveMetadata.routeStatus !== "open" && observedLiveMetadata.routeStatusSource != null;
  const liveMetadata = outputBound ? observedLiveMetadata : {
    ...observedLiveMetadata,
    canUseCapacity: false,
    canUseFee: false,
    capacityReason: "route-output-identity-unobserved",
    capacityRejectionReason: "route-output-identity-unobserved" as const,
    feeReason: "route-output-identity-unobserved",
    immediateRedeemableUsd: null,
    immediateRedeemableRatio: null,
    settlementDelaySec: null,
    dailyLimitUsd: null,
    queueDepthUsd: null,
    minRedeemUsd: null,
    redemptionFeeBps: null,
    buyFeeBpsMin: null,
    buyFeeBpsMax: null,
    routeStatus: preserveAdverseStatus ? observedLiveMetadata.routeStatus : null,
    routeStatusSource: preserveAdverseStatus ? observedLiveMetadata.routeStatusSource : null,
    routeStatusReason: preserveAdverseStatus ? observedLiveMetadata.routeStatusReason : null,
    routeStatusReviewedAt: preserveAdverseStatus ? observedLiveMetadata.routeStatusReviewedAt : null,
    liveHolderEligibility: null,
    v9FpiControllerRouteState: null,
    v9SfrxusdCrosschainRouteState: null,
    v9OutputValuation: null,
  };
  const capacity = await resolveRedemptionCapacity(db, stablecoinId, config.capacityModel, supplyUsd, now, {
    ...options,
    reserveSnapshotMetadata,
    redemptionLiveMetadata: liveMetadata,
    executableRedemptionObservation: directObservation,
    executableObserverValuation,
  });
  const capacityScoring = computeCapacityScore({
    immediateCapacityUsd: capacity.scoringCapacityUsd,
    immediateCapacityRatio: capacity.scoringCapacityRatio,
    absoluteOnlyMode: capacity.capacityScoreMode,
  });
  const constrainedCapacityScoring = applyCapacityConstraintScoreEffects({
    capacityScore: capacityScoring.score,
    scoringCapacityUsd: capacity.scoringCapacityUsd,
    settlementDelaySec: capacity.settlementDelaySec,
    queueDepthUsd: capacity.queueDepthUsd,
    minRedeemUsd: capacity.minRedeemUsd,
    liveHolderEligibility: capacity.liveHolderEligibility,
  });
  const modeledExitSizeUsd = computeModeledExitSizeUsd(supplyUsd);
  let fiatReferences: RedemptionFiatReferenceContext | undefined;
  if (cache?.kind === "ok" && cache.updatedAt <= now &&
      now - cache.updatedAt <= STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC &&
      (config.costModel.feeComponents || config.v9RouteCostTerms?.feeComponents ||
        (config.routeFamily === "offchain-issuer" && WORKER_TRACKED_META_BY_ID.get(stablecoinId)?.flags.pegCurrency !== "USD"))) {
    const currentPegObservations = deriveCurrentPegObservationMap({
      peggedAssets: cache.payload.peggedAssets, fxFallbackRates: cache.payload.fxFallbackRates, asOf: cache.updatedAt,
    });
    fiatReferences = { clockSec: now, pegDataById: Object.fromEntries(
      [...currentPegObservations].map(([id, observation]) => [id, { ...observation,
        pegCurrency: WORKER_TRACKED_META_BY_ID.get(id)!.flags.pegCurrency }]),
    ) };
  }
  const staticFields = resolveStaticFields(stablecoinId, config, reserveSnapshotMetadata, now, liveMetadata, fiatReferences);
  const settlementModel = resolveReviewedRedemptionSettlement(config, now);
  const scored = computeRedemptionBackstopScore({
    routeFamily: config.routeFamily,
    accessScore: staticFields.accessScore,
    settlementScore: staticFields.settlementScore,
    executionCertaintyScore: staticFields.executionCertaintyScore,
    capacityScore: constrainedCapacityScoring.score,
    outputAssetQualityScore: staticFields.outputAssetQualityScore,
    costScore: staticFields.costScore,
    totalScoreCap: config.totalScoreCap,
    executableCapacityUsd: capacity.scoringCapacityUsd,
    modeledExitSizeUsd,
  });
  const eventualCapacityScoring = computeCapacityScore({
    immediateCapacityUsd: capacity.settlementBoundUnproven ? null : capacity.eventualCapacityUsd ?? null,
    immediateCapacityRatio: capacity.settlementBoundUnproven ? null : capacity.eventualCapacityRatio ?? null,
  });
  const eventualRedeemabilityScore =
    eventualCapacityScoring.score == null
      ? null
      : computeRedemptionBackstopScore({
          routeFamily: config.routeFamily,
          accessScore: staticFields.accessScore,
          settlementScore: staticFields.settlementScore,
          executionCertaintyScore: staticFields.executionCertaintyScore,
          capacityScore: eventualCapacityScoring.score,
          outputAssetQualityScore: staticFields.outputAssetQualityScore,
          costScore: staticFields.costScore,
          totalScoreCap: config.totalScoreCap,
          executableCapacityUsd: capacity.eventualCapacityUsd ?? null,
          modeledExitSizeUsd,
        }).score;
  let resolutionState: RedemptionBackstopEntry["resolutionState"] =
    scored.score != null
      ? "resolved"
      : capacity.resolutionState === "resolved" && eventualRedeemabilityScore == null
        ? "missing-capacity"
        : capacity.resolutionState;
  let score = scored.score;
  let capsApplied = [...constrainedCapacityScoring.capsApplied, ...scored.capsApplied];
  const holderEligibility = config.holderEligibility ?? resolveDefaultHolderEligibility(config);
  const hasStrongLiveDirectRoute = isStrongLiveDirectRoute({
    capacityConfidence: capacity.capacityConfidence,
    capacityKind: capacity.capacityKind,
    sourceMode: capacity.sourceMode,
    accessModel: config.accessModel,
    settlementModel,
  });
  const routeSuspension = resolveReviewedRouteSuspension(config, `redemption:${stablecoinId}:${config.routeFamily}`, now);
  const staticRouteStatus: RedemptionRouteStatusEvidence = {
    routeStatus: routeSuspension ? "suspended" :
      capacity.routeStatus === "unknown" && !capacity.routeStatusSource
        ? "unknown"
        : resolutionState === "resolved"
          ? (config.routeStatus === "suspended" ? "unknown" : config.routeStatus ?? "open")
          : "unknown",
    routeStatusSource: routeSuspension ? "operator-notice" : "static-config",
    ...(routeSuspension ? { routeStatusReason: routeSuspension.reason, routeStatusReviewedAt: routeSuspension.reviewedAt } : {}),
  };
  const liveRouteStatus: RedemptionRouteStatusEvidence | null =
    directObservation && liveMetadata.routeStatus && liveMetadata.routeStatusSource
      ? {
          routeStatus: liveMetadata.routeStatus,
          routeStatusSource: liveMetadata.routeStatusSource,
          ...(liveMetadata.routeStatusReason ? { routeStatusReason: liveMetadata.routeStatusReason } : {}),
        }
      : capacity.routeStatus && capacity.routeStatusSource
      ? {
          routeStatus: capacity.routeStatus,
          routeStatusSource: capacity.routeStatusSource,
          ...(capacity.routeStatusReason ? { routeStatusReason: capacity.routeStatusReason } : {}),
          ...(capacity.routeStatusReviewedAt ? { routeStatusReviewedAt: capacity.routeStatusReviewedAt } : {}),
        }
      : null;
  const mergedRouteStatus = mergeRedemptionRouteStatus({
    staticEvidence: staticRouteStatus,
    liveEvidence: routeSuspension ? null : liveRouteStatus,
    severeMarketImplied: routeSuspension ? null : options.routeAvailability ?? null,
    allowSevereMarketOpenException: hasStrongLiveDirectRoute && liveRouteStatus?.routeStatus === "open",
  });
  const routeStatus = mergedRouteStatus.routeStatus;
  const routeStatusSource = mergedRouteStatus.routeStatusSource;
  const routeStatusReason = mergedRouteStatus.routeStatusReason;
  const routeStatusReviewedAt = mergedRouteStatus.routeStatusReviewedAt;

  if (mergedRouteStatus.impaired && (resolutionState === "resolved" || options.routeAvailability != null)) {
    resolutionState = "impaired";
    score = null;
    const translatedCaps = mergedRouteStatus.capsApplied.map((cap) =>
      cap === "route-status-impairment" ? "live-route-status-impairment" : cap,
    );
    capsApplied = [...capsApplied, ...translatedCaps];
  }

  const routeExitCorrelation = config.routeExitCorrelation ?? inferDefaultRouteExitCorrelation(config);
  const baseCapacityProfile = capacity.capacityProfile
    ? {
        ...capacity.capacityProfile,
        ...(modeledExitSizeUsd != null ? { modeledExitSizeUsd } : {}),
        ...(capacity.settlementBoundUnproven ? { settlementBoundUnproven: true as const } : {}),
      }
    : undefined;
  const exitRouteObservation = liveMetadata.v9SfrxusdCrosschainRouteState
    ? buildSfrxusdCrosschainV9ExitRouteObservation({
        state: liveMetadata.v9SfrxusdCrosschainRouteState,
        modeledExitSizeUsd,
        routeStatus,
        resolutionState,
        now,
      })
    : (liveMetadata.v9FpiControllerRouteState
        ? buildFpiControllerV9ExitRouteObservation({
            state: liveMetadata.v9FpiControllerRouteState,
            modeledExitSizeUsd,
            routeStatus,
            resolutionState,
            now,
          })
        : null) ??
      buildRedemptionExitRouteObservation({
        stablecoinId,
        config: { ...config, settlementModel },
        capacityProfile: baseCapacityProfile,
        scoringCapacityUsd: capacity.scoringCapacityUsd,
        supplyUsd,
        routeStatus,
        resolutionState,
        sourceMode: capacity.sourceMode,
        capacityConfidence: capacity.capacityConfidence,
        ...(capacity.capacityKind ? { capacityKind: capacity.capacityKind } : {}),
        ...(capacity.freshnessKind ? { freshnessKind: capacity.freshnessKind } : {}),
        ...(capacity.evidenceObservedAt != null ? { evidenceObservedAt: capacity.evidenceObservedAt } : {}),
        ...(capacity.settlementDelaySec != null ? { settlementDelaySec: capacity.settlementDelaySec } : {}),
        ...(capacity.settlementBoundUnproven
          ? { settlementBoundUnproven: true }
          : {}),
        ...(liveMetadata.v9OutputValuation ? { outputValuation: liveMetadata.v9OutputValuation } : {}),
        ...(capacity.sharedResourceKey ? { sharedResourceKey: capacity.sharedResourceKey } : {}),
        resolvedFeeBps: observerModel ? (outputBound ? directObservation?.allInFeeBps ?? null : null) : staticFields.feeBps,
        fiatReferences,
        now,
      });
  const capacityProfile = baseCapacityProfile
    ? {
        ...baseCapacityProfile,
        ...(exitRouteObservation ? { exitRouteObservations: [exitRouteObservation] } : {}),
      }
    : undefined;
  const capacityBasis = resolveCapacityBasis(config.routeFamily, config.capacityModel, capacity.capacityConfidence);
  const confidence = deriveModelConfidenceWithDetails({
    resolutionState,
    capacityConfidence: capacity.capacityConfidence,
    feeConfidence: staticFields.feeConfidence,
    routeStatus,
    routeStatusSource,
    capacityUsd: capacity.immediateCapacityUsd,
    reviewedAt: config.reviewedAt,
    holderEligibility,
    sourceMode: capacity.sourceMode,
    freshnessKind: capacity.freshnessKind,
    now,
  });
  const modelConfidence = confidence.modelConfidence;
  const notes = dedupNotes([
    ...(config.notes ?? []),
    ...capacity.notes,
    ...staticFields.notes,
    ...mergedRouteStatus.notes,
    ...(directObservation
      ? [
          `${descriptor!.observerId} observation block ${directObservation.blockNumber}; native capacity state ${directObservation.capacityState}`,
          `${descriptor!.observerId} diagnostics: ${JSON.stringify(directObservation.diagnostics)}`,
        ]
      : []),
  ]);

  const entry: RedemptionBackstopEntry = {
    stablecoinId,
    ...(!observerModel && options.reserveInput && (
      (!routeSuspension && capacity.consumedReserveCapacity)
      || staticFields.selectedLiveFee
      || (capacity.consumedReserveRouteStatus && !routeSuspension && mergedRouteStatus.routeStatus === capacity.routeStatus && (
        mergedRouteStatus.routeStatusSource === capacity.routeStatusSource
        || (capacity.routeStatus === "unknown" && !capacity.routeStatusSource && mergedRouteStatus.routeStatusSource === "static-config")
      ))
      || (!routeSuspension && exitRouteObservation && (liveMetadata.v9SfrxusdCrosschainRouteState || liveMetadata.v9FpiControllerRouteState || liveMetadata.v9OutputValuation))
    ) ? { reserveInput: options.reserveInput } : {}),
    score,
    dexLiquidityScore,
    accessScore: staticFields.accessScore,
    settlementScore: staticFields.settlementScore,
    executionCertaintyScore: staticFields.executionCertaintyScore,
    capacityScore: constrainedCapacityScoring.score,
    outputAssetQualityScore: staticFields.outputAssetQualityScore,
    costScore: staticFields.costScore,
    routeFamily: config.routeFamily,
    accessModel: config.accessModel,
    settlementModel,
    executionModel: config.executionModel,
    outputAssetType: config.outputAssetType,
    provider: capacity.provider,
    sourceMode: capacity.sourceMode,
    resolutionState,
    routeStatus,
    routeStatusSource,
    ...(routeStatusReason ? { routeStatusReason } : {}),
    ...(routeStatusReviewedAt ? { routeStatusReviewedAt } : {}),
    holderEligibility,
    capacityConfidence: capacity.capacityConfidence,
    ...(capacity.capacityRejectionReason ? { capacityRejectionReason: capacity.capacityRejectionReason } : {}),
    ...(capacityBasis ? { capacityBasis } : {}),
    capacitySemantics: capacity.capacitySemantics,
    feeConfidence: staticFields.feeConfidence,
    feeModelKind: staticFields.feeModelKind,
    modelConfidence,
    confidenceDetails: confidence.confidenceDetails,
    immediateCapacityUsd: capacity.immediateCapacityUsd,
    immediateCapacityRatio: capacity.immediateCapacityRatio,
    ...(capacityProfile ? { capacityProfile } : {}),
    eventualRedeemabilityScore,
    ...(capacity.capacityKind ? { capacityKind: capacity.capacityKind } : {}),
    ...(capacity.freshnessKind ? { freshnessKind: capacity.freshnessKind } : {}),
    ...(capacity.sourceTimestamp != null ? { sourceTimestamp: capacity.sourceTimestamp } : {}),
    ...(capacity.sourceUrls && capacity.sourceUrls.length > 0 ? { sourceUrls: capacity.sourceUrls } : {}),
    ...(capacity.settlementDelaySec != null ? { settlementDelaySec: capacity.settlementDelaySec } : {}),
    ...(capacity.queueDepthUsd != null ? { queueDepthUsd: capacity.queueDepthUsd } : {}),
    ...(capacity.dailyLimitUsd != null ? { dailyLimitUsd: capacity.dailyLimitUsd } : {}),
    ...(capacity.minRedeemUsd != null ? { minRedeemUsd: capacity.minRedeemUsd } : {}),
    ...(capacity.liveHolderEligibility ? { liveHolderEligibility: capacity.liveHolderEligibility } : {}),
    feeBps: staticFields.feeBps,
    feeDescription: staticFields.feeDescription,
    ...(staticFields.costScenarioScores ? { costScenarioScores: staticFields.costScenarioScores } : {}),
    routeExitCorrelation,
    queueEnabled: staticFields.queueEnabled,
    methodologyVersion: REDEMPTION_BACKSTOP_METHODOLOGY_VERSION,
    updatedAt: now,
    ...(directObservation && outputBound ? {
      sourceTimestamp: directObservation.sourceTimestamp,
      sourceUrls: directObservation.sourceUrls,
      freshnessKind: directObservation.freshnessKind,
    } : {}),
    ...(staticFields.docs ? { docs: staticFields.docs } : {}),
    notes,
    capsApplied,
  };
  // Deduplicate the selected public provenance list without rewriting retained evidence.
  if (entry.sourceUrls && entry.sourceUrls.length > 1) {
    entry.sourceUrls = [...new Set(entry.sourceUrls)];
  }
  if (routeSuspension) {
    // Unavailable on this rail, not measured zero; separately produced channels remain independent.
    entry.score = null;
    entry.capacityScore = null;
    entry.eventualRedeemabilityScore = null;
    entry.immediateCapacityUsd = null;
    entry.immediateCapacityRatio = null;
    entry.resolutionState = "impaired";
    if (entry.capacityProfile) {
      entry.capacityProfile = {
        scoringHorizon: "unknown",
        capacityProfileConfidence: entry.capacityProfile.capacityProfileConfidence,
        immediateUsd: null, dailyLimitUsd: null, queuedUsd: null, eventualUsd: null, scoringUsd: null,
        ...(modeledExitSizeUsd != null ? { modeledExitSizeUsd } : {}),
      };
    }
    entry.capsApplied = ["reviewed-route-suspension"];
  }
  let finalizedEntry = entry;
  if (entry.capacityProfile && !entry.capacityProfile.exitRouteObservations) {
    const derived = deriveSupplyModelExitRouteObservation(entry, now, fiatReferences, config);
    if (derived) {
      finalizedEntry = { ...entry, capacityProfile: { ...entry.capacityProfile, exitRouteObservations: [derived] } };
    }
  }
  const executionRoutes = await observeReviewedExitExecutionRoutes({
    assetId: stablecoinId, circulatingUsd: supplyUsd, clockSec: now, db, signal: options.signal, rpcOptions: options.rpcOptions,
    stablecoinsCache: options.stablecoinsCache, envelope: options.exitExecutionEnvelope, reviews: options.exitExecutionReviews,
  });
  if (executionRoutes.observations.length > 0) {
    finalizedEntry = { ...finalizedEntry, capacityProfile: {
      ...(finalizedEntry.capacityProfile ?? { scoringHorizon: "unknown", capacityProfileConfidence: "heuristic" }),
      exitRouteObservations: [...(finalizedEntry.capacityProfile?.exitRouteObservations ?? []), ...executionRoutes.observations],
    } };
  }
  return finalizedEntry;
}

function inferDefaultRouteExitCorrelation(
  config: Pick<RedemptionBackstopConfig, "routeFamily" | "outputAssetType">,
): RedemptionBackstopEntry["routeExitCorrelation"] {
  if (config.routeFamily === "offchain-issuer") return "independent-issuer-rail";
  if (config.routeFamily === "psm-swap") return "same-stablecoin-pool-backing";
  if (config.routeFamily === "stablecoin-redeem" && config.outputAssetType === "stable-single") {
    return "wrapper-to-parent-dependency";
  }
  if (config.routeFamily === "basket-redeem" || config.routeFamily === "collateral-redeem") {
    return "same-protocol-liquidity";
  }
  return "unknown";
}

function dedupNotes(notes: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const note of notes) {
    if (seen.has(note)) continue;
    seen.add(note);
    out.push(note);
  }
  return out;
}

export function buildFailedRedemptionBackstopEntry(
  stablecoinId: string,
  config: RedemptionBackstopConfig,
  now = Math.floor(Date.now() / 1000),
): RedemptionBackstopEntry {
  const staticFields = resolveStaticFields(stablecoinId, config);
  const settlementModel = resolveReviewedRedemptionSettlement(config, now);
  // A failed row contains no admitted measurement, regardless of declared capabilities.
  const capacityConfidence = "heuristic" as const;
  const capacityBasis = resolveCapacityBasis(config.routeFamily, config.capacityModel, capacityConfidence);
  const capacitySemantics = resolveCapacitySemantics(config.capacityModel);
  const resolutionState: RedemptionBackstopEntry["resolutionState"] = "failed";
  const holderEligibility = config.holderEligibility ?? resolveDefaultHolderEligibility(config);

  const entry: RedemptionBackstopEntry = {
    stablecoinId,
    score: null,
    dexLiquidityScore: null,
    accessScore: staticFields.accessScore,
    settlementScore: staticFields.settlementScore,
    executionCertaintyScore: staticFields.executionCertaintyScore,
    capacityScore: null,
    outputAssetQualityScore: staticFields.outputAssetQualityScore,
    costScore: staticFields.costScore,
    routeFamily: config.routeFamily,
    accessModel: config.accessModel,
    settlementModel,
    executionModel: config.executionModel,
    outputAssetType: config.outputAssetType,
    provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.SYNC_ERROR,
    sourceMode: "static",
    resolutionState,
    routeStatus: "unknown",
    routeStatusSource: "static-config",
    holderEligibility,
    capacityConfidence,
    ...(capacityBasis ? { capacityBasis } : {}),
    capacitySemantics,
    feeConfidence: staticFields.feeConfidence,
    feeModelKind: staticFields.feeModelKind,
    modelConfidence: deriveModelConfidence({
      resolutionState,
      capacityConfidence,
      feeConfidence: staticFields.feeConfidence,
    }),
    immediateCapacityUsd: null,
    immediateCapacityRatio: null,
    feeBps: staticFields.feeBps,
    feeDescription: staticFields.feeDescription,
    queueEnabled: staticFields.queueEnabled,
    methodologyVersion: REDEMPTION_BACKSTOP_METHODOLOGY_VERSION,
    updatedAt: now,
    ...(staticFields.docs ? { docs: staticFields.docs } : {}),
    notes: [
      ...(config.notes ?? []),
      "Latest redemption-backstop sync failed; stale resolved data was intentionally cleared until the next successful refresh",
    ],
    capsApplied: [],
  };
  return entry;
}
