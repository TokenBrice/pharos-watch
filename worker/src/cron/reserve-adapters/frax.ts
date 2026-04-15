import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildUnknownExposureWarning,
  requireJsonInputFromConfig,
  fetchJsonWithRetry,
  normalizeSlices,
  unverifiedFreshnessMetadata,
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

/* ---------- legacy combineddata API types (used by frax-frax) ---------- */

export interface FraxCombinedDataResponse {
  protocol?: {
    collateral?: {
      ratio: number;
      decentralization_ratio: number;
      total_dollar_value: number;
    };
  };
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
  WTGXX: { label: "WTGXX (WisdomTree Government Money Market)", risk: "low" },
  USTB:  { label: "USTB (Superstate tokenized T-bills)", risk: getCanonicalReserveAssetRisk("USTB") ?? "low", coinId: "ustb-superstate" },
  BUIDL: { label: "BUIDL (BlackRock tokenized T-bills)", risk: getCanonicalReserveAssetRisk("BUIDL") ?? "low", coinId: "buidl-blackrock" },
  CVX: { label: "CVX", risk: "very-high" },
  CRV: { label: "CRV", risk: getCanonicalReserveAssetRisk("CRV") ?? "very-high" },
  CHR: { label: "CHR", risk: "very-high" },
  DAI: { label: "DAI", risk: getCanonicalReserveAssetRisk("DAI") ?? "low", coinId: "dai-makerdao" },
  ETH: { label: "ETH", risk: getCanonicalReserveAssetRisk("ETH") ?? "very-low" },
  FPI: { label: "FPI", risk: "medium" },
  FRAX: { label: "FRAX", risk: getCanonicalReserveAssetRisk("FRAX") ?? "low", coinId: "frax-frax" },
  LFRAX: { label: "LFRAX", risk: "medium" },
  MULTI: { label: "MULTI", risk: "very-high" },
  OP: { label: "OP", risk: "high" },
  PYUSD: { label: "PYUSD", risk: getCanonicalReserveAssetRisk("PYUSD") ?? "low", coinId: "pyusd-paypal" },
  RAM: { label: "RAM", risk: "very-high" },
  SDT: { label: "SDT", risk: "very-high" },
  THE: { label: "THE", risk: "very-high" },
  USDB:  { label: "USDB (DBS tokenized deposits)", risk: "low" },
  USDC:  { label: "USDC (Circle)", risk: "low", coinId: "usdc-circle" },
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
  sfrxUSD: { label: "sfrxUSD", risk: "low", coinId: "frxusd-frax" },
  stkAAVE: { label: "stkAAVE", risk: "very-high" },
  wfrxETH: { label: "wfrxETH", risk: "medium" },
  ZZ: { label: "ZZ", risk: "very-high" },
};

/* ---------- v2 balance-sheet adapter ---------- */

export function adaptFraxBalanceSheet(payload: FraxBalanceSheetResponse): AdapterResult {
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

  const total = [...bySymbol.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error("Frax balance-sheet total asset value is zero");
  const stableRedeemableUsd = ["USDC", "USDS", "PYUSD", "DAI", "FRAX"]
    .reduce((sum, symbol) => sum + (bySymbol.get(symbol) ?? 0), 0);
  const sourceTimestamp = payload.asOfTimestamp
    ? Math.floor(new Date(payload.asOfTimestamp).getTime() / 1000)
    : null;

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
        ...(config.coinId ? { coinId: config.coinId } : {}),
      });
    }
  }

  if (unknownUsd > 0) {
    slices.push({
      name: "Unmapped Frax balance-sheet assets",
      pct: (unknownUsd / total) * 100,
      risk: "medium",
    });
    warnings.push(buildUnknownExposureWarning({
      code: "unknown-token",
      message: `Frax balance-sheet unknown token(s): ${unknownSymbols.sort().join(", ")}`,
      unknownExposurePct: (unknownUsd / total) * 100,
    }));
  }

  return {
    slices: normalizeSlices(slices),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      totalCollateralUsd: total,
      assetCount: bySymbol.size,
      ...(sourceTimestamp != null
        ? { sourceTimestamp, freshnessMode: "verified" as const }
        : unverifiedFreshnessMetadata(
            "frax-balance-sheet-api",
            "Frax balance-sheet response did not include asOfTimestamp",
          )),
      immediateRedeemableUsd: stableRedeemableUsd,
      ...(total > 0 ? { immediateRedeemableRatio: stableRedeemableUsd / total } : {}),
      redemption: {
        capacityUsd: stableRedeemableUsd,
        ...(total > 0 ? { capacityRatioOfSupply: stableRedeemableUsd / total } : {}),
        capacityKind: "live-proxy-validated" as const,
        freshnessKind: sourceTimestamp != null ? "verified-source-timestamp" as const : "unverified" as const,
        ...(sourceTimestamp != null ? { sourceTimestamp } : {}),
        routeStatus: "unknown" as const,
        sourceUrls: ["https://frax.com/transparency"],
      },
    },
  };
}

/* ---------- legacy combineddata adapter (frax-frax) ---------- */

const LEGACY_FALLBACK_SLICE = [
  { name: "Tokenized T-bills and cash equivalents (BUIDL, USTB, USCC, USDC)", pct: 100, risk: "low" as const },
];

export function adaptFraxCombinedData(payload: FraxCombinedDataResponse, coin?: StablecoinMeta): AdapterResult {
  const collateral = payload.protocol?.collateral;
  if (!collateral || !Number.isFinite(collateral.total_dollar_value)) {
    throw new Error("Frax combineddata response missing collateral data");
  }

  return {
    slices: coin?.reserves?.length ? coin.reserves : LEGACY_FALLBACK_SLICE,
    metadata: {
      freshnessMode: "unverified",
      collateralRatio: collateral.ratio,
      decentralizationRatio: collateral.decentralization_ratio,
      totalCollateralUsd: collateral.total_dollar_value,
    },
  };
}

/* ---------- fetch entrypoint ---------- */

function isBalanceSheetResponse(payload: unknown): payload is FraxBalanceSheetResponse {
  return Array.isArray((payload as FraxBalanceSheetResponse)?.assets);
}

export async function fetchFraxReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "frax");
  const payload = await fetchJsonWithRetry<FraxBalanceSheetResponse | FraxCombinedDataResponse>(
    primaryInput.url,
    signal,
    12_000,
    ctx,
  );

  if (isBalanceSheetResponse(payload)) {
    return adaptFraxBalanceSheet(payload);
  }
  return adaptFraxCombinedData(payload as FraxCombinedDataResponse, coin);
}


/**
 * Dedicated balance-sheet adapter entrypoint for coins using the Frax v2
 * balance-sheet API with independent evidence class (e.g. frxUSD).
 */
export async function fetchFraxBalanceSheetReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "frax-balance-sheet");
  const payload = await fetchJsonWithRetry<FraxBalanceSheetResponse>(
    primaryInput.url,
    signal,
    12_000,
    ctx,
  );

  if (!isBalanceSheetResponse(payload)) {
    throw new Error("frax-balance-sheet adapter requires a v2 balance-sheet API response");
  }
  return adaptFraxBalanceSheet(payload);
}
