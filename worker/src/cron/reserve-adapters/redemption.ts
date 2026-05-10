import type {
  LiveReserveInput,
  LiveReserveRedemptionTelemetry,
  LiveReserveSnapshotMetadata,
} from "@shared/types/live-reserves";
import type { AdapterContext } from "./types";
import { fetchOnchainRateBps, type OnchainRateProbe } from "./onchain";

type EvmInput = Extract<LiveReserveInput, { kind: "onchain-evm" }>;

type BuildRedemptionSnapshotMetadataOptions = Omit<LiveReserveRedemptionTelemetry, "feeBps"> & {
  feeBps?: LiveReserveRedemptionTelemetry["feeBps"] | null;
};

interface DocumentedRedemptionTelemetryOptions {
  holderEligibility?: string;
}

export function buildDocumentedRedemptionTelemetry(
  sourceTimestamp?: number | null,
  options: DocumentedRedemptionTelemetryOptions = {},
): LiveReserveRedemptionTelemetry {
  return {
    capacityKind: "documented-bound",
    freshnessKind: sourceTimestamp != null ? "verified-source-timestamp" : "unverified",
    ...(sourceTimestamp != null ? { sourceTimestamp } : {}),
    routeStatus: "unknown",
    ...(options.holderEligibility ? { holderEligibility: options.holderEligibility } : {}),
  };
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
