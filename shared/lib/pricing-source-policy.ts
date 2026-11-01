import type { PriceObservedAtMode } from "../types/core";
import type { PricingSourceTrustTier } from "./pricing-source-registry-types";
import { getPricingSourceRegistryEntry } from "./pricing-source-registry";
import { normalizePricingSourceKeys } from "./pricing-sources";

export const FIXED_PEG_SEVERE_DOWNSIDE_RATIO = 0.5;

/**
 * Maximum relative bid/ask spread (basis points of the midpoint) for a CEX
 * two-sided book to contribute a quote. A wider book is not a price, and its
 * last trade is no better evidence.
 */
export const CEX_MAX_BID_ASK_SPREAD_BPS = 100;

/**
 * Whether provenance permits treating a price as observed. Callers still validate
 * the value and freshness; absent legacy modes retain their existing semantics.
 */
export function isObservedPrice(asset: {
  priceSource?: string | null;
  priceObservedAtMode?: string | null;
}): boolean {
  const mode = asset.priceObservedAtMode;
  if (mode != null && mode !== "upstream" && mode !== "local_fetch" && mode !== "unknown") return false;
  // Any nominal-reference component (e.g. `protocol-par`) disqualifies the whole composite.
  return !normalizePricingSourceKeys(asset.priceSource).some(
    (part) => getPricingSourceRegistryEntry(part)?.trustTier === "nominal_reference",
  );
}

/**
 * Whether an admitted quote is a DefiLlama feed's exact-reference default with
 * no corroborating source family. DefiLlama list/contract feeds publish a flat
 * reference value for assets they cannot otherwise price; that value is a list
 * default, not an observed market observation, unless another independent
 * source family agrees.
 */
export function isUncorroboratedDefiLlamaReferenceQuote(input: {
  price: number;
  referencePrice: number | null | undefined;
  sources: readonly (string | null | undefined)[] | string | null | undefined;
}): boolean {
  const referencePrice = input.referencePrice;
  if (
    referencePrice == null ||
    !Number.isFinite(referencePrice) ||
    referencePrice <= 0 ||
    !Number.isFinite(input.price) ||
    input.price !== referencePrice
  ) {
    return false;
  }

  return isDefiLlamaFamilyListOnlyQuote(input.sources);
}

/**
 * Distinct list assets that may legitimately share one verbatim price: wrapped
 * and derivative variants (for example the four USDC wrappers observed at
 * 0.999520515794015 on 2026-10-30). A value shared by more assets is the
 * response-level fill DefiLlama uses for assets it cannot price.
 */
const DEFILLAMA_LIST_FILL_DEFAULT_MIN_ASSET_COUNT = 5;

/** The per-response fill-default status of one DefiLlama list row's price. */
export interface DefiLlamaListFillDefaultQuote {
  value: number;
  /** The list row's own `priceSource` attribution; it is not independent corroboration. */
  upstreamSource: string | null;
}

/**
 * Prices a DefiLlama list response repeats verbatim across at least
 * `DEFILLAMA_LIST_FILL_DEFAULT_MIN_ASSET_COUNT` distinct assets. Counting is per
 * response, never a hardcoded constant, so a changed fill value is detected the
 * same way.
 */
export function detectDefiLlamaListFillDefaultPrices(
  rows: Iterable<{ id?: unknown; price?: unknown }>,
): Set<number> {
  const assetsByPrice = new Map<number, Set<string>>();
  let anonymousRows = 0;
  for (const row of rows) {
    const price = row.price;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
    const rawId = row.id;
    const assetKey =
      typeof rawId === "string" || (typeof rawId === "number" && Number.isFinite(rawId))
        ? String(rawId)
        : `#anonymous-${anonymousRows++}`;
    const assetKeys = assetsByPrice.get(price) ?? new Set<string>();
    assetKeys.add(assetKey);
    assetsByPrice.set(price, assetKeys);
  }

  const fillDefaultPrices = new Set<number>();
  for (const [price, assetKeys] of assetsByPrice) {
    if (assetKeys.size >= DEFILLAMA_LIST_FILL_DEFAULT_MIN_ASSET_COUNT) fillDefaultPrices.add(price);
  }
  return fillDefaultPrices;
}

/**
 * Whether an admitted quote is this response's fill default with no
 * corroborating source family. The list row's own attribution label names the
 * read that produced the fill, so it cannot corroborate itself.
 */
export function isUncorroboratedDefiLlamaListFillQuote(input: {
  price: number;
  fillDefault: DefiLlamaListFillDefaultQuote | null | undefined;
  sources: readonly (string | null | undefined)[] | string | null | undefined;
}): boolean {
  const fillDefault = input.fillDefault;
  if (
    fillDefault == null ||
    !Number.isFinite(fillDefault.value) ||
    fillDefault.value <= 0 ||
    !Number.isFinite(input.price) ||
    input.price !== fillDefault.value
  ) {
    return false;
  }

  const parts = normalizePricingSourceKeys(input.sources);
  if (parts.length === 0) return false;

  const upstreamParts = new Set(normalizePricingSourceKeys(fillDefault.upstreamSource));
  for (const part of parts) {
    if (!isDefiLlamaFamilyListSourcePart(part) && !upstreamParts.has(part)) return false;
  }
  return true;
}

