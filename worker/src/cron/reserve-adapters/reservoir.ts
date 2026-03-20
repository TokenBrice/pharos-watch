import type { LiveReserveWarning, LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import { fetchJsonWithRetry, getAdapterTimeout, isHttpJsonInput, normalizeSlices } from "./helpers";

interface ReservoirBalanceItem {
  label: string;
  totalBalanceValue: string;
}

export interface ReservoirReservesResponse {
  assets: ReservoirBalanceItem[];
  liabilities: ReservoirBalanceItem[];
  totalAssets: string;
  totalLiabilities: string;
  equity: string;
}

interface ReservoirBucketConfig {
  key: string;
  label: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  match: (item: ReservoirBalanceItem) => boolean;
}

const RESERVOIR_BUCKETS: ReservoirBucketConfig[] = [
  {
    key: "usd1",
    label: "USD1 lending markets",
    risk: "medium",
    coinId: "usd1-world-liberty-financial",
    depType: "wrapper",
    match: (item) => item.label.includes("USD1"),
  },
  {
    key: "pyusd",
    label: "PYUSD lending markets",
    risk: "medium",
    coinId: "pyusd-paypal",
    depType: "wrapper",
    match: (item) => item.label.includes("PYUSD"),
  },
  {
    key: "rlusd",
    label: "RLUSD lending markets",
    risk: "medium",
    coinId: "rlusd-ripple",
    depType: "wrapper",
    match: (item) => item.label.includes("RLUSD"),
  },
  {
    key: "gho",
    label: "GHO lending markets",
    risk: "medium",
    coinId: "gho-aave",
    depType: "wrapper",
    match: (item) => item.label.includes("GHO"),
  },
  {
    key: "usdt",
    label: "USDT / USDT0 positions",
    risk: "medium",
    coinId: "usdt-tether",
    depType: "wrapper",
    match: (item) => item.label.includes("USDT0") || item.label === "USDT",
  },
  {
    key: "usdc",
    label: "USDC positions",
    risk: "medium",
    coinId: "usdc-circle",
    depType: "wrapper",
    match: (item) => item.label.includes("USDC"),
  },
  {
    key: "rusd",
    label: "rUSD strategy vaults",
    risk: "medium",
    match: (item) => item.label.includes("RUSD"),
  },
];

export interface AdaptReservoirResult {
  slices: ReserveSlice[];
  unknownAssets: string[];
}

export function adaptReservoirReserves(payload: ReservoirReservesResponse): AdaptReservoirResult {
  const totalAssets = Number(payload.totalAssets);
  if (!Number.isFinite(totalAssets) || totalAssets <= 0) {
    return { slices: [], unknownAssets: [] };
  }

  const bucketTotals = new Map<string, number>();
  const unknownAssets: string[] = [];

  for (const asset of payload.assets) {
    const value = Number(asset.totalBalanceValue);
    if (!Number.isFinite(value) || value <= 0) continue;

    const bucket = RESERVOIR_BUCKETS.find((candidate) => candidate.match(asset));
    if (!bucket) {
      unknownAssets.push(asset.label);
      continue;
    }

    bucketTotals.set(bucket.key, (bucketTotals.get(bucket.key) ?? 0) + value);
  }

  const slices = Array.from(bucketTotals.entries())
    .map(([bucketKey, bucketValue]) => {
      const config = RESERVOIR_BUCKETS.find((bucket) => bucket.key === bucketKey)!;
      return {
        name: config.label,
        pct: (bucketValue / totalAssets) * 100,
        risk: config.risk,
        ...(config.coinId ? { coinId: config.coinId } : {}),
        ...(config.depType ? { depType: config.depType } : {}),
      } satisfies ReserveSlice;
    })
    .filter((slice) => slice.pct >= 0.05)
    .sort((a, b) => b.pct - a.pct);

  return {
    slices: normalizeSlices(slices),
    unknownAssets,
  };
}

export async function fetchReservoirReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = config.inputs.primary;
  if (!isHttpJsonInput(primaryInput)) {
    throw new Error("reservoir adapter requires an http-json primary input");
  }

  const payload = await fetchJsonWithRetry<ReservoirReservesResponse>(primaryInput.url, signal, getAdapterTimeout(config, 12_000));
  const adapted = adaptReservoirReserves(payload);
  const warnings: LiveReserveWarning[] = adapted.unknownAssets.map((label) => ({
    code: "unknown-position",
    message: `Unmapped reserve position: ${label}`,
    severity: "warning",
  }));

  return {
    slices: adapted.slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      assetCount: payload.assets.length,
      liabilityCount: payload.liabilities.length,
      totalAssets: payload.totalAssets,
      totalLiabilities: payload.totalLiabilities,
      equity: payload.equity,
      unknownAssetCount: adapted.unknownAssets.length,
    },
  };
}
