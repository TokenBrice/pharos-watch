import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { buildReserveSlicesFromValues, requireHttpJsonInput } from "./utils";

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

function parseAccountableParams(config: LiveReservesConfig): AccountableParams {
  const params = config.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return {};

  const bucket =
    params.bucket === "type"
    || params.bucket === "reserves_split"
    || params.bucket === "deployment"
    || params.bucket === "type_split"
    || params.bucket === "stablecoin_split"
    || params.bucket === "exposure_split"
      ? params.bucket
      : undefined;
  const rawRiskMap = params.riskMap;
  const rawRenameMap = params.renameMap;
  const riskMap: Record<string, ReserveSlice["risk"]> = {};
  const renameMap: Record<string, string> = {};

  if (rawRiskMap && typeof rawRiskMap === "object" && !Array.isArray(rawRiskMap)) {
    for (const [key, value] of Object.entries(rawRiskMap)) {
      if (
        value === "very-low"
        || value === "low"
        || value === "medium"
        || value === "high"
        || value === "very-high"
      ) {
        riskMap[key] = value;
      }
    }
  }

  if (rawRenameMap && typeof rawRenameMap === "object" && !Array.isArray(rawRenameMap)) {
    for (const [key, value] of Object.entries(rawRenameMap)) {
      if (typeof value === "string" && value.trim()) {
        renameMap[key] = value.trim();
      }
    }
  }

  return {
    bucket,
    ...(Object.keys(riskMap).length > 0 ? { riskMap } : {}),
    ...(Object.keys(renameMap).length > 0 ? { renameMap } : {}),
  };
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractNestedNumericValue(value: unknown): number | null {
  const direct = toNumber(value);
  if (direct != null) return direct;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  let total = 0;
  let found = false;
  for (const nested of Object.values(value)) {
    const numeric = extractNestedNumericValue(nested);
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
  const slices = buildReserveSlicesFromValues(
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

  return {
    slices,
    metadata: {
      collateralization: payload.data.collateralization,
      interval: payload.data.reserves.interval,
      verifiability: payload.data.reserves.verifiability,
      totalReserves,
      dashboardTimestamp: payload.data.ts,
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
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireHttpJsonInput(config, "accountable");
  const params = parseAccountableParams(config);
  const res = await fetchWithRetry(primaryInput.url, { signal }, 2, { timeoutMs: 12_000 });
  if (!res) throw new Error("Accountable dashboard: fetchWithRetry returned null (all retries failed)");
  if (!res.ok) throw new Error(`Accountable dashboard ${res.status}`);

  const payload = await res.json() as AccountableDashboardResponse;
  return adaptAccountableDashboard(payload, params);
}
