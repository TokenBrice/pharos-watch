import type { DexPriceObs, GtNewPool } from "../cron/dex-liquidity/types";
import type { SymbolLookups } from "../cron/dex-liquidity/types";
import { QUALITY_MULTIPLIERS, normalizeDexSymbol } from "./dex-cron-constants";
import { buildPoolIdentity } from "../cron/dex-liquidity/pool-identity";
import { isPlausibleDexObservationPrice } from "../cron/dex-liquidity/price-sanity";
import type { PriceValidationReferences } from "./price-validation";
import type {
  DexAmmExecutionModel,
  DexAmmExecutionToken,
  DexExecutionCapabilityGate,
} from "@shared/types/market";
import { canonicalExitRouteScopedId, canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";
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
  const bounded = values
    .slice(0, DEX_DIAGNOSTIC_SAMPLE_LIMIT)
    .map((value) => value.replace(/\s+/g, " ").trim().slice(0, DEX_DIAGNOSTIC_MAX_CHARS));
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
  pool: Pick<DexApiPool, "source" | "tvlUsd" | "volume24hUsd" | "tokens">,
  minTvlUsd = DIRECT_API_POOL_MIN_TVL_USD,
): boolean {
  if (!isEligibleDirectApiPool(pool, minTvlUsd)) return false;
  if (Number.isFinite(pool.volume24hUsd) && pool.volume24hUsd > 0) return true;
  if (pool.tokens.some((token) => token.priceUsdDependency != null)) return true;
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

    const reviewedExactCandidate =
      pool.source === "balancer" ||
      (pool.source === "raydium" && pool.poolType === "raydium-amm");
    const tokens = pool.tokens
      .filter((token) => reviewedExactCandidate || (typeof token.address === "string" && token.address.trim().length > 0))
      .map((token) => ({
        ...token,
        priceUsd: toPositiveFiniteNumberOrNull(token.priceUsd),
        weight: toPositiveFiniteNumberOrNull(token.weight),
      }));
    if (tokens.length < 2 && !reviewedExactCandidate) {
      skippedInvalidUnitCount++;
      continue;
    }

    const balances =
      Array.isArray(pool.balances) &&
      pool.balances.length === tokens.length &&
      pool.balances.every((balance) => toNonNegativeFiniteNumberOrNull(balance) != null)
        ? pool.balances
        : null;
    const tokenVolumes24h =
      Array.isArray(pool.tokenVolumes24h) &&
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
  const contractMeta = contractMetaByChainAddress.get(canonicalExitRouteAssetKey(pool.chain, token.address));
  return contractMeta?.symbol ?? null;
}

function resolvePoolTokenDecimals(
  pool: DexApiPool,
  token: DexApiPoolToken,
  contractMetaByChainAddress: SymbolLookups["contractMetaByChainAddress"],
): number | null {
  if (Number.isFinite(token.decimals) && token.decimals > 0) return token.decimals;
  if (canonicalExitRouteScopedId(pool.chain, token.address) === NATIVE_PLACEHOLDER_TOKEN) return 18;
  const contractMeta = contractMetaByChainAddress.get(canonicalExitRouteAssetKey(pool.chain, token.address));
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
      normalizedBalances.push(rawBalance / 10 ** decimals);
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

  const trackedAssetId = resolveStablecoinIdForDexApiToken(pool.chain, token, chainAddressToId, symbolToChainScopedIds);
  const sourcePrice = toPositiveFiniteNumberOrNull(token.priceUsd);
  const trackedPrice =
    trackedAssetId == null ? null : toPositiveFiniteNumberOrNull(trackedStablecoinPrices?.get(trackedAssetId));
  const referencePriceUsd =
    sourcePrice ??
    trackedPrice ??
    getTokenReferenceUsdPrice(
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
    referencePriceSource:
      sourcePrice != null ? "source-token-usd" : trackedPrice != null ? "tracked-market" : "peg-reference",
    ...(trackedAssetId ? { trackedAssetId } : {}),
    ...(weight != null ? { weight } : {}),
  };
}

interface AmmExecutionCapability {
  executionModel: DexAmmExecutionModel | null;
  gate: DexExecutionCapabilityGate | null;
}

function capabilityGate(
  family: DexExecutionCapabilityGate["family"],
  reason: DexExecutionCapabilityGate["reason"],
): AmmExecutionCapability {
  return { executionModel: null, gate: { family, reason } };
}

/**
 * Raydium's pool list carries no per-token USD price, so an untracked counter
 * asset fails direct reference resolution and the whole pool gates to
 * incomplete-exact-capture. The same API response's spot `price` (tokens[0]
 * denominated in tokens[1], decimal-adjusted) plus the other token's direct
 * reference implies the counter reference — the same derivation
 * deriveTokenUsdPrice already uses for display pricing. Only price resolution
 * may be repaired this way; identity or balance failures stay gated.
 */
