import { resolveCapacitySemantics } from "@shared/lib/redemption-backstop-confidence";
import {
  REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS,
  REDEMPTION_BACKSTOP_PROVIDER_IDS,
} from "@shared/lib/redemption-backstop-providers";
import type { RedemptionCapacityModel } from "@shared/lib/redemption-backstops";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import { getLatestSuccessfulReserveSnapshotMetadata } from "../live-reserves/store";
import {
  readRedemptionBackstopLiveMetadata,
  evaluateRedemptionCapacityEvidenceAdmission,
  type RedemptionBackstopLiveMetadata,
} from "../redemption-backstop/live-metadata";
import {
  buildBoundedCapacityFields,
  resolveCapacityBasis,
  type CapacityResolution,
  type CapacityResolverContext,
} from "./profile";

type ReserveSyncModel = Extract<RedemptionCapacityModel, { kind: "reserve-sync-metadata" }>;

function pickRouteStatusFields(
  liveMetadata: RedemptionBackstopLiveMetadata,
): Partial<Pick<CapacityResolution,
  "routeStatus" | "routeStatusSource" | "routeStatusReason" | "routeStatusReviewedAt" |
  "consumedReserveRouteStatus" | "settlementBoundUnproven" | "capacityRejectionReason" | "sharedResourceKey" | "dailyLimitUsd"
