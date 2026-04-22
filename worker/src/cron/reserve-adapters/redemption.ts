import type {
  LiveReserveInput,
  LiveReserveRedemptionCapacityKind,
  LiveReserveRedemptionFreshnessKind,
  LiveReserveRedemptionRouteStatus,
  LiveReserveRedemptionRouteStatusSource,
  LiveReserveSnapshotMetadata,
} from "@shared/types/live-reserves";
import type { AdapterContext } from "./types";
import { fetchOnchainRateBps, type OnchainRateProbe } from "./onchain";

type EvmInput = Extract<LiveReserveInput, { kind: "onchain-evm" }>;

interface BuildRedemptionSnapshotMetadataOptions {
  capacityUsd?: number;
  capacityRatioOfSupply?: number;
  capacityKind?: LiveReserveRedemptionCapacityKind;
  freshnessKind?: LiveReserveRedemptionFreshnessKind;
  sourceTimestamp?: number;
  blockNumber?: number;
  routeStatus?: LiveReserveRedemptionRouteStatus;
  routeStatusSource?: LiveReserveRedemptionRouteStatusSource;
  routeStatusReason?: string;
  routeStatusReviewedAt?: string;
  holderEligibility?: string;
  settlementDelaySec?: number;
  queueDepthUsd?: number;
  dailyLimitUsd?: number;
  minRedeemUsd?: number;
  feeBps?: number | null;
  sourceUrls?: string[];
}

export function buildRedemptionSnapshotMetadata(
  options: BuildRedemptionSnapshotMetadataOptions,
): Pick<LiveReserveSnapshotMetadata, "redemption" | "redemptionFeeBps"> {
  const { feeBps, ...redemption } = options;
  return {
    ...(feeBps != null ? { redemptionFeeBps: feeBps } : {}),
    redemption: {
      ...redemption,
      ...(feeBps != null ? { feeBps } : {}),
    },
  };
}

export async function probeOptionalRedemptionRateBps(
  input: EvmInput,
  probe: OnchainRateProbe | undefined,
  signal: AbortSignal,
  ctx?: AdapterContext,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
): Promise<number | null> {
  if (!probe) {
    return null;
  }

  return fetchOnchainRateBps(input, probe, signal, ctx, rpcUrl, fallbackRpcUrl);
}
