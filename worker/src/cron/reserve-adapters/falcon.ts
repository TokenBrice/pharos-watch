import type { LiveReserveWarning, LiveReservesConfig, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import { fetchJsonWithRetry, getAdapterTimeout, requireJsonInputFromConfig, slicesFromValues } from "./helpers";

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
const FALCON_RWA_ASSETS = new Set(["USTB", "JTRSY", "JAAA", "XAUT"]);

/** Well-known altcoins that legitimately go to the "other" bucket without warning. */
const FALCON_OTHER_KNOWN = new Set([
  // L1/L2 natives
  "SOL", "BNB", "TRX", "XRP", "AVAX", "TON", "NEAR", "ATOM", "SEI",
  "BERA", "POL", "KAVA", "CELO", "EOS", "FLR", "WFLR", "ASTR",
  "RON", "RONIN", "METIS", "S", "SONIC", "KLAY", "CFX",
  // DeFi / governance
  "CRV", "CVX", "UNI", "DODO", "MORPHO", "PENDLE", "EUL",
  "GNO", "ANKR", "BAL", "SUSHI", "QI",
  // Popular / meme
  "FLOKI", "TRUMP", "HMSTR", "DEXE", "FET",
  // Other known tokens
  "LUMIA", "JST", "XDC", "SIREN", "MANTA", "JASMY",
  "MASK", "IOST", "SUN", "BTTC", "BTT", "WLFI",
  "PROM", "BABY", "DOLO", "LAYER", "PORTAL",
  "MANTRA", "YGG", "API3", "COTI", "MOVE",
  "FIDA", "ID", "A", "SOPH",
]);

/** Only warn about unknown assets above this USD value. */
const FALCON_UNKNOWN_WARN_THRESHOLD = 10_000;

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

  const warnings: LiveReserveWarning[] = [];
  const bucketTotals = new Map<FalconBucket, number>();
  for (const asset of assets) {
    const value = sumFalconAssetValue(asset);
    if (!Number.isFinite(value) || value <= 0) continue;
    const bucket = bucketForFalconAsset(asset.label);
    if (bucket === "other" && !FALCON_OTHER_KNOWN.has(asset.label) && value > FALCON_UNKNOWN_WARN_THRESHOLD) {
      warnings.push({
        code: "unknown-asset",
        message: `Unmapped Falcon asset: ${asset.label} ($${value.toFixed(0)})`,
        severity: "warning",
      });
    }
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
    ...(warnings.length > 0 ? { warnings } : {}),
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
  const payload = await fetchJsonWithRetry<FalconTransparencyResponse>(primaryInput.url, signal, getAdapterTimeout(config, 12_000));
  return adaptFalconTransparency(payload);
}
