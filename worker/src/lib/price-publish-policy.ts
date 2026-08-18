import {
  getPricingSourceRegistryEntry,
  isPricingSourceSoftGuardrailExempt,
} from "@shared/lib/pricing-source-registry";
import { FIXED_PEG_SEVERE_DOWNSIDE_RATIO, hasDepegAuthoritativeSource } from "@shared/lib/pricing-source-policy";
import { normalizePricingSourceKeys } from "@shared/lib/pricing-sources";
import { getReferencePriceForContext, isSevereFixedPegDownside, validatePriceCandidate, type PriceValidationContext, type PriceValidationDecision, type PriceValidationReferences } from "./price-validation";
import type { PriceConfidence, PriceObservedAtMode } from "@shared/types/core";

const WEAK_FIXED_PEG_JUMP_WITHHOLD_BPS = 2_000;
const WEAK_FALLBACK_FIXED_PEG_DEPEG_BPS = 500;

export interface TrustedPriceReference {
  price: number;
  source: string | null;
  confidence: PriceConfidence | null;
  observedAt: number | null;
  observedAtMode?: PriceObservedAtMode | null;
  agreeSources: string[];
}

export interface PublishablePriceDecision {
  accepted: boolean;
  reason: string;
}

interface PricePublicationDecision extends PublishablePriceDecision {
  referenceType: PriceValidationDecision["referenceType"];
  referencePrice: PriceValidationDecision["referencePrice"];
  candidateRatio: PriceValidationDecision["candidateRatio"];
  boundsUsed: PriceValidationDecision["boundsUsed"];
  gates: string[];
}

export interface PublishablePriceInput {
  price: number;
  source: string | null | undefined;
  confidence: PriceConfidence | null | undefined;
  agreeSources?: string[];
  candidatePrices?: Record<string, number>;
  mode: "primary_authoritative" | "fallback_enrichment";
  validationContext: PriceValidationContext;
  validationReferences?: PriceValidationReferences;
  previousTrustedPrice?: TrustedPriceReference | null;
}

export interface PriceAssetPublicationLike {
  priceConfidence?: PriceConfidence | null;
  priceSource?: string | null;
}

function isFallbackOnlyPublicationSource(source: string | null | undefined): boolean {
  if (!source) return false;
  if (source === "dexscreener") return true;
  const parts = normalizePricingSourceKeys(source);
  return parts.length > 0 && parts.every((part) => {
    if (part === "coingecko-native-implied" || part === "defillama-contract") return true;
    const trustTier = getPricingSourceRegistryEntry(part)?.trustTier;
    return trustTier === "fallback_search" || trustTier === "cached_replay";
  });
}

function priceValidationModeForAsset(asset: PriceAssetPublicationLike): "primary_authoritative" | "fallback_enrichment" {
  return asset.priceConfidence === "fallback" || isFallbackOnlyPublicationSource(asset.priceSource)
    ? "fallback_enrichment"
    : "primary_authoritative";
}

function isFixedPegValidationContext(context: PriceValidationContext): boolean {
  return context.pegClass === "usd" || context.pegClass === "fiat_fx" || context.pegClass === "commodity";
}

function sourceLineageFamily(source: string): string | null {
  const entry = getPricingSourceRegistryEntry(source);
  if (!entry) return null;

  return entry.depegSourceFamily;
}

function sourceParts(source: string | null | undefined): string[] {
  return normalizePricingSourceKeys(source);
}

function isFallbackSearchOnlySource(source: string | null | undefined): boolean {
  const parts = sourceParts(source);
  return parts.length > 0 && parts.every((part) => {
    const trustTier = getPricingSourceRegistryEntry(part)?.trustTier;
    return trustTier === "fallback_search";
  });
}

function fixedPegDeviationBps(input: PublishablePriceInput): number | null {
  if (!isFixedPegValidationContext(input.validationContext)) return null;
  const referencePrice = getReferencePriceForContext(input.validationContext, input.validationReferences);
  if (referencePrice == null || !Number.isFinite(referencePrice) || referencePrice <= 0) return null;
  return Math.abs(input.price - referencePrice) / referencePrice * 10_000;
}

