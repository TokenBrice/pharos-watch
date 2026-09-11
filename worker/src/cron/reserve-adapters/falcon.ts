import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  accumulateBucketedExposure,
  assertFiniteNonNegativeReserveRows,
  buildBucketSlices,
  buildRedemptionSnapshotMetadata,
  computeUnknownExposurePct,
  fetchJsonAdapterInput,
  freshnessMetadataFromTimestamp,
  parseTimestampLikeToUnixSeconds,
  reserveInfoWarning,
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
const FALCON_TRACKED_STABLE_ASSETS: Partial<Record<string, { name: string; coinId: string; risk: "low" }>> = {
  USDC: { name: "USDC cash-equivalent assets", coinId: "usdc-circle", risk: "low" },
  USDT: { name: "USDT cash-equivalent assets", coinId: "usdt-tether", risk: "low" },
  DAI: { name: "DAI cash-equivalent assets", coinId: "dai-makerdao", risk: "low" },
  FDUSD: { name: "FDUSD cash-equivalent assets", coinId: "fdusd-first-digital", risk: "low" },
  FRAX: { name: "FRAX cash-equivalent assets", coinId: "frax-frax", risk: "low" },
  USD1: { name: "USD1 cash-equivalent assets", coinId: "usd1-world-liberty-financial", risk: "low" },
  USDS: { name: "USDS cash-equivalent assets", coinId: "usds-sky", risk: "low" },
  TUSD: { name: "TUSD cash-equivalent assets", coinId: "tusd-trueusd", risk: "low" },
  AUSD: { name: "AUSD cash-equivalent assets", coinId: "ausd-agora", risk: "low" },
  USDB: { name: "USDB cash-equivalent assets", coinId: "usdb-blast", risk: "low" },
  GHO: { name: "GHO cash-equivalent assets", coinId: "gho-aave", risk: "low" },
};
const FALCON_RWA_ASSETS = new Set(["USTB", "JTRSY", "JAAA", "XAUT"]);
const USTB_CANONICAL_RISK = getCanonicalReserveAssetRisk("USTB");
if (USTB_CANONICAL_RISK == null) {
  throw new Error("Falcon USTB reserve row requires a canonical reserve-risk entry");
}
const FALCON_TRACKED_RWA_ASSETS: Partial<Record<string, { name: string; coinId: string; risk: ReserveSlice["risk"] }>> = {
  USTB: { name: "USTB tokenized Treasury assets", coinId: "ustb-superstate", risk: USTB_CANONICAL_RISK },
  JTRSY: { name: "JTRSY tokenized Treasury assets", coinId: "jtrsy-anemoy", risk: "medium" },
  JAAA: { name: "JAAA CLO assets", coinId: "jaaa-janus-henderson-anemoy", risk: "medium" },
  XAUT: { name: "XAUt gold token assets", coinId: "xaut-tether", risk: "medium" },
};

function bucketForFalconAsset(label: string): FalconBucket {
  if (FALCON_STABLE_ASSETS.has(label)) return "stable";
  if (FALCON_BTC_ASSETS.has(label)) return "btc";
  if (FALCON_ETH_ASSETS.has(label)) return "eth";
  if (FALCON_RWA_ASSETS.has(label)) return "rwa";
  return "other";
}

function sumFalconAssetValue(asset: FalconBreakdownAsset): number {
  const venues = Object.entries(asset)
    .filter(([key]) => key !== "label")
    .map(([venue, value]) => ({
      venue,
      value:
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim()
          ? Number(value)
          : NaN,
    }));
  assertFiniteNonNegativeReserveRows(
    venues,
    (venue) => venue.value,
    `Falcon ${asset.label} venue values`,
  );
  return venues.reduce((total, venue) => total + venue.value, 0);
}

