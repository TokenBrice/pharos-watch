import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildRedemptionSnapshotMetadata,
  buildUnknownExposureWarning,
  freshnessMetadataFromTimestamp,
  parseTimestampLikeToUnixSeconds,
  requireJsonInputFromConfig,
  fetchJsonWithRetry,
  normalizeSlices,
  reserveDegradedWarning,
} from "./helpers";

/* ---------- v2 balance-sheet API types ---------- */

interface BalanceSheetAsset {
  tokenSymbol: string;
  totalValueUsd: number;
  category?: string;
}

export interface FraxBalanceSheetResponse {
  asOfTimestamp?: string;
  totalAssets?: number;
  assets?: BalanceSheetAsset[];
}

/* ---------- v2 FPI collateral API types ---------- */

interface FraxFpiCollateralRow {
  key?: string;
  name?: string;
  tokenSymbol?: string;
  tokenName?: string;
  valueUsd?: number | null;
}

export interface FraxFpiCollateralResponse {
  updatedAtBlock?: number;
  updatedAtTimestampSec?: number;
  assets?: FraxFpiCollateralRow[];
  liabilities?: FraxFpiCollateralRow[];
}

/* ---------- token → display / risk / coinId map ---------- */

interface TokenDisplayConfig {
  label: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
}

const TOKEN_DISPLAY: Record<string, TokenDisplayConfig> = {
  AUSD: { label: "AUSD (Agora Dollar)", risk: getCanonicalReserveAssetRisk("AUSD") ?? "low" },
  AVAX: { label: "AVAX", risk: getCanonicalReserveAssetRisk("AVAX") ?? "high" },
  WTGXX: { label: "WTGXX (WisdomTree Government Money Market)", risk: "low", coinId: "wtgxx-wisdomtree" },
  USTB: {
    label: "USTB (Superstate tokenized T-bills)",
    risk: getCanonicalReserveAssetRisk("USTB") ?? "low",
    coinId: "ustb-superstate",
  },
  BUIDL: {
    label: "BUIDL (BlackRock tokenized T-bills)",
    risk: getCanonicalReserveAssetRisk("BUIDL") ?? "low",
    coinId: "buidl-blackrock",
  },
  CVX: { label: "CVX", risk: "very-high" },
  CRV: { label: "CRV", risk: getCanonicalReserveAssetRisk("CRV") ?? "very-high" },
  CHR: { label: "CHR", risk: "very-high" },
  DAI: { label: "DAI", risk: getCanonicalReserveAssetRisk("DAI") ?? "low", coinId: "dai-makerdao" },
  ETH: { label: "ETH", risk: getCanonicalReserveAssetRisk("ETH") ?? "very-low" },
  FPI: { label: "FPI", risk: "medium" },
  FRAX: { label: "FRAX", risk: getCanonicalReserveAssetRisk("FRAX") ?? "low", coinId: "frax-frax" },
  FXS: { label: "FXS", risk: "high" },
  LFRAX: { label: "LFRAX", risk: "medium" },
  MULTI: { label: "MULTI", risk: "very-high" },
  OP: { label: "OP", risk: "high" },
  PYUSD: { label: "PYUSD", risk: getCanonicalReserveAssetRisk("PYUSD") ?? "low", coinId: "pyusd-paypal" },
  RAM: { label: "RAM", risk: "very-high" },
  SDT: { label: "SDT", risk: "very-high" },
  THE: { label: "THE", risk: "very-high" },
  USDB: { label: "USDB (Bridge)", risk: "low" },
  USDC: { label: "USDC (Circle)", risk: "low", coinId: "usdc-circle" },
  USCC: { label: "USCC (Superstate crypto arbitrage)", risk: "medium" },
  USDS: { label: "USDS", risk: getCanonicalReserveAssetRisk("USDS") ?? "low", coinId: "usds-sky" },
  USDe: { label: "USDe", risk: "high", coinId: "usde-ethena" },
  WAVAX: { label: "WAVAX", risk: "high" },
  WBNB: { label: "WBNB", risk: "high" },
  WETH: { label: "WETH", risk: getCanonicalReserveAssetRisk("WETH") ?? "very-low" },
  WPOL: { label: "WPOL", risk: "high" },
  ZK: { label: "ZK", risk: "high" },
  axlUSDC: { label: "axlUSDC", risk: "medium", coinId: "usdc-circle" },
  axlfrxETH: { label: "axlfrxETH", risk: "medium" },
  cvxCRV: { label: "cvxCRV", risk: "very-high" },
  frxETH: { label: "frxETH", risk: "low" },
  frxUSD: { label: "frxUSD", risk: getCanonicalReserveAssetRisk("FRXUSD") ?? "low", coinId: "frxusd-frax" },
  lzfrxETH: { label: "lzfrxETH", risk: "medium" },
  lzsfrxETH: { label: "lzsfrxETH", risk: "medium" },
  reUSD: { label: "reUSD", risk: "medium", coinId: "reusd-re-protocol" },
  sDAI: { label: "sDAI", risk: "low", coinId: "dai-makerdao" },
  sFRAX: { label: "sFRAX", risk: "medium", coinId: "frax-frax" },
  sfrxETH: { label: "sfrxETH", risk: getCanonicalReserveAssetRisk("SFRXETH") ?? "low" },
  sfrxUSD: { label: "sfrxUSD", risk: "low", coinId: "sfrxusd-frax" },
  stkAAVE: { label: "stkAAVE", risk: "very-high" },
  // Staked Convex wrapper of the Curve FPI/FRAX LP; no governance-token leg,
  // so it inherits FPI's own risk rating rather than FXS's.
  stkcvxFPIFRAX: { label: "stkcvxFPIFRAX (staked Convex FPI/FRAX LP)", risk: "medium" },
  wfrxETH: { label: "wfrxETH", risk: "medium" },
  ZZ: { label: "ZZ", risk: "very-high" },
};

