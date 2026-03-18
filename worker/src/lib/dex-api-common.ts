import type { DexPriceObs, GtNewPool } from "../cron/dex-liquidity/types";
import {
  buildPriceValidationContext,
  getReferencePriceForContext,
  type PriceValidationReferences,
} from "./price-validation";
import { isPlausibleDexObservationPrice } from "../cron/dex-liquidity/price-sanity";
import { QUALITY_MULTIPLIERS, normalizeDexSymbol, isUsdReferenceSymbol } from "./dex-constants";

export interface DexApiPoolToken {
  address: string;
  symbol: string;
  decimals: number;
  /** Per-token USD price when available (Balancer provides this via balanceUSD/balance). */
  priceUsd?: number | null;
}

export interface DexApiPool {
  source: "fluid" | "balancer" | "raydium" | "orca";
  chain: string;
  poolAddress: string;
  poolType: string;
  tokens: DexApiPoolToken[];
  /** Raw pool price ratio (token[0] / token[1]). Used for price inversion logic. */
  price: number | null;
  tvlUsd: number;
  volume24hUsd: number;
  feeRate: number | null;
  balances: number[] | null;
  /** Optional per-token raw 24h volumes in native token units. */
  tokenVolumes24h?: number[] | null;
}

export type DexApiFetchResult = DexApiPool[] & {
  ok: boolean;
  degraded: boolean;
  errors: string[];
};

export function makeDexApiFetchResult(
  pools: DexApiPool[],
  meta: { ok: boolean; degraded: boolean; errors: string[] },
): DexApiFetchResult {
  return Object.assign(pools, meta);
}

/** Min TVL for a pool's price to be considered as a price observation */
export const DIRECT_API_PRICE_MIN_TVL_USD = 50_000;

/**
 * Max TVL for a single pool — any pool reporting more than this is treated as a data error.
 * The largest individual DEX pool in existence is ~$1-2B (Curve 3pool).
 * $10B gives plenty of headroom while catching obvious anomalies like $337B.
 */
export const DIRECT_API_MAX_POOL_TVL_USD = 10_000_000_000;

/** Min TVL for a pool to be included in liquidity scoring */
export const DIRECT_API_POOL_MIN_TVL_USD = 10_000;

/** Resolve a token to a stablecoin ID via address match or symbol fallback. */
function resolveStablecoinId(
  token: DexApiPoolToken,
  addressToId: Map<string, string>,
  symbolToIds: Map<string, string[]>,
): string | undefined {
  const addr = token.address.toLowerCase();
  const byAddr = addressToId.get(addr);
  if (byAddr) return byAddr;
  // Symbol fallback (empty symbols from Fluid skip this path)
  const sym = normalizeDexSymbol(token.symbol);
  if (sym) return symbolToIds.get(sym)?.[0];
  return undefined;
}

/**
 * Derive USD price for a specific token in a 2-token pool.
 *
 * Strategy per source:
 * - Balancer: uses per-token `priceUsd` (derived from balanceUSD / balance by the fetcher)
 * - Fluid/Raydium/Orca: `pool.price` is token[0]/token[1] ratio.
 *   If stablecoin is token[0] and token[1] is a USD reference: price = pool.price
 *   If stablecoin is token[1] and token[0] is a USD reference: price = 1 / pool.price
 */
function deriveTokenUsdPrice(
  pool: DexApiPool,
  tokenIndex: number,
  addressToId: Map<string, string>,
  validationReferences?: PriceValidationReferences,
): number | null {
  const token = pool.tokens[tokenIndex];

  // 1. Prefer per-token priceUsd if set (Balancer)
  if (token.priceUsd != null && Number.isFinite(token.priceUsd) && token.priceUsd > 0) {
    return token.priceUsd;
  }

  // 2. Derive from pool.price ratio for 2-token pools
  if (pool.price == null || !Number.isFinite(pool.price) || pool.price <= 0) return null;
  if (pool.tokens.length !== 2) return null;

  const otherIdx = tokenIndex === 0 ? 1 : 0;
  const otherToken = pool.tokens[otherIdx];
  const otherUsdRef = getTokenReferenceUsdPrice(otherToken, addressToId, validationReferences);
  if (otherUsdRef == null) return null;

  // pool.price = token[0] priced in token[1]
  if (tokenIndex === 0) return pool.price * otherUsdRef;
  return (1 / pool.price) * otherUsdRef;
}

function getTokenReferenceUsdPrice(
  token: DexApiPoolToken,
  addressToId: Map<string, string>,
  validationReferences?: PriceValidationReferences,
): number | null {
  const symbol = normalizeDexSymbol(token.symbol);
  if (symbol && isUsdReferenceSymbol(symbol)) return 1;

  const stablecoinId = addressToId.get(token.address.toLowerCase());
  if (!stablecoinId) return null;

  const context = buildPriceValidationContext({ stablecoinId });
  return getReferencePriceForContext(context, validationReferences);
}