>> {
  return {
    consumedReserveRouteStatus: liveMetadata.routeStatus != null,
    ...(liveMetadata.routeStatus ? { routeStatus: liveMetadata.routeStatus } : {}),
    ...(liveMetadata.routeStatusSource ? { routeStatusSource: liveMetadata.routeStatusSource } : {}),
    ...(liveMetadata.routeStatusReason ? { routeStatusReason: liveMetadata.routeStatusReason } : {}),
    ...(liveMetadata.routeStatusReviewedAt ? { routeStatusReviewedAt: liveMetadata.routeStatusReviewedAt } : {}),
    ...(liveMetadata.settlementBoundUnproven ? { settlementBoundUnproven: true } : {}),
    ...(liveMetadata.capacityRejectionReason ? { capacityRejectionReason: liveMetadata.capacityRejectionReason } : {}),
    ...(liveMetadata.sharedResourceKey ? { sharedResourceKey: liveMetadata.sharedResourceKey } : {}),
    ...(liveMetadata.dailyLimitUsd != null ? { dailyLimitUsd: liveMetadata.dailyLimitUsd } : {}),
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
    Pick<CapacityResolution, "routeStatus" | "routeStatusSource" | "routeStatusReason" | "routeStatusReviewedAt" | "consumedReserveRouteStatus">
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
  const unquantifiedConfidence = "heuristic" as const;
  const fallbackCapacityConfidence: RedemptionBackstopEntry["capacityConfidence"] =
    model.confidence === "documented-bound" || model.confidence === "heuristic" ? model.confidence : "heuristic";
  const capacitySemantics = resolveCapacitySemantics({
    kind: "reserve-sync-metadata",
    fallbackRatio: model.fallbackRatio,
  });
  const retainedSnapshot =
    options.reserveSnapshotMetadata !== undefined
      ? options.reserveSnapshotMetadata
      : await getLatestSuccessfulReserveSnapshotMetadata(db, stablecoinId, now);
  const admission = evaluateRedemptionCapacityEvidenceAdmission(stablecoinId, retainedSnapshot, now);
  const liveMetadata =
    (admission.eligible ? options.redemptionLiveMetadata : undefined)
    ?? readRedemptionBackstopLiveMetadata(stablecoinId, retainedSnapshot, now);

  // A validated async marker invalidates immediate/scoring cash even on an
  // unknown route or a configured fallback. A measured pause remains zero.
  if (liveMetadata.settlementBoundUnproven && (liveMetadata.routeStatus !== "paused" || !liveMetadata.canUseCapacity)) {
    const flaggedCapacityConfidence = unquantifiedConfidence;
    return {
      consumedReserveCapacity: true,
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
      ...(liveMetadata.evidenceObservedAt != null ? { evidenceObservedAt: liveMetadata.evidenceObservedAt } : {}),
      ...(liveMetadata.sourceUrls.length > 0 ? { sourceUrls: liveMetadata.sourceUrls } : {}),
      ...(liveMetadata.settlementDelaySec != null ? { settlementDelaySec: liveMetadata.settlementDelaySec } : {}),
      ...(liveMetadata.queueDepthUsd != null ? { queueDepthUsd: liveMetadata.queueDepthUsd } : {}),
      ...(liveMetadata.dailyLimitUsd != null ? { dailyLimitUsd: liveMetadata.dailyLimitUsd } : {}),
      ...(liveMetadata.minRedeemUsd != null ? { minRedeemUsd: liveMetadata.minRedeemUsd } : {}),
      ...(liveMetadata.liveHolderEligibility ? { liveHolderEligibility: liveMetadata.liveHolderEligibility } : {}),
      ...pickRouteStatusFields(liveMetadata),
      capacityRejectionReason: liveMetadata.capacityRejectionReason &&
        liveMetadata.capacityRejectionReason !== "redeemable-capacity-unobserved"
        ? liveMetadata.capacityRejectionReason : "settlement-bound-unproven",
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
    const capacityKind = (liveMetadata.settlementDelaySec ?? 0) > 0 && liveMetadata.capacityKind === "live-direct"
      ? "documented-bound" as const
      : liveMetadata.capacityKind;
    const liveCapacityConfidence =
      capacityKind === "documented-bound"
        ? ("documented-bound" as const)
        : (model.liveCapacityConfidence ?? liveMetadata.capacityConfidence);
    const {
      hasSupplyCeiling,
      hasPositiveSupply,
      capacityExceedsSupply,
      dailyLimitCapsCapacity,
      ...capacityFields
    } = buildBoundedCapacityFields({
      rawCapacityUsd,
      supplyUsd,
      dailyLimitUsd: liveMetadata.dailyLimitUsd,
      queueDepthUsd: liveMetadata.queueDepthUsd,
      capacityProfileConfidence: liveCapacityConfidence,
      settlementBoundUnproven: liveMetadata.settlementBoundUnproven,
      applyDailyLimit: true,
      eventualCapacityUsd: model.eventualCapacityModel === "supply-full" ? supplyUsd : undefined,
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
      consumedReserveCapacity: true,
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
      ...(capacityKind ? { capacityKind } : {}),
      ...(liveMetadata.freshnessKind ? { freshnessKind: liveMetadata.freshnessKind } : {}),
      ...(liveMetadata.sourceTimestamp != null ? { sourceTimestamp: liveMetadata.sourceTimestamp } : {}),
      ...(liveMetadata.evidenceObservedAt != null ? { evidenceObservedAt: liveMetadata.evidenceObservedAt } : {}),
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

  const canUseConfiguredFallback = liveMetadata.routeStatus == null || liveMetadata.routeStatus === "open";
  if (canUseConfiguredFallback && model.fallbackRatio != null && supplyUsd != null && supplyUsd > 0) {
    const capacityFields = buildBoundedCapacityFields({
      rawCapacityUsd: supplyUsd * model.fallbackRatio,
      supplyUsd,
      dailyLimitUsd: liveMetadata.dailyLimitUsd,
      capacityProfileConfidence: fallbackCapacityConfidence,
      settlementBoundUnproven: liveMetadata.settlementBoundUnproven,
      applyDailyLimit: true,
    });
    return {
      consumedReserveCapacity: liveMetadata.dailyLimitUsd != null,
      immediateCapacityUsd: capacityFields.immediateCapacityUsd,
      immediateCapacityRatio: capacityFields.immediateCapacityRatio,
      scoringCapacityUsd: capacityFields.scoringCapacityUsd,
      scoringCapacityRatio: capacityFields.scoringCapacityRatio,
      capacityProfile: capacityFields.capacityProfile,
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

  if (canUseConfiguredFallback && model.fallbackUsd != null) {
    const capacityFields = buildBoundedCapacityFields({
      rawCapacityUsd: model.fallbackUsd,
      supplyUsd,
      dailyLimitUsd: liveMetadata.dailyLimitUsd,
      capacityProfileConfidence: fallbackCapacityConfidence,
      settlementBoundUnproven: liveMetadata.settlementBoundUnproven,
      applyDailyLimit: model.fallbackUsd > 0,
    });
    return {
      consumedReserveCapacity: liveMetadata.dailyLimitUsd != null,
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
    capacityConfidence: unquantifiedConfidence,
    // routeFamily=null: recomputed by the public projection.
    capacityBasis: resolveCapacityBasis(null, model, unquantifiedConfidence),
    capacitySemantics,
    ...pickRouteStatusFields(liveMetadata),
    notes: [...liveMetadata.capacityNotes, liveMetadata.capacityReason ?? "Live reserve metadata unavailable"],
  };
}
