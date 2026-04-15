import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  parseTimestampLikeToUnixSeconds,
  requireJsonInputFromConfig,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
} from "./helpers";

interface SolsticeTimelinePoint {
  ts?: string | number;
  date?: string;
  reserves?: number;
  supply?: number;
  delta_neutral?: boolean;
  overcollateralized?: boolean;
}

interface SolsticeDashboardPayload {
  res?: string;
  data?: {
    collateralization?: number;
    ts?: string | number;
    reserves?: {
      verifiability?: string;
      interval?: string;
      timeline?: SolsticeTimelinePoint[];
    };
  };
}

function latestTimelinePoint(points: SolsticeTimelinePoint[] | undefined): SolsticeTimelinePoint | null {
  if (!Array.isArray(points) || points.length === 0) return null;
  return points
    .slice()
    .sort((left, right) => (
      (parseTimestampLikeToUnixSeconds(right.ts) ?? 0) - (parseTimestampLikeToUnixSeconds(left.ts) ?? 0)
    ))[0] ?? null;
}

export function adaptSolsticeAttestation(payload: SolsticeDashboardPayload): AdapterResult {
  if (payload.res !== "ok" || !payload.data?.reserves) {
    throw new Error("solstice-attestation returned an invalid response");
  }

  const point = latestTimelinePoint(payload.data.reserves.timeline);
  const totalReserveUsd = point?.reserves;
  const supplyUsd = point?.supply;
  if (!Number.isFinite(totalReserveUsd) || !Number.isFinite(supplyUsd) || (totalReserveUsd ?? 0) <= 0 || (supplyUsd ?? 0) <= 0) {
    throw new Error("solstice-attestation missing reserve/supply timeline values");
  }

  const sourceTimestamp =
    parseTimestampLikeToUnixSeconds(payload.data.ts)
    ?? parseTimestampLikeToUnixSeconds(point?.ts)
    ?? parseTimestampLikeToUnixSeconds(point?.date);
  const collateralizationRatio = (totalReserveUsd ?? 0) / (supplyUsd ?? 1);

  return {
    slices: [
      {
        name: "Aggregate Solstice attested reserves",
        pct: 100,
        risk: "high",
      },
    ],
    metadata: {
      ...(sourceTimestamp != null
        ? verifiedFreshnessMetadata(sourceTimestamp)
        : unverifiedFreshnessMetadata(
            "solstice-attestation-api",
            "Solstice attestation payload did not expose a trustworthy source timestamp",
          )),
      totalReserveUsd,
      supplyUsd,
      collateralizationRatio,
      publishedCollateralizationRatio: payload.data.collateralization,
      deltaNeutral: point?.delta_neutral,
      overcollateralized: point?.overcollateralized,
      verifiability: payload.data.reserves.verifiability,
      interval: payload.data.reserves.interval,
      sourceProvenance:
        "Aggregate solvency proof only. Kept proof-class until timestamped asset-category composition is source-verified.",
    },
  };
}

export async function fetchSolsticeAttestationReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInputFromConfig(config, "solstice-attestation");
  const payload = await fetchJsonWithRetry<SolsticeDashboardPayload>(input.url, signal, 12_000, ctx);
  return adaptSolsticeAttestation(payload);
}