function countIndependentSevereSourceFamilies(sources: string[]): {
  independentFamilyCount: number;
  allListAggregators: boolean;
} {
  const families = new Set<string>();
  let sawSource = false;
  let allListAggregators = true;

  for (const source of normalizePricingSourceKeys(sources)) {
    const entry = getPricingSourceRegistryEntry(source);
    const family = sourceLineageFamily(source);
    if (!entry || !family) continue;
    sawSource = true;
    families.add(family);
    allListAggregators = allListAggregators && !!entry.isListAggregator;
  }

  return {
    independentFamilyCount: families.size,
    allListAggregators: sawSource && allListAggregators,
  };
}

function hasIndependentSevereSourceFamilyCorroboration(sources: string[]): boolean {
  const { independentFamilyCount, allListAggregators } = countIndependentSevereSourceFamilies(sources);
  return independentFamilyCount >= 2 && !allListAggregators;
}

function hasIndependentSevereCandidateCorroboration(input: PublishablePriceInput): boolean {
  if (!input.candidatePrices) return false;

  const severeSources = Object.entries(input.candidatePrices)
    .filter(([, price]) => (
      typeof price === "number" &&
      Number.isFinite(price) &&
      price > 0 &&
      isSevereFixedPegDownside(
        price,
        input.validationContext,
        input.validationReferences,
        FIXED_PEG_SEVERE_DOWNSIDE_RATIO,
      )
    ))
    .map(([source]) => source);

  return hasIndependentSevereSourceFamilyCorroboration(severeSources);
}

function hasSevereDownsidePublicationCorroboration(input: PublishablePriceInput): boolean {
  if (!isSevereFixedPegDownside(input.price, input.validationContext, input.validationReferences, FIXED_PEG_SEVERE_DOWNSIDE_RATIO)) {
    return false;
  }

  if (isPricingSourceSoftGuardrailExempt(input.source)) {
    return true;
  }

  if (
    input.confidence === "high" &&
    hasIndependentSevereSourceFamilyCorroboration(
      input.agreeSources && input.agreeSources.length > 0
        ? input.agreeSources
        : sourceParts(input.source),
    )
  ) {
    return true;
  }

  if (
    input.previousTrustedPrice &&
    isSevereFixedPegDownside(
      input.previousTrustedPrice.price,
      input.validationContext,
      input.validationReferences,
      FIXED_PEG_SEVERE_DOWNSIDE_RATIO,
    )
  ) {
    return true;
  }

  // Directional corroboration: if 2+ independent candidate sources independently
  // confirm severe downside, the depeg is real even without a tight-cluster consensus.
  if (hasIndependentSevereCandidateCorroboration(input)) return true;

  return false;
}

function allowsSevereDownsidePublication(input: PublishablePriceInput): boolean {
  if (!isSevereFixedPegDownside(input.price, input.validationContext, input.validationReferences, FIXED_PEG_SEVERE_DOWNSIDE_RATIO)) {
    return true;
  }

  return hasSevereDownsidePublicationCorroboration(input);
}

function allowsWeakFallbackFixedPegDepegPublication(input: PublishablePriceInput): boolean {
  if (!isFallbackSearchOnlySource(input.source)) return true;
  if (isPricingSourceSoftGuardrailExempt(input.source)) return true;
  if (hasDepegAuthoritativeSource(input.agreeSources ?? sourceParts(input.source))) return true;
  if (
    isSevereFixedPegDownside(
      input.price,
      input.validationContext,
      input.validationReferences,
      FIXED_PEG_SEVERE_DOWNSIDE_RATIO,
    ) &&
    hasIndependentSevereCandidateCorroboration(input)
  ) {
    return true;
  }

  const deviationBps = fixedPegDeviationBps(input);
  return deviationBps == null || deviationBps < WEAK_FALLBACK_FIXED_PEG_DEPEG_BPS;
}

