import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildUnknownExposureWarning,
  classifyBucketedValues,
  fetchJsonWithRetry,
  unverifiedFreshnessMetadata,
  requireJsonInputFromConfig,
} from "./helpers";
import type { ValueBucketRule } from "./classification";
import { wrapperAssetMeta } from "./wrapper-assets";
import { buildBrowserHeaders, NEUTRAL_ADAPTER_HEADERS } from "./request";
import { toErrorMessage } from "../../lib/error-utils";

interface ReservoirBalanceItem {
  label: string;
  description?: string;
  iconPath?: string;
  totalBalanceValue: string;
}

export interface ReservoirReservesResponse {
  assets: ReservoirBalanceItem[];
  liabilities: ReservoirBalanceItem[];
  totalAssets: string;
  totalLiabilities: string;
  equity: string;
}

type ReservoirBucketKey = "usd1" | "pyusd" | "rlusd" | "ausd" | "gho" | "usdt" | "usdc" | "rusd" | "prime" | "usdat";

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
  "ausd",
  "gho",
  "usdt",
  "usdc",
];

// Word-boundary regex rules are single-token exclusive; for multi-token
// labels (e.g. "PYUSD/USDC") the first matching rule wins, so wrappers
// (USD1/PYUSD/RLUSD/GHO) are listed before USDT/USDC.
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
    key: "ausd",
    name: "AUSD lending markets",
    risk: "medium",
    ...wrapperAssetMeta("ausd"),
    match: (item) => /\bAUSD\b/.test(item.label),
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
    match: (item) => /\bUSDC\b/.test(item.label) || /\bSteakhouse Prime Instant\b/i.test(item.label),
  },
  {
    key: "rusd",
    name: "rUSD strategy vaults",
    risk: "medium",
    match: (item) => /\bRUSD\b/.test(item.label),
  },
  {
    key: "prime",
    name: "Hastra / Sentora PRIME credit allocations",
    risk: "high",
    match: (item) => /\bPRIME\b/.test(item.label),
  },
  {
    key: "usdat",
    name: "Pendle PT USDat tokenized-treasury principal token",
    risk: "high",
    // Reservoir's raw row names the Pendle PT and Pendle resolves the market's
    // underlying asset to the tracked Saturn USDat Ethereum contract.
    coinId: "usdat-saturn",
    depType: "collateral",
    match: (item) => /\bUSDAT\b/i.test(item.label),
  },
];

const SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT = 0.5;

export interface AdaptReservoirResult {
  slices: ReserveSlice[];
  unknownAssets: string[];
  unknownExposurePct: number;
  sourceTotalGapPct: number;
  immediateRedeemableUsd: number;
  supplyUsd: number | null;
}

export function adaptReservoirReserves(payload: ReservoirReservesResponse): AdaptReservoirResult {
  const totalAssets = Number(payload.totalAssets);
  if (!Number.isFinite(totalAssets) || totalAssets <= 0) {
    return {
      slices: [],
      unknownAssets: [],
      unknownExposurePct: 0,
      sourceTotalGapPct: 0,
      immediateRedeemableUsd: 0,
      supplyUsd: null,
    };
  }

  const disclosedAssetValue = payload.assets.reduce((sum, asset) => {
    const value = Number(asset.totalBalanceValue);
    return Number.isFinite(value) && value > 0 ? sum + value : sum;
  }, 0);
  const sourceTotalGapUsd = Math.max(0, totalAssets - disclosedAssetValue);
  const sourceTotalGapPct = (sourceTotalGapUsd / totalAssets) * 100;
  const assets =
    sourceTotalGapPct > SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT
      ? [
          ...payload.assets,
          {
            label: "Unmapped Reservoir balance-sheet total-assets gap",
            totalBalanceValue: String(sourceTotalGapUsd),
          },
        ]
      : payload.assets;

  const classified = classifyBucketedValues({
    items: assets,
    rules: RESERVOIR_BUCKETS,
    getValue: (asset) => Number(asset.totalBalanceValue),
    getUnknownLabel: (asset) => asset.label,
    totalValue: totalAssets,
    unknownSliceName: "Unmapped reserve positions",
  });

  const totalLiabilities = Number(payload.totalLiabilities);
  const supplyUsd = Number.isFinite(totalLiabilities) && totalLiabilities > 0 ? totalLiabilities : null;
  const stableBucketUsd = RESERVOIR_STABLE_BUCKET_KEYS.reduce(
    (sum, key) => sum + (classified.bucketTotals.get(key) ?? 0),
    0,
  );
  const immediateRedeemableUsd = supplyUsd != null ? Math.min(stableBucketUsd, supplyUsd) : stableBucketUsd;

  return {
    slices: classified.slices,
    unknownAssets: classified.unknownItems,
    unknownExposurePct: classified.unknownExposurePct,
    sourceTotalGapPct,
    immediateRedeemableUsd,
    supplyUsd,
  };
}

