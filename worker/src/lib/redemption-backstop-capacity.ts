import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { resolveCapacityConfidence, resolveCapacitySemantics } from "@shared/lib/redemption-backstop-confidence";
import {
  REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS,
  REDEMPTION_BACKSTOP_PROVIDER_IDS,
  type RedemptionBackstopProviderId,
} from "@shared/lib/redemption-backstop-providers";
import type { RedemptionBackstopConfig, RedemptionCapacityModel } from "@shared/lib/redemption-backstops";
import type { RedemptionBackstopEntry, RedemptionCapacityProfile } from "@shared/types/redemption";
import { getLatestSuccessfulReserveSnapshotMetadata, type ReserveSnapshotMetadataRecord } from "./live-reserves-store";
import type { RedemptionRouteAvailability } from "./redemption-backstop-availability";
import { readRedemptionBackstopLiveMetadata } from "./redemption-backstop-live-metadata";

export interface CapacityResolution {
  immediateCapacityUsd: number | null;
  immediateCapacityRatio: number | null;
  scoringCapacityUsd: number | null;
  scoringCapacityRatio: number | null;
  eventualCapacityUsd?: number | null;
  eventualCapacityRatio?: number | null;
  capacityProfile?: RedemptionCapacityProfile;
  capacityScoreMode?: "interpolated" | "tier-floor";
  provider: RedemptionBackstopProviderId;
  sourceMode: RedemptionBackstopEntry["sourceMode"];
  resolutionState: RedemptionBackstopEntry["resolutionState"];
  capacityConfidence: RedemptionBackstopEntry["capacityConfidence"];
  capacityBasis?: RedemptionBackstopEntry["capacityBasis"];
  capacitySemantics: RedemptionBackstopEntry["capacitySemantics"];
  capacityKind?: RedemptionBackstopEntry["capacityKind"];
  freshnessKind?: RedemptionBackstopEntry["freshnessKind"];
  sourceTimestamp?: number;
  sourceUrls?: string[];
  settlementDelaySec?: number;
  queueDepthUsd?: number;
  dailyLimitUsd?: number;
  minRedeemUsd?: number;
  liveHolderEligibility?: RedemptionBackstopEntry["liveHolderEligibility"];
  routeStatus?: RedemptionBackstopEntry["routeStatus"];
  routeStatusSource?: RedemptionBackstopEntry["routeStatusSource"];
  routeStatusReason?: string;
  routeStatusReviewedAt?: string;
  notes: string[];
}

export interface RedemptionBackstopBuildOptions {
  reserveSnapshotMetadata?: ReserveSnapshotMetadataRecord | null;
  routeAvailability?: RedemptionRouteAvailability | null;
  routeStatusFeed?: {
    origin: "operator-override" | "protocol-feed";
    routeStatus: RedemptionBackstopEntry["routeStatus"];
    routeStatusSource: RedemptionBackstopEntry["routeStatusSource"];
    routeStatusReason?: string;
    routeStatusReviewedAt?: string;
  } | null;
}

export function resolveReserveSyncCapacityConfidence(
  stablecoinId: string,
): RedemptionBackstopEntry["capacityConfidence"] {
  const adapterKey = TRACKED_META_BY_ID.get(stablecoinId)?.liveReservesConfig?.adapter;
  if (!adapterKey) return "dynamic";
  const telemetry = getLiveReserveAdapterDefinition(adapterKey)?.redemptionTelemetry.capacity;
  if (telemetry === "direct") return "live-direct";
  if (telemetry === "proxy") return "live-proxy";
  return "dynamic";
}

export function resolveCapacityBasis(
  routeFamily: RedemptionBackstopConfig["routeFamily"] | null,
  model: RedemptionCapacityModel,
  capacityConfidence?: RedemptionBackstopEntry["capacityConfidence"],
): RedemptionBackstopEntry["capacityBasis"] | undefined {
  if (model.kind === "reserve-sync-metadata") {
    if (capacityConfidence === "live-direct") return "live-direct-telemetry";
    if (capacityConfidence === "live-proxy") return "live-proxy-buffer";
    if (model.basis) return model.basis;
    return "live-proxy-buffer";
  }

  if (model.basis) return model.basis;
  if (model.kind === "fixed-usd") return "fixed-buffer";
  if (model.kind === "supply-full") {
    return routeFamily === "offchain-issuer" || routeFamily === "stablecoin-redeem"
      ? "issuer-term-redemption"
      : "full-system-eventual";
  }

  if (routeFamily === "psm-swap") return "psm-balance-share";
  if (routeFamily === "queue-redeem") return "strategy-buffer";
  return "hot-buffer";
}

