import type { DexPriceObs, GtNewPool } from "../cron/dex-liquidity/types";
import type { SymbolLookups } from "../cron/dex-liquidity/types";
import { QUALITY_MULTIPLIERS, normalizeDexSymbol } from "./dex-cron-constants";
import { buildPoolIdentity } from "../cron/dex-liquidity/pool-identity";
import { isPlausibleDexObservationPrice } from "../cron/dex-liquidity/price-sanity";
import type { PriceValidationReferences } from "./price-validation";
import type { DexAmmExecutionModel, DexAmmExecutionToken } from "@shared/types/market";
import type { DexApiFetchResult, DexApiPool, DexApiPoolToken } from "./dex-api-types";
import {
  derivePoolVolume24hUsd,
  deriveTokenUsdPrice,
  getTokenReferenceUsdPrice,
  isTrackedDexApiToken,
  resolveStablecoinIdForDexApiToken,
} from "./dex-api-token-pricing";

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

export function makeDexApiFetchResult(
  pools: DexApiPool[],
  meta: {
    ok: boolean;
    degraded: boolean;
    errors: string[];
    warnings?: string[];
    pagination?: DexApiFetchResult["pagination"];
  },
): DexApiFetchResult {
  return {
    pools,
    ...meta,
    errors: boundDexDiagnostics(meta.errors),
    warnings: boundDexDiagnostics(meta.warnings ?? []),
  };
}

const DEX_DIAGNOSTIC_SAMPLE_LIMIT = 12;
const DEX_DIAGNOSTIC_MAX_CHARS = 240;

function boundDexDiagnostics(values: readonly string[]): string[] {
  const bounded = values.slice(0, DEX_DIAGNOSTIC_SAMPLE_LIMIT).map((value) =>
    value.replace(/\s+/g, " ").trim().slice(0, DEX_DIAGNOSTIC_MAX_CHARS)
  );
  const omitted = values.length - bounded.length;
  if (omitted > 0) bounded.push(`${omitted} additional diagnostic(s) omitted`);
  return bounded;
}

export function isEligibleDirectApiPool(
  pool: Pick<DexApiPool, "tvlUsd">,
  minTvlUsd = DIRECT_API_POOL_MIN_TVL_USD,
): boolean {
  return pool.tvlUsd >= minTvlUsd && pool.tvlUsd <= DIRECT_API_MAX_POOL_TVL_USD;
}

export function isPreferredDirectApiPool(
  pool: Pick<DexApiPool, "source" | "tvlUsd" | "volume24hUsd">,
  minTvlUsd = DIRECT_API_POOL_MIN_TVL_USD,
): boolean {
  if (!isEligibleDirectApiPool(pool, minTvlUsd)) return false;
  if (Number.isFinite(pool.volume24hUsd) && pool.volume24hUsd > 0) return true;
  return pool.source === "aerodrome-slipstream" || pool.source === "velodrome-slipstream";
}

function toPositiveFiniteNumberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function toNonNegativeFiniteNumberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export interface DexApiPoolNormalizationResult {
  pools: DexApiPool[];
  skippedInvalidUnitCount: number;
}

export function normalizeDexApiPoolsForMerge(pools: DexApiPool[]): DexApiPoolNormalizationResult {
  const normalizedPools: DexApiPool[] = [];
  let skippedInvalidUnitCount = 0;

  for (const pool of pools) {
    const tvlUsd = toPositiveFiniteNumberOrNull(pool.tvlUsd);
    if (tvlUsd == null) {
      skippedInvalidUnitCount++;
      continue;
    }

    const tokens = pool.tokens
      .filter((token) => typeof token.address === "string" && token.address.trim().length > 0)
      .map((token) => ({
        ...token,
        priceUsd: toPositiveFiniteNumberOrNull(token.priceUsd),
        weight: toPositiveFiniteNumberOrNull(token.weight),
      }));
    if (tokens.length < 2) {
      skippedInvalidUnitCount++;
      continue;
    }

    const balances = Array.isArray(pool.balances) &&
      pool.balances.length === tokens.length &&
      pool.balances.every((balance) => toNonNegativeFiniteNumberOrNull(balance) != null)
      ? pool.balances
      : null;
    const tokenVolumes24h = Array.isArray(pool.tokenVolumes24h) &&
      pool.tokenVolumes24h.length === tokens.length &&
      pool.tokenVolumes24h.every((volume) => toNonNegativeFiniteNumberOrNull(volume) != null)
      ? pool.tokenVolumes24h
      : null;

    normalizedPools.push({
      ...pool,
      tokens,
      price: toPositiveFiniteNumberOrNull(pool.price),
      tvlUsd,
      volume24hUsd: toNonNegativeFiniteNumberOrNull(pool.volume24hUsd) ?? 0,
      feeRate: toNonNegativeFiniteNumberOrNull(pool.feeRate),
      balances,
      ...(tokenVolumes24h ? { tokenVolumes24h } : { tokenVolumes24h: null }),
    });
  }

  return { pools: normalizedPools, skippedInvalidUnitCount };
}

