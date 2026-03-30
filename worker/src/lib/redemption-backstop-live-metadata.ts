import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { RedemptionCapacityConfidence } from "@shared/types/redemption";
import type { LiveReserveWarning } from "@shared/types/live-reserves";
import type { ReserveSnapshotMetadataRecord } from "./live-reserves-store";
import { LIVE_RESERVE_FRESHNESS_SEC } from "./live-reserves-store";
import { SCORING_LIVE_RESERVE_EVIDENCE_CLASSES } from "./live-reserves-store-shared";
import { hasScoringEligibleLiveReserveFreshness } from "./live-reserves-store-parsing";

export interface RedemptionBackstopLiveMetadata {
  updatedAt: number | null;
  isFresh: boolean;
  hasScoringEligibleFreshness: boolean;
  hasBlockingWarnings: boolean;
  capacityConfidence: Exclude<RedemptionCapacityConfidence, "documented-bound" | "heuristic"> | null;
  canUseCapacity: boolean;
  canUseFee: boolean;
  capacityReason: string | null;
  feeReason: string | null;
  immediateRedeemableUsd: number | null;
  immediateRedeemableRatio: number | null;
  redemptionFeeBps: number | null;
  buyFeeBpsMin: number | null;
  buyFeeBpsMax: number | null;
}

function coerceFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasBlockingRedemptionWarnings(warnings: LiveReserveWarning[], warningCount: number): boolean {
  if (warningCount <= 0) return false;
  if (warnings.length === 0) return true;
  return warnings.some((warning) => warning.effect !== "info");
}

function resolveCapacityReason(args: {
  snapshotMetadata: ReserveSnapshotMetadataRecord | null | undefined;
  isFresh: boolean;
  hasBlockingWarnings: boolean;
  hasScoringEligibleFreshness: boolean;
  telemetryCapacity: "direct" | "proxy" | "none";
  fallbackTelemetryAvailable: boolean;
  stablecoinId: string;
}): string | null {
  if (!args.snapshotMetadata) return "Live reserve metadata unavailable";
  if (!args.isFresh) return "Live reserve metadata stale; fresh metadata required";
  if (args.snapshotMetadata.syncStatus !== "ok") return "Live reserve metadata degraded; latest snapshot not in ok state";
  if (args.hasBlockingWarnings) return "Live reserve metadata degraded by reserve warnings";
  if (!SCORING_LIVE_RESERVE_EVIDENCE_CLASSES.includes(args.snapshotMetadata.evidenceClass)) {
    return "Live reserve metadata uses weak or non-scoring evidence for redemption capacity";
  }
  if (!args.hasScoringEligibleFreshness) {
    return "Live reserve metadata lacks scoring-grade freshness evidence";
  }
  if (args.telemetryCapacity === "none" && !args.fallbackTelemetryAvailable) {
    return `Live reserve adapter for ${args.stablecoinId} does not expose redeemable-capacity telemetry`;
  }
  return null;
}

function resolveFeeReason(args: {
  snapshotMetadata: ReserveSnapshotMetadataRecord | null | undefined;
  isFresh: boolean;
  hasBlockingWarnings: boolean;
  hasScoringEligibleFreshness: boolean;
  telemetryFee: "current-bps" | "none";
  fallbackTelemetryAvailable: boolean;
  stablecoinId: string;
}): string | null {
  if (!args.snapshotMetadata) return "Live redemption fee telemetry unavailable";
  if (!args.isFresh) return "Live redemption fee telemetry stale; using reviewed fee model instead";
  if (args.snapshotMetadata.syncStatus !== "ok") return "Live redemption fee telemetry degraded; latest snapshot not in ok state";
  if (args.hasBlockingWarnings) return "Live redemption fee telemetry degraded by reserve warnings";
  if (!args.hasScoringEligibleFreshness) {
    return "Live redemption fee telemetry lacks trustworthy freshness evidence";
  }
  if (args.telemetryFee === "none" && !args.fallbackTelemetryAvailable) {
    return `Live reserve adapter for ${args.stablecoinId} does not expose redemption-fee telemetry`;
  }
  return null;
}

export function readRedemptionBackstopLiveMetadata(
  stablecoinId: string,
  snapshotMetadata: ReserveSnapshotMetadataRecord | null | undefined,
  now = Math.floor(Date.now() / 1000),
): RedemptionBackstopLiveMetadata {
  const metadata = snapshotMetadata?.metadata ?? {};
  const updatedAt = snapshotMetadata?.fetchedAt ?? null;
  const trackedMeta = TRACKED_META_BY_ID.get(stablecoinId);
  const adapterKey = trackedMeta?.liveReservesConfig?.adapter ?? null;
  const adapterDefinition = adapterKey ? getLiveReserveAdapterDefinition(adapterKey) : null;
  const isFresh = updatedAt != null && now - updatedAt <= LIVE_RESERVE_FRESHNESS_SEC;
  const hasScoringEligibleFreshness = hasScoringEligibleLiveReserveFreshness(metadata);
  const hasBlockingWarnings = hasBlockingRedemptionWarnings(
    snapshotMetadata?.warnings ?? [],
    snapshotMetadata?.warningCount ?? 0,
  );
  const telemetryCapacity = adapterDefinition?.redemptionTelemetry.capacity ?? "none";
  const telemetryFee = adapterDefinition?.redemptionTelemetry.fee ?? "none";
  const fallbackCapacityTelemetryAvailable =
    coerceFiniteNumber(metadata.immediateRedeemableUsd) != null || coerceFiniteNumber(metadata.immediateRedeemableRatio) != null;
  const fallbackFeeTelemetryAvailable = coerceFiniteNumber(metadata.redemptionFeeBps) != null;
  const capacityReason = resolveCapacityReason({
    snapshotMetadata,
    isFresh,
    hasBlockingWarnings,
    hasScoringEligibleFreshness,
    telemetryCapacity,
    fallbackTelemetryAvailable: fallbackCapacityTelemetryAvailable,
    stablecoinId,
  });
  const feeReason = resolveFeeReason({
    snapshotMetadata,
    isFresh,
    hasBlockingWarnings,
    hasScoringEligibleFreshness,
    telemetryFee,
    fallbackTelemetryAvailable: fallbackFeeTelemetryAvailable,
    stablecoinId,
  });

  return {
    updatedAt,
    isFresh,
    hasScoringEligibleFreshness,
    hasBlockingWarnings,
    capacityConfidence:
      telemetryCapacity === "direct"
        ? "live-direct"
        : telemetryCapacity === "proxy"
          ? "live-proxy"
          : fallbackCapacityTelemetryAvailable
            ? "dynamic"
            : null,
    canUseCapacity: capacityReason == null,
    canUseFee: feeReason == null,
    capacityReason,
    feeReason,
    immediateRedeemableUsd: coerceFiniteNumber(metadata.immediateRedeemableUsd),
    immediateRedeemableRatio: coerceFiniteNumber(metadata.immediateRedeemableRatio),
    redemptionFeeBps: coerceFiniteNumber(metadata.redemptionFeeBps),
    buyFeeBpsMin: coerceFiniteNumber(metadata.buyFeeBpsMin),
    buyFeeBpsMax: coerceFiniteNumber(metadata.buyFeeBpsMax),
  };
}
