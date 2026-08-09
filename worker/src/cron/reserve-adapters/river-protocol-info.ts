import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildCoverageShortfallWarnings,
  fetchJsonAdapterInput,
  reserveDegradedWarning,
  SOURCE_TIMESTAMP_SPREAD_DEGRADE_SEC,
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
  const collateralizationRatio = (totalReserveUsd ?? 0) / (supplyUsd ?? 1);
  const warnings = buildCoverageShortfallWarnings({
    code: "reserve-undercollateralized",
    message: (pct) => `River protocol-info TVL covers ${pct}% of circulating satUSD`,
    coverageRatio: collateralizationRatio,
  });

  const timestampSummary = summarizeSourceTimestamps([
    ...(payload.tvlData ?? []).map((point) => point.timestamp),
    ...(payload.circulatingData ?? []).map((point) => point.timestamp),
  ]);
  if (
    timestampSummary
    && timestampSummary.sourceTimestampSpreadSec > SOURCE_TIMESTAMP_SPREAD_DEGRADE_SEC
  ) {
    warnings.push(reserveDegradedWarning(
      "source-timestamp-spread",
      `River protocol-info source timestamps span ${timestampSummary.sourceTimestampSpreadSec} seconds`,
    ));
  }

  return {
    slices: [
      {
        name: "Aggregate River protocol collateral TVL",
        pct: 100,
        risk: "medium",
      },
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...(timestampSummary
        ? {
            ...verifiedFreshnessMetadata(timestampSummary.sourceTimestamp),
            oldestSourceTimestamp: timestampSummary.sourceTimestamp,
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
      collateralizationRatio,
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
  const payload = await fetchJsonAdapterInput<RiverProtocolInfoPayload>(config, "river-protocol-info", signal, 12_000, ctx);
  return adaptRiverProtocolInfo(payload);
}
