import { sumPegBuckets } from "@shared/lib/supply";
import {
  deriveModelConfidenceWithDetails,
  deriveModelConfidence,
  resolveCapacityConfidence,
  resolveCapacitySemantics,
} from "@shared/lib/redemption-backstop-confidence";
import {
  applyCapacityConstraintScoreEffects,
  computeCapacityScore,
  computeEffectiveExitScore,
  computeModeledExitSizeUsd,
  computeRedemptionBackstopScore,
  isStrongLiveDirectRoute,
  REDEMPTION_ACCESS_SCORES,
  REDEMPTION_EXECUTION_SCORES,
  REDEMPTION_OUTPUT_ASSET_SCORES,
  REDEMPTION_SETTLEMENT_SCORES,
} from "@shared/lib/redemption-backstop-scoring";
import { getRedemptionBackstopConfig, type RedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { resolveDefaultHolderEligibility } from "@shared/lib/redemption-backstop-configs/shared";
import { REDEMPTION_BACKSTOP_PROVIDER_IDS } from "@shared/lib/redemption-backstop-providers";
import { REDEMPTION_BACKSTOP_METHODOLOGY_VERSION } from "@shared/lib/redemption-backstop-version";
import type { StablecoinData } from "@shared/types/market";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import { getLatestSuccessfulReserveSnapshotMetadata, type ReserveSnapshotMetadataRecord } from "./live-reserves-store";
import {
  resolveCapacityBasis,
  resolveRedemptionCapacity,
  resolveReserveSyncCapacityConfidence,
  type RedemptionBackstopBuildOptions,
} from "./redemption-backstop-capacity";
import { mergeRedemptionRouteStatus, type RedemptionRouteStatusEvidence } from "./redemption-backstop-route-status";
import { resolveRedemptionStaticFields } from "./redemption-backstop-cost";
import {
  readRedemptionBackstopLiveMetadata,
  type RedemptionBackstopLiveMetadata,
} from "./redemption-backstop-live-metadata";
import {
  buildRedemptionExitRouteObservation,
  deriveSupplyModelExitRouteObservation,
} from "./redemption-exit-route-observations";

function resolveStaticFields(
  stablecoinId: string,
  config: RedemptionBackstopConfig,
  reserveSnapshotMetadata?: ReserveSnapshotMetadataRecord | null,
  now = Math.floor(Date.now() / 1000),
  liveMetadata?: RedemptionBackstopLiveMetadata,
) {
  const accessScore = REDEMPTION_ACCESS_SCORES[config.accessModel];
  const settlementScore = REDEMPTION_SETTLEMENT_SCORES[config.settlementModel];
  const executionCertaintyScore = REDEMPTION_EXECUTION_SCORES[config.executionModel];
  const outputAssetQualityScore = REDEMPTION_OUTPUT_ASSET_SCORES[config.outputAssetType];
  return resolveRedemptionStaticFields(
    stablecoinId,
    config,
    {
      accessScore,
      settlementScore,
      executionCertaintyScore,
      outputAssetQualityScore,
    },
    reserveSnapshotMetadata,
    now,
    liveMetadata,
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
    sumPegBuckets(asset.circulating),
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
  const reserveSnapshotMetadata =
    options.reserveSnapshotMetadata !== undefined
      ? options.reserveSnapshotMetadata
      : await getLatestSuccessfulReserveSnapshotMetadata(db, stablecoinId);
  const liveMetadata =
    options.redemptionLiveMetadata ?? readRedemptionBackstopLiveMetadata(stablecoinId, reserveSnapshotMetadata, now);
  const capacity = await resolveRedemptionCapacity(db, stablecoinId, config.capacityModel, supplyUsd, now, {
    ...options,
    reserveSnapshotMetadata,
    redemptionLiveMetadata: liveMetadata,
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
  const staticFields = resolveStaticFields(stablecoinId, config, reserveSnapshotMetadata, now, liveMetadata);
  const scored = computeRedemptionBackstopScore({
    routeFamily: config.routeFamily,
    accessScore: staticFields.accessScore,
    settlementScore: staticFields.settlementScore,
    executionCertaintyScore: staticFields.executionCertaintyScore,
    capacityScore: constrainedCapacityScoring.score,
    outputAssetQualityScore: staticFields.outputAssetQualityScore,
    costScore: staticFields.costScore,
    totalScoreCap: config.totalScoreCap,
  });
  const eventualCapacityScoring = computeCapacityScore({
    immediateCapacityUsd: capacity.eventualCapacityUsd ?? null,
    immediateCapacityRatio: capacity.eventualCapacityRatio ?? null,
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
    settlementModel: config.settlementModel,
  });
  const staticRouteStatus: RedemptionRouteStatusEvidence = {
    routeStatus:
      capacity.routeStatus === "unknown" && !capacity.routeStatusSource
        ? "unknown"
        : resolutionState === "resolved"
          ? (config.routeStatus ?? "open")
          : "unknown",
    routeStatusSource: "static-config",
  };
  const liveRouteStatus: RedemptionRouteStatusEvidence | null =
    capacity.routeStatus && capacity.routeStatusSource
      ? {
          routeStatus: capacity.routeStatus,
          routeStatusSource: capacity.routeStatusSource,
          ...(capacity.routeStatusReason ? { routeStatusReason: capacity.routeStatusReason } : {}),
          ...(capacity.routeStatusReviewedAt ? { routeStatusReviewedAt: capacity.routeStatusReviewedAt } : {}),
        }
      : null;
  const mergedRouteStatus = mergeRedemptionRouteStatus({
    staticEvidence: staticRouteStatus,
    liveEvidence: liveRouteStatus,
    severeMarketImplied: options.routeAvailability ?? null,
    allowSevereMarketOpenException: hasStrongLiveDirectRoute,
  });
  const routeStatus = mergedRouteStatus.routeStatus;
  const routeStatusSource = mergedRouteStatus.routeStatusSource;
  const routeStatusReason = mergedRouteStatus.routeStatusReason;
  const routeStatusReviewedAt = mergedRouteStatus.routeStatusReviewedAt;

  if (resolutionState === "resolved" && mergedRouteStatus.impaired) {
    resolutionState = "impaired";
    score = null;
    const translatedCaps = mergedRouteStatus.capsApplied.map((cap) =>
      cap === "route-status-impairment" ? "live-route-status-impairment" : cap,
    );
    capsApplied = [...capsApplied, ...translatedCaps];
  }

  const routeExitCorrelation = config.routeExitCorrelation ?? inferDefaultRouteExitCorrelation(config);
  const modeledExitSizeUsd = computeModeledExitSizeUsd(supplyUsd);
  const baseCapacityProfile = capacity.capacityProfile
    ? {
        ...capacity.capacityProfile,
        ...(modeledExitSizeUsd != null ? { modeledExitSizeUsd } : {}),
      }
    : undefined;
  const exitRouteObservation = buildRedemptionExitRouteObservation({
    stablecoinId,
    config,
    capacityProfile: baseCapacityProfile,
    scoringCapacityUsd: capacity.scoringCapacityUsd,
    supplyUsd,
    routeStatus,
    resolutionState,
    sourceMode: capacity.sourceMode,
    capacityConfidence: capacity.capacityConfidence,
    ...(capacity.capacityKind ? { capacityKind: capacity.capacityKind } : {}),
    ...(capacity.freshnessKind ? { freshnessKind: capacity.freshnessKind } : {}),
    ...(capacity.sourceTimestamp != null ? { sourceTimestamp: capacity.sourceTimestamp } : {}),
    ...(capacity.settlementDelaySec != null ? { settlementDelaySec: capacity.settlementDelaySec } : {}),
    resolvedFeeBps: staticFields.feeBps,
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
    reviewedAt: config.reviewedAt,
    holderEligibility,
    sourceMode: capacity.sourceMode,
    freshnessKind: capacity.freshnessKind,
    now,
  });
  const modelConfidence = confidence.modelConfidence;
  const effectiveExitScore =
    resolutionState === "resolved"
      ? computeEffectiveExitScore(dexLiquidityScore, score, {
          circulatingSupplyUsd: supplyUsd,
          currentExecutableCapacityUsd: capacity.scoringCapacityUsd,
          routeExitCorrelation,
          modelConfidence,
        })
      : null;
  const notes = dedupNotes([
    ...(config.notes ?? []),
    ...capacity.notes,
    ...staticFields.notes,
    ...mergedRouteStatus.notes,
  ]);

  const entry: RedemptionBackstopEntry = {
    stablecoinId,
    score,
    effectiveExitScore,
    dexLiquidityScore,
    accessScore: staticFields.accessScore,
    settlementScore: staticFields.settlementScore,
    executionCertaintyScore: staticFields.executionCertaintyScore,
    capacityScore: constrainedCapacityScoring.score,
    outputAssetQualityScore: staticFields.outputAssetQualityScore,
    costScore: staticFields.costScore,
    routeFamily: config.routeFamily,
    accessModel: config.accessModel,
    settlementModel: config.settlementModel,
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
    ...(staticFields.docs ? { docs: staticFields.docs } : {}),
    notes,
    capsApplied,
  };
  if (entry.capacityProfile && !entry.capacityProfile.exitRouteObservations) {
    const derived = deriveSupplyModelExitRouteObservation(entry, now);
    if (derived) {
      return { ...entry, capacityProfile: { ...entry.capacityProfile, exitRouteObservations: [derived] } };
    }
  }
  return entry;
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
  const capacityConfidence =
    config.capacityModel.kind === "reserve-sync-metadata"
      ? resolveReserveSyncCapacityConfidence(stablecoinId)
      : resolveCapacityConfidence(config.capacityModel);
  const capacityBasis = resolveCapacityBasis(config.routeFamily, config.capacityModel, capacityConfidence);
  const capacitySemantics = resolveCapacitySemantics(config.capacityModel);
  const resolutionState: RedemptionBackstopEntry["resolutionState"] = "failed";
  const holderEligibility = config.holderEligibility ?? resolveDefaultHolderEligibility(config);

  return {
    stablecoinId,
    score: null,
    effectiveExitScore: null,
    dexLiquidityScore: null,
    accessScore: staticFields.accessScore,
    settlementScore: staticFields.settlementScore,
    executionCertaintyScore: staticFields.executionCertaintyScore,
    capacityScore: null,
    outputAssetQualityScore: staticFields.outputAssetQualityScore,
    costScore: staticFields.costScore,
    routeFamily: config.routeFamily,
    accessModel: config.accessModel,
    settlementModel: config.settlementModel,
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
}
