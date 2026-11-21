import type { PriceValidationReferences } from "./price-validation";
import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC, DEX_FRESHNESS_SEC } from "@shared/lib/depeg-config";
import { getReferenceMarket, getReferenceMarketClosureStart } from "@shared/lib/reference-market-hours";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { buildPriceValidationContext, getFreshReferencePriceForContext, getReferencePriceForContext } from "./price-validation";
import { isUsdReferenceSymbol, normalizeDexSymbol } from "./dex-cron-constants";
import { logWorkerEvent } from "./structured-log";
import { resolveTrackedStablecoinId } from "../cron/dex-liquidity/token-resolution";
import type { DexApiPool, DexApiPoolToken } from "./dex-api-types";

const NATIVE_PLACEHOLDER_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export interface DexMarketMark {
  priceUsd: number;
  observedAtSec: number;
  observedAtMode?: "upstream";
  /** Fresh agreement of at least two independent market source families; its clock is local collection time. */
  corroboration?: "multi-source";
  source: string;
}

export type DexValuationPrices = ReadonlyMap<string, number> & {
  readonly marketMarks?: ReadonlyMap<string, DexMarketMark>;
  readonly closureValuationRejectedAssetIds?: Set<string>;
};

export function getAdmittedDexMarketMark(
  prices: DexValuationPrices | undefined,
  stablecoinId: string,
  assessedAtSec: number,
): DexMarketMark | null {
  const mark = prices?.marketMarks?.get(stablecoinId);
  if (
    !mark || mark.priceUsd !== prices?.get(stablecoinId) ||
    !Number.isFinite(mark.priceUsd) || mark.priceUsd <= 0 || !mark.source.trim() ||
    !Number.isSafeInteger(assessedAtSec) ||
    !Number.isSafeInteger(mark.observedAtSec) || mark.observedAtSec <= 0 ||
    mark.observedAtSec > assessedAtSec || assessedAtSec - mark.observedAtSec > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC
  ) return null;
  return mark;
}

/** A closed-session leg needs a mark observed after the close: an upstream clock or a fresh multi-source consensus. */
export function isClosureValuationMark<T extends Pick<DexMarketMark, "observedAtSec" | "observedAtMode" | "corroboration">>(
  mark: T | null | undefined,
  closureStart: number,
): mark is T {
  return mark != null && mark.observedAtSec >= closureStart &&
    (mark.observedAtMode === "upstream" || mark.corroboration === "multi-source");
}

export function getClosedReferenceDexValuation(
  prices: DexValuationPrices | undefined,
  stablecoinId: string,
  assessedAtSec: number,
) {
  if (!prices?.marketMarks) return null;
  const market = getReferenceMarket(buildPriceValidationContext({ stablecoinId }).pegCurrency);
  const closureStart = getReferenceMarketClosureStart(market, assessedAtSec);
  if (closureStart == null) return null;
  const mark = getAdmittedDexMarketMark(prices, stablecoinId, assessedAtSec);
  return { market, closureStart, mark: isClosureValuationMark(mark, closureStart) ? mark : null };
}

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
  trackedStablecoinPrices?: DexValuationPrices,
): number | null {
  return resolveTokenReferenceUsdPrice(
    token, chain, chainAddressToId, symbolToChainScopedIds, validationReferences, trackedStablecoinPrices,
  );
}

export function getMeasuredTokenReferenceUsdPrice(
  measuredReferenceAtSec: number,
  token: DexApiPoolToken,
  chain: string,
  chainAddressToId: Map<string, string>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
  validationReferences?: PriceValidationReferences,
  trackedStablecoinPrices?: DexValuationPrices,
): number | null {
  if (!Number.isSafeInteger(measuredReferenceAtSec) || measuredReferenceAtSec <= 0) return null;
  return resolveTokenReferenceUsdPrice(
    token, chain, chainAddressToId, symbolToChainScopedIds, validationReferences, trackedStablecoinPrices, measuredReferenceAtSec,
  );
}

