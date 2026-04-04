import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  requireJsonInputFromConfig,
  fetchJsonWithRetry,
  getAdapterTimeout,
  normalizeSlices,
  reserveDegradedWarning,
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
  WTGXX: { label: "WTGXX (WisdomTree Government Money Market)", risk: "low" },
  USTB:  { label: "USTB (Superstate tokenized T-bills)", risk: getCanonicalReserveAssetRisk("USTB") ?? "low", coinId: "ustb-superstate" },
  BUIDL: { label: "BUIDL (BlackRock tokenized T-bills)", risk: getCanonicalReserveAssetRisk("BUIDL") ?? "low", coinId: "buidl-blackrock" },
  USDB:  { label: "USDB (DBS tokenized deposits)", risk: "low" },
  USDC:  { label: "USDC (Circle)", risk: "low", coinId: "usdc-circle" },
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

  const slices: ReserveSlice[] = [];
  for (const [symbol, usd] of bySymbol) {
    const config = TOKEN_DISPLAY[symbol];
    if (!config) {
      warnings.push(reserveDegradedWarning(
        "unknown-token",
        `Frax balance-sheet: unknown token ${symbol} ($${Math.round(usd).toLocaleString()}) defaulted to medium risk`,
      ));
    }
    slices.push({
      name: config?.label ?? symbol,
      pct: (usd / total) * 100,
      risk: config?.risk ?? "medium",
      ...(config?.coinId ? { coinId: config.coinId } : {}),
    });
  }

  return {
    slices: normalizeSlices(slices),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      totalCollateralUsd: total,
      assetCount: bySymbol.size,
      ...(payload.asOfTimestamp
        ? { sourceTimestamp: Math.floor(new Date(payload.asOfTimestamp).getTime() / 1000), freshnessMode: "verified" as const }
        : unverifiedFreshnessMetadata(
            "frax-balance-sheet-api",
            "Frax balance-sheet response did not include asOfTimestamp",
          )),
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
    getAdapterTimeout(config, 12_000),
    ctx,
  );

  if (isBalanceSheetResponse(payload)) {
    return adaptFraxBalanceSheet(payload);
  }
  return adaptFraxCombinedData(payload as FraxCombinedDataResponse, coin);
}
