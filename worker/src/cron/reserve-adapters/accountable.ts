import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  getAdapterTimeout,
  parseTimestampLikeToUnixSeconds,
  reserveDegradedWarning,
  requireJsonInputFromConfig,
  slicesFromValues,
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

function extractNestedNumericValue(value: unknown, depth = 0): number | null {
  const direct = toFiniteNumber(value);
  if (direct != null) return direct;
  if (depth > 4) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  let total = 0;
  let found = false;
  for (const nested of Object.values(value)) {
    const numeric = extractNestedNumericValue(nested, depth + 1);
    if (numeric == null) continue;
    total += numeric;
    found = true;
  }

  return found ? total : null;
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
        .map(([name, value]) => ({ name, value: extractNestedNumericValue(value) ?? 0 }));
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
  const warnings = breakdown
    .filter(({ name }) => !(name in riskMap))
    .map((entry) => reserveDegradedWarning(
      "unmapped-bucket",
      `Accountable bucket defaulted to medium risk: ${entry.name}`,
    ));
  const slices = slicesFromValues(
    breakdown.map(({ name, value }) => ({
      name: renameMap[name] ?? name,
      value,
      risk: riskMap[name] ?? "medium",
    })),
  );

  const totalReserves =
    typeof payload.data.reserves.total_reserves === "object"
      ? payload.data.reserves.total_reserves?.value
      : payload.data.reserves.total_reserves;
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.data.ts);

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      bucket,
      breakdownCount: breakdown.length,
      collateralization: payload.data.collateralization,
      interval: payload.data.reserves.interval,
      verifiability: payload.data.reserves.verifiability,
      totalReserves,
      dashboardTimestamp: payload.data.ts,
      ...(sourceTimestamp != null
        ? { sourceTimestamp, freshnessMode: "verified" as const }
        : { freshnessMode: "unverified" as const }),
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
    getAdapterTimeout(config, 12_000),
    ctx,
  );
  return adaptAccountableDashboard(payload, params);
}
