import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC, DEX_FRESHNESS_SEC, DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD } from "@shared/lib/depeg-config";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { getPrimaryPriceAgeSec, getPrimaryTrustSources, type PrimaryPriceTrustInput } from "@shared/lib/depeg-primary-trust";
export { classifyPrimaryDepegTrust } from "@shared/lib/depeg-primary-trust";
import { DEX_PRICE_CHECK_FRESHNESS_SEC, DEX_PRICE_CHECK_UI_MIN_TVL_USD } from "./dex-liquidity/dex-cron-constants";
import { normalizePricingSourceKeys } from "@shared/lib/pricing-sources";
import { getDexPriceSourceEntries } from "@shared/lib/dex-price-sources";
export { getDexPriceSourceEntries } from "@shared/lib/dex-price-sources";

export type DexPriceTrustTier = "ui" | "depeg";

export interface DexTrustPolicy {
  maxAgeSec: number;
  minTvlUsd: number;
}

// Moved to shared so display surfaces (frontend hero, peg-analytics) share
// the detection engine's peg-reference gate; re-exported below for existing
// worker call sites.
export { isAuthoritativeDepegPegReference } from "@shared/lib/peg-reference-trust";

export type OffchainDepegConfirmerKey = "coingecko-confirm";

export function resolveDepegSourceFamily(sourceKey: string | null | undefined): string | null {
  if (!sourceKey) return null;
  const normalized = sourceKey.trim().toLowerCase();
  if (!normalized) return null;
  const compositeParts = normalizePricingSourceKeys(normalized);
  if (compositeParts.length > 1) {
    const families = compositeParts
      .map((part) => resolveDepegSourceFamily(part))
      .filter((family): family is string => !!family);
    return [...new Set(families)].join("+") || null;
  }

  // Unregistered historical alias; registered families belong to the pricing registry.
  if (normalized === "dexscreener") {
    return "fallback:dexscreener";
  }

  return getPricingSourceRegistryEntry(normalized)?.depegSourceFamily ?? normalized;
}

export function getPrimaryDepegSourceFamilies(
  input: Pick<PrimaryPriceTrustInput, "agreeSources" | "priceSource">,
): Set<string> {
  const families = new Set<string>();
  for (const source of getPrimaryTrustSources(input)) {
    const family = resolveDepegSourceFamily(source);
    if (family) families.add(family);
  }
  return families;
}

export function getFreshIndependentPrimarySourceFamilies(
  input: PrimaryPriceTrustInput,
  nowSec: number,
  excludedFamily: string,
): Set<string> {
  if (
    !isObservedPrice(input) ||
    input.price == null ||
    !Number.isFinite(input.price) ||
    input.price <= 0 ||
    input.priceSource === "cached" ||
    (input.priceConfidence !== "single-source" && input.priceConfidence !== "high") ||
    getPrimaryPriceAgeSec(input, nowSec) > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC
  ) {
    return new Set();
  }

  return new Set(
    [...getPrimaryDepegSourceFamilies(input)].filter(
      (family) => family !== excludedFamily && !family.startsWith("fallback:"),
    ),
  );
}

export function chooseIndependentOffchainDepegConfirmer(
  input: Pick<PrimaryPriceTrustInput, "agreeSources" | "priceSource">,
): OffchainDepegConfirmerKey | null {
  const primaryFamilies = getPrimaryDepegSourceFamilies(input);
  if (!primaryFamilies.has("coingecko")) return "coingecko-confirm";
  return null;
}

export function getDexTrustPolicy(tier: DexPriceTrustTier): DexTrustPolicy {
  if (tier === "ui") {
    return {
      maxAgeSec: DEX_PRICE_CHECK_FRESHNESS_SEC,
      minTvlUsd: DEX_PRICE_CHECK_UI_MIN_TVL_USD,
    };
  }

  return {
    maxAgeSec: DEX_FRESHNESS_SEC,
    minTvlUsd: DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD,
  };
}

export function isTrustedDexPriceRow(
  row: Pick<{ updated_at: number; source_total_tvl: number }, "updated_at" | "source_total_tvl">,
  nowSec: number,
  tier: DexPriceTrustTier,
): boolean {
  if (!Number.isSafeInteger(row.updated_at) || row.updated_at > nowSec) return false;
  if (!Number.isFinite(row.source_total_tvl) || row.source_total_tvl < 0) return false;

  const policy = getDexTrustPolicy(tier);
  return (nowSec - row.updated_at) < policy.maxAgeSec && row.source_total_tvl >= policy.minTvlUsd;
}

