import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { RedemptionBackstopConfig, RedemptionCapacityModel } from "@shared/lib/redemption-backstops";
import type { RedemptionBackstopProviderId } from "@shared/lib/redemption-backstop-providers";
import type { RedemptionBackstopEntry, RedemptionCapacityProfile } from "@shared/types/redemption";
import type { ReserveSnapshotMetadataRecord } from "../live-reserves-store";
import type { RedemptionRouteAvailability } from "../redemption-backstop-availability";

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

export interface CapacityResolverContext {
  db: D1Database;
  stablecoinId: string;
  supplyUsd: number | null;
  now: number;
  options: RedemptionBackstopBuildOptions;
}

export type CapacityResolver<M extends RedemptionCapacityModel = RedemptionCapacityModel> = (
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