function isDefiLlamaFamilyListSourcePart(source: string): boolean {
  const entry = getPricingSourceRegistryEntry(source);
  return entry?.isListAggregator === true && entry.depegSourceFamily === "defillama";
}

/** All cited parts are DefiLlama-family list aggregators. */
function isDefiLlamaFamilyListOnlyQuote(
  sources: readonly (string | null | undefined)[] | string | null | undefined,
): boolean {
  const parts = normalizePricingSourceKeys(sources);
  if (parts.length === 0) return false;

  const families = new Set<string>();
  for (const part of parts) {
    const entry = getPricingSourceRegistryEntry(part);
    if (!entry || !entry.isListAggregator) return false;
    families.add(entry.depegSourceFamily);
  }
  return families.size === 1 && families.has("defillama");
}

/**
 * Single owner of the hard-tier membership question. Callers must not
 * re-enumerate the hard trust tiers; a future tier addition is decided here.
 */
export function isHardPricingTrustTier(tier: PricingSourceTrustTier | null | undefined): boolean {
  return tier === "hard_market" || tier === "hard_oracle" || tier === "hard_protocol";
}

export function isPoolChallengeEligibleConsensus(sources: string[]): boolean {
  const sourceParts = normalizePricingSourceKeys(sources);
  return (
    sourceParts.length > 0 &&
    sourceParts.every((source) => {
      const entry = getPricingSourceRegistryEntry(source);
      return entry != null && !entry.isPoolChallengeExempt;
    })
  );
}

export function isReplaySafePriceSource(source: string | null | undefined): boolean {
  if (!source) return false;
  const sourceParts = normalizePricingSourceKeys(source);
  return (
    sourceParts.length > 0 && sourceParts.every((part) => getPricingSourceRegistryEntry(part)?.isReplaySafe ?? false)
  );
}

/**
 * Returns the per-source max trusted age (seconds), or the composite cap when the source has no per-source window.
 *
 * Trust monotonicity: the window is computed over the composite's replay-safe
 * core. An agreeing non-replay-safe corroborator (e.g. an exact-address
 * augmentation lane joining a consensus label) must not zero the window the
 * core earns on its own. Unknown source keys and cached-replay lineage remain
 * hard failures — a mislabeled or cache-of-cache row never replays.
 */
export function getPriceCacheMaxAgeSec(source: string | null | undefined, compositeCapSec: number): number {
  if (!source) return compositeCapSec;
  let maxAgeSec = compositeCapSec;
  let replaySafeParts = 0;
  for (const part of normalizePricingSourceKeys(source)) {
    const entry = getPricingSourceRegistryEntry(part);
    if (!entry || entry.trustTier === "cached_replay") {
      return 0;
    }
    if (!entry.isReplaySafe) continue;
    replaySafeParts += 1;
    const sourceWindow = entry.maxTrustedAgeSec;
    if (typeof sourceWindow === "number" && Number.isFinite(sourceWindow) && sourceWindow > 0) {
      maxAgeSec = Math.min(maxAgeSec, sourceWindow);
    }
  }
  return replaySafeParts > 0 ? maxAgeSec : 0;
}

export function hasDepegAuthoritativeSource(sources: string[] | null | undefined): boolean {
  if (!sources || sources.length === 0) return false;
  return normalizePricingSourceKeys(sources).some(
    (source) => getPricingSourceRegistryEntry(source)?.canBeDepegAuthoritative ?? false,
  );
}

export function countDepegAuthoritativeSources(sources: string[] | null | undefined): number {
  if (!sources || sources.length === 0) return 0;
  return [...new Set(normalizePricingSourceKeys(sources))].filter(
    (source) => getPricingSourceRegistryEntry(source)?.canBeDepegAuthoritative ?? false,
  ).length;
}

export function hasUpstreamCapableDepegAuthoritativeSource(sources: string[] | null | undefined): boolean {
  if (!sources || sources.length === 0) return false;
  return normalizePricingSourceKeys(sources).some((source) => {
    const entry = getPricingSourceRegistryEntry(source);
    return !!entry?.canBeDepegAuthoritative && !!entry.supportsUpstreamObservedAt;
  });
}

export function isSingleSourceDepegAuthoritative(
  source: string | null | undefined,
  observedAtMode: PriceObservedAtMode | null | undefined,
): boolean {
  if (!source) return false;
  const sourceParts = normalizePricingSourceKeys(source);
  if (sourceParts.length !== 1) return false;
  const entry = getPricingSourceRegistryEntry(sourceParts[0]);
  if (!entry?.canSingleSourceDepegAuthoritative) {
    return false;
  }

  if (observedAtMode === "upstream") {
    return true;
  }

  if (observedAtMode == null && entry.supportsUpstreamObservedAt) {
    return true;
  }

  return false;
}