export function shouldWithholdTemporalJump(input: PublishablePriceInput): boolean {
  if (!isFixedPegValidationContext(input.validationContext)) return false;
  const previousTrustedPrice = input.previousTrustedPrice?.price;
  if (previousTrustedPrice == null || !Number.isFinite(previousTrustedPrice) || previousTrustedPrice <= 0) {
    return false;
  }

  const authoritativeSources = input.agreeSources && input.agreeSources.length > 0
    ? input.agreeSources
    : input.source
      ? [input.source]
      : [];
  const hasAuthoritativeAgreement =
    (input.confidence === "high" || input.confidence === "single-source") &&
    hasDepegAuthoritativeSource(authoritativeSources);
  if (hasAuthoritativeAgreement || isPricingSourceSoftGuardrailExempt(input.source)) {
    return false;
  }
  if (
    isSevereFixedPegDownside(input.price, input.validationContext, input.validationReferences, FIXED_PEG_SEVERE_DOWNSIDE_RATIO) &&
    hasSevereDownsidePublicationCorroboration(input)
  ) {
    return false;
  }

  const mid = (input.price + previousTrustedPrice) / 2;
  if (mid <= 0) return false;
  const moveBps = Math.abs(input.price - previousTrustedPrice) / mid * 10_000;
  return moveBps >= WEAK_FIXED_PEG_JUMP_WITHHOLD_BPS;
}

function evaluatePriceForPublication(input: PublishablePriceInput): PricePublicationDecision {
  const decision = validatePriceCandidate(
    input.price,
    input.validationContext,
    input.mode,
    input.validationReferences,
  );
  const base = {
    referenceType: decision.referenceType,
    referencePrice: decision.referencePrice,
    candidateRatio: decision.candidateRatio,
    boundsUsed: decision.boundsUsed,
  };
  if (!decision.accepted) {
    return { ...base, accepted: false, reason: decision.reasonCode, gates: ["price-validation"] };
  }

  if (!allowsSevereDownsidePublication(input)) {
    return { ...base, accepted: false, reason: "severe_downside_requires_corroboration", gates: ["price-validation", "severe-downside-corroboration"] };
  }

  if (!allowsWeakFallbackFixedPegDepegPublication(input)) {
    return { ...base, accepted: false, reason: "weak_fallback_depeg_requires_corroboration", gates: ["price-validation", "fallback-depeg-corroboration"] };
  }

  if (shouldWithholdTemporalJump(input)) {
    return { ...base, accepted: false, reason: "temporal_jump_requires_corroboration", gates: ["price-validation", "temporal-jump-corroboration"] };
  }

  return { ...base, accepted: true, reason: decision.reasonCode, gates: ["price-validation"] };
}

function validatePriceForPublication(input: PublishablePriceInput): PublishablePriceDecision {
  const decision = evaluatePriceForPublication(input);
  return { accepted: decision.accepted, reason: decision.reason };
}

export function validatePrimaryPriceCandidate(
  input: Omit<PublishablePriceInput, "mode">,
): PublishablePriceDecision {
  return validatePriceForPublication({ ...input, mode: "primary_authoritative" });
}

export function validateFallbackPriceCandidate(
  input: Omit<PublishablePriceInput, "mode">,
): PublishablePriceDecision {
  return validatePriceForPublication({ ...input, mode: "fallback_enrichment" });
}

/**
 * `candidatePrices` is a separate argument (not a field on `asset`) so callers
 * validating a full pipeline asset can pass it by reference instead of
 * shallow-copying every asset just to attach the candidate map.
 */
export function validatePublishedAssetPrice(input: {
  asset: {
    price?: number | null | undefined;
    priceSource?: string | null;
    priceConfidence?: PriceConfidence | null;
    agreeSources?: string[];
  };
  candidatePrices?: Record<string, number>;
  validationContext: PriceValidationContext;
  validationReferences?: PriceValidationReferences;
  previousTrustedPrice?: TrustedPriceReference | null;
}): PublishablePriceDecision {
  return validatePriceForPublication({
    price: input.asset.price ?? 0,
    source: input.asset.priceSource,
    confidence: input.asset.priceConfidence ?? null,
    agreeSources: input.asset.agreeSources,
    candidatePrices: input.candidatePrices,
    mode: priceValidationModeForAsset(input.asset),
    validationContext: input.validationContext,
    validationReferences: input.validationReferences,
    previousTrustedPrice: input.previousTrustedPrice,
  });
}