function applyRaydiumPoolImpliedReferences(
  pool: DexApiPool,
  modelEntries: { token: DexApiPoolToken; balance: number; index: number }[],
  tokens: (DexAmmExecutionToken | null)[],
  chainAddressToId: Map<string, string>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
): (DexAmmExecutionToken | null)[] {
  if (pool.price == null || !Number.isFinite(pool.price) || pool.price <= 0) return tokens;
  if (modelEntries.length !== 2) return tokens;
  const resolved = [...tokens];
  for (let position = 0; position < 2; position++) {
    if (resolved[position] != null) continue;
    const anchor = resolved[position === 0 ? 1 : 0]!;
    if (anchor == null) return tokens;
    const { token, balance, index } = modelEntries[position]!;
    const address = token.address.trim();
    const symbol = normalizeDexSymbol(token.symbol);
    if (!address || !symbol || !Number.isFinite(token.decimals) || token.decimals < 0 || token.decimals > 255) {
      return tokens;
    }
    if (!Number.isFinite(balance) || balance <= 0) return tokens;
    const implied = index === 0 ? pool.price * anchor.referencePriceUsd : anchor.referencePriceUsd / pool.price;
    if (!Number.isFinite(implied) || implied <= 0) return tokens;
    const trackedAssetId = resolveStablecoinIdForDexApiToken(
      pool.chain,
      token,
      chainAddressToId,
      symbolToChainScopedIds,
    );
    if (trackedAssetId) return tokens;
    resolved[position] = {
      address,
      symbol,
      decimals: token.decimals,
      balance,
      referencePriceUsd: implied,
      referencePriceSource: "pool-implied",
    };
  }
  return resolved;
}

function isCanonicalEvmAddress(value: string): boolean {
  return /^0x[a-f0-9]{40}$/.test(value.trim().toLowerCase());
}

