import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildUnknownExposureWarning,
  classifyBucketedValues,
  fetchJsonWithRetry,
  isHttpJsonInput,
  unverifiedFreshnessMetadata,
} from "./helpers";
import type { ValueBucketRule } from "./classification";
import { wrapperAssetMeta } from "./wrapper-assets";

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

type ReservoirBucketKey = "usd1" | "pyusd" | "rlusd" | "gho" | "usdt" | "usdc" | "rusd";

const RESERVOIR_BUCKETS: readonly ValueBucketRule<ReservoirBalanceItem, ReservoirBucketKey>[] = [
  {
    key: "usd1",
    name: "USD1 lending markets",
    risk: "medium",
    ...wrapperAssetMeta("usd1"),
    match: (item) => item.label.includes("USD1"),
  },
  {
    key: "pyusd",
    name: "PYUSD lending markets",
    risk: "medium",
    ...wrapperAssetMeta("pyusd"),
    match: (item) => item.label.includes("PYUSD"),
  },
  {
    key: "rlusd",
    name: "RLUSD lending markets",
    risk: "medium",
    ...wrapperAssetMeta("rlusd"),
    match: (item) => item.label.includes("RLUSD"),
  },
  {
    key: "gho",
    name: "GHO lending markets",
    risk: "medium",
    ...wrapperAssetMeta("gho"),
    match: (item) => item.label.includes("GHO"),
  },
  {
    key: "usdt",
    name: "USDT / USDT0 positions",
    risk: "medium",
    ...wrapperAssetMeta("usdt"),
    match: (item) => item.label.includes("USDT0") || item.label === "USDT",
  },
  {
    key: "usdc",
    name: "USDC positions",
    risk: "medium",
    ...wrapperAssetMeta("usdc"),
    match: (item) => item.label.includes("USDC"),
  },
  {
    key: "rusd",
    name: "rUSD strategy vaults",
    risk: "medium",
    match: (item) => item.label.includes("RUSD"),
  },
];

export interface AdaptReservoirResult {
  slices: ReserveSlice[];
  unknownAssets: string[];
  unknownExposurePct: number;
  immediateRedeemableUsd: number;
  supplyUsd: number | null;
}

export function adaptReservoirReserves(payload: ReservoirReservesResponse): AdaptReservoirResult {
  const totalAssets = Number(payload.totalAssets);
  if (!Number.isFinite(totalAssets) || totalAssets <= 0) {
    return { slices: [], unknownAssets: [], unknownExposurePct: 0, immediateRedeemableUsd: 0, supplyUsd: null };
  }

  const classified = classifyBucketedValues({
    items: payload.assets,
    rules: RESERVOIR_BUCKETS,
    getValue: (asset) => Number(asset.totalBalanceValue),
    getUnknownLabel: (asset) => asset.label,
    totalValue: totalAssets,
    unknownSliceName: "Unmapped reserve positions",
  });

  const totalLiabilities = Number(payload.totalLiabilities);
  const supplyUsd = Number.isFinite(totalLiabilities) && totalLiabilities > 0 ? totalLiabilities : null;
  const immediateRedeemableUsd = classified.bucketTotals.get("usdc") ?? 0;

  return {
    slices: classified.slices,
    unknownAssets: classified.unknownItems,
    unknownExposurePct: classified.unknownExposurePct,
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
    12_000,
    ctx,
  );
  const adapted = adaptReservoirReserves(payload);
  const totalAssetsUsd = Number(payload.totalAssets);
  const totalLiabilitiesUsd = Number(payload.totalLiabilities);
  const shareholderEquityUsd = Number(payload.equity);
  const warnings: LiveReserveWarning[] = adapted.unknownAssets.length > 0
    ? [buildUnknownExposureWarning({
        code: "unknown-position",
        message: `Unmapped reserve positions: ${adapted.unknownAssets.join(", ")}`,
        unknownExposurePct: adapted.unknownExposurePct,
      })]
    : [];

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
      ...(adapted.unknownAssets.length > 0 ? { unknownAssetLabels: adapted.unknownAssets } : {}),
      ...unverifiedFreshnessMetadata(
        "protocol-balance-sheet-api",
        "Reservoir balance-sheet payload does not include a trustworthy source timestamp",
      ),
      unknownExposurePct: adapted.unknownExposurePct,
      ...(Number.isFinite(totalAssetsUsd) && totalAssetsUsd > 0 ? { totalAssetsUsd } : {}),
      ...(Number.isFinite(totalLiabilitiesUsd) && totalLiabilitiesUsd > 0 ? { totalLiabilitiesUsd } : {}),
      ...(Number.isFinite(shareholderEquityUsd) ? { shareholderEquityUsd } : {}),
      ...(Number.isFinite(totalAssetsUsd) && totalAssetsUsd > 0 && Number.isFinite(totalLiabilitiesUsd) && totalLiabilitiesUsd > 0
        ? { collateralizationRatio: totalAssetsUsd / totalLiabilitiesUsd }
        : {}),
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