async function fetchReservoirPayload(
  url: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<ReservoirReservesResponse> {
  try {
    return await fetchJsonWithRetry<ReservoirReservesResponse>(url, signal, 20_000, ctx, {
      headers: RESERVOIR_BROWSER_HEADERS,
    });
  } catch (primaryError) {
    if (signal.aborted) throw primaryError;
    try {
      return await fetchJsonWithRetry<ReservoirReservesResponse>(url, signal, 20_000, ctx, {
        headers: NEUTRAL_ADAPTER_HEADERS,
      });
    } catch (fallbackError) {
      if (signal.aborted) throw fallbackError;
      throw new Error(
        `browser fetch failed: ${toErrorMessage(primaryError)}; neutral fetch failed: ${toErrorMessage(fallbackError)}`,
      );
    }
  }
}

export async function fetchReservoirReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "reservoir");

  const payload = await fetchReservoirPayload(primaryInput.url, signal, ctx);
  const adapted = adaptReservoirReserves(payload);
  const totalAssetsUsd = Number(payload.totalAssets);
  const totalLiabilitiesUsd = Number(payload.totalLiabilities);
  const shareholderEquityUsd = Number(payload.equity);
  const warnings: LiveReserveWarning[] =
    adapted.unknownAssets.length > 0
      ? [
          buildUnknownExposureWarning({
            code: "unknown-position",
            message: `Unmapped reserve positions: ${adapted.unknownAssets.join(", ")}`,
            unknownExposurePct: adapted.unknownExposurePct,
          }),
        ]
      : [];
  if (adapted.sourceTotalGapPct > SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT) {
    warnings.push(
      buildUnknownExposureWarning({
        code: "source-total-gap",
        message: "Reservoir totalAssets exceeds disclosed asset rows",
        unknownExposurePct: adapted.sourceTotalGapPct,
        thresholdPct: SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT,
      }),
    );
  }
  if (
    Number.isFinite(totalAssetsUsd) &&
    Number.isFinite(totalLiabilitiesUsd) &&
    totalAssetsUsd > 0 &&
    totalLiabilitiesUsd > totalAssetsUsd
  ) {
    warnings.push({
      code: "reservoir-insolvent",
      message: `Reservoir total liabilities (${totalLiabilitiesUsd}) exceed total assets (${totalAssetsUsd})`,
      severity: "warning",
      effect: "degraded",
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
      ...(adapted.sourceTotalGapPct > 0 ? { sourceTotalGapPct: adapted.sourceTotalGapPct } : {}),
      ...unverifiedFreshnessMetadata(
        "protocol-balance-sheet-api",
        "Reservoir's timestamp-less protocol API payload is not independently freshness-verified during this adapter run",
      ),
      unknownExposurePct: adapted.unknownExposurePct,
      ...(Number.isFinite(totalAssetsUsd) && totalAssetsUsd > 0 ? { totalAssetsUsd } : {}),
      ...(Number.isFinite(totalLiabilitiesUsd) && totalLiabilitiesUsd > 0 ? { totalLiabilitiesUsd } : {}),
      ...(Number.isFinite(shareholderEquityUsd) ? { shareholderEquityUsd } : {}),
      ...(Number.isFinite(totalAssetsUsd) &&
      totalAssetsUsd > 0 &&
      Number.isFinite(totalLiabilitiesUsd) &&
      totalLiabilitiesUsd > 0
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
              routeStatusSource: "protocol-api" as const,
              sourceUrls: [primaryInput.url],
            },
          }
        : {}),
    },
  };
}
