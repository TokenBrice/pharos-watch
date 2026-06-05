import { resolveCapacitySemantics } from "@shared/lib/redemption-backstop-confidence";
import {
  REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS,
  REDEMPTION_BACKSTOP_PROVIDER_IDS,
} from "@shared/lib/redemption-backstop-providers";
import type { RedemptionCapacityModel } from "@shared/lib/redemption-backstops";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import { getLatestSuccessfulReserveSnapshotMetadata } from "../live-reserves-store";
import {
  readRedemptionBackstopLiveMetadata,
  type RedemptionBackstopLiveMetadata,
} from "../redemption-backstop-live-metadata";
import {
  resolveCapacityBasis,
  resolveReserveSyncCapacityConfidence,
  type CapacityResolution,
  type CapacityResolverContext,
} from "./profile";

type ReserveSyncModel = Extract<RedemptionCapacityModel, { kind: "reserve-sync-metadata" }>;

function pickRouteStatusFields(
  liveMetadata: RedemptionBackstopLiveMetadata,
): Partial<
  Pick<CapacityResolution, "routeStatus" | "routeStatusSource" | "routeStatusReason" | "routeStatusReviewedAt">
> {
  return {
    ...(liveMetadata.routeStatus ? { routeStatus: liveMetadata.routeStatus } : {}),
    ...(liveMetadata.routeStatusSource ? { routeStatusSource: liveMetadata.routeStatusSource } : {}),
    ...(liveMetadata.routeStatusReason ? { routeStatusReason: liveMetadata.routeStatusReason } : {}),
    ...(liveMetadata.routeStatusReviewedAt ? { routeStatusReviewedAt: liveMetadata.routeStatusReviewedAt } : {}),
  };
}

function buildReserveSyncFallbackFields(
  model: ReserveSyncModel,
  liveMetadata: RedemptionBackstopLiveMetadata,
  params: {
    capacityConfidence: RedemptionBackstopEntry["capacityConfidence"];
    capacitySemantics: RedemptionBackstopEntry["capacitySemantics"];
  },
): Pick<
  CapacityResolution,
  | "provider"
  | "sourceMode"
  | "resolutionState"
  | "capacityConfidence"
  | "capacityBasis"
  | "capacitySemantics"
> &
  Partial<
    Pick<CapacityResolution, "routeStatus" | "routeStatusSource" | "routeStatusReason" | "routeStatusReviewedAt">
  > {
  const { capacityConfidence, capacitySemantics } = params;
  return {
    provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_FALLBACK,
    sourceMode:
      REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_FALLBACK]
        .defaultSourceMode,
    resolutionState: "resolved",
    capacityConfidence,
    capacityBasis: resolveCapacityBasis(null, model, capacityConfidence),
    capacitySemantics,
    ...pickRouteStatusFields(liveMetadata),
  };
}