function resolveTokenReferenceUsdPrice(
  token: DexApiPoolToken,
  chain: string,
  chainAddressToId: Map<string, string>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
  validationReferences?: PriceValidationReferences,
  trackedStablecoinPrices?: DexValuationPrices,
  measuredReferenceAtSec?: number,
): number | null {
  const resolved = resolveTrackedStablecoinId(
    { chain, address: token.address, symbol: token.symbol },
    { chainAddressToId, symbolToChainScopedIds },
  );
  if (resolved.status === "matched" && resolved.stablecoinId) {
    const context = buildPriceValidationContext({ stablecoinId: resolved.stablecoinId });
    if (measuredReferenceAtSec !== undefined) {
      const closure = getClosedReferenceDexValuation(trackedStablecoinPrices, resolved.stablecoinId, measuredReferenceAtSec);
      if (closure) {
        if (closure.mark) return closure.mark.priceUsd;
        trackedStablecoinPrices?.closureValuationRejectedAssetIds?.add(resolved.stablecoinId);
        logWorkerEvent({
          scope: "lib",
          level: "info",
          event: "dex_measured_valuation_unavailable",
          job: "sync-dex-liquidity",
          message: "Withheld measured DEX USD valuation during reference closure",
          metadata: {
            reason: "reference-market-closed-without-current-token-mark",
            stablecoinId: resolved.stablecoinId,
            chain,
            market: closure.market,
            assessedAtSec: measuredReferenceAtSec,
            closureStartedAtSec: closure.closureStart,
            maxObservationAgeSec: DEPEG_PRIMARY_PRICE_MAX_AGE_SEC,
          },
        });
        return null;
      }
    }
    const trackedPrice = trackedStablecoinPrices?.get(resolved.stablecoinId);
    if (trackedPrice != null && Number.isFinite(trackedPrice) && trackedPrice > 0) {
      return trackedPrice;
    }

    // navToken legs price only from a guarded NAV reference carried in the
    // trusted map (orchestrator-phases/lookups admits fresh protocol-redeem
    // NAV overrides). Missing NAV stays null — never a peg/reference print.
    if (WORKER_TRACKED_META_BY_ID.get(resolved.stablecoinId)?.flags.navToken === true) return null;

    return measuredReferenceAtSec === undefined
      ? getReferencePriceForContext(context, validationReferences)
      : getFreshReferencePriceForContext(context, validationReferences, measuredReferenceAtSec);
  }

  const normalizedAddress = (token.address ?? "").trim().toLowerCase();
  const allowSymbolUsdFallback = normalizedAddress.length === 0 || normalizedAddress === NATIVE_PLACEHOLDER_TOKEN;
  const symbol = normalizeDexSymbol(token.symbol);
  if (allowSymbolUsdFallback && symbol && isUsdReferenceSymbol(symbol)) {
    return 1;
  }

  return null;
}

function getPoolRatioMultiplier(pool: DexApiPool, tokenIndex: number): number | null {
  if (pool.tokens.length !== 2 || pool.price == null || !Number.isFinite(pool.price) || pool.price <= 0) return null;
  return tokenIndex === 0 ? pool.price : 1 / pool.price;
}

function getDirectDexTokenUsdPrice(token: DexApiPoolToken): number | null {
  const price = token.priceUsd;
  return token.priceUsdDependency == null && price != null && Number.isFinite(price) && price > 0 ? price : null;
}

