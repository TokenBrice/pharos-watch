import { resolveCapacityBasis } from "@shared/lib/redemption-backstop-capacity";
import type { RedemptionBackstopProviderId } from "@shared/lib/redemption-backstop-providers";
import type { RedemptionBackstopEntry, RedemptionCapacityProfile } from "@shared/types/redemption";
import type { ReserveSnapshotMetadataRecord } from "../live-reserves/store";
import type { RedemptionRouteAvailability } from "../redemption-backstop/availability";
import type { RedemptionBackstopLiveMetadata } from "../redemption-backstop/live-metadata";
import type { EvmRpcOptions } from "../evm-rpc";
import type { StablecoinsCacheLoadResult } from "../stablecoins-cache";
import type { V9ValidatedPolicyEnvelope } from "@shared/types/safety-score-v9";
import type { ExitExecutionModelReview } from "@shared/types/exit-route";
import type { ExecutableRedemptionObservation } from "../../cron/reserve-adapters/executable-redemption-observers";
import type { AdapterContext } from "../../cron/reserve-adapters/types";

import type { ConsumedReserveInput } from "@shared/types/reserve-input";
export interface CapacityResolution {
  consumedReserveCapacity?: boolean;
  consumedReserveRouteStatus?: boolean;
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
  capacityRejectionReason?: RedemptionBackstopEntry["capacityRejectionReason"];
  sharedResourceKey?: string;
  capacityBasis?: RedemptionBackstopEntry["capacityBasis"];
  capacitySemantics: RedemptionBackstopEntry["capacitySemantics"];
  capacityKind?: RedemptionBackstopEntry["capacityKind"];
  freshnessKind?: RedemptionBackstopEntry["freshnessKind"];
  sourceTimestamp?: number;
  evidenceObservedAt?: number;
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
  signal?: AbortSignal;
  reserveSnapshotMetadata?: ReserveSnapshotMetadataRecord | null;
  reserveInput?: ConsumedReserveInput;
  redemptionLiveMetadata?: RedemptionBackstopLiveMetadata;
  routeAvailability?: RedemptionRouteAvailability | null;
  rpcOptions?: EvmRpcOptions;
  stablecoinsCache?: StablecoinsCacheLoadResult;
  exitExecutionEnvelope?: V9ValidatedPolicyEnvelope;
  exitExecutionReviews?: readonly ExitExecutionModelReview[];
  executableRedemptionObservation?: ExecutableRedemptionObservation | null;
  executableObserverValuation?: { outputAssetKey: string; priceUsd: number; observedAt: number } | null;
  adapterContext?: AdapterContext;
}

export interface CapacityResolverContext {
  db: D1Database;
  stablecoinId: string;
  supplyUsd: number | null;
  now: number;
  options: RedemptionBackstopBuildOptions;
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

type BoundedCapacityFields = Pick<
  CapacityResolution,
  "immediateCapacityUsd" | "immediateCapacityRatio" | "scoringCapacityUsd" | "scoringCapacityRatio" | "capacityProfile"
> & {
  hasSupplyCeiling: boolean;
  hasPositiveSupply: boolean;
  capacityExceedsSupply: boolean;
  dailyLimitCapsCapacity: boolean;
};

// Callers admit the quantity and decide model semantics before this arithmetic
// step. In particular, eventual capacity is never inferred from the live buffer.
export function buildBoundedCapacityFields(params: {
  rawCapacityUsd: number;
  supplyUsd: number | null;
  dailyLimitUsd?: number | null;
  queueDepthUsd?: number | null;
  eventualCapacityUsd?: number | null;
  capacityProfileConfidence: RedemptionBackstopEntry["capacityConfidence"];
  settlementBoundUnproven?: boolean;
  applyDailyLimit: boolean;
}): BoundedCapacityFields {
  const { rawCapacityUsd, supplyUsd, dailyLimitUsd } = params;
  const hasSupplyCeiling = supplyUsd != null;
  const hasPositiveSupply = supplyUsd != null && supplyUsd > 0;
  const capacityExceedsSupply = supplyUsd != null && rawCapacityUsd > supplyUsd;
  const immediateCapacityUsd = Math.max(0, supplyUsd != null ? Math.min(supplyUsd, rawCapacityUsd) : rawCapacityUsd);
  const immediateCapacityRatio = supplyUsd != null && supplyUsd > 0
    ? Math.min(1, immediateCapacityUsd / supplyUsd)
    : null;
  const dailyLimitCapsCapacity = params.applyDailyLimit && dailyLimitUsd != null && dailyLimitUsd < immediateCapacityUsd;
  const scoringCapacityUsd = dailyLimitCapsCapacity && dailyLimitUsd != null ? Math.max(0, dailyLimitUsd) : immediateCapacityUsd;
  const scoringCapacityRatio = supplyUsd != null && supplyUsd > 0
    ? Math.min(1, scoringCapacityUsd / supplyUsd)
    : null;
  return {
    immediateCapacityUsd,
    immediateCapacityRatio,
    scoringCapacityUsd,
    scoringCapacityRatio,
    capacityProfile: {
      immediateUsd: immediateCapacityUsd,
      ...(dailyLimitUsd != null ? { dailyLimitUsd } : {}),
      ...(params.queueDepthUsd != null ? { queuedUsd: params.queueDepthUsd } : {}),
      ...(params.eventualCapacityUsd != null ? { eventualUsd: params.eventualCapacityUsd } : {}),
      scoringUsd: scoringCapacityUsd,
      scoringHorizon: dailyLimitCapsCapacity ? "daily" : params.queueDepthUsd != null ? "queued" : "immediate",
      capacityProfileConfidence: params.capacityProfileConfidence,
      ...(params.settlementBoundUnproven ? { settlementBoundUnproven: true } : {}),
    },
    hasSupplyCeiling,
    hasPositiveSupply,
    capacityExceedsSupply,
    dailyLimitCapsCapacity,
  };
}

export { resolveCapacityBasis };