function buildAmmExecutionCapability(
  pool: DexApiPool,
  trackedTokenIndex: number,
  chainAddressToId: Map<string, string>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
  validationReferences?: PriceValidationReferences,
  trackedStablecoinPrices?: Map<string, number>,
): AmmExecutionCapability {
  const family: DexExecutionCapabilityGate["family"] | null =
    pool.source === "balancer"
      ? "balancer-amm"
      : pool.source === "raydium" && pool.poolType === "raydium-amm"
        ? "raydium-amm"
        : null;
  if (pool.executionCapabilityGate) {
    return { executionModel: null, gate: pool.executionCapabilityGate };
  }
  if (family == null) return { executionModel: null, gate: null };

  if (
    trackedTokenIndex < 0 ||
    trackedTokenIndex >= pool.tokens.length
  ) {
    return capabilityGate(family, "tracked-input-unresolved");
  }
  if (
    pool.balancesNormalized !== true ||
    pool.balances == null ||
    pool.balances.length !== pool.tokens.length ||
    pool.feeRate == null
  ) {
    return capabilityGate(family, "incomplete-exact-capture");
  }
  if (!Number.isFinite(pool.feeRate) || pool.feeRate < 0 || pool.feeRate >= 1) {
    return capabilityGate(family, "invalid-invariant-parameters");
  }

  let invariant: DexAmmExecutionModel["invariant"];
  if (pool.source === "raydium" && pool.poolType === "raydium-amm") {
    if (pool.tokens.length !== 2) return capabilityGate(family, "unsupported-invariant");
    invariant = "constant-product";
  } else if (pool.source === "balancer" && pool.poolType === "balancer-weighted") {
    invariant = "weighted-constant-mean";
  } else if (pool.source === "balancer" && pool.poolType === "balancer-stable") {
    if (pool.amp == null) return capabilityGate(family, "incomplete-exact-capture");
    if (!Number.isFinite(pool.amp) || pool.amp <= 0) {
      return capabilityGate(family, "invalid-invariant-parameters");
    }
    invariant = "stableswap";
  } else {
    return capabilityGate(family, "unsupported-invariant");
  }

  // Composable stable pools list the pool's own phantom BPT as a token; it is
  // not a swappable counter-asset and must not enter the invariant.
  const poolAddress = pool.poolAddress.trim().toLowerCase();
  if (family === "balancer-amm" && !isCanonicalEvmAddress(poolAddress)) {
    return capabilityGate(family, "incomplete-exact-capture");
  }
  const entries = pool.tokens.map((token, index) => ({ token, balance: pool.balances![index]!, index }));
  const modelEntries =
    invariant === "stableswap"
      ? entries.filter(({ token }) => token.address.trim().toLowerCase() !== poolAddress)
      : entries;
  if (modelEntries.length < 2) return capabilityGate(family, "incomplete-exact-capture");
  if (modelEntries.length > 8) return capabilityGate(family, "unsupported-invariant");
  const modelTrackedIndex = modelEntries.findIndex(({ index }) => index === trackedTokenIndex);
  if (modelTrackedIndex === -1) return capabilityGate(family, "tracked-input-unresolved");

  if (modelEntries.some(({ token }) =>
    (family === "balancer-amm" ? !isCanonicalEvmAddress(token.address) : !token.address.trim()) ||
    !normalizeDexSymbol(token.symbol) ||
    !Number.isFinite(token.decimals) ||
    token.decimals < 0 ||
    token.decimals > 255
  )) {
    return capabilityGate(family, "incomplete-exact-capture");
  }
  if (modelEntries.some(({ balance }) => !Number.isFinite(balance) || balance <= 0)) {
    return capabilityGate(family, "invalid-invariant-parameters");
  }

  const identityKeys = modelEntries.map(({ token }) => canonicalExitRouteScopedId(pool.chain, token.address));
  if (new Set(identityKeys).size !== identityKeys.length) {
    return capabilityGate(family, "ambiguous-token-identity");
  }

  // Stable math runs on rate-scaled balances; every modeled token needs a measured rate.
  const priceRates =
    invariant === "stableswap" ? modelEntries.map(({ token }) => token.priceRate) : null;
  if (priceRates != null && priceRates.some((rate) => rate == null)) {
    return capabilityGate(family, "incomplete-exact-capture");
  }
  if (priceRates != null && priceRates.some((rate) => typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0)) {
    return capabilityGate(family, "invalid-invariant-parameters");
  }

  const tokens = modelEntries.map(({ token, balance }) =>
    resolveExecutionToken(
      pool,
      token,
      balance,
      chainAddressToId,
      symbolToChainScopedIds,
      validationReferences,
      trackedStablecoinPrices,
    ),
  );
  const referencedTokens =
    family === "raydium-amm"
      ? applyRaydiumPoolImpliedReferences(pool, modelEntries, tokens, chainAddressToId, symbolToChainScopedIds)
      : tokens;
  if (referencedTokens.some((token) => token == null)) {
    return capabilityGate(family, "incomplete-exact-capture");
  }
  let exactTokens = referencedTokens as DexAmmExecutionToken[];

  if (invariant === "weighted-constant-mean") {
    const weights = exactTokens.map((token) => token.weight);
    if (weights.some((weight) => weight == null)) {
      return capabilityGate(family, "incomplete-exact-capture");
    }
    const weightSum = (weights as number[]).reduce((sum, weight) => sum + weight, 0);
    if (!Number.isFinite(weightSum) || Math.abs(weightSum - 1) > 0.0001) {
      return capabilityGate(family, "invalid-invariant-parameters");
    }
  }

  let amplification: number | undefined;
  if (invariant === "stableswap") {
    const rates = priceRates as number[];
    // Balancer StableMath operates on scaled balances (balance * priceRate).
    // Scaling each balance and dividing its reference price by the same rate
    // keeps every USD quantity unchanged while the invariant sees the
    // on-chain scaled units.
    exactTokens = exactTokens.map((token, index) => ({
      ...token,
      balance: token.balance * rates[index]!,
      referencePriceUsd: token.referencePriceUsd / rates[index]!,
    }));
    // The API reports the contract amplification (Ann = amp * n); the model
    // stores the plain paper convention (Ann = A * n^n), so convert by n^(n-1).
    const n = exactTokens.length;
    amplification = pool.amp! / n ** (n - 1);
  }

  return {
    executionModel: {
      source: invariant === "constant-product" ? "raydium" : "balancer",
      invariant,
      trackedTokenIndex: modelTrackedIndex,
      feeRate: pool.feeRate,
      ...(amplification != null ? { amplification } : {}),
      tokens: exactTokens,
    },
    gate: null,
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
    const priceUsd =
      directPrice != null && Number.isFinite(directPrice) && directPrice > 0
        ? directPrice
        : (getTokenReferenceUsdPrice(
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
          ));

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
      const stablecoinId = resolveStablecoinIdForDexApiToken(
        pool.chain,
        token,
        chainAddressToId,
        symbolToChainScopedIds,
      );
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
      const executionCapability = buildAmmExecutionCapability(
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
        ...(balanceMetrics
          ? {
              balanceRatio: balanceMetrics.balanceRatio,
              balanceDetails: balanceMetrics.balanceDetails,
            }
          : {}),
        ...(feeTierBps != null ? { feeTierBps } : {}),
        ...(executionCapability.executionModel
          ? { ammExecutionModel: executionCapability.executionModel }
          : {}),
        ...(executionCapability.gate
          ? { executionCapabilityGate: executionCapability.gate }
          : {}),
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
    if (
      pool.executionCapabilityGate?.family === "balancer-amm" &&
      pool.executionCapabilityGate.reason === "paused-or-swap-disabled"
    ) continue;
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
      const stablecoinId = resolveStablecoinIdForDexApiToken(
        pool.chain,
        token,
        chainAddressToId,
        symbolToChainScopedIds,
      );
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