export type DexAggregateClockReason = "aggregate-clock-unavailable" | "aggregate-clock-invalid" | "aggregate-clock-future";
export interface DexAggregateClock {
  aggregateObservedAt: number | null;
  aggregateClockReason: DexAggregateClockReason | null;
}

/** Every repeated clock and the optional independent header must validate. */
export function getDexAggregateObservedAt(payload: unknown, nowSec: number): DexAggregateClock {
  const sources = getDexPriceSourceEntries(payload);
  const unavailable: DexAggregateClock = { aggregateObservedAt: null, aggregateClockReason: "aggregate-clock-unavailable" };
  if (sources == null) return unavailable;
  const contributors = Array.isArray(payload) ? sources : [payload, ...sources];
  if (contributors.length === 0) return unavailable;
  let oldest = Infinity;
  for (const source of contributors) {
    const clock = source != null && typeof source === "object" && "aggregateObservedAt" in source
      ? source.aggregateObservedAt : null;
    if (clock == null) return unavailable;
    if (typeof clock !== "number" || !Number.isFinite(clock) || clock <= 0) {
      return { aggregateObservedAt: null, aggregateClockReason: "aggregate-clock-invalid" };
    }
    if (clock > nowSec) return { aggregateObservedAt: null, aggregateClockReason: "aggregate-clock-future" };
    oldest = Math.min(oldest, clock);
  }
  return { aggregateObservedAt: oldest, aggregateClockReason: null };
}

export function readDexAggregateObservedAt(json: string | null | undefined, nowSec: number): number | null {
  try {
    return getDexAggregateObservedAt(JSON.parse(json ?? "null"), nowSec).aggregateObservedAt;
  } catch {
    return null;
  }
}

export function getDexAggregateRejectionReason(
  row: { updated_at: number; source_total_tvl: number; aggregateObservedAt?: number | null; aggregateClockReason?: DexAggregateClockReason | null },
  nowSec: number,
  tier: DexPriceTrustTier,
): string | null {
  const { maxAgeSec, minTvlUsd } = getDexTrustPolicy(tier);
  if (!Number.isSafeInteger(row.updated_at) || row.updated_at <= 0) return "publication-invalid";
  if (row.updated_at > nowSec) return "publication-future";
  if (nowSec - row.updated_at >= maxAgeSec) return "publication-stale";
  if (!Number.isFinite(row.source_total_tvl) || row.source_total_tvl < 0) return "tvl-invalid";
  if (row.source_total_tvl < minTvlUsd) return "insufficient-tvl";
  if (row.aggregateClockReason) return row.aggregateClockReason;
  const clock = row.aggregateObservedAt;
  if (clock == null) return "aggregate-clock-unavailable";
  if (typeof clock !== "number" || !Number.isFinite(clock) || clock <= 0) return "aggregate-clock-invalid";
  if (clock > nowSec) return "aggregate-clock-future";
  return nowSec - clock >= maxAgeSec ? "aggregate-clock-stale" : null;
}

/** Publication/TVL alone remains available for conservative vetoes. */
export function isAffirmativeDexPriceRow(
  row: Parameters<typeof getDexAggregateRejectionReason>[0],
  nowSec: number,
  tier: DexPriceTrustTier,
): boolean {
  return getDexAggregateRejectionReason(row, nowSec, tier) == null;
}

export function hasFreshMultiSourcePrimaryAgreement(
  input: PrimaryPriceTrustInput,
  nowSec: number,
): boolean {
  if (!isObservedPrice(input) || input.price == null || !Number.isFinite(input.price) || input.price <= 0) {
    return false;
  }

  if (
    input.priceSource === "cached" ||
    input.priceConfidence === "fallback" ||
    input.priceConfidence === "low" ||
    getPrimaryPriceAgeSec(input, nowSec) > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC
  ) {
    return false;
  }

  if (input.priceConfidence !== "high") {
    return false;
  }

  const sourceFamilies = getPrimaryDepegSourceFamilies(input);
  if (sourceFamilies.size < 2) {
    return false;
  }

  return [...sourceFamilies].some((family) => !family.startsWith("fallback:"));
}
