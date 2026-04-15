import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildUnknownExposureWarning,
  computeUnknownExposurePct,
  fetchJsonWithRetry,
  parseTimestampLikeToUnixSeconds,
  requireJsonInputFromConfig,
  slicesFromValues,
  unverifiedFreshnessMetadata,
} from "./helpers";
import { toFiniteNumber } from "../../lib/number-utils";

interface AccountableDashboardResponse {
  res: string;
  data?: {
    collateralization: number;
    ts: string;
    reserves?: {
      interval?: string;
      verifiability?: string;
      total_reserves?: number | { name?: string; value?: number };
      type?: Record<string, number>;
      reserves_split?: Array<{ name: string; value: number }>;
      deployment?: Record<string, number>;
      type_split?: Record<string, number>;
      stablecoin_split?: Record<string, number>;
      exposure_split?: Record<string, Record<string, number> | number>;
    };
  };
}

interface AccountableParams {
  bucket?: "type" | "reserves_split" | "deployment" | "type_split" | "stablecoin_split" | "exposure_split";
  riskMap?: Record<string, ReserveSlice["risk"]>;
  renameMap?: Record<string, string>;
}

const VALID_BUCKETS = new Set(["type", "reserves_split", "deployment", "type_split", "stablecoin_split", "exposure_split"]);

function parseAccountableParams(config: LiveReservesConfig): AccountableParams {
  const params = parseLiveReserveAdapterParams("accountable", config.params);
  if (params.bucket != null && !VALID_BUCKETS.has(params.bucket)) {
    throw new Error(`accountable: invalid bucket "${params.bucket}", expected one of: ${[...VALID_BUCKETS].join(", ")}`);
  }
  return params;
}

function extractAccountableBucketValue(value: unknown, depth = 0): number | null {
  const direct = toFiniteNumber(value);
  if (direct != null) return direct;
  if (depth > 1) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  for (const key of ["value", "usd", "amount", "total"]) {
    const numeric = toFiniteNumber(record[key]);
    if (numeric != null) return numeric;
  }

  const numericChildren = Object.values(record)
    .map((nested) => extractAccountableBucketValue(nested, depth + 1))
    .filter((numeric): numeric is number => numeric != null);

  if (numericChildren.length === 0) return null;
  return numericChildren.reduce((sum, numeric) => sum + numeric, 0);
}

function extractBucketEntries(
  reserves: NonNullable<NonNullable<AccountableDashboardResponse["data"]>["reserves"]>,
  bucket: NonNullable<AccountableParams["bucket"]>,
): Array<{ name: string; value: number }> {
  switch (bucket) {
    case "type":
      return Object.entries(reserves.type ?? {}).map(([name, value]) => ({ name, value }));
    case "reserves_split":
      return (reserves.reserves_split ?? [])
        .map((entry) => ({ name: entry.name, value: entry.value }));
    case "deployment":
      return Object.entries(reserves.deployment ?? {}).map(([name, value]) => ({ name, value }));
    case "type_split":
      return Object.entries(reserves.type_split ?? {}).map(([name, value]) => ({ name, value }));
    case "stablecoin_split":
      return Object.entries(reserves.stablecoin_split ?? {}).map(([name, value]) => ({ name, value }));
    case "exposure_split":
      return Object.entries(reserves.exposure_split ?? {})
        .map(([name, value]) => ({ name, value: extractAccountableBucketValue(value) ?? 0 }));
    default:
      return [];
  }
}

function adaptAccountableDashboard(
  payload: AccountableDashboardResponse,
  params: AccountableParams,
): AdapterResult {
  if (payload.res !== "ok" || !payload.data?.reserves) {
    throw new Error("Accountable dashboard returned an invalid response");
  }

  const bucket = params.bucket ?? "type";
  const breakdown = extractBucketEntries(payload.data.reserves, bucket);
  if (breakdown.length === 0) {
    throw new Error(`Unsupported Accountable bucket: ${bucket}`);
  }

  const riskMap = params.riskMap ?? {};
  const renameMap = params.renameMap ?? {};
  const mapped = breakdown.filter(({ name }) => name in riskMap);
  const unknown = breakdown.filter(({ name }) => !(name in riskMap));
  const totalValue = breakdown.reduce((sum, entry) => sum + entry.value, 0);
  const unknownValue = unknown.reduce((sum, entry) => sum + entry.value, 0);
  const unknownExposurePct = computeUnknownExposurePct(unknownValue, totalValue);

  const slices = slicesFromValues(
    [
      ...mapped.map(({ name, value }) => ({
        name: renameMap[name] ?? name,
        value,
        risk: riskMap[name]!,
      })),
      ...(unknownValue > 0
        ? [{
            name: "Unknown / unmapped Accountable buckets",
            value: unknownValue,
            risk: "high" as const,
          }]
        : []),
    ].map(({ name, value, risk }) => ({
      name: renameMap[name] ?? name,
      value,
      risk,
    })),
  );

  const totalReserves =
    typeof payload.data.reserves.total_reserves === "object"
      ? payload.data.reserves.total_reserves?.value
      : payload.data.reserves.total_reserves;
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.data.ts);
  const stableRedeemableUsd = breakdown
    .filter((entry) => /stable|cash|usdc|usdt|pyusd|dai|treasury/i.test(entry.name))
    .reduce((sum, entry) => sum + entry.value, 0);

  return {
    slices,
    ...(unknownExposurePct > 0
      ? {
          warnings: [buildUnknownExposureWarning({
            code: "unmapped-bucket",
            message: `Accountable bucket mapping is missing: ${unknown.map((entry) => entry.name).sort().join(", ")}`,
            unknownExposurePct,
          })],
        }
      : {}),
    metadata: {
      bucket,
      breakdownCount: breakdown.length,
      mappedBucketCount: mapped.length,
      ...(unknown.length > 0 ? { unknownBucketCount: unknown.length } : {}),
      ...(unknown.length > 0 ? { unknownBucketNames: unknown.map((entry) => entry.name).sort() } : {}),
      ...(unknownExposurePct > 0 ? { unknownExposurePct } : {}),
      collateralization: payload.data.collateralization,
      interval: payload.data.reserves.interval,
      verifiability: payload.data.reserves.verifiability,
      totalReserves,
      dashboardTimestamp: payload.data.ts,
      ...(sourceTimestamp != null
        ? { sourceTimestamp, freshnessMode: "verified" as const }
        : unverifiedFreshnessMetadata(
            "accountable-dashboard",
            "Accountable dashboard payload does not expose a readable upstream timestamp",
          )),
      redemption: {
        capacityUsd: stableRedeemableUsd,
        capacityKind: "live-proxy-validated" as const,
        freshnessKind: sourceTimestamp != null ? "verified-source-timestamp" as const : "unverified" as const,
        ...(sourceTimestamp != null ? { sourceTimestamp } : {}),
        routeStatus: "unknown" as const,
        sourceUrls: [],
      },
    },
  };
}

export function adaptAccountableTypeBreakdown(
  payload: AccountableDashboardResponse,
  params: AccountableParams = {},
): ReserveSlice[] {
  return adaptAccountableDashboard(payload, params).slices;
}

export async function fetchAccountableReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "accountable");
  const params = parseAccountableParams(config);
  const payload = await fetchJsonWithRetry<AccountableDashboardResponse>(
    primaryInput.url,
    signal,
    12_000,
    ctx,
  );
  return adaptAccountableDashboard(payload, params);
}
