import { sumPegBuckets } from "@shared/lib/supply";
import {
  deriveModelConfidence,
  resolveCapacityConfidence,
  resolveCapacitySemantics,
} from "@shared/lib/redemption-backstop-confidence";
import {
  computeCapacityScore,
  computeEffectiveExitScore,
  computeRedemptionBackstopScore,
  REDEMPTION_ACCESS_SCORES,
  REDEMPTION_EXECUTION_SCORES,
  REDEMPTION_OUTPUT_ASSET_SCORES,
  REDEMPTION_SETTLEMENT_SCORES,
} from "@shared/lib/redemption-backstop-scoring";
import {
  getRedemptionBackstopConfig,
  type RedemptionBackstopConfig,
} from "@shared/lib/redemption-backstops";
import { resolveDefaultHolderEligibility } from "@shared/lib/redemption-backstop-configs/shared";
import { REDEMPTION_BACKSTOP_VERSION } from "@shared/lib/redemption-backstop-version";
import type { StablecoinData } from "@shared/types/market";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import {
  getLatestSuccessfulReserveSnapshotMetadata,
  type ReserveSnapshotMetadataRecord,
} from "./live-reserves-store";
import {
  resolveCapacityBasis,
  resolveRedemptionCapacity,
  resolveReserveSyncCapacityConfidence,
  type RedemptionBackstopBuildOptions,
} from "./redemption-backstop-capacity";
import { resolveRedemptionStaticFields } from "./redemption-backstop-cost";

function resolveStaticFields(
  stablecoinId: string,
  config: RedemptionBackstopConfig,
  reserveSnapshotMetadata?: ReserveSnapshotMetadataRecord | null,
  now = Math.floor(Date.now() / 1000),
){
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
  const capacity = await resolveRedemptionCapacity(db, stablecoinId, config.capacityModel, supplyUsd, now, {
    ...options,
    reserveSnapshotMetadata,
  });
  const capacityScoring = computeCapacityScore({
    immediateCapacityUsd: capacity.scoringCapacityUsd,
    immediateCapacityRatio: capacity.scoringCapacityRatio,
  });
  const staticFields = resolveStaticFields(stablecoinId, config, reserveSnapshotMetadata, now);
  const scored = computeRedemptionBackstopScore({
    routeFamily: config.routeFamily,
    accessScore: staticFields.accessScore,
    settlementScore: staticFields.settlementScore,
    executionCertaintyScore: staticFields.executionCertaintyScore,
    capacityScore: capacityScoring.score,
    outputAssetQualityScore: staticFields.outputAssetQualityScore,
    costScore: staticFields.costScore,
    totalScoreCap: config.totalScoreCap,
  });
  let resolutionState: RedemptionBackstopEntry["resolutionState"] =
    scored.score != null
      ? "resolved"
      : capacity.resolutionState === "resolved"
        ? "missing-capacity"
        : capacity.resolutionState;
  let score = scored.score;
  let capsApplied = scored.capsApplied;
  let routeStatus: RedemptionBackstopEntry["routeStatus"] =
    resolutionState === "resolved"
      ? config.routeStatus ?? "open"
      : "unknown";
  let routeStatusSource: RedemptionBackstopEntry["routeStatusSource"] = "static-config";
  let routeStatusReason: RedemptionBackstopEntry["routeStatusReason"];
  let routeStatusReviewedAt: RedemptionBackstopEntry["routeStatusReviewedAt"];
  const holderEligibility =
    config.holderEligibility ?? resolveDefaultHolderEligibility(config);
  const routeAvailability = options.routeAvailability;
  const hasStrongLiveDirectRoute =
    capacity.capacityConfidence === "live-direct" &&
    capacity.sourceMode === "dynamic" &&
    config.accessModel === "permissionless-onchain" &&
    (config.settlementModel === "atomic" || config.settlementModel === "immediate");
  const routeImpaired =
    resolutionState === "resolved" &&
    routeAvailability != null &&
    !hasStrongLiveDirectRoute;

  if (routeImpaired) {
    resolutionState = "impaired";
    score = null;
    routeStatus = routeAvailability.routeStatus;
    routeStatusSource = routeAvailability.routeStatusSource;
    routeStatusReason = routeAvailability.routeStatusReason;
    routeStatusReviewedAt = routeAvailability.routeStatusReviewedAt;
    capsApplied = [...capsApplied, "market-implied-depeg-impairment"];
  }

  const effectiveExitScore =
    resolutionState === "resolved" && !options.suppressEffectiveExitScore
      ? computeEffectiveExitScore(dexLiquidityScore, score)
      : null;
  const capacityBasis = resolveCapacityBasis(config.routeFamily, config.capacityModel, capacity.capacityConfidence);
  const modelConfidence = deriveModelConfidence({
    resolutionState,
    capacityConfidence: capacity.capacityConfidence,
    feeConfidence: staticFields.feeConfidence,
  });
  const notes = [
    ...(config.notes ?? []),
    ...capacity.notes,
    ...staticFields.notes,
    ...(routeStatusReason ? [routeStatusReason] : []),
  ];

  return {
    stablecoinId,
    score,
    effectiveExitScore,
    dexLiquidityScore,
    accessScore: staticFields.accessScore,
    settlementScore: staticFields.settlementScore,
    executionCertaintyScore: staticFields.executionCertaintyScore,
    capacityScore: capacityScoring.score,
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
    immediateCapacityUsd: capacity.immediateCapacityUsd,
    immediateCapacityRatio: capacity.immediateCapacityRatio,
    feeBps: staticFields.feeBps,
    feeDescription: staticFields.feeDescription,
    queueEnabled: staticFields.queueEnabled,
    methodologyVersion: REDEMPTION_BACKSTOP_VERSION,
    updatedAt: now,
    ...(staticFields.docs ? { docs: staticFields.docs } : {}),
    notes,
    capsApplied,
  };
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
  const holderEligibility =
    config.holderEligibility ?? resolveDefaultHolderEligibility(config);

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
    provider: "sync-error",
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
    methodologyVersion: REDEMPTION_BACKSTOP_VERSION,
    updatedAt: now,
    ...(staticFields.docs ? { docs: staticFields.docs } : {}),
    notes: [
      ...(config.notes ?? []),
      "Latest redemption-backstop sync failed; stale resolved data was intentionally cleared until the next successful refresh",
    ],
    capsApplied: [],
  };
}
