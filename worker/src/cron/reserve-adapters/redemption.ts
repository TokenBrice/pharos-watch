import type {
  LiveReserveInput,
  LiveReserveRedemptionTelemetry,
  LiveReserveSnapshotMetadata,
} from "@shared/types/live-reserves";
import type { RedemptionHolderEligibility } from "@shared/types/redemption";
import type { AdapterContext } from "./types";
import { fetchOnchainRateBps, type OnchainRateProbe } from "./onchain";

type EvmInput = Extract<LiveReserveInput, { kind: "onchain-evm" }>;

type LiveRouteStatusSource = Extract<
  LiveReserveRedemptionTelemetry["routeStatusSource"],
  "onchain" | "protocol-api"
>;

type BuildRedemptionSnapshotMetadataBase = Omit<
  LiveReserveRedemptionTelemetry,
  "feeBps" | "routeStatusSource"
> & {
  feeBps?: LiveReserveRedemptionTelemetry["feeBps"] | null;
};

type BuildRedemptionSnapshotMetadataOptions =
  | (BuildRedemptionSnapshotMetadataBase & {
      routeStatusSource?: Exclude<LiveReserveRedemptionTelemetry["routeStatusSource"], LiveRouteStatusSource>;
      routeObserved?: never;
    })
  | (BuildRedemptionSnapshotMetadataBase & {
      routeStatusSource: LiveRouteStatusSource;
      routeObserved: true;
    });

interface DocumentedRedemptionTelemetryOptions {
  holderEligibility?: RedemptionHolderEligibility;
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
): Pick<LiveReserveSnapshotMetadata, "redemption"> {
  const { feeBps, routeObserved, routeStatusSource, ...redemption } = options;
  const routeStatusSourceRequiresObservation =
    routeStatusSource === "onchain" || routeStatusSource === "protocol-api";
  return {
    redemption: {
      ...redemption,
      ...(routeStatusSource != null && (!routeStatusSourceRequiresObservation || routeObserved === true)
        ? { routeStatusSource }
        : {}),
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
