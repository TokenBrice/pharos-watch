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

type ReserveSyncCapacityFields = Pick<
  CapacityResolution,
  "immediateCapacityUsd" | "immediateCapacityRatio" | "scoringCapacityUsd" | "scoringCapacityRatio" | "capacityProfile"
> & {
  hasSupplyCeiling: boolean;
  hasPositiveSupply: boolean;
  capacityExceedsSupply: boolean;
  dailyLimitCapsCapacity: boolean;
};

function clampUnitInterval(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function buildReserveSyncCapacityFields(params: {
  rawCapacityUsd: number;
  reportedCapacityRatio?: number | null;
  supplyUsd: number | null;
  dailyLimitUsd?: number | null;
  queueDepthUsd?: number | null;
  capacityProfileConfidence: RedemptionBackstopEntry["capacityConfidence"];
  applyDailyLimit: boolean;
  includeEventualSupplyInProfile?: boolean;
}): ReserveSyncCapacityFields {
  const hasSupplyCeiling = params.supplyUsd != null;
  const hasPositiveSupply = hasSupplyCeiling && (params.supplyUsd as number) > 0;
  const capacityExceedsSupply = hasSupplyCeiling && params.rawCapacityUsd > (params.supplyUsd as number);
  const immediateCapacityUsd = hasSupplyCeiling
    ? Math.max(0, Math.min(params.supplyUsd as number, params.rawCapacityUsd))
    : Math.max(0, params.rawCapacityUsd);
  const immediateCapacityRatio =
    params.reportedCapacityRatio != null
      ? clampUnitInterval(params.reportedCapacityRatio)
      : hasPositiveSupply
        ? clampUnitInterval(immediateCapacityUsd / (params.supplyUsd as number))
        : null;
  const dailyLimitCapsCapacity =
    params.applyDailyLimit && params.dailyLimitUsd != null
      ? params.dailyLimitUsd < immediateCapacityUsd
      : false;
  const scoringCapacityUsd = dailyLimitCapsCapacity
    ? Math.max(0, params.dailyLimitUsd as number)
    : immediateCapacityUsd;
  const scoringCapacityRatio =
    dailyLimitCapsCapacity && hasPositiveSupply
      ? clampUnitInterval(scoringCapacityUsd / (params.supplyUsd as number))
      : immediateCapacityRatio;

  return {
    immediateCapacityUsd,
    immediateCapacityRatio,
    scoringCapacityUsd,
    scoringCapacityRatio,
    capacityProfile: {
      immediateUsd: immediateCapacityUsd,
      ...(params.dailyLimitUsd != null ? { dailyLimitUsd: params.dailyLimitUsd } : {}),
      ...(params.queueDepthUsd != null ? { queuedUsd: params.queueDepthUsd } : {}),
      ...(params.includeEventualSupplyInProfile && hasSupplyCeiling ? { eventualUsd: params.supplyUsd as number } : {}),
      scoringUsd: scoringCapacityUsd,
      scoringHorizon: dailyLimitCapsCapacity ? "daily" : params.queueDepthUsd != null ? "queued" : "immediate",
      capacityProfileConfidence: params.capacityProfileConfidence,
    },
    hasSupplyCeiling,
    hasPositiveSupply,
    capacityExceedsSupply,
    dailyLimitCapsCapacity,
  };
}

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
    // routeFamily=null: redemption-backstop-sources.ts recomputes capacityBasis with the real
    // routeFamily; the value set here is not consumed downstream of reserve-sync.
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

  // The bounded-gap lane is reserved for OPEN routes: a paused route's zero is
  // the measured pause, not an evidence gap, so it falls through to the
  // measured capacity path below regardless of the producer flag.
  if (liveMetadata.settlementBoundUnproven && liveMetadata.routeStatus === "open") {
    const flaggedCapacityConfidence =
      liveMetadata.capacityKind === "documented-bound"
        ? ("documented-bound" as const)
        : (model.liveCapacityConfidence ?? liveMetadata.capacityConfidence ?? liveCapacityConfidence);
    return {
      immediateCapacityUsd: null,
      immediateCapacityRatio: null,
      scoringCapacityUsd: null,
      scoringCapacityRatio: null,
      capacityProfile: {
        immediateUsd: null,
        scoringUsd: null,
        scoringHorizon: "unknown",
        capacityProfileConfidence: flaggedCapacityConfidence,
        settlementBoundUnproven: true,
      },
      provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_METADATA,
      sourceMode:
        REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_METADATA]
          .defaultSourceMode,
      resolutionState: "missing-capacity",
      capacityConfidence: flaggedCapacityConfidence,
      // routeFamily=null: recomputed with the real routeFamily in redemption-backstop-sources.ts; not read downstream here.
      capacityBasis: resolveCapacityBasis(null, model, flaggedCapacityConfidence),
      capacitySemantics,
      settlementBoundUnproven: true,
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
        "Live redemption settlement completion bound is unproven; capacity is not established",
      ],
    };
  }

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
    // Confidence resolution, most conservative source first: an adapter that
    // marks this run's capacity documented-bound (e.g. sBOLD when its
    // collateral-health gate is restricted or unreadable) always downgrades,
    // then a config override may downgrade a bounded-proxy read (e.g. Makina
    // dUSD), and only then does the adapter-derived live confidence apply.
    // The measured capacity value is used in all three cases; only its
    // confidence label changes.
    const liveCapacityConfidence =
      liveMetadata.capacityKind === "documented-bound"
        ? ("documented-bound" as const)
        : (model.liveCapacityConfidence ?? liveMetadata.capacityConfidence);
    const {
      hasSupplyCeiling,
      hasPositiveSupply,
      capacityExceedsSupply,
      dailyLimitCapsCapacity,
      ...capacityFields
    } = buildReserveSyncCapacityFields({
      rawCapacityUsd,
      reportedCapacityRatio: liveMetadata.immediateRedeemableRatio,
      supplyUsd,
      dailyLimitUsd: liveMetadata.dailyLimitUsd,
      queueDepthUsd: liveMetadata.queueDepthUsd,
      capacityProfileConfidence: liveCapacityConfidence,
      applyDailyLimit: true,
      includeEventualSupplyInProfile: model.eventualCapacityModel === "supply-full",
    });
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
      ...capacityFields,
      eventualCapacityUsd:
        model.eventualCapacityModel === "supply-full" && hasSupplyCeiling ? supplyUsd : undefined,
      eventualCapacityRatio:
        model.eventualCapacityModel === "supply-full" && hasPositiveSupply ? 1 : undefined,
      provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_METADATA,
      sourceMode:
        REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_METADATA]
          .defaultSourceMode,
      resolutionState: "resolved",
      capacityConfidence: liveCapacityConfidence,
      // routeFamily=null: recomputed with the real routeFamily in redemption-backstop-sources.ts; not read downstream here.
      capacityBasis: resolveCapacityBasis(null, model, liveCapacityConfidence),
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
    const capacityFields = buildReserveSyncCapacityFields({
      rawCapacityUsd: model.fallbackUsd,
      supplyUsd,
      dailyLimitUsd: liveMetadata.dailyLimitUsd,
      capacityProfileConfidence: fallbackCapacityConfidence,
      applyDailyLimit: model.fallbackUsd > 0,
    });
    return {
      immediateCapacityUsd: capacityFields.immediateCapacityUsd,
      immediateCapacityRatio: capacityFields.immediateCapacityRatio,
      scoringCapacityUsd: capacityFields.scoringCapacityUsd,
      scoringCapacityRatio: capacityFields.scoringCapacityRatio,
      capacityScoreMode: capacityFields.hasPositiveSupply ? "interpolated" : "tier-floor",
      capacityProfile: capacityFields.capacityProfile,
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
    // routeFamily=null: recomputed with the real routeFamily in redemption-backstop-sources.ts; not read downstream here.
    capacityBasis: resolveCapacityBasis(null, model, liveCapacityConfidence),
    capacitySemantics,
    ...pickRouteStatusFields(liveMetadata),
    notes: [...liveMetadata.capacityNotes, liveMetadata.capacityReason ?? "Live reserve metadata unavailable"],
  };
}
