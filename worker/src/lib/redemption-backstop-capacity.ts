import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import {
  resolveCapacityConfidence,
  resolveCapacitySemantics,
} from "@shared/lib/redemption-backstop-confidence";
import {
  REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS,
  REDEMPTION_BACKSTOP_PROVIDER_IDS,
  type RedemptionBackstopProviderId,
} from "@shared/lib/redemption-backstop-providers";
import type {
  RedemptionBackstopConfig,
  RedemptionCapacityModel,
} from "@shared/lib/redemption-backstops";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import {
  getLatestSuccessfulReserveSnapshotMetadata,
  type ReserveSnapshotMetadataRecord,
} from "./live-reserves-store";
import type { RedemptionRouteAvailability } from "./redemption-backstop-availability";
import { readRedemptionBackstopLiveMetadata } from "./redemption-backstop-live-metadata";

export interface CapacityResolution {
  immediateCapacityUsd: number | null;
  immediateCapacityRatio: number | null;
  scoringCapacityUsd: number | null;
  scoringCapacityRatio: number | null;
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
    model.confidence === "documented-bound" || model.confidence === "heuristic"
      ? model.confidence
      : "heuristic";
  const capacitySemantics = resolveCapacitySemantics({
    kind: "reserve-sync-metadata",
    fallbackRatio: model.fallbackRatio,
  });
  const snapshotMetadata = reserveSnapshotMetadata !== undefined
    ? reserveSnapshotMetadata
    : await getLatestSuccessfulReserveSnapshotMetadata(db, stablecoinId);
  const liveMetadata = readRedemptionBackstopLiveMetadata(stablecoinId, snapshotMetadata, now);

  if (
    liveMetadata.canUseCapacity
    && liveMetadata.capacityConfidence != null
    && (liveMetadata.immediateRedeemableUsd != null || (liveMetadata.immediateRedeemableRatio != null && supplyUsd != null))
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
    const dailyLimitNote = dailyLimitCapsCapacity
      ? "Live redemption daily limit caps usable scoring capacity"
      : null;
    const queueDepthNote = liveMetadata.queueDepthUsd != null
      ? "Live redemption queue depth is surfaced as a route constraint"
      : null;
    const settlementDelayNote = liveMetadata.settlementDelaySec != null
      ? "Live redemption settlement delay is surfaced as a route constraint"
      : null;

    return {
      immediateCapacityUsd,
      immediateCapacityRatio: derivedRatio,
      scoringCapacityUsd,
      scoringCapacityRatio,
      provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_METADATA,
      sourceMode:
        REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[
          REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_METADATA
        ].defaultSourceMode,
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
      provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_FALLBACK,
      sourceMode:
        REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[
          REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_FALLBACK
        ].defaultSourceMode,
      resolutionState: "resolved",
      capacityConfidence: fallbackCapacityConfidence,
      capacityBasis: resolveCapacityBasis(null, model, fallbackCapacityConfidence),
      capacitySemantics,
      notes: [
        liveMetadata.capacityReason
          ? `${liveMetadata.capacityReason}; using configured fallback ratio`
          : "Live reserve metadata unavailable; using configured fallback ratio",
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
      scoringCapacityUsd: supplyUsd,
      scoringCapacityRatio: supplyUsd > 0 ? 1 : null,
      provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_FULL_MODEL,
      sourceMode:
        REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[
          REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_FULL_MODEL
        ].defaultSourceMode,
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
      scoringCapacityUsd: supplyUsd * model.ratio,
      scoringCapacityRatio: model.ratio,
      provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_RATIO_MODEL,
      sourceMode:
        REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[
          REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_RATIO_MODEL
        ].defaultSourceMode,
      resolutionState: "resolved",
      capacityConfidence,
      capacitySemantics,
      notes: [],
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