function derivePoolVolume24hUsd(
  pool: DexApiPool,
  addressToId: Map<string, string>,
  validationReferences?: PriceValidationReferences,
): number {
  if (!pool.tokenVolumes24h || pool.tokenVolumes24h.length !== pool.tokens.length) {
    return pool.volume24hUsd;
  }

  const candidates: number[] = [];
  for (let i = 0; i < pool.tokenVolumes24h.length; i++) {
    const rawVolume = pool.tokenVolumes24h[i];
    if (!Number.isFinite(rawVolume) || rawVolume <= 0) continue;

    const ownReferencePrice = getTokenReferenceUsdPrice(pool.tokens[i], addressToId, validationReferences);
    if (ownReferencePrice != null && ownReferencePrice > 0) {
      candidates.push(rawVolume * ownReferencePrice);
      continue;
    }

    const derivedPrice = deriveTokenUsdPrice(pool, i, addressToId, validationReferences);
    if (derivedPrice != null && derivedPrice > 0) {
      candidates.push(rawVolume * derivedPrice);
    }
  }

  if (candidates.length === 0) return pool.volume24hUsd;
  if (candidates.length === 1) return candidates[0];
  return candidates.reduce((sum, value) => sum + value, 0) / candidates.length;
}

/**
 * Convert DexApiPool[] to GtNewPool[] keyed by stablecoinId.
 * Matches pool tokens against the stablecoin contract registry + symbol fallback.
 */
export function convertToGtNewPools(
  pools: DexApiPool[],
  addressToId: Map<string, string>,
  symbolToIds: Map<string, string[]>,
  validationReferences?: PriceValidationReferences,
): Map<string, GtNewPool[]> {
  const result = new Map<string, GtNewPool[]>();

  for (const pool of pools) {
    if (pool.tvlUsd < DIRECT_API_POOL_MIN_TVL_USD || pool.tvlUsd > DIRECT_API_MAX_POOL_TVL_USD) continue;
    const volume24hUsd = derivePoolVolume24hUsd(pool, addressToId, validationReferences);

    for (let i = 0; i < pool.tokens.length; i++) {
      const token = pool.tokens[i];
      const stablecoinId = resolveStablecoinId(token, addressToId, symbolToIds);
      if (!stablecoinId) continue;

      const qualityMultiplier = QUALITY_MULTIPLIERS[pool.poolType] ?? QUALITY_MULTIPLIERS.generic!;
      const pairSymbols = pool.tokens.map((t) => normalizeDexSymbol(t.symbol) || t.address.slice(0, 10));
      const symbolStr = pairSymbols.join(" / ");

      // Derive price for this specific stablecoin token
      const tokenPrice = deriveTokenUsdPrice(pool, i, addressToId, validationReferences);

      const gtPool: GtNewPool = {
        address: pool.poolAddress,
        chain: pool.chain,
        dexId: pool.source,
        name: `${pool.source}:${symbolStr}`,
        tvlUsd: pool.tvlUsd,
        volume24hUsd,
        qualityMultiplier,
        maturityDays: 90, // conservative default for established DEXes
        price: tokenPrice ?? 0,
        symbol: symbolStr,
        poolType: pool.poolType,
        sourceFamily: "direct_api",
      };

      const existing = result.get(stablecoinId) ?? [];
      existing.push(gtPool);
      result.set(stablecoinId, existing);
    }
  }

  return result;
}

/**
 * Extract price observations from DexApiPool[] for computeDexPrices().
 * Applies per-token price inversion and plausibility filtering.
 * Only pools with TVL >= $50K and a valid derived price contribute.
 */
export function extractPriceObservations(
  pools: DexApiPool[],
  addressToId: Map<string, string>,
  symbolToIds: Map<string, string[]>,
  validationReferences?: PriceValidationReferences,
): Map<string, DexPriceObs[]> {
  const result = new Map<string, DexPriceObs[]>();

  for (const pool of pools) {
    if (pool.tvlUsd < DIRECT_API_PRICE_MIN_TVL_USD || pool.tvlUsd > DIRECT_API_MAX_POOL_TVL_USD) continue;

    for (let i = 0; i < pool.tokens.length; i++) {
      const token = pool.tokens[i];
      const stablecoinId = resolveStablecoinId(token, addressToId, symbolToIds);
      if (!stablecoinId) continue;

      const price = deriveTokenUsdPrice(pool, i, addressToId, validationReferences);
      if (price == null || price <= 0) continue;

      // Plausibility filter — matches existing code paths in fetch-primary.ts
      if (validationReferences && !isPlausibleDexObservationPrice(stablecoinId, price, validationReferences)) {
        continue;
      }

      const obs: DexPriceObs = {
        price,
        tvl: pool.tvlUsd,
        chain: pool.chain,
        protocol: pool.source,
      };

      const existing = result.get(stablecoinId) ?? [];
      existing.push(obs);
      result.set(stablecoinId, existing);
    }
  }

  return result;
}