// FPI collateral rows in this allowlist report no tokenSymbol, only a `name`.
// Keep them separate from tokenSymbol mappings so arbitrary provider row names
// cannot collide with trusted symbols such as FRAX, DAI, or USDC.
const FPI_COLLATERAL_NAME_ONLY_DISPLAY: Record<string, TokenDisplayConfig> = {
  // FPIS is FPI's own governance token, so this LP is rated like FXS rather
  // than a stable pair.
  "Fraxswap V2 FRAX/FPIS": { label: "Fraxswap V2 FRAX/FPIS", risk: "high" },
};

const SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT = 0.5;
const FPI_UNKNOWN_EXPOSURE_THRESHOLD_PCT = 5;

/* ---------- v2 balance-sheet adapter ---------- */

export function adaptFraxBalanceSheet(payload: FraxBalanceSheetResponse, subjectId?: string): AdapterResult {
  const assets = payload.assets;
  if (!assets?.length || !payload.totalAssets || payload.totalAssets <= 0) {
    throw new Error("Frax balance-sheet response missing or empty assets array");
  }

  const warnings: LiveReserveWarning[] = [];

  // Aggregate USD value by tokenSymbol
  const bySymbol = new Map<string, number>();
  for (const asset of assets) {
    if (!asset.category?.startsWith("asset:")) continue;
    const usd = Number(asset.totalValueUsd);
    if (!Number.isFinite(usd) || usd <= 0) continue;
    bySymbol.set(asset.tokenSymbol, (bySymbol.get(asset.tokenSymbol) ?? 0) + usd);
  }

  const categorizedAssetTotal = [...bySymbol.values()].reduce((a, b) => a + b, 0);
  if (categorizedAssetTotal <= 0) throw new Error("Frax balance-sheet total asset value is zero");
  const sourceTotal = Number(payload.totalAssets);
  if (!Number.isFinite(sourceTotal) || sourceTotal <= 0) {
    throw new Error("Frax balance-sheet totalAssets is invalid or zero");
  }
  const total = Math.max(categorizedAssetTotal, sourceTotal);
  const stableRedeemableUsd = ["USDC", "USDS", "PYUSD", "DAI", "FRAX"].reduce(
    (sum, symbol) => sum + (bySymbol.get(symbol) ?? 0),
    0,
  );
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.asOfTimestamp);

  const slices: ReserveSlice[] = [];
  const unknownSymbols: string[] = [];
  let unknownUsd = 0;
  for (const [symbol, usd] of bySymbol) {
    const config = TOKEN_DISPLAY[symbol];
    if (!config) {
      unknownSymbols.push(symbol);
      unknownUsd += usd;
    }
    if (config) {
      slices.push({
        name: config.label,
        pct: (usd / total) * 100,
        risk: config.risk,
        ...(config.coinId && config.coinId !== subjectId ? { coinId: config.coinId } : {}),
      });
    }
  }

  if (unknownUsd > 0) {
    slices.push({
      name: "Unmapped Frax balance-sheet assets",
      pct: (unknownUsd / total) * 100,
      risk: "high",
    });
    warnings.push(
      buildUnknownExposureWarning({
        code: "unknown-token",
        message: `Frax balance-sheet unknown token(s): ${unknownSymbols.sort().join(", ")}`,
        unknownExposurePct: (unknownUsd / total) * 100,
      }),
    );
  }

  const sourceTotalGapUsd = sourceTotal - categorizedAssetTotal;
  const sourceTotalGapPct = sourceTotalGapUsd > 0 ? (sourceTotalGapUsd / total) * 100 : 0;
  if (sourceTotalGapPct > SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT) {
    slices.push({
      name: "Unmapped Frax balance-sheet total-assets gap",
      pct: sourceTotalGapPct,
      risk: "high",
    });
    warnings.push(
      buildUnknownExposureWarning({
        code: "source-total-gap",
        message: "Frax balance-sheet totalAssets exceeds mapped asset-category rows",
        unknownExposurePct: sourceTotalGapPct,
        thresholdPct: SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT,
      }),
    );
  }

  return {
    slices: normalizeSlices(slices),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      totalCollateralUsd: total,
      categorizedAssetTotalUsd: categorizedAssetTotal,
      sourceTotalAssetsUsd: sourceTotal,
      ...(sourceTotalGapPct > 0 ? { sourceTotalGapPct } : {}),
      assetCount: bySymbol.size,
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "frax-balance-sheet-api",
        "Frax balance-sheet response did not include asOfTimestamp",
      ),
      immediateRedeemableUsd: stableRedeemableUsd,
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: stableRedeemableUsd,
        capacityKind: "live-proxy-validated",
        freshnessKind: sourceTimestamp != null ? "verified-source-timestamp" : "unverified",
        ...(sourceTimestamp != null ? { sourceTimestamp } : {}),
        routeStatus: "unknown",
        sourceUrls: ["https://frax.com/transparency"],
      }),
    },
  };
}

