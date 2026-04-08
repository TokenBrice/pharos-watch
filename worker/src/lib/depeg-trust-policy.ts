import type { PegRateSource } from "@shared/lib/peg-rates";
import type { DepegPrimaryTrust, PriceConfidence, PriceObservedAtMode } from "@shared/types/core";
import {
  DEPEG_PRIMARY_PRICE_MAX_AGE_SEC,
  DEX_FRESHNESS_SEC,
  DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD,
  DEX_PRICE_CHECK_FRESHNESS_SEC,
  DEX_PRICE_CHECK_UI_MIN_TVL_USD,
} from "./constants";
import { splitCompositePriceSource } from "@shared/lib/pricing-sources";
import {
  countDepegAuthoritativeSources,
  hasUpstreamCapableDepegAuthoritativeSource,
  isSingleSourceDepegAuthoritative,
} from "./pricing-source-policy";

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

interface PegReferenceTrustInput {
  pegCurrency?: string | null;
  pegType?: string | null;
  pegRateSource?: PegRateSource | null;
  pegRateContributorCount?: number | null;
}

function getPrimaryPriceAgeSec(
  input: Pick<PrimaryPriceTrustInput, "priceObservedAt" | "priceUpdatedAt">,
  nowSec: number,
): number {
  return typeof input.priceObservedAt === "number" && Number.isFinite(input.priceObservedAt)
    ? Math.max(0, nowSec - input.priceObservedAt)
    : typeof input.priceUpdatedAt === "number" && Number.isFinite(input.priceUpdatedAt)
      ? Math.max(0, nowSec - input.priceUpdatedAt)
      : Number.POSITIVE_INFINITY;
}

function getPrimaryTrustSources(input: Pick<PrimaryPriceTrustInput, "agreeSources" | "priceSource">): string[] {
  return input.agreeSources && input.agreeSources.length > 0
    ? input.agreeSources
    : splitCompositePriceSource(input.priceSource ?? "");
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

  return getPrimaryTrustSources(input).length >= 2;
}

export function isAuthoritativeDepegPegReference(input: PegReferenceTrustInput): boolean {
  if (!input.pegType || input.pegType === "peggedUSD") {
    return true;
  }

  const pegCurrency = input.pegCurrency ?? null;
  if (
    pegCurrency == null ||
    pegCurrency === "USD" ||
    pegCurrency === "VAR" ||
    pegCurrency === "OTHER" ||
    pegCurrency === "GOLD" ||
    pegCurrency === "SILVER"
  ) {
    return true;
  }

  return input.pegRateSource === "fallback" || (input.pegRateContributorCount ?? 0) >= 3;
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