async function resolveCapacityFromReserveSyncMetadata(
  db: D1Database,
  stablecoinId: string,
  model: Extract<RedemptionCapacityModel, { kind: "reserve-sync-metadata" }>,
  supplyUsd: number | null,
  now: number,
  reserveSnapshotMetadata?: ReserveSnapshotMetadataRecord | null,
): Promise<CapacityResolution> {
  const liveCapacityConfidence = resolveReserveSyncCapacityConfidence(stablecoinId);
  const fallbackCapacityConfidence: RedemptionBackstopEntry["capacityConfidence"] =
    model.confidence === "documented-bound" || model.confidence === "heuristic" ? model.confidence : "heuristic";
  const capacitySemantics = resolveCapacitySemantics({
    kind: "reserve-sync-metadata",
    fallbackRatio: model.fallbackRatio,
  });
  const snapshotMetadata =
    reserveSnapshotMetadata !== undefined
      ? reserveSnapshotMetadata
      : await getLatestSuccessfulReserveSnapshotMetadata(db, stablecoinId);
  const liveMetadata = readRedemptionBackstopLiveMetadata(stablecoinId, snapshotMetadata, now);

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
      ...(liveMetadata.routeStatus ? { routeStatus: liveMetadata.routeStatus } : {}),
      ...(liveMetadata.routeStatusSource ? { routeStatusSource: liveMetadata.routeStatusSource } : {}),
      ...(liveMetadata.routeStatusReason ? { routeStatusReason: liveMetadata.routeStatusReason } : {}),
      ...(liveMetadata.routeStatusReviewedAt ? { routeStatusReviewedAt: liveMetadata.routeStatusReviewedAt } : {}),
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
      provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_FALLBACK,
      sourceMode:
        REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_FALLBACK]
          .defaultSourceMode,
      resolutionState: "resolved",
      capacityConfidence: fallbackCapacityConfidence,
      capacityBasis: resolveCapacityBasis(null, model, fallbackCapacityConfidence),
      capacitySemantics,
      ...(liveMetadata.routeStatus ? { routeStatus: liveMetadata.routeStatus } : {}),
      ...(liveMetadata.routeStatusSource ? { routeStatusSource: liveMetadata.routeStatusSource } : {}),
      ...(liveMetadata.routeStatusReason ? { routeStatusReason: liveMetadata.routeStatusReason } : {}),
      ...(liveMetadata.routeStatusReviewedAt ? { routeStatusReviewedAt: liveMetadata.routeStatusReviewedAt } : {}),
      notes: [
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
      provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_FALLBACK,
      sourceMode:
        REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_FALLBACK]
          .defaultSourceMode,
      resolutionState: "resolved",
      capacityConfidence: fallbackCapacityConfidence,
      capacityBasis: resolveCapacityBasis(null, model, fallbackCapacityConfidence),
      capacitySemantics,
      notes: [
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
    ...(liveMetadata.routeStatus ? { routeStatus: liveMetadata.routeStatus } : {}),
    ...(liveMetadata.routeStatusSource ? { routeStatusSource: liveMetadata.routeStatusSource } : {}),
    ...(liveMetadata.routeStatusReason ? { routeStatusReason: liveMetadata.routeStatusReason } : {}),
    ...(liveMetadata.routeStatusReviewedAt ? { routeStatusReviewedAt: liveMetadata.routeStatusReviewedAt } : {}),
    notes: [liveMetadata.capacityReason ?? "Live reserve metadata unavailable"],
  };
}