/* ---------- v2 FPI collateral adapter ---------- */

function positiveUsd(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function isFpiSelfHolding(row: FraxFpiCollateralRow): boolean {
  return row.tokenSymbol === "FPI";
}

function describeFpiCollateralRow(row: FraxFpiCollateralRow): string {
  const symbol = row.tokenSymbol?.trim();
  if (symbol) return symbol;
  const name = row.name?.trim();
  if (name) return name;
  return row.key?.trim() || "unlabeled-row";
}

function getFpiCollateralMappingKey(row: FraxFpiCollateralRow): string | undefined {
  const symbol = row.tokenSymbol?.trim();
  if (symbol) return symbol;

  const name = row.name?.trim();
  return name && FPI_COLLATERAL_NAME_ONLY_DISPLAY[name] ? name : undefined;
}

function getFpiCollateralDisplayConfig(key: string): TokenDisplayConfig | undefined {
  return TOKEN_DISPLAY[key] ?? FPI_COLLATERAL_NAME_ONLY_DISPLAY[key];
}

export function adaptFraxFpiCollateral(payload: FraxFpiCollateralResponse): AdapterResult {
  const assets = payload.assets;
  if (!assets?.length) {
    throw new Error("Frax FPI collateral response missing or empty assets array");
  }

  const warnings: LiveReserveWarning[] = [];
  const bySymbol = new Map<string, number>();
  const unknownLabels = new Set<string>();
  let unknownUsd = 0;
  let selfHeldFpiUsd = 0;

  for (const asset of assets) {
    const usd = positiveUsd(asset.valueUsd);
    if (usd <= 0) continue;
    if (isFpiSelfHolding(asset)) {
      selfHeldFpiUsd += usd;
      continue;
    }

    const symbol = getFpiCollateralMappingKey(asset);
    const config = symbol ? getFpiCollateralDisplayConfig(symbol) : undefined;
    if (symbol && config) {
      bySymbol.set(symbol, (bySymbol.get(symbol) ?? 0) + usd);
    } else {
      unknownUsd += usd;
      unknownLabels.add(describeFpiCollateralRow(asset));
    }
  }

  const mappedCollateralUsd = [...bySymbol.values()].reduce((sum, usd) => sum + usd, 0);
  const totalCollateralUsd = mappedCollateralUsd + unknownUsd;
  if (totalCollateralUsd <= 0) {
    throw new Error("Frax FPI collateral response has no positive non-FPI collateral assets");
  }

  const totalLiabilitiesUsd = (payload.liabilities ?? []).reduce(
    (sum, liability) => sum + positiveUsd(liability.valueUsd),
    0,
  );
  const netExternalLiabilitiesUsd = Math.max(totalLiabilitiesUsd - selfHeldFpiUsd, 0);
  const collateralizationRatio =
    netExternalLiabilitiesUsd > 0 ? totalCollateralUsd / netExternalLiabilitiesUsd : undefined;
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.updatedAtTimestampSec);
  const stableRedeemableUsd = ["FRAX", "sFRAX", "sfrxUSD"].reduce(
    (sum, symbol) => sum + (bySymbol.get(symbol) ?? 0),
    0,
  );

  const slices: ReserveSlice[] = [];
  for (const [symbol, usd] of bySymbol) {
    const config = getFpiCollateralDisplayConfig(symbol);
    if (!config) continue;
    slices.push({
      name: config.label,
      pct: (usd / totalCollateralUsd) * 100,
      risk: config.risk,
      ...(config.coinId ? { coinId: config.coinId } : {}),
    });
  }

  if (unknownUsd > 0) {
    const unknownExposurePct = (unknownUsd / totalCollateralUsd) * 100;
    slices.push({
      name: "Unmapped Frax FPI collateral assets",
      pct: unknownExposurePct,
      risk: "high",
    });
    warnings.push(
      buildUnknownExposureWarning({
        code: "unknown-token",
        message: `Frax FPI collateral unknown token(s): ${[...unknownLabels].sort().join(", ")}`,
        unknownExposurePct,
        thresholdPct: FPI_UNKNOWN_EXPOSURE_THRESHOLD_PCT,
      }),
    );
  }

  if (collateralizationRatio != null && collateralizationRatio < 1) {
    warnings.push(
      reserveDegradedWarning(
        "undercollateralized",
        `Frax FPI non-FPI collateral is ${(collateralizationRatio * 100).toFixed(2)}% of net external FPI liabilities`,
      ),
    );
  }

  return {
    slices: normalizeSlices(slices),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      totalCollateralUsd,
      mappedCollateralUsd,
      unknownCollateralUsd: unknownUsd,
      selfHeldFpiUsd,
      totalLiabilitiesUsd,
      netExternalLiabilitiesUsd,
      ...(collateralizationRatio != null ? { collateralizationRatio } : {}),
      assetCount: assets.length,
      liabilityCount: payload.liabilities?.length ?? 0,
      ...(payload.updatedAtBlock != null ? { updatedAtBlock: payload.updatedAtBlock } : {}),
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "frax-fpi-collateral-api",
        "Frax FPI collateral response did not include updatedAtTimestampSec",
      ),
      immediateRedeemableUsd: stableRedeemableUsd,
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: stableRedeemableUsd,
        capacityKind: "live-proxy-validated",
        freshnessKind: sourceTimestamp != null ? "verified-source-timestamp" : "unverified",
        ...(sourceTimestamp != null ? { sourceTimestamp } : {}),
        routeStatus: "open",
        routeStatusSource: "protocol-api",
        sourceUrls: ["https://frax.com/transparency"],
      }),
    },
  };
}