export async function resolveReserveSyncCapacity(
  model: ReserveSyncModel,
  context: CapacityResolverContext,
): Promise<CapacityResolution> {
  const { db, stablecoinId, supplyUsd, now, options } = context;
  const liveCapacityConfidence = resolveReserveSyncCapacityConfidence(stablecoinId);
  const fallbackCapacityConfidence: RedemptionBackstopEntry["capacityConfidence"] =
    model.confidence === "documented-bound" || model.confidence === "heuristic" ? model.confidence : "heuristic";
  const capacitySemantics = resolveCapacitySemantics({
    kind: "reserve-sync-metadata",
    fallbackRatio: model.fallbackRatio,
  });
  const snapshotMetadata =
    options.reserveSnapshotMetadata !== undefined
      ? options.reserveSnapshotMetadata
      : await getLatestSuccessfulReserveSnapshotMetadata(db, stablecoinId);
  const liveMetadata =
    options.redemptionLiveMetadata ?? readRedemptionBackstopLiveMetadata(stablecoinId, snapshotMetadata, now);

  if (
    liveMetadata.canUseCapacity &&
    liveMetadata.capacityConfidence != null &&
    (liveMetadata.immediateRedeemableUsd != null ||
      (liveMetadata.immediateRedeemableRatio != null && supplyUsd != null))
  ) {
    const rawCapacityUsd =
      liveMetadata.immediateRedeemableUsd != null
        ? liveMetadata.immediateRedeemableUsd
        : (supplyUsd as number) * (liveMetadata.immediateRedeemableRatio as number);
    const hasSupplyCeiling = supplyUsd != null;
    const hasPositiveSupply = hasSupplyCeiling && (supplyUsd as number) > 0;
    const capacityExceedsSupply = hasSupplyCeiling && rawCapacityUsd > (supplyUsd as number);
    const immediateCapacityUsd = hasSupplyCeiling
      ? Math.max(0, Math.min(supplyUsd as number, rawCapacityUsd))
      : Math.max(0, rawCapacityUsd);
    const derivedRatio =
      liveMetadata.immediateRedeemableRatio != null
        ? Math.max(0, Math.min(1, liveMetadata.immediateRedeemableRatio))
        : hasPositiveSupply
          ? Math.max(0, Math.min(1, immediateCapacityUsd / (supplyUsd as number)))
          : null;
    const dailyLimitCapsCapacity =
      liveMetadata.dailyLimitUsd != null && liveMetadata.dailyLimitUsd < immediateCapacityUsd;
    const scoringCapacityUsd = dailyLimitCapsCapacity
      ? Math.max(0, liveMetadata.dailyLimitUsd as number)
      : immediateCapacityUsd;
    const scoringCapacityRatio =
      dailyLimitCapsCapacity && hasPositiveSupply
        ? Math.max(0, Math.min(1, scoringCapacityUsd / (supplyUsd as number)))
        : derivedRatio;
    const clampNote = capacityExceedsSupply
      ? "Live reserve redemption capacity exceeds current supply; clamped to supply for scoring"
      : null;
    const dailyLimitNote = dailyLimitCapsCapacity ? "Live redemption daily limit caps usable scoring capacity" : null;
    const queueDepthNote =
      liveMetadata.queueDepthUsd != null ? "Live redemption queue depth is surfaced as a route constraint" : null;
    const settlementDelayNote =
      liveMetadata.settlementDelaySec != null
        ? "Live redemption settlement delay is surfaced as a route constraint"
        : null;

    return {
      immediateCapacityUsd,
      immediateCapacityRatio: derivedRatio,
      scoringCapacityUsd,
      scoringCapacityRatio,
      eventualCapacityUsd: hasSupplyCeiling ? supplyUsd : undefined,
      eventualCapacityRatio: hasPositiveSupply ? 1 : undefined,
      capacityProfile: {
        immediateUsd: immediateCapacityUsd,
        ...(liveMetadata.dailyLimitUsd != null ? { dailyLimitUsd: liveMetadata.dailyLimitUsd } : {}),
        ...(liveMetadata.queueDepthUsd != null ? { queuedUsd: liveMetadata.queueDepthUsd } : {}),
        ...(hasSupplyCeiling ? { eventualUsd: supplyUsd as number } : {}),
        scoringUsd: scoringCapacityUsd,
        scoringHorizon: dailyLimitCapsCapacity ? "daily" : liveMetadata.queueDepthUsd != null ? "queued" : "immediate",
        capacityProfileConfidence: liveMetadata.capacityConfidence,
      },
      provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_METADATA,
      sourceMode:
        REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_METADATA]
          .defaultSourceMode,
      resolutionState: "resolved",
      capacityConfidence: liveMetadata.capacityConfidence,
      capacityBasis: resolveCapacityBasis(null, model, liveMetadata.capacityConfidence),
      capacitySemantics,
      ...(liveMetadata.capacityKind ? { capacityKind: liveMetadata.capacityKind } : {}),
      ...(liveMetadata.freshnessKind ? { freshnessKind: liveMetadata.freshnessKind } : {}),
      ...(liveMetadata.sourceTimestamp != null ? { sourceTimestamp: liveMetadata.sourceTimestamp } : {}),
      ...(liveMetadata.sourceUrls.length > 0 ? { sourceUrls: liveMetadata.sourceUrls } : {}),
      ...(liveMetadata.settlementDelaySec != null ? { settlementDelaySec: liveMetadata.settlementDelaySec } : {}),
      ...(liveMetadata.queueDepthUsd != null ? { queueDepthUsd: liveMetadata.queueDepthUsd } : {}),
      ...(liveMetadata.dailyLimitUsd != null ? { dailyLimitUsd: liveMetadata.dailyLimitUsd } : {}),
      ...(liveMetadata.minRedeemUsd != null ? { minRedeemUsd: liveMetadata.minRedeemUsd } : {}),
      ...(liveMetadata.liveHolderEligibility ? { liveHolderEligibility: liveMetadata.liveHolderEligibility } : {}),
      ...pickRouteStatusFields(liveMetadata),
      notes: [
        ...liveMetadata.capacityNotes,
        ...(clampNote ? [clampNote] : []),
        ...(dailyLimitNote ? [dailyLimitNote] : []),
        ...(queueDepthNote ? [queueDepthNote] : []),
        ...(settlementDelayNote ? [settlementDelayNote] : []),
      ],
    };
  }

  if (model.fallbackRatio != null && supplyUsd != null && supplyUsd > 0) {
    return {
      immediateCapacityUsd: supplyUsd * model.fallbackRatio,
      immediateCapacityRatio: model.fallbackRatio,
      scoringCapacityUsd: supplyUsd * model.fallbackRatio,
      scoringCapacityRatio: model.fallbackRatio,
      capacityProfile: {
        immediateUsd: supplyUsd * model.fallbackRatio,
        scoringUsd: supplyUsd * model.fallbackRatio,
        scoringHorizon: "immediate",
        capacityProfileConfidence: fallbackCapacityConfidence,
      },
      ...buildReserveSyncFallbackFields(model, liveMetadata, {
        capacityConfidence: fallbackCapacityConfidence,
        capacitySemantics,
      }),
      notes: [
        ...liveMetadata.capacityNotes,
        liveMetadata.capacityReason
          ? `${liveMetadata.capacityReason}; using configured fallback ratio`
          : "Live reserve metadata unavailable; using configured fallback ratio",
      ],
    };
  }

  if (model.fallbackUsd != null) {
    const hasSupplyCeiling = supplyUsd != null;
    const hasPositiveSupply = hasSupplyCeiling && (supplyUsd as number) > 0;
    const immediateCapacityUsd = hasSupplyCeiling
      ? Math.max(0, Math.min(supplyUsd as number, model.fallbackUsd))
      : Math.max(0, model.fallbackUsd);
    const dailyLimitCapsCapacity =
      model.fallbackUsd > 0 && liveMetadata.dailyLimitUsd != null
        ? liveMetadata.dailyLimitUsd < immediateCapacityUsd
        : false;
    const scoringCapacityUsd = dailyLimitCapsCapacity
      ? Math.max(0, liveMetadata.dailyLimitUsd as number)
      : immediateCapacityUsd;
    const scoringCapacityRatio = hasPositiveSupply
      ? Math.max(0, Math.min(1, scoringCapacityUsd / (supplyUsd as number)))
      : null;
    const immediateCapacityRatio = hasPositiveSupply
      ? Math.max(0, Math.min(1, immediateCapacityUsd / (supplyUsd as number)))
      : null;
    return {
      immediateCapacityUsd,
      immediateCapacityRatio,
      scoringCapacityUsd,
      scoringCapacityRatio,
      capacityScoreMode: hasPositiveSupply ? "interpolated" : "tier-floor",
      capacityProfile: {
        immediateUsd: immediateCapacityUsd,
        ...(liveMetadata.dailyLimitUsd != null ? { dailyLimitUsd: liveMetadata.dailyLimitUsd } : {}),
        scoringUsd: scoringCapacityUsd,
        scoringHorizon: dailyLimitCapsCapacity ? "daily" : "immediate",
        capacityProfileConfidence: fallbackCapacityConfidence,
      },
      ...buildReserveSyncFallbackFields(model, liveMetadata, {
        capacityConfidence: fallbackCapacityConfidence,
        capacitySemantics,
      }),
      notes: [
        ...liveMetadata.capacityNotes,
        liveMetadata.capacityReason
          ? `${liveMetadata.capacityReason}; using configured fallback USD capacity`
          : "Live reserve metadata unavailable; using configured fallback USD capacity",
      ],
    };
  }

  return {
    immediateCapacityUsd: null,
    immediateCapacityRatio: null,
    scoringCapacityUsd: null,
    scoringCapacityRatio: null,
    provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_METADATA,
    sourceMode: "static",
    resolutionState: supplyUsd == null ? "missing-cache" : "missing-capacity",
    capacityConfidence: liveCapacityConfidence,
    capacityBasis: resolveCapacityBasis(null, model, liveCapacityConfidence),
    capacitySemantics,
    ...pickRouteStatusFields(liveMetadata),
    notes: [...liveMetadata.capacityNotes, liveMetadata.capacityReason ?? "Live reserve metadata unavailable"],
  };
}
