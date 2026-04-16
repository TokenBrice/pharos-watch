import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildUnknownExposureWarning,
  classifyBucketedValues,
  fetchJsonWithRetry,
  requireJsonInputFromConfig,
  unverifiedFreshnessMetadata,
} from "./helpers";
import type { ValueBucketRule } from "./classification";
import { wrapperAssetMeta } from "./wrapper-assets";
import { buildBrowserHeaders } from "./request";

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

const RESERVOIR_BROWSER_HEADERS = buildBrowserHeaders(
  "https://app.reservoir.xyz",
  "https://app.reservoir.xyz/reserves",
);

// Stable buckets redeemable for rUSD on short notice. Reservoir holds a mix of
// stablecoin-wrapped positions, any of which can be routed to the redemption
// queue, so the immediate redeemable estimate should aggregate across all of
// them rather than favouring USDC alone.
const RESERVOIR_STABLE_BUCKET_KEYS: readonly ReservoirBucketKey[] = [
  "usd1",
  "pyusd",
  "rlusd",
  "gho",
  "usdt",
  "usdc",
];

// Label-match helpers use token-exclusive regex word-boundaries so that a
// single-token label like "USDC" only matches the USDC rule, not USD1 or USDT.
// For multi-token labels like "Aave - PYUSD/USDC", the rule listed FIRST wins.
//
// Canonical ordering when adding new tokens:
//   1. Tokens with unique prefixes/numerics (USD1) first, to prevent them
//      matching generic "USD" patterns below.
//   2. Wrapper-family tokens (PYUSD, RLUSD, GHO) next, so pools that pair a
//      wrapper with USDC/USDT attribute to the wrapper family.
//   3. USDT before USDC so USDT0-wrapped pools (e.g. "USDT0/USDC" on Plasma)
//      attribute to USDT/USDT0, not USDC.
//   4. Plain USDC last among the dollar-ledger buckets.
//   5. rUSD self-strategy vaults last of all.
const RESERVOIR_BUCKETS: readonly ValueBucketRule<ReservoirBalanceItem, ReservoirBucketKey>[] = [
  {
    key: "usd1",
    name: "USD1 lending markets",
    risk: "medium",
    ...wrapperAssetMeta("usd1"),
    // USD1 is the only "USD<digit>" label, so a word-boundary match is safe
    match: (item) => /\bUSD1\b/.test(item.label),
  },
  {
    key: "pyusd",
    name: "PYUSD lending markets",
    risk: "medium",
    ...wrapperAssetMeta("pyusd"),
    match: (item) => /\bPYUSD\b/.test(item.label),
  },
  {
    key: "rlusd",
    name: "RLUSD lending markets",
    risk: "medium",
    ...wrapperAssetMeta("rlusd"),
    match: (item) => /\bRLUSD\b/.test(item.label),
  },
  {
    key: "gho",
    name: "GHO lending markets",
    risk: "medium",
    ...wrapperAssetMeta("gho"),
    // Match GHO as a standalone token or sGHO; exclude RUSD/USDT labels that
    // happen to contain a G.
    match: (item) => /\b(?:s?GHO)\b/.test(item.label),
  },
  {
    key: "usdt",
    name: "USDT / USDT0 positions",
    risk: "medium",
    ...wrapperAssetMeta("usdt"),
    // USDT0 and plain USDT; exclude USDT-adjacent labels like "tUSD".
    match: (item) => /\bUSDT0?\b/.test(item.label),
  },
  {
    key: "usdc",
    name: "USDC positions",
    risk: "medium",
    ...wrapperAssetMeta("usdc"),
    // USDC standalone only; other stablecoins that contain "USD" (USD1/USDT/etc)
    // match their own rules first.
    match: (item) => /\bUSDC\b/.test(item.label),
  },
  {
    key: "rusd",
    name: "rUSD strategy vaults",
    risk: "medium",
    match: (item) => /\bRUSD\b/.test(item.label),
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
  const immediateRedeemableUsd = RESERVOIR_STABLE_BUCKET_KEYS.reduce(
    (sum, key) => sum + (classified.bucketTotals.get(key) ?? 0),
    0,
  );

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
  const primaryInput = requireJsonInputFromConfig(config, "reservoir");

  const payload = await fetchJsonWithRetry<ReservoirReservesResponse>(
    primaryInput.url,
    signal,
    12_000,
    ctx,
    { headers: RESERVOIR_BROWSER_HEADERS },
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
  if (
    Number.isFinite(totalAssetsUsd)
    && Number.isFinite(totalLiabilitiesUsd)
    && totalAssetsUsd > 0
    && totalLiabilitiesUsd > totalAssetsUsd
  ) {
    warnings.push({
      code: "reservoir-insolvent",
      message: `Reservoir total liabilities (${totalLiabilitiesUsd}) exceed total assets (${totalAssetsUsd})`,
      severity: "warning",
      effect: "fatal",
    });
  }

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
            redemption: {
              capacityUsd: adapted.immediateRedeemableUsd,
              ...(adapted.supplyUsd > 0
                ? { capacityRatioOfSupply: adapted.immediateRedeemableUsd / adapted.supplyUsd }
                : {}),
              capacityKind: "live-proxy-validated" as const,
              freshnessKind: "unverified" as const,
              routeStatus: "unknown" as const,
              sourceUrls: [primaryInput.url],
            },
          }
        : {}),
    },
  };
}
