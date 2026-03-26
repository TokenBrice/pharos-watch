import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  accumulateBucketedExposure,
  fetchJsonWithRetry,
  getAdapterTimeout,
  requireJsonInputFromConfig,
  reserveDegradedWarning,
  slicesFromValues,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
} from "./helpers";

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
  const {
    bucketTotals,
    totalValue: totalAssetUsd,
    unknownValue: unknownExposureUsd,
    unknownValuesByKey,
  } = accumulateBucketedExposure({
    items: assets,
    getValue: sumFalconAssetValue,
    getBucket: (asset) => bucketForFalconAsset(asset.label),
    isUnknown: (asset, bucket) => bucket === "other" && !FALCON_OTHER_KNOWN.has(asset.label),
    getUnknownKey: (asset) => asset.label,
  });

  for (const [label, value] of unknownValuesByKey) {
    const sharePct = totalAssetUsd > 0 ? (value / totalAssetUsd) * 100 : 0;
    if (value > FALCON_UNKNOWN_WARN_THRESHOLD || sharePct >= 0.25) {
      warnings.push(reserveDegradedWarning(
        "unknown-asset",
        `Unmapped Falcon asset: ${label} ($${value.toFixed(0)}, ${sharePct.toFixed(2)}%)`,
      ));
    }
  }

  const insuranceFund =
    typeof payload.usdf?.insurance_fund === "string"
      ? Number(payload.usdf.insurance_fund)
      : NaN;
  const supplyUsd =
    typeof payload.usdf?.supply === "string"
      ? Number(payload.usdf.supply)
      : NaN;
  const stableBucketUsd = bucketTotals.get("stable") ?? 0;

  const slices = slicesFromValues([
    {
      name: "Stablecoins / cash equivalents",
      value: stableBucketUsd,
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
      ...(Number.isFinite(supplyUsd) && supplyUsd > 0 ? { supplyUsd } : {}),
      immediateRedeemableUsd: stableBucketUsd,
      ...(Number.isFinite(supplyUsd) && supplyUsd > 0
        ? { immediateRedeemableRatio: stableBucketUsd / supplyUsd }
        : {}),
      assetCount: assets.length,
      ...(payload.snapshot_date > 0
        ? verifiedFreshnessMetadata(payload.snapshot_date)
        : unverifiedFreshnessMetadata(
            "issuer-api",
            "Falcon transparency payload did not expose a trustworthy snapshot timestamp",
          )),
      unknownExposurePct: totalAssetUsd > 0 ? (unknownExposureUsd / totalAssetUsd) * 100 : 0,
    },
  };
}

export async function fetchFalconReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "falcon");
  const payload = await fetchJsonWithRetry<FalconTransparencyResponse>(
    primaryInput.url,
    signal,
    getAdapterTimeout(config, 12_000),
    ctx,
  );
  return adaptFalconTransparency(payload);
}
