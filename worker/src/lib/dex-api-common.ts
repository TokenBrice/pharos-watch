import type { DexPriceObs, GtNewPool } from "../cron/dex-liquidity/types";
import type { SymbolLookups } from "../cron/dex-liquidity/types";
import {
  buildPriceValidationContext,
  getReferencePriceForContext,
  type PriceValidationReferences,
} from "./price-validation";
import { isPlausibleDexObservationPrice } from "../cron/dex-liquidity/price-sanity";
import { QUALITY_MULTIPLIERS, normalizeDexSymbol, isUsdReferenceSymbol } from "./dex-constants";
import { buildPoolIdentity } from "../cron/dex-liquidity/pool-identity";
import {
  makeChainAddressKey,
  resolveTrackedStablecoinId,
} from "../cron/dex-liquidity/token-resolution";
import type { DexApiFetchResult, DexApiPool, DexApiPoolToken } from "./dex-api-types";

export type { DexApiFetchResult, DexApiPool, DexApiPoolToken } from "./dex-api-types";

export function makeDexApiFetchResult(
  pools: DexApiPool[],
  meta: { ok: boolean; degraded: boolean; errors: string[] },
): DexApiFetchResult {
  return { pools, ...meta };
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
const NATIVE_PLACEHOLDER_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export function isEligibleDirectApiPool(
  pool: Pick<DexApiPool, "tvlUsd">,
  minTvlUsd = DIRECT_API_POOL_MIN_TVL_USD,
): boolean {
  return pool.tvlUsd >= minTvlUsd && pool.tvlUsd <= DIRECT_API_MAX_POOL_TVL_USD;
}

function getDisplayTokenSymbol(token: DexApiPoolToken): string {
  return normalizeDexSymbol(token.symbol) || token.address.slice(0, 10);
}

function resolvePoolTokenDecimals(
  pool: DexApiPool,
  token: DexApiPoolToken,
  contractMetaByChainAddress: SymbolLookups["contractMetaByChainAddress"],
): number | null {
  if (Number.isFinite(token.decimals) && token.decimals > 0) return token.decimals;
  if (token.address.toLowerCase() === NATIVE_PLACEHOLDER_TOKEN) return 18;
  const contractMeta = contractMetaByChainAddress.get(makeChainAddressKey(pool.chain, token.address));
  return contractMeta?.decimals ?? null;
}

export function hydrateDirectApiPoolMetadata(
  pools: DexApiPool[],
  contractMetaByChainAddress: SymbolLookups["contractMetaByChainAddress"],
): void {
  for (const pool of pools) {
    for (const token of pool.tokens) {
      const resolvedDecimals = resolvePoolTokenDecimals(pool, token, contractMetaByChainAddress);
      if (resolvedDecimals != null) {
        token.decimals = resolvedDecimals;
      }
    }

    if (
      pool.source !== "fluid" ||
      pool.balancesNormalized === true ||
      !pool.balances ||
      pool.balances.length !== pool.tokens.length
    ) {
      continue;
    }

    const normalizedBalances: number[] = [];
    let normalizationComplete = true;
    for (let index = 0; index < pool.tokens.length; index++) {
      const rawBalance = pool.balances[index];
      const token = pool.tokens[index]!;
      const decimals = resolvePoolTokenDecimals(pool, token, contractMetaByChainAddress);
      if (!Number.isFinite(rawBalance) || rawBalance == null || rawBalance < 0 || decimals == null) {
        normalizationComplete = false;
        break;
      }
      normalizedBalances.push(rawBalance / (10 ** decimals));
    }

    pool.balances = normalizationComplete ? normalizedBalances : null;
    pool.balancesNormalized = normalizationComplete;
  }
}

/** Resolve a token to a stablecoin ID via canonical address match, with symbol fallback only when no address is present. */
function resolveStablecoinId(
  chain: string,
  token: DexApiPoolToken,
  chainAddressToId: Map<string, string>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
): string | undefined {
  const result = resolveTrackedStablecoinId(
    { chain, address: token.address, symbol: token.symbol },
    { chainAddressToId, symbolToChainScopedIds },
  );
  return result.status === "matched" ? result.stablecoinId : undefined;
}

function isTrackedToken(
  chain: string,
  token: DexApiPoolToken,
  chainAddressToId: Map<string, string>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
): boolean {
  const resolved = resolveTrackedStablecoinId(
    { chain, address: token.address, symbol: token.symbol },
    { chainAddressToId, symbolToChainScopedIds },
  );
  return resolved.status === "matched";
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
  chainAddressToId: Map<string, string>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
  validationReferences?: PriceValidationReferences,
  trackedStablecoinPrices?: Map<string, number>,
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
  const otherUsdRef = getTokenReferenceUsdPrice(
    otherToken,
    pool.chain,
    chainAddressToId,
    symbolToChainScopedIds,
    validationReferences,
    trackedStablecoinPrices,
  );
  if (otherUsdRef == null) return null;

  // pool.price = token[0] priced in token[1]
  if (tokenIndex === 0) return pool.price * otherUsdRef;
  return (1 / pool.price) * otherUsdRef;
}

function derivePoolFeeTierBps(feeRate: number | null): number | null {
  if (feeRate == null || !Number.isFinite(feeRate) || feeRate <= 0) return null;
  const bps = feeRate * 10_000;
  if (!Number.isFinite(bps) || bps <= 0) return null;
  return Math.round(bps * 100) / 100;
}

function getTokenReferenceUsdPrice(
  token: DexApiPoolToken,
  chain: string,
  chainAddressToId: Map<string, string>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
  validationReferences?: PriceValidationReferences,
  trackedStablecoinPrices?: Map<string, number>,
): number | null {
  const resolved = resolveTrackedStablecoinId(
    { chain, address: token.address, symbol: token.symbol },
    { chainAddressToId, symbolToChainScopedIds },
  );
  if (resolved.status === "matched" && resolved.stablecoinId) {
    const trackedPrice = trackedStablecoinPrices?.get(resolved.stablecoinId);
    if (trackedPrice != null && Number.isFinite(trackedPrice) && trackedPrice > 0) {
      return trackedPrice;
    }

    const context = buildPriceValidationContext({ stablecoinId: resolved.stablecoinId });
    return getReferencePriceForContext(context, validationReferences);
  }

  const normalizedAddress = (token.address ?? "").trim().toLowerCase();
  const allowSymbolUsdFallback = normalizedAddress.length === 0 || normalizedAddress === NATIVE_PLACEHOLDER_TOKEN;
  const symbol = normalizeDexSymbol(token.symbol);
  if (allowSymbolUsdFallback && symbol && isUsdReferenceSymbol(symbol)) {
    return 1;
  }

  return null;
}

function derivePoolVolume24hUsd(
  pool: DexApiPool,
  chainAddressToId: Map<string, string>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
  validationReferences?: PriceValidationReferences,
  trackedStablecoinPrices?: Map<string, number>,
): number {
  if (!pool.tokenVolumes24h || pool.tokenVolumes24h.length !== pool.tokens.length) {
    return pool.volume24hUsd;
  }

  const candidates: number[] = [];
  for (let i = 0; i < pool.tokenVolumes24h.length; i++) {
    const rawVolume = pool.tokenVolumes24h[i];
    if (!Number.isFinite(rawVolume) || rawVolume <= 0) continue;

    const ownReferencePrice = getTokenReferenceUsdPrice(
      pool.tokens[i],
      pool.chain,
      chainAddressToId,
      symbolToChainScopedIds,
      validationReferences,
      trackedStablecoinPrices,
    );
    if (ownReferencePrice != null && ownReferencePrice > 0) {
      candidates.push(rawVolume * ownReferencePrice);
      continue;
    }

    const derivedPrice = deriveTokenUsdPrice(
      pool,
      i,
      chainAddressToId,
      symbolToChainScopedIds,
      validationReferences,
      trackedStablecoinPrices,
    );
    if (derivedPrice != null && derivedPrice > 0) {
      candidates.push(rawVolume * derivedPrice);
    }
  }

  if (candidates.length === 0) return pool.volume24hUsd;
  if (candidates.length === 1) return candidates[0];
  return candidates.reduce((sum, value) => sum + value, 0) / candidates.length;
}

function derivePoolBalanceMetrics(
  pool: DexApiPool,
  chainAddressToId: Map<string, string>,
  symbolToIds: Map<string, string[]>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
  validationReferences?: PriceValidationReferences,
  trackedStablecoinPrices?: Map<string, number>,
): {
  balanceRatio: number;
  balanceDetails: {
    symbol: string;
    balancePct: number;
    isTracked: boolean;
  }[];
} | null {
  if (!pool.balances || pool.balances.length !== pool.tokens.length || pool.tokens.length < 2) {
    return null;
  }

  const usdBalances = pool.tokens.map((token, index) => {
    const balance = pool.balances?.[index];
    if (!Number.isFinite(balance) || balance == null || balance < 0) return null;

      const directPrice = token.priceUsd;
      const priceUsd = directPrice != null && Number.isFinite(directPrice) && directPrice > 0
        ? directPrice
        : getTokenReferenceUsdPrice(
          token,
          pool.chain,
          chainAddressToId,
          symbolToChainScopedIds,
          validationReferences,
          trackedStablecoinPrices,
        ) ??
          deriveTokenUsdPrice(
            pool,
            index,
            chainAddressToId,
            symbolToChainScopedIds,
            validationReferences,
            trackedStablecoinPrices,
          );

    if (priceUsd == null || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;
    return balance * priceUsd;
  });

  if (usdBalances.some((value) => value == null)) return null;

  const measuredBalances = usdBalances as number[];
  const totalUsd = measuredBalances.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return null;

  const rawWeights = pool.tokens.map((token) => {
    const weight = token.weight;
    return weight != null && Number.isFinite(weight) && weight > 0 ? weight : 0;
  });
  const hasMeasuredWeights = rawWeights.every((weight) => weight > 0);
  const normalizedWeights = hasMeasuredWeights ? rawWeights : new Array(pool.tokens.length).fill(1);
  const totalWeight = normalizedWeights.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) return null;

  const normalizedShares = measuredBalances.map((usdBalance, index) => {
    const actualShare = usdBalance / totalUsd;
    const targetShare = normalizedWeights[index]! / totalWeight;
    return targetShare > 0 ? actualShare / targetShare : 0;
  });

  const minShare = normalizedShares.reduce((min, value) => Math.min(min, value), Infinity);
  const maxShare = normalizedShares.reduce((max, value) => Math.max(max, value), 0);
  if (!Number.isFinite(minShare) || !Number.isFinite(maxShare) || maxShare <= 0) return null;

  return {
    balanceRatio: minShare / maxShare,
    balanceDetails: measuredBalances.map((usdBalance, index) => {
      const token = pool.tokens[index]!;
      return {
        symbol: getDisplayTokenSymbol(token),
        balancePct: Math.round((usdBalance / totalUsd) * 1000) / 10,
        isTracked: isTrackedToken(pool.chain, token, chainAddressToId, symbolToChainScopedIds),
      };
    }),
  };
}

/**
 * Convert DexApiPool[] to GtNewPool[] keyed by stablecoinId.
 * Matches pool tokens against the stablecoin contract registry + symbol fallback.
 */
export function convertToGtNewPools(
  pools: DexApiPool[],
  chainAddressToId: Map<string, string>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
  symbolToIds: Map<string, string[]>,
  validationReferences?: PriceValidationReferences,
  trackedStablecoinPrices?: Map<string, number>,
): Map<string, GtNewPool[]> {
  const result = new Map<string, GtNewPool[]>();

  for (const pool of pools) {
    if (!isEligibleDirectApiPool(pool)) continue;
    const volume24hUsd = derivePoolVolume24hUsd(
      pool,
      chainAddressToId,
      symbolToChainScopedIds,
      validationReferences,
      trackedStablecoinPrices,
    );
    const balanceMetrics = derivePoolBalanceMetrics(
      pool,
      chainAddressToId,
      symbolToIds,
      symbolToChainScopedIds,
      validationReferences,
      trackedStablecoinPrices,
    );
    const feeTierBps = derivePoolFeeTierBps(pool.feeRate);

    for (let i = 0; i < pool.tokens.length; i++) {
      const token = pool.tokens[i];
      const stablecoinId = resolveStablecoinId(pool.chain, token, chainAddressToId, symbolToChainScopedIds);
      if (!stablecoinId) continue;

      const qualityMultiplier = QUALITY_MULTIPLIERS[pool.poolType] ?? QUALITY_MULTIPLIERS.generic!;
      const pairSymbols = pool.tokens.map((t) => getDisplayTokenSymbol(t));
      const symbolStr = pairSymbols.join(" / ");

      // Derive price for this specific stablecoin token
      const tokenPrice = deriveTokenUsdPrice(
        pool,
        i,
        chainAddressToId,
        symbolToChainScopedIds,
        validationReferences,
        trackedStablecoinPrices,
      );

      const gtPool: GtNewPool = {
        address: pool.poolAddress,
        chain: pool.chain,
        dexId: pool.source,
        name: `${pool.source}:${symbolStr}`,
        tvlUsd: pool.tvlUsd,
        volume24hUsd,
        qualityMultiplier,
        maturityDays: 30,
        price: tokenPrice ?? 0,
        symbol: symbolStr,
        poolType: pool.poolType,
        sourceFamily: "direct_api",
        ...(balanceMetrics ? {
          balanceRatio: balanceMetrics.balanceRatio,
          balanceDetails: balanceMetrics.balanceDetails,
        } : {}),
        ...(feeTierBps != null ? { feeTierBps } : {}),
        measurement: {
          tvlMeasured: true,
          volumeMeasured: pool.tokenVolumes24h != null || (Number.isFinite(pool.volume24hUsd) && pool.volume24hUsd > 0),
          balanceMeasured: balanceMetrics != null,
          maturityMeasured: false,
          priceMeasured: tokenPrice != null && tokenPrice > 0,
          synthetic: false,
        },
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
  chainAddressToId: Map<string, string>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
  validationReferences?: PriceValidationReferences,
  trackedStablecoinPrices?: Map<string, number>,
): Map<string, DexPriceObs[]> {
  const result = new Map<string, DexPriceObs[]>();

  for (const pool of pools) {
    if (!isEligibleDirectApiPool(pool, DIRECT_API_PRICE_MIN_TVL_USD)) continue;
    const identity = buildPoolIdentity({
      chain: pool.chain,
      protocol: pool.source,
      poolAddressOrId: pool.poolAddress,
      tokenAddresses: pool.tokens.map((token) => token.address),
      poolType: pool.poolType,
      feeTierBps: derivePoolFeeTierBps(pool.feeRate),
      isStable: pool.poolType.includes("stable") || pool.poolType.includes("fluid"),
    });

    for (let i = 0; i < pool.tokens.length; i++) {
      const token = pool.tokens[i];
      const stablecoinId = resolveStablecoinId(pool.chain, token, chainAddressToId, symbolToChainScopedIds);
      if (!stablecoinId) continue;

      const price = deriveTokenUsdPrice(
        pool,
        i,
        chainAddressToId,
        symbolToChainScopedIds,
        validationReferences,
        trackedStablecoinPrices,
      );
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
        poolKey: identity.exactPoolKey ?? undefined,
        derivedMatchKey: identity.derivedMatchKey ?? undefined,
        identityConfidence: identity.exactPoolKey ? "exact" : identity.derivedMatchKey ? "derived_ambiguous" : "none",
        sourceFamily: "direct_api",
      };

      const existing = result.get(stablecoinId) ?? [];
      existing.push(obs);
      result.set(stablecoinId, existing);
    }
  }

  return result;
}
