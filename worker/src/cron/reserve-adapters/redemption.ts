import type {
  LiveReserveInput,
  LiveReserveRedemptionTelemetry,
  LiveReserveRedemptionTelemetryKnownFields,
  LiveReserveSnapshotMetadata,
} from "@shared/types/live-reserves";
import { LiveReserveRedemptionTelemetrySchema } from "@shared/types/live-reserves";
import type { RedemptionHolderEligibility } from "@shared/types/redemption";
import type { AdapterContext } from "./types";
import { fetchOnchainRateBps, type OnchainRateProbe } from "./onchain";

type EvmInput = Extract<LiveReserveInput, { kind: "onchain-evm" }>;

type LiveRouteStatusSource = Extract<
  LiveReserveRedemptionTelemetryKnownFields["routeStatusSource"],
  "onchain" | "protocol-api"
>;
/** Opaque protocol diagnostics, separate from the schema-owned common wire fields. */
interface RedemptionSnapshotMetadataExtensions {
  sharedResourceKey?: string;
  redemptionHandlerAddress?: string;
  guardEnabled?: boolean;
  reUsdOraclePrice?: number;
  permissionlessPriceThreshold?: number;
  litePsmAddress?: string;
  litePsmPocket?: string;
  litePsmGem?: string;
  litePsmUsdcBalanceRaw?: string;
}


type BuildRedemptionSnapshotMetadataBase = Omit<
  LiveReserveRedemptionTelemetryKnownFields,
  "feeBps" | "routeStatusSource"
> & RedemptionSnapshotMetadataExtensions & {
  feeBps?: LiveReserveRedemptionTelemetryKnownFields["feeBps"] | null;
};

type BuildRedemptionSnapshotMetadataOptions =
  | (BuildRedemptionSnapshotMetadataBase & {
      routeStatusSource?: Exclude<LiveReserveRedemptionTelemetryKnownFields["routeStatusSource"], LiveRouteStatusSource>;
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
  // Preserve malformed arrays for fatal output validation; never filter bad evidence into a valid claim.
  if (redemption.sourceUrls !== undefined &&
    LiveReserveRedemptionTelemetrySchema.shape.sourceUrls.safeParse(redemption.sourceUrls).success) {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const url of redemption.sourceUrls) {
      const value = new URL(url).toString();
      if (!seen.has(value)) {
        seen.add(value);
        normalized.push(value);
      }
    }
    redemption.sourceUrls = normalized;
  }
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