function getDisplayTokenSymbol(token: DexApiPoolToken): string {
  return normalizeDexSymbol(token.symbol) || token.address.slice(0, 10);
}

function resolvePoolTokenSymbol(
  pool: DexApiPool,
  token: DexApiPoolToken,
  contractMetaByChainAddress: SymbolLookups["contractMetaByChainAddress"],
): string | null {
  const normalizedSymbol = normalizeDexSymbol(token.symbol);
  if (normalizedSymbol) return token.symbol;
  const contractMeta = contractMetaByChainAddress.get(`${pool.chain.toLowerCase()}:${token.address.toLowerCase()}`);
  return contractMeta?.symbol ?? null;
}

function resolvePoolTokenDecimals(
  pool: DexApiPool,
  token: DexApiPoolToken,
  contractMetaByChainAddress: SymbolLookups["contractMetaByChainAddress"],
): number | null {
  if (Number.isFinite(token.decimals) && token.decimals > 0) return token.decimals;
  if (token.address.toLowerCase() === NATIVE_PLACEHOLDER_TOKEN) return 18;
  const contractMeta = contractMetaByChainAddress.get(`${pool.chain.toLowerCase()}:${token.address.toLowerCase()}`);
  return contractMeta?.decimals ?? null;
}

export function hydrateDirectApiPoolMetadata(
  pools: DexApiPool[],
  contractMetaByChainAddress: SymbolLookups["contractMetaByChainAddress"],
): void {
  for (const pool of pools) {
    for (const token of pool.tokens) {
      const resolvedSymbol = resolvePoolTokenSymbol(pool, token, contractMetaByChainAddress);
      if (resolvedSymbol) {
        token.symbol = resolvedSymbol;
      }

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

function derivePoolFeeTierBps(feeRate: number | null): number | null {
  if (feeRate == null || !Number.isFinite(feeRate) || feeRate <= 0) return null;
  const bps = feeRate * 10_000;
  if (!Number.isFinite(bps) || bps <= 0) return null;
  return Math.round(bps * 100) / 100;
}

function resolveExecutionToken(
  pool: DexApiPool,
  token: DexApiPoolToken,
  balance: number,
  chainAddressToId: Map<string, string>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
  validationReferences?: PriceValidationReferences,
  trackedStablecoinPrices?: Map<string, number>,
): DexAmmExecutionToken | null {
  const address = token.address.trim();
  const symbol = normalizeDexSymbol(token.symbol);
  if (!address || !symbol || !Number.isFinite(token.decimals) || token.decimals < 0 || token.decimals > 255) {
    return null;
  }
  if (!Number.isFinite(balance) || balance <= 0) return null;

  const trackedAssetId = resolveStablecoinIdForDexApiToken(
    pool.chain,
    token,
    chainAddressToId,
    symbolToChainScopedIds,
  );
  const sourcePrice = toPositiveFiniteNumberOrNull(token.priceUsd);
  const trackedPrice = trackedAssetId == null
    ? null
    : toPositiveFiniteNumberOrNull(trackedStablecoinPrices?.get(trackedAssetId));
  const referencePriceUsd = sourcePrice ?? trackedPrice ?? getTokenReferenceUsdPrice(
    token,
    pool.chain,
    chainAddressToId,
    symbolToChainScopedIds,
    validationReferences,
    trackedStablecoinPrices,
  );
  if (referencePriceUsd == null || !Number.isFinite(referencePriceUsd) || referencePriceUsd <= 0) return null;

  const weight = toPositiveFiniteNumberOrNull(token.weight);
  return {
    address,
    symbol,
    decimals: token.decimals,
    balance,
    referencePriceUsd,
    referencePriceSource: sourcePrice != null
      ? "source-token-usd"
      : trackedPrice != null
        ? "tracked-market"
        : "peg-reference",
    ...(trackedAssetId ? { trackedAssetId } : {}),
    ...(weight != null ? { weight } : {}),
  };
}

function buildAmmExecutionModel(
  pool: DexApiPool,
  trackedTokenIndex: number,
  chainAddressToId: Map<string, string>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
  validationReferences?: PriceValidationReferences,
  trackedStablecoinPrices?: Map<string, number>,
): DexAmmExecutionModel | null {
  if (
    pool.balancesNormalized !== true ||
    pool.balances == null ||
    pool.balances.length !== pool.tokens.length ||
    trackedTokenIndex < 0 ||
    trackedTokenIndex >= pool.tokens.length ||
    pool.feeRate == null ||
    !Number.isFinite(pool.feeRate) ||
    pool.feeRate < 0 ||
    pool.feeRate >= 1
  ) {
    return null;
  }

  const invariant = pool.source === "raydium" && pool.poolType === "raydium-amm" && pool.tokens.length === 2
    ? "constant-product"
    : pool.source === "balancer" && pool.poolType === "balancer-weighted"
      ? "weighted-constant-mean"
      : null;
  if (invariant == null) return null;

  const tokens = pool.tokens.map((token, index) => resolveExecutionToken(
    pool,
    token,
    pool.balances![index]!,
    chainAddressToId,
    symbolToChainScopedIds,
    validationReferences,
    trackedStablecoinPrices,
  ));
  if (tokens.some((token) => token == null)) return null;
  const exactTokens = tokens as DexAmmExecutionToken[];
  const identityKeys = exactTokens.map((token) => token.address.toLowerCase());
  if (new Set(identityKeys).size !== identityKeys.length) return null;

  if (invariant === "weighted-constant-mean") {
    const weights = exactTokens.map((token) => token.weight);
    if (weights.some((weight) => weight == null)) return null;
    const weightSum = (weights as number[]).reduce((sum, weight) => sum + weight, 0);
    if (!Number.isFinite(weightSum) || Math.abs(weightSum - 1) > 0.0001) return null;
  }

  return {
    source: invariant === "constant-product" ? "raydium" : "balancer",
    invariant,
    trackedTokenIndex,
    feeRate: pool.feeRate,
    tokens: exactTokens,
  };
}

function derivePoolBalanceMetrics(
  pool: DexApiPool,
  chainAddressToId: Map<string, string>,
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
        isTracked: isTrackedDexApiToken(pool.chain, token, chainAddressToId, symbolToChainScopedIds),
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
      symbolToChainScopedIds,
      validationReferences,
      trackedStablecoinPrices,
    );
    const feeTierBps = derivePoolFeeTierBps(pool.feeRate);

    for (let i = 0; i < pool.tokens.length; i++) {
      const token = pool.tokens[i];
      const stablecoinId = resolveStablecoinIdForDexApiToken(pool.chain, token, chainAddressToId, symbolToChainScopedIds);
      if (!stablecoinId) continue;

      const qualityMultiplier = QUALITY_MULTIPLIERS[pool.poolType] ?? QUALITY_MULTIPLIERS.generic!;
      const pairSymbols = pool.tokens.map((t) => getDisplayTokenSymbol(t));
      const symbolStr = pairSymbols.join(" / ");

      const tokenPrice = deriveTokenUsdPrice(
        pool,
        i,
        chainAddressToId,
        symbolToChainScopedIds,
        validationReferences,
        trackedStablecoinPrices,
      );
      const ammExecutionModel = buildAmmExecutionModel(
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
        ...(ammExecutionModel ? { ammExecutionModel } : {}),
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
      const stablecoinId = resolveStablecoinIdForDexApiToken(pool.chain, token, chainAddressToId, symbolToChainScopedIds);
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
