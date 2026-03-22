import type { LiveReserveWarning, LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./types";
import { fetchJsonWithRetry, getAdapterTimeout, isHttpJsonInput, normalizeSlices, reserveDegradedWarning } from "./helpers";

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
  immediateRedeemableUsd: number;
  supplyUsd: number | null;
}

export function adaptReservoirReserves(payload: ReservoirReservesResponse): AdaptReservoirResult {
  const totalAssets = Number(payload.totalAssets);
  if (!Number.isFinite(totalAssets) || totalAssets <= 0) {
    return { slices: [], unknownAssets: [], immediateRedeemableUsd: 0, supplyUsd: null };
  }

  const bucketTotals = new Map<string, number>();
  const unknownAssets: string[] = [];
  let unknownAssetsUsd = 0;

  for (const asset of payload.assets) {
    const value = Number(asset.totalBalanceValue);
    if (!Number.isFinite(value) || value <= 0) continue;

    const bucket = RESERVOIR_BUCKETS.find((candidate) => candidate.match(asset));
    if (!bucket) {
      unknownAssets.push(asset.label);
      unknownAssetsUsd += value;
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
    .sort((a, b) => b.pct - a.pct);

  if (unknownAssetsUsd > 0) {
    slices.push({
      name: "Unmapped reserve positions",
      pct: (unknownAssetsUsd / totalAssets) * 100,
      risk: "high",
    });
  }

  const totalLiabilities = Number(payload.totalLiabilities);
  const supplyUsd = Number.isFinite(totalLiabilities) && totalLiabilities > 0 ? totalLiabilities : null;
  const usdcBucket = RESERVOIR_BUCKETS.find((bucket) => bucket.key === "usdc");
  const immediateRedeemableUsd = usdcBucket
    ? payload.assets.reduce((sum, asset) => {
        if (!usdcBucket.match(asset)) return sum;
        const value = Number(asset.totalBalanceValue);
        return Number.isFinite(value) && value > 0 ? sum + value : sum;
      }, 0)
    : 0;

  return {
    slices: normalizeSlices(slices),
    unknownAssets,
    immediateRedeemableUsd,
    supplyUsd,
  };
}

export async function fetchReservoirReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = config.inputs.primary;
  if (!isHttpJsonInput(primaryInput)) {
    throw new Error("reservoir adapter requires an http-json primary input");
  }

  const payload = await fetchJsonWithRetry<ReservoirReservesResponse>(
    primaryInput.url,
    signal,
    getAdapterTimeout(config, 12_000),
    ctx,
  );
  const adapted = adaptReservoirReserves(payload);
  const warnings: LiveReserveWarning[] = adapted.unknownAssets.map((label) => reserveDegradedWarning(
    "unknown-position",
    `Unmapped reserve position: ${label}`,
  ));

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
      freshnessMode: "unverified",
      unknownExposurePct:
        Number(payload.totalAssets) > 0
          ? adapted.slices
            .filter((slice) => slice.name === "Unmapped reserve positions")
            .reduce((sum, slice) => sum + slice.pct, 0)
          : 0,
      ...(adapted.supplyUsd != null
        ? {
            supplyUsd: adapted.supplyUsd,
            immediateRedeemableUsd: adapted.immediateRedeemableUsd,
            ...(adapted.supplyUsd > 0
              ? { immediateRedeemableRatio: adapted.immediateRedeemableUsd / adapted.supplyUsd }
              : {}),
          }
        : {}),
    },
  };
}
