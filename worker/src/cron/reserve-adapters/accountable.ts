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
      total_reserves?: number;
      type?: Record<string, number>;
      reserves_split?: Array<{ name: string; value: number }>;
    };
  };
}

interface AccountableParams {
  bucket?: "type" | "reserves_split";
  riskMap?: Record<string, ReserveSlice["risk"]>;
}

function parseAccountableParams(config: LiveReservesConfig): AccountableParams {
  const params = config.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return {};

  const bucket =
    params.bucket === "type" || params.bucket === "reserves_split"
      ? params.bucket
      : undefined;
  const rawRiskMap = params.riskMap;
  const riskMap: Record<string, ReserveSlice["risk"]> = {};

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

  return {
    bucket,
    ...(Object.keys(riskMap).length > 0 ? { riskMap } : {}),
  };
}

function adaptAccountableDashboard(
  payload: AccountableDashboardResponse,
  params: AccountableParams,
): AdapterResult {
  if (payload.res !== "ok" || !payload.data?.reserves) {
    throw new Error("Accountable dashboard returned an invalid response");
  }

  const bucket = params.bucket ?? "type";
  const breakdown =
    bucket === "type"
      ? Object.entries(payload.data.reserves.type ?? {}).map(([name, value]) => ({ name, value }))
      : bucket === "reserves_split"
        ? payload.data.reserves.reserves_split ?? []
        : null;
  if (!breakdown) {
    throw new Error(`Unsupported Accountable bucket: ${bucket}`);
  }

  const riskMap = params.riskMap ?? {};
  const slices = buildReserveSlicesFromValues(
    breakdown.map(({ name, value }) => ({
      name,
      value,
      risk: riskMap[name] ?? "medium",
    })),
  );

  return {
    slices,
    metadata: {
      collateralization: payload.data.collateralization,
      interval: payload.data.reserves.interval,
      verifiability: payload.data.reserves.verifiability,
      totalReserves: payload.data.reserves.total_reserves,
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
