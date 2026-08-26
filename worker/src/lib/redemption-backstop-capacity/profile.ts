import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { resolveCapacityBasis } from "@shared/lib/redemption-backstop-capacity";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { RedemptionCapacityModel } from "@shared/lib/redemption-backstops";
import type { RedemptionBackstopProviderId } from "@shared/lib/redemption-backstop-providers";
import type { RedemptionBackstopEntry, RedemptionCapacityProfile } from "@shared/types/redemption";
import type { ReserveSnapshotMetadataRecord } from "../live-reserves-store";
import type { RedemptionRouteAvailability } from "../redemption-backstop-availability";
import type { RedemptionBackstopLiveMetadata } from "../redemption-backstop-live-metadata";

export interface CapacityResolution {
  immediateCapacityUsd: number | null;
  immediateCapacityRatio: number | null;
  scoringCapacityUsd: number | null;
  scoringCapacityRatio: number | null;
  eventualCapacityUsd?: number | null;
  eventualCapacityRatio?: number | null;
  capacityProfile?: RedemptionCapacityProfile;
  settlementBoundUnproven?: true;
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
  redemptionLiveMetadata?: RedemptionBackstopLiveMetadata;
  routeAvailability?: RedemptionRouteAvailability | null;
}

export interface CapacityResolverContext {
  db: D1Database;
  stablecoinId: string;
  supplyUsd: number | null;
  now: number;
  options: RedemptionBackstopBuildOptions;
}

type CapacityResolver<M extends RedemptionCapacityModel = RedemptionCapacityModel> = (
  model: M,
  context: CapacityResolverContext,
) => Promise<CapacityResolution>;

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

export function buildMissingSupplyResolution(
  provider: RedemptionBackstopProviderId,
  capacityConfidence: RedemptionBackstopEntry["capacityConfidence"],
  capacitySemantics: RedemptionBackstopEntry["capacitySemantics"],
): CapacityResolution {
  return {
    immediateCapacityUsd: null,
    immediateCapacityRatio: null,
    scoringCapacityUsd: null,
    scoringCapacityRatio: null,
    provider,
    sourceMode: "static",
    resolutionState: "missing-cache",
    capacityConfidence,
    capacitySemantics,
    notes: ["Stablecoins cache missing current supply; route retained as configured but unrated"],
  };
}

export { resolveCapacityBasis };