export function adaptFalconTransparency(payload: FalconTransparencyResponse): AdapterResult {
  const assets = payload.usdf?.breakdown?.assets ?? [];
  if (assets.length === 0) {
    throw new Error("Falcon transparency payload missing usdf.breakdown.assets");
  }

  const warnings: LiveReserveWarning[] = [];
  const trackedStableValues = new Map<string, number>();
  const trackedRwaValues = new Map<string, number>();
  // Compute each asset's USD value once; it is consumed by the total, the
  // bucket classifier and the tracked-stable/RWA accumulation below.
  const assetValues = new Map<FalconBreakdownAsset, number>();
  for (const asset of assets) {
    assetValues.set(asset, sumFalconAssetValue(asset));
  }
  const {
    bucketTotals,
    totalValue: totalAssetUsd,
    unknownValue: unknownExposureUsd,
    unknownValuesByKey,
  } = accumulateBucketedExposure({
    items: assets,
    getValue: (asset) => assetValues.get(asset)!,
    getBucket: (asset) => {
      const bucket = bucketForFalconAsset(asset.label);
      const value = assetValues.get(asset)!;
      if (bucket === "stable" && FALCON_TRACKED_STABLE_ASSETS[asset.label]) {
        trackedStableValues.set(asset.label, (trackedStableValues.get(asset.label) ?? 0) + value);
      }
      if (bucket === "rwa" && FALCON_TRACKED_RWA_ASSETS[asset.label]) {
        trackedRwaValues.set(asset.label, (trackedRwaValues.get(asset.label) ?? 0) + value);
      }
      return bucket;
    },
    isUnknown: (_asset, bucket) => bucket === "other",
    getUnknownKey: (asset) => asset.label,
  });

  const unknownExposurePct = computeUnknownExposurePct(unknownExposureUsd, totalAssetUsd);

  // Unmapped assets keep their full weight inside the high-risk "other" bucket
  // and the unknown-exposure total; the shared policy cap (5% for
  // dynamic-mix/independent) decides whether that exposure degrades the
  // snapshot. Falcon's unmapped set is a long tail of altcoin dust, so it is
  // reported as one discovery warning instead of a per-asset degradation.
  if (unknownValuesByKey.size > 0) {
    const symbols = Array.from(unknownValuesByKey)
      .sort(([, left], [, right]) => right - left)
      .map(([label]) => label);
    warnings.push(reserveInfoWarning(
      "unknown-asset",
      `Unmapped Falcon assets: ${symbols.join(", ")} ` +
        `(${symbols.length} symbols, $${unknownExposureUsd.toFixed(2)}, ${unknownExposurePct.toFixed(2)}% of reserves)`,
    ));
  }

  const insuranceFund =
    typeof payload.usdf?.insurance_fund === "string"
      ? Number(payload.usdf.insurance_fund)
      : NaN;
  const supplyUsd =
    typeof payload.usdf?.supply === "string"
      ? Number(payload.usdf.supply)
      : NaN;
  if (!Number.isFinite(supplyUsd) || supplyUsd <= 0) {
    throw new Error("Falcon missing or invalid usdf.supply");
  }
  const { slices, immediateRedeemableUsd: stableBucketUsd } = buildBucketSlices(
    bucketTotals,
    [
      ...Array.from(trackedStableValues, ([label, value]) => {
        const config = FALCON_TRACKED_STABLE_ASSETS[label]!;
        return {
          name: config.name,
          value,
          risk: config.risk,
          coinId: config.coinId,
          depType: "collateral" as const,
        };
      }),
      {
        name: "Stablecoins / cash equivalents",
        value: Math.max(0, (bucketTotals.get("stable") ?? 0) - Array.from(trackedStableValues.values()).reduce((sum, value) => sum + value, 0)),
        risk: "low",
      },
      {
        name: "BTC collateral",
        bucket: "btc",
        risk: "medium",
      },
      {
        name: "ETH / liquid staking collateral",
        bucket: "eth",
        risk: "medium",
      },
      ...Array.from(trackedRwaValues, ([label, value]) => {
        const config = FALCON_TRACKED_RWA_ASSETS[label]!;
        return {
          name: config.name,
          value,
          risk: config.risk,
          coinId: config.coinId,
        };
      }),
      {
        name: "Tokenized RWA / credit assets",
        value: Math.max(0, (bucketTotals.get("rwa") ?? 0) - Array.from(trackedRwaValues.values()).reduce((sum, value) => sum + value, 0)),
        risk: "medium",
      },
      {
        name: "Other crypto / tokenized assets",
        bucket: "other",
        risk: "high",
      },
      {
        name: "Insurance fund",
        value: Number.isFinite(insuranceFund) && insuranceFund > 0 ? insuranceFund : 0,
        risk: "medium",
      },
    ],
    "stable",
  );

  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.snapshot_date);

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      snapshotDate: payload.snapshot_date,
      supply: payload.usdf?.supply,
      insuranceFund: payload.usdf?.insurance_fund,
      supplyUsd,
      assetCount: assets.length,
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "issuer-api",
        "Falcon transparency payload did not expose a trustworthy snapshot timestamp",
      ),
      unknownExposurePct,
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: stableBucketUsd,
        capacityRatioOfSupply: stableBucketUsd / supplyUsd,
        capacityKind: "live-queue",
        freshnessKind: sourceTimestamp != null ? "verified-source-timestamp" : "unverified",
        ...(sourceTimestamp != null ? { sourceTimestamp } : {}),
        routeStatus: "open",
        routeStatusSource: "protocol-api",
        holderEligibility: "whitelisted-primary",
        settlementDelaySec: 7 * 24 * 60 * 60,
        sourceUrls: ["https://api.falcon.finance/api/v1/transparency"],
      }),
    },
  };
}

export async function fetchFalconReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const payload = await fetchJsonAdapterInput<FalconTransparencyResponse>(
    config,
    "falcon",
    signal,
    12_000,
    ctx,
  );
  return adaptFalconTransparency(payload);
}
