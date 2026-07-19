import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import type { DepegPrimaryTrust, PriceConfidence, PriceObservedAtMode } from "@shared/types/core";
import {
  countDepegAuthoritativeSources,
  hasUpstreamCapableDepegAuthoritativeSource,
  isSingleSourceDepegAuthoritative,
} from "@shared/lib/pricing-source-policy";
import {
  DEPEG_PRIMARY_PRICE_MAX_AGE_SEC,
  DEX_FRESHNESS_SEC,
  DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD,
  DEX_PRICE_CHECK_FRESHNESS_SEC,
  DEX_PRICE_CHECK_UI_MIN_TVL_USD,
} from "./constants";
import { normalizePricingSourceKeys } from "@shared/lib/pricing-sources";

export type DexPriceTrustTier = "ui" | "depeg";

export interface DexTrustPolicy {
  maxAgeSec: number;
  minTvlUsd: number;
}

interface PrimaryPriceTrustInput {
  price?: number | null;
  priceSource?: string | null;
  priceConfidence?: PriceConfidence | null;
  priceUpdatedAt?: number | null;
  priceObservedAt?: number | null;
  priceObservedAtMode?: PriceObservedAtMode | null;
  agreeSources?: string[] | null;
}

// Moved to shared so display surfaces (frontend hero, peg-analytics) share
// the detection engine's peg-reference gate; re-exported below for existing
// worker call sites.
export { isAuthoritativeDepegPegReference } from "@shared/lib/peg-reference-trust";
export type { PegReferenceTrustInput } from "@shared/lib/peg-reference-trust";

export type OffchainDepegConfirmerKey = "coingecko-confirm" | "defillama-confirm";

function getPrimaryPriceAgeSec(
  input: Pick<PrimaryPriceTrustInput, "priceObservedAt" | "priceUpdatedAt">,
  nowSec: number,
): number {
  const observedAt = typeof input.priceObservedAt === "number" && Number.isFinite(input.priceObservedAt)
    ? input.priceObservedAt
    : typeof input.priceUpdatedAt === "number" && Number.isFinite(input.priceUpdatedAt)
      ? input.priceUpdatedAt
      : null;
  if (observedAt == null || observedAt > nowSec) return Number.POSITIVE_INFINITY;
  return nowSec - observedAt;
}

function getPrimaryTrustSources(input: Pick<PrimaryPriceTrustInput, "agreeSources" | "priceSource">): string[] {
  const sources = input.agreeSources && input.agreeSources.length > 0
    ? input.agreeSources
    : input.priceSource ?? "";
  return normalizePricingSourceKeys(sources);
}

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

  if (
    normalized === "coingecko" ||
    normalized === "coingecko-native-implied" ||
    normalized === "coingecko-mirror" ||
    normalized === "coingecko-low-volume" ||
    normalized === "cg-ticker"
  ) {
    return "coingecko";
  }
  if (
    normalized === "defillama" ||
    normalized === "defillama-list" ||
    normalized === "defillama-contract"
  ) {
    return "defillama";
  }
  if (
    normalized === "dexscreener"
  ) {
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

export function chooseIndependentOffchainDepegConfirmer(
  input: Pick<PrimaryPriceTrustInput, "agreeSources" | "priceSource">,
): OffchainDepegConfirmerKey | null {
  const primaryFamilies = getPrimaryDepegSourceFamilies(input);
  if (!primaryFamilies.has("coingecko")) return "coingecko-confirm";
  if (!primaryFamilies.has("defillama")) return "defillama-confirm";
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
  const policy = getDexTrustPolicy(tier);
  return (nowSec - row.updated_at) < policy.maxAgeSec && row.source_total_tvl >= policy.minTvlUsd;
}

export function hasFreshMultiSourcePrimaryAgreement(
  input: PrimaryPriceTrustInput,
  nowSec: number,
): boolean {
  if (input.price == null || !Number.isFinite(input.price) || input.price <= 0) {
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


export function classifyPrimaryDepegTrust(
  input: PrimaryPriceTrustInput,
  nowSec: number,
): DepegPrimaryTrust {
  if (input.price == null || !Number.isFinite(input.price) || input.price <= 0) {
    return "unusable";
  }

  const ageSec = getPrimaryPriceAgeSec(input, nowSec);
  const trustSources = getPrimaryTrustSources(input);

  if (
    input.priceSource === "cached" ||
    input.priceConfidence === "fallback" ||
    input.priceConfidence === "low" ||
    ageSec > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC
  ) {
    return "confirm_required";
  }

  if (input.priceConfidence === "single-source") {
    return trustSources.length === 1 && isSingleSourceDepegAuthoritative(trustSources[0], input.priceObservedAtMode)
      ? "authoritative"
      : "confirm_required";
  }

  if (input.priceConfidence === "high") {
    if (countDepegAuthoritativeSources(trustSources) >= 2) {
      return "authoritative";
    }

    if (hasUpstreamCapableDepegAuthoritativeSource(trustSources)) {
      return "authoritative";
    }
  }

  return "confirm_required";
}
