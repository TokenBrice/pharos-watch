import type { LiveReservesConfig, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import { fetchJsonWithRetry, requireJsonInputFromConfig, slicesFromValues } from "./helpers";

interface FalconBreakdownAsset {
  label: string;
  [venue: string]: string | number;
}

export interface FalconTransparencyResponse {
  snapshot_date: number;
  usdf?: {
    supply: string;
    insurance_fund: string;
    breakdown?: {
      assets?: FalconBreakdownAsset[];
    };
  };
}

type FalconBucket = "stable" | "btc" | "eth" | "rwa" | "other";

const FALCON_BTC_ASSETS = new Set(["BTC", "WBTC", "MBTC", "ENZOBTC"]);
const FALCON_ETH_ASSETS = new Set(["ETH", "ETH-AETH", "stETH", "WBETH", "mETH", "LsETH", "WETH_BASECHAIN_ETH_QV3S"]);
const FALCON_STABLE_ASSETS = new Set([
  "USDC",
  "USDT",
  "USDC_ARB_3SBJ",
  "USDC_BASECHAIN_ETH_5I5C",
  "USDT_ARB",
  "DAI",
  "FDUSD",
  "FRAX",
  "USD1",
  "USDS",
  "TUSD",
  "AUSD",
  "USDB",
  "GHO",
]);
const FALCON_RWA_ASSETS = new Set(["USTB", "JTRSY", "JAAA"]);

function bucketForFalconAsset(label: string): FalconBucket {
  if (FALCON_STABLE_ASSETS.has(label)) return "stable";
  if (FALCON_BTC_ASSETS.has(label)) return "btc";
  if (FALCON_ETH_ASSETS.has(label)) return "eth";
  if (FALCON_RWA_ASSETS.has(label)) return "rwa";
  return "other";
}

function sumFalconAssetValue(asset: FalconBreakdownAsset): number {
  let total = 0;
  for (const [key, value] of Object.entries(asset)) {
    if (key === "label") continue;
    const numeric =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim()
          ? Number(value)
          : NaN;
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    total += numeric;
  }
  return total;
}

export function adaptFalconTransparency(payload: FalconTransparencyResponse): AdapterResult {
  const assets = payload.usdf?.breakdown?.assets ?? [];
  if (assets.length === 0) {
    throw new Error("Falcon transparency payload missing usdf.breakdown.assets");
  }

  const bucketTotals = new Map<FalconBucket, number>();
  for (const asset of assets) {
    const value = sumFalconAssetValue(asset);
    if (!Number.isFinite(value) || value <= 0) continue;
    const bucket = bucketForFalconAsset(asset.label);
    bucketTotals.set(bucket, (bucketTotals.get(bucket) ?? 0) + value);
  }

  const insuranceFund =
    typeof payload.usdf?.insurance_fund === "string"
      ? Number(payload.usdf.insurance_fund)
      : NaN;

  const slices = slicesFromValues([
    {
      name: "Stablecoins / cash equivalents",
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
      name: "Tokenized RWA / credit assets",
      value: bucketTotals.get("rwa") ?? 0,
      risk: "medium",
    },
    {
      name: "Other crypto / tokenized assets",
      value: bucketTotals.get("other") ?? 0,
      risk: "high",
    },
    {
      name: "Insurance fund",
      value: Number.isFinite(insuranceFund) && insuranceFund > 0 ? insuranceFund : 0,
      risk: "medium",
    },
  ]);

  return {
    slices,
    metadata: {
      snapshotDate: payload.snapshot_date,
      supply: payload.usdf?.supply,
      insuranceFund: payload.usdf?.insurance_fund,
      assetCount: assets.length,
    },
  };
}

export async function fetchFalconReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "falcon");
  const payload = await fetchJsonWithRetry<FalconTransparencyResponse>(primaryInput.url, signal, 12_000);
  return adaptFalconTransparency(payload);
}