function deriveTokenInventoryUsdPrice(
  pool: DexApiPool,
  tokenIndex: number,
  chainAddressToId: Map<string, string>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
  validationReferences?: PriceValidationReferences,
  trackedStablecoinPrices?: DexValuationPrices,
): number | null {
  const token = pool.tokens[tokenIndex];

  if (token.priceUsdDependency) {
    const dependencyPrice = trackedStablecoinPrices?.get(token.priceUsdDependency.stablecoinId);
    const multiplier = token.priceUsdDependency.multiplier;
    if (
      dependencyPrice == null ||
      !Number.isFinite(dependencyPrice) ||
      dependencyPrice <= 0 ||
      !Number.isFinite(multiplier) ||
      multiplier <= 0
    ) return null;
    return dependencyPrice * multiplier;
  }

  const directPrice = getDirectDexTokenUsdPrice(token);
  if (directPrice != null) return directPrice;

  const multiplier = getPoolRatioMultiplier(pool, tokenIndex);
  if (multiplier == null) return null;
  const otherUsdRef = getTokenReferenceUsdPrice(
    pool.tokens[tokenIndex === 0 ? 1 : 0],
    pool.chain,
    chainAddressToId,
    symbolToChainScopedIds,
    validationReferences,
    trackedStablecoinPrices,
  );
  if (otherUsdRef == null) return null;
  return multiplier * otherUsdRef;
}

export function deriveTokenUsdObservation(
  pool: DexApiPool,
  tokenIndex: number,
  stablecoinId: string,
  chainAddressToId: Map<string, string>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
  trackedStablecoinPrices: DexValuationPrices | undefined,
  assessedAtSec: number,
): {
  price: number;
  observedAt: number | null;
  counterpartyPrice?: DexMarketMark & { stablecoinId: string };
} | null {
  const token = pool.tokens[tokenIndex];
  const directPrice = getDirectDexTokenUsdPrice(token);
  if (directPrice != null) {
    return {
      price: directPrice,
      observedAt: pool.priceObservedAt === undefined ? pool.readStartedAtSec ?? null : pool.priceObservedAt,
    };
  }

  const ratioObservedAt = pool.ratioObservedAtSec;
  if (ratioObservedAt == null || !Number.isSafeInteger(ratioObservedAt) || ratioObservedAt <= 0) return null;
  if (ratioObservedAt > assessedAtSec || assessedAtSec - ratioObservedAt >= DEX_FRESHNESS_SEC) return null;
  const multiplier = token.priceUsdDependency?.multiplier ?? getPoolRatioMultiplier(pool, tokenIndex);
  if (multiplier == null || !Number.isFinite(multiplier) || multiplier <= 0) return null;
  const otherId = token.priceUsdDependency?.stablecoinId ?? resolveStablecoinIdForDexApiToken(
    pool.chain, pool.tokens[tokenIndex === 0 ? 1 : 0], chainAddressToId, symbolToChainScopedIds,
  );
  if (!otherId || otherId === stablecoinId) return null;
  const mark = getAdmittedDexMarketMark(trackedStablecoinPrices, otherId, assessedAtSec);
  if (!mark) return null;
  const price = multiplier * mark.priceUsd;
  if (!Number.isFinite(price) || price <= 0) return null;
  // The multi-source label admits closed-market capacity valuation only, never price evidence.
  const { corroboration: _corroboration, ...priceMark } = mark;
  return {
    price,
    observedAt: Math.min(ratioObservedAt, mark.observedAtSec),
    counterpartyPrice: { ...priceMark, stablecoinId: otherId },
  };
}

function derivePoolVolume24hUsd(
  pool: DexApiPool,
  chainAddressToId: Map<string, string>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
  validationReferences?: PriceValidationReferences,
  trackedStablecoinPrices?: Map<string, number>,
): number | null {
  if (!pool.tokenVolumes24h || pool.tokenVolumes24h.length !== pool.tokens.length) {
    return pool.volume24hUsd;
  }
  // Every side reporting exactly zero native volume is a measured quiet day.
  if (pool.tokenVolumes24h.every((volume) => volume === 0)) return 0;

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

    const derivedPrice = deriveTokenInventoryUsdPrice(
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

export { deriveTokenInventoryUsdPrice, derivePoolVolume24hUsd };
