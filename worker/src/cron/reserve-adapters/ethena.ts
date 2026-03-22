import type { LiveReservesConfig, LiveReserveWarning, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./types";
import { fetchJsonWithRetry, getAdapterTimeout, requireJsonInputFromConfig, slicesFromValues } from "./helpers";

interface EthenaCollateralRow {
  asset: string;
  exchange: string;
  timestamp: number;
  usdAmount: number;
}

export interface EthenaCollateralResponse {
  collateral: EthenaCollateralRow[];
  totalBackingAssetsInUsd: number;
}

type EthenaBucket = "stable" | "btc" | "eth" | "other";

const ETHENA_ETH_ASSETS = new Set(["ETH", "stETH", "WBETH", "mETH", "LsETH"]);
const ETHENA_BTC_ASSETS = new Set(["BTC"]);
const ETHENA_STABLE_ASSETS = new Set(["Liquid Cash"]);
const ETHENA_OTHER_ASSETS = new Set(["SOL", "XRP", "BNB", "HYPE"]);

function bucketForEthenaAsset(asset: string): EthenaBucket {
  if (ETHENA_STABLE_ASSETS.has(asset)) return "stable";
  if (ETHENA_BTC_ASSETS.has(asset)) return "btc";
  if (ETHENA_ETH_ASSETS.has(asset)) return "eth";
  return "other";
}

export function listUnexpectedEthenaAssets(payload: EthenaCollateralResponse): string[] {
  const knownAssets = new Set([
    ...ETHENA_STABLE_ASSETS,
    ...ETHENA_BTC_ASSETS,
    ...ETHENA_ETH_ASSETS,
    ...ETHENA_OTHER_ASSETS,
  ]);

  return Array.from(new Set(payload.collateral.map((row) => row.asset)))
    .filter((asset) => !knownAssets.has(asset));
}

export function adaptEthenaCollateral(payload: EthenaCollateralResponse): AdapterResult {
  const bucketTotals = new Map<EthenaBucket, number>();
  let computedTotalBackingAssetsInUsd = 0;
  let unknownExposureUsd = 0;
  const knownAssets = new Set([
    ...ETHENA_STABLE_ASSETS,
    ...ETHENA_BTC_ASSETS,
    ...ETHENA_ETH_ASSETS,
    ...ETHENA_OTHER_ASSETS,
  ]);

  for (const row of payload.collateral) {
    if (!Number.isFinite(row.usdAmount) || row.usdAmount <= 0) continue;
    computedTotalBackingAssetsInUsd += row.usdAmount;
    const bucket = bucketForEthenaAsset(row.asset);
    if (!knownAssets.has(row.asset)) {
      unknownExposureUsd += row.usdAmount;
    }
    bucketTotals.set(bucket, (bucketTotals.get(bucket) ?? 0) + row.usdAmount);
  }

  if (
    payload.totalBackingAssetsInUsd > 0
    && Math.abs(computedTotalBackingAssetsInUsd - payload.totalBackingAssetsInUsd) / payload.totalBackingAssetsInUsd > 0.02
  ) {
    throw new Error(
      `Ethena collateral total ${computedTotalBackingAssetsInUsd.toFixed(2)} does not match totalBackingAssetsInUsd ${payload.totalBackingAssetsInUsd.toFixed(2)}`,
    );
  }

  const slices = slicesFromValues([
    {
      name: "Liquid stables / cash equivalents",
      value: bucketTotals.get("stable") ?? 0,
      risk: "low",
    },
    {
      name: "BTC collateral",
      value: bucketTotals.get("btc") ?? 0,
      risk: "medium",
    },
    {
      name: "ETH / liquid staking collateral",
      value: bucketTotals.get("eth") ?? 0,
      risk: "medium",
    },
    {
      name: "Other crypto collateral",
      value: bucketTotals.get("other") ?? 0,
      risk: "high",
    },
  ]);

  const assetCount = new Set(payload.collateral.map((row) => row.asset)).size;
  const lastUpdatedAt = payload.collateral.reduce(
    (max, row) => (row.timestamp > max ? row.timestamp : max),
    0,
  );

  return {
    slices,
    metadata: {
      assetCount,
      computedTotalBackingAssetsInUsd,
      totalBackingAssetsInUsd: payload.totalBackingAssetsInUsd,
      lastUpdatedAt,
      sourceTimestamp: lastUpdatedAt,
      unknownExposurePct:
        computedTotalBackingAssetsInUsd > 0
          ? (unknownExposureUsd / computedTotalBackingAssetsInUsd) * 100
          : 0,
    },
  };
}

export async function fetchEthenaReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "ethena");
  const payload = await fetchJsonWithRetry<EthenaCollateralResponse>(primaryInput.url, signal, getAdapterTimeout(config, 12_000));
  const adapted = adaptEthenaCollateral(payload);
  const unknownAssets = listUnexpectedEthenaAssets(payload);
  const warnings: LiveReserveWarning[] = unknownAssets.map((asset) => ({
    code: "unknown-asset",
    message: `Ethena asset bucketed into other-crypto: ${asset}`,
    severity: "warning",
  }));

  return {
    ...adapted,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
