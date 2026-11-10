import type { DepegPrimaryTrust, PriceConfidence, PriceObservedAtMode } from "../types/core";
import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC } from "./depeg-config";
import { normalizePricingSourceKeys } from "./pricing-sources";
import { countDepegAuthoritativeSources, hasUpstreamCapableDepegAuthoritativeSource, isSingleSourceDepegAuthoritative, isObservedPrice } from "./pricing-source-policy";

export interface PrimaryPriceTrustInput {
  price?: number | null;
  priceSource?: string | null;
  priceConfidence?: PriceConfidence | null;
  priceUpdatedAt?: number | null;
  priceObservedAt?: number | null;
  priceObservedAtMode?: PriceObservedAtMode | null;
  agreeSources?: string[] | null;
}

export function getPrimaryPriceAgeSec(
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

export function getPrimaryTrustSources(input: Pick<PrimaryPriceTrustInput, "agreeSources" | "priceSource">): string[] {
  const sources = input.agreeSources && input.agreeSources.length > 0
    ? input.agreeSources
    : input.priceSource ?? "";
  return normalizePricingSourceKeys(sources);
}

export function classifyPrimaryDepegTrust(
  input: PrimaryPriceTrustInput,
  nowSec: number,
): DepegPrimaryTrust {
  if (!isObservedPrice(input) || input.price == null || !Number.isFinite(input.price) || input.price <= 0) {
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