export async function resolveRedemptionCapacity(
  db: D1Database,
  stablecoinId: string,
  model: RedemptionCapacityModel,
  supplyUsd: number | null,
  now: number,
  options: RedemptionBackstopBuildOptions = {},
): Promise<CapacityResolution> {
  const capacityConfidence = resolveCapacityConfidence(model);
  const capacitySemantics = resolveCapacitySemantics(model);
  if (model.kind === "supply-full") {
    if (supplyUsd == null) {
      return {
        immediateCapacityUsd: null,
        immediateCapacityRatio: null,
        scoringCapacityUsd: null,
        scoringCapacityRatio: null,
        provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_FULL_MODEL,
        sourceMode: "static",
        resolutionState: "missing-cache",
        capacityConfidence,
        capacitySemantics,
        notes: ["Stablecoins cache missing current supply; route retained as configured but unrated"],
      };
    }
    return {
      immediateCapacityUsd: null,
      immediateCapacityRatio: null,
      scoringCapacityUsd: null,
      scoringCapacityRatio: null,
      eventualCapacityUsd: supplyUsd,
      eventualCapacityRatio: supplyUsd > 0 ? 1 : null,
      capacityProfile: {
        immediateUsd: null,
        eventualUsd: supplyUsd,
        scoringUsd: null,
        scoringHorizon: "eventual",
        capacityProfileConfidence: capacityConfidence,
      },
      provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_FULL_MODEL,
      sourceMode:
        REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_FULL_MODEL].defaultSourceMode,
      resolutionState: "resolved",
      capacityConfidence,
      capacitySemantics,
      notes: ["Modeled as eventual redeemability of current supply; immediate liquidity is not separately quantified"],
    };
  }

  if (model.kind === "supply-ratio") {
    if (supplyUsd == null) {
      return {
        immediateCapacityUsd: null,
        immediateCapacityRatio: null,
        scoringCapacityUsd: null,
        scoringCapacityRatio: null,
        provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_RATIO_MODEL,
        sourceMode: "static",
        resolutionState: "missing-cache",
        capacityConfidence,
        capacitySemantics,
        notes: ["Stablecoins cache missing current supply; route retained as configured but unrated"],
      };
    }
    return {
      immediateCapacityUsd: supplyUsd * model.ratio,
      immediateCapacityRatio: model.ratio,
      scoringCapacityUsd:
        model.dailyLimitUsd != null ? Math.min(supplyUsd * model.ratio, model.dailyLimitUsd) : supplyUsd * model.ratio,
      scoringCapacityRatio:
        model.dailyLimitUsd != null && supplyUsd > 0
          ? Math.min(model.ratio, model.dailyLimitUsd / supplyUsd)
          : model.ratio,
      capacityProfile: {
        immediateUsd: supplyUsd * model.ratio,
        ...(model.dailyLimitUsd != null ? { dailyLimitUsd: model.dailyLimitUsd } : {}),
        scoringUsd:
          model.dailyLimitUsd != null
            ? Math.min(supplyUsd * model.ratio, model.dailyLimitUsd)
            : supplyUsd * model.ratio,
        scoringHorizon: model.dailyLimitUsd != null ? "daily" : "immediate",
        capacityProfileConfidence: capacityConfidence,
      },
      provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_RATIO_MODEL,
      sourceMode:
        REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_RATIO_MODEL].defaultSourceMode,
      resolutionState: "resolved",
      capacityConfidence,
      capacitySemantics,
      notes: [],
    };
  }

  if (model.kind === "fixed-usd") {
    const hasPositiveSupply = supplyUsd != null && supplyUsd > 0;
    const rawCapacityUsd = Math.max(0, model.amountUsd);
    const immediateCapacityUsd = supplyUsd != null ? Math.min(supplyUsd, rawCapacityUsd) : rawCapacityUsd;
    const immediateCapacityRatio = hasPositiveSupply ? Math.min(1, immediateCapacityUsd / supplyUsd) : null;
    const dailyLimitCapsCapacity = model.dailyLimitUsd != null && model.dailyLimitUsd < immediateCapacityUsd;
    const scoringCapacityUsd = dailyLimitCapsCapacity
      ? Math.max(0, model.dailyLimitUsd as number)
      : immediateCapacityUsd;
    const scoringCapacityRatio = hasPositiveSupply ? Math.min(1, scoringCapacityUsd / supplyUsd) : null;
    return {
      immediateCapacityUsd,
      immediateCapacityRatio,
      scoringCapacityUsd,
      scoringCapacityRatio,
      capacityScoreMode: hasPositiveSupply ? "interpolated" : "tier-floor",
      capacityProfile: {
        immediateUsd: immediateCapacityUsd,
        ...(model.dailyLimitUsd != null ? { dailyLimitUsd: model.dailyLimitUsd } : {}),
        scoringUsd: scoringCapacityUsd,
        scoringHorizon: dailyLimitCapsCapacity ? "daily" : "immediate",
        capacityProfileConfidence: capacityConfidence,
      },
      provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.FIXED_USD_MODEL,
      sourceMode:
        REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[REDEMPTION_BACKSTOP_PROVIDER_IDS.FIXED_USD_MODEL].defaultSourceMode,
      resolutionState: "resolved",
      capacityConfidence,
      capacitySemantics,
      notes: [
        ...(supplyUsd != null && rawCapacityUsd > supplyUsd
          ? ["Configured fixed USD capacity exceeds current supply; clamped to supply for scoring"]
          : []),
        ...(supplyUsd == null
          ? [
              "Stablecoins cache missing current supply; fixed USD capacity is visible with conservative bounded scoring",
            ]
          : []),
        ...(dailyLimitCapsCapacity ? ["Documented daily limit caps usable scoring capacity"] : []),
      ],
    };
  }

  return resolveCapacityFromReserveSyncMetadata(
    db,
    stablecoinId,
    model,
    supplyUsd,
    now,
    options.reserveSnapshotMetadata,
  );
}