/* ---------- fetch entrypoint ---------- */

function isBalanceSheetResponse(payload: unknown): payload is FraxBalanceSheetResponse {
  return Array.isArray((payload as FraxBalanceSheetResponse)?.assets);
}

function isFpiCollateralResponse(payload: unknown): payload is FraxFpiCollateralResponse {
  const response = payload as FraxFpiCollateralResponse;
  return Array.isArray(response?.assets) && Array.isArray(response?.liabilities);
}

/**
 * Dedicated balance-sheet adapter entrypoint for coins using the Frax v2
 * balance-sheet API with independent evidence class (e.g. frxUSD).
 */
export async function fetchFraxBalanceSheetReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "frax-balance-sheet");
  const payload = await fetchJsonWithRetry<FraxBalanceSheetResponse>(primaryInput.url, signal, 12_000, ctx);

  if (!isBalanceSheetResponse(payload)) {
    throw new Error("frax-balance-sheet adapter requires a v2 balance-sheet API response");
  }
  return adaptFraxBalanceSheet(payload, coin.id);
}

/**
 * Dedicated adapter entrypoint for the Frax FPI collateral endpoint. FPI
 * balances controlled by FPI system addresses are treasury/self holdings, so
 * they are excluded from reserve slices and netted against FPI liabilities.
 */
export async function fetchFraxFpiCollateralReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "frax-fpi-collateral");
  const payload = await fetchJsonWithRetry<FraxFpiCollateralResponse>(primaryInput.url, signal, 12_000, ctx);

  if (!isFpiCollateralResponse(payload)) {
    throw new Error("frax-fpi-collateral adapter requires the FPI collateral API response");
  }
  return adaptFraxFpiCollateral(payload);
}
