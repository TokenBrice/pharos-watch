import type { LiveReservesConfig, LiveReserveWarning, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { buildReserveSlicesFromValues, requireHttpJsonInput } from "./utils";

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

function bucketForEthenaAsset(asset: string): EthenaBucket {
  if (ETHENA_STABLE_ASSETS.has(asset)) return "stable";
  if (ETHENA_BTC_ASSETS.has(asset)) return "btc";
  if (ETHENA_ETH_ASSETS.has(asset)) return "eth";
  return "other";
}

export function adaptEthenaCollateral(payload: EthenaCollateralResponse): AdapterResult {
  const bucketTotals = new Map<EthenaBucket, number>();

  for (const row of payload.collateral) {
    if (!Number.isFinite(row.usdAmount) || row.usdAmount <= 0) continue;
    const bucket = bucketForEthenaAsset(row.asset);
    bucketTotals.set(bucket, (bucketTotals.get(bucket) ?? 0) + row.usdAmount);
  }

  const slices = buildReserveSlicesFromValues([
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
      totalBackingAssetsInUsd: payload.totalBackingAssetsInUsd,
      lastUpdatedAt,
    },
  };
}

export async function fetchEthenaReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireHttpJsonInput(config, "ethena");
  const res = await fetchWithRetry(primaryInput.url, { signal }, 2, { timeoutMs: 12_000 });
  if (!res) throw new Error("Ethena collateral API: fetchWithRetry returned null (all retries failed)");
  if (!res.ok) throw new Error(`Ethena collateral API ${res.status}`);

  const payload = await res.json() as EthenaCollateralResponse;
  const adapted = adaptEthenaCollateral(payload);

  const knownAssets = new Set([...ETHENA_STABLE_ASSETS, ...ETHENA_BTC_ASSETS, ...ETHENA_ETH_ASSETS]);
  const unknownAssets = Array.from(new Set(payload.collateral.map((row) => row.asset)))
    .filter((asset) => !knownAssets.has(asset));
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
