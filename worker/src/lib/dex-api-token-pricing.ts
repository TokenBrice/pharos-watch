import type { PriceValidationReferences } from "./price-validation";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildPriceValidationContext, getReferencePriceForContext } from "./price-validation";
import { isUsdReferenceSymbol, normalizeDexSymbol } from "./dex-cron-constants";
import { resolveTrackedStablecoinId } from "../cron/dex-liquidity/token-resolution";
import type { DexApiPool, DexApiPoolToken } from "./dex-api-types";

const NATIVE_PLACEHOLDER_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export function resolveStablecoinIdForDexApiToken(
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

export function isTrackedDexApiToken(
  chain: string,
  token: DexApiPoolToken,
  chainAddressToId: Map<string, string>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
): boolean {
  return resolveTrackedStablecoinId(
    { chain, address: token.address, symbol: token.symbol },
    { chainAddressToId, symbolToChainScopedIds },
  ).status === "matched";
}

export function getTokenReferenceUsdPrice(
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

    if (TRACKED_META_BY_ID.get(resolved.stablecoinId)?.flags.navToken === true) return null;

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

function deriveTokenUsdPrice(
  pool: DexApiPool,
  tokenIndex: number,
  chainAddressToId: Map<string, string>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
  validationReferences?: PriceValidationReferences,
  trackedStablecoinPrices?: Map<string, number>,
): number | null {
  const token = pool.tokens[tokenIndex];

  if (token.priceUsd != null && Number.isFinite(token.priceUsd) && token.priceUsd > 0) {
    return token.priceUsd;
  }

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

  if (tokenIndex === 0) return pool.price * otherUsdRef;
  return (1 / pool.price) * otherUsdRef;
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
  // For a 2-token pool both sides represent the same economic flow, so the two
  // USD estimates should be ~equal; averaging smooths reference-vs-derived
  // divergence. For 3+ token pools (e.g. Balancer) averaging N independent
  // estimates of the same flow is not meaningful, so keep the raw source value.
  if (pool.tokens.length !== 2) return pool.volume24hUsd;
  return candidates.reduce((sum, value) => sum + value, 0) / candidates.length;
}

export { deriveTokenUsdPrice, derivePoolVolume24hUsd };
