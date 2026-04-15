import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  requireJsonInputFromConfig,
  summarizeSourceTimestamps,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
} from "./helpers";

interface RiverTimeseriesPoint {
  chainId?: number;
  timestamp?: string | number;
  value?: number;
}

interface RiverProtocolInfoPayload {
  tvl?: number;
  circulatingSupply?: number;
  chainCirculating?: Array<{ chain?: string; circulating?: number }>;
  tvlData?: RiverTimeseriesPoint[];
  circulatingData?: RiverTimeseriesPoint[];
}

export function adaptRiverProtocolInfo(payload: RiverProtocolInfoPayload): AdapterResult {
  const totalReserveUsd = payload.tvl;
  const supplyUsd = payload.circulatingSupply;
  if (!Number.isFinite(totalReserveUsd) || !Number.isFinite(supplyUsd) || (totalReserveUsd ?? 0) <= 0 || (supplyUsd ?? 0) <= 0) {
    throw new Error("river-protocol-info missing TVL or circulating supply");
  }

  const timestampSummary = summarizeSourceTimestamps([
    ...(payload.tvlData ?? []).map((point) => point.timestamp),
    ...(payload.circulatingData ?? []).map((point) => point.timestamp),
  ]);

  return {
    slices: [
      {
        name: "Aggregate River protocol collateral TVL",
        pct: 100,
        risk: "medium",
      },
    ],
    metadata: {
      ...(timestampSummary
        ? {
            ...verifiedFreshnessMetadata(timestampSummary.sourceTimestamp),
            latestSourceTimestamp: timestampSummary.latestSourceTimestamp,
            sourceTimestampSpreadSec: timestampSummary.sourceTimestampSpreadSec,
            sourceTimestampCount: timestampSummary.timestampCount,
          }
        : unverifiedFreshnessMetadata(
            "river-protocol-info-api",
            "River protocol-info payload did not expose a trustworthy source timestamp",
          )),
      totalReserveUsd,
      supplyUsd,
      collateralizationRatio: (totalReserveUsd ?? 0) / (supplyUsd ?? 1),
      chainCirculatingCount: payload.chainCirculating?.length ?? 0,
      tvlPointCount: payload.tvlData?.length ?? 0,
      circulatingPointCount: payload.circulatingData?.length ?? 0,
      sourceProvenance:
        "Aggregate TVL telemetry only. Kept proof-class until asset-level collateral composition is source-verified.",
    },
  };
}

export async function fetchRiverProtocolInfoReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInputFromConfig(config, "river-protocol-info");
  const payload = await fetchJsonWithRetry<RiverProtocolInfoPayload>(input.url, signal, 12_000, ctx);
  return adaptRiverProtocolInfo(payload);
}
