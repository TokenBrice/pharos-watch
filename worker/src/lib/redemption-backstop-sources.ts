import { getCirculatingRaw } from "@shared/lib/supply";
import {
  deriveModelConfidenceWithDetails,
  deriveModelConfidence,
  resolveCapacityConfidence,
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
  REDEMPTION_OUTPUT_ASSET_SCORES,
  REDEMPTION_SETTLEMENT_SCORES,
} from "@shared/lib/redemption-backstop-scoring";
import {
  getRedemptionBackstopConfig,
  resolveReviewedRedemptionSettlement,
  type RedemptionBackstopConfig,
} from "@shared/lib/redemption-backstops";
import { resolveDefaultHolderEligibility } from "@shared/lib/redemption-backstop-configs/shared";
import { REDEMPTION_BACKSTOP_PROVIDER_IDS } from "@shared/lib/redemption-backstop-providers";
import { REDEMPTION_BACKSTOP_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/redemption-backstop";
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
import { buildFpiControllerV9ExitRouteObservation } from "./fpi-controller-redemption-route";
import { buildSfrxusdCrosschainV9ExitRouteObservation } from "./sfrxusd-crosschain-redemption-route";

interface OutputDependencyResolutionParticipant {
  entry: RedemptionBackstopEntry;
  outputStablecoinIds: readonly string[];
}

interface OutputDependencyResolutionRun {
  participants: Map<string, OutputDependencyResolutionParticipant>;
}

const outputDependencyResolutionRuns = new Map<number, OutputDependencyResolutionRun>();
const MAX_OUTPUT_DEPENDENCY_RESOLUTION_RUNS = 4;

// The sync builds rows serially, then persists the completed array. Keeping the
// returned row references here lets either build order converge on the same
// snapshot-local disclosure without recursively re-running a dependency's
// capacity resolver or changing that dependency's score semantics.
function registerOutputDependencyResolution(
  entry: RedemptionBackstopEntry,
  config: RedemptionBackstopConfig,
  now: number,
): void {
  let run = outputDependencyResolutionRuns.get(now);
  if (!run || run.participants.has(entry.stablecoinId)) {
    run = { participants: new Map() };
    outputDependencyResolutionRuns.set(now, run);
  }

  const outputStablecoinIds = (config.outputAssets ?? []).filter((id) => !id.startsWith("asset:"));
  run.participants.set(entry.stablecoinId, { entry, outputStablecoinIds });

  for (const participant of run.participants.values()) {
    const unresolvedDependencyId = participant.outputStablecoinIds.find((dependencyId) => {
      const dependency = run!.participants.get(dependencyId)?.entry;
      return dependency != null && dependency.resolutionState !== "resolved";
    });
    if (unresolvedDependencyId) {
      participant.entry.outputDependencyResolution = {
        stablecoinId: unresolvedDependencyId,
        resolutionState: run.participants.get(unresolvedDependencyId)!.entry.resolutionState,
      };
    } else {
      delete participant.entry.outputDependencyResolution;
    }
  }

  while (outputDependencyResolutionRuns.size > MAX_OUTPUT_DEPENDENCY_RESOLUTION_RUNS) {
    const oldestRun = outputDependencyResolutionRuns.keys().next().value;
    if (oldestRun == null) break;
    outputDependencyResolutionRuns.delete(oldestRun);
  }
}

function resolveStaticFields(
  stablecoinId: string,
  config: RedemptionBackstopConfig,
  reserveSnapshotMetadata?: ReserveSnapshotMetadataRecord | null,
  now = Math.floor(Date.now() / 1000),
  liveMetadata?: RedemptionBackstopLiveMetadata,
) {
  const settlementModel = resolveReviewedRedemptionSettlement(config, now);
  const accessScore = REDEMPTION_ACCESS_SCORES[config.accessModel];
  const settlementScore = REDEMPTION_SETTLEMENT_SCORES[settlementModel];
  const executionCertaintyScore = REDEMPTION_EXECUTION_SCORES[config.executionModel];
  const outputAssetQualityScore = REDEMPTION_OUTPUT_ASSET_SCORES[config.outputAssetType];
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
    getCirculatingRaw(asset),
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
  const modeledExitSizeUsd = computeModeledExitSizeUsd(supplyUsd);
  const staticFields = resolveStaticFields(stablecoinId, config, reserveSnapshotMetadata, now, liveMetadata);
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
          executableCapacityUsd: capacity.eventualCapacityUsd,
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
        ...(capacity.sourceTimestamp != null ? { sourceTimestamp: capacity.sourceTimestamp } : {}),
        ...(capacity.settlementDelaySec != null ? { settlementDelaySec: capacity.settlementDelaySec } : {}),
        ...(capacity.settlementBoundUnproven ? { settlementBoundUnproven: true } : {}),
        ...(liveMetadata.v9OutputValuation ? { outputValuation: liveMetadata.v9OutputValuation } : {}),
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
  const notes = dedupNotes([
    ...(config.notes ?? []),
    ...capacity.notes,
    ...staticFields.notes,
    ...mergedRouteStatus.notes,
  ]);

  const entry: RedemptionBackstopEntry = {
    stablecoinId,
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
  let finalizedEntry = entry;
  if (entry.capacityProfile && !entry.capacityProfile.exitRouteObservations) {
    const derived = deriveSupplyModelExitRouteObservation(entry, now);
    if (derived) {
      finalizedEntry = { ...entry, capacityProfile: { ...entry.capacityProfile, exitRouteObservations: [derived] } };
    }
  }
  registerOutputDependencyResolution(finalizedEntry, config, now);
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
  const capacityConfidence =
    config.capacityModel.kind === "reserve-sync-metadata"
      ? resolveReserveSyncCapacityConfidence(stablecoinId)
      : resolveCapacityConfidence(config.capacityModel);
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
  registerOutputDependencyResolution(entry, config, now);
  return entry;
}
