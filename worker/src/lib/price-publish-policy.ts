import { isPricingSourceSoftGuardrailExempt } from "@shared/lib/pricing-source-registry";
import { isSevereFixedPegDownside, validatePriceCandidate, type PriceValidationContext, type PriceValidationDecision, type PriceValidationReferences } from "./price-validation";
import { FIXED_PEG_SEVERE_DOWNSIDE_RATIO, hasDepegAuthoritativeSource } from "./pricing-source-policy";
import type { PriceConfidence, PriceObservedAtMode } from "@shared/types/core";

const WEAK_FIXED_PEG_JUMP_QUARANTINE_BPS = 2_000;

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

function priceValidationModeForAsset(asset: PriceAssetPublicationLike): "primary_authoritative" | "fallback_enrichment" {
  return asset.priceConfidence === "fallback" ||
    asset.priceSource === "coingecko-native-implied" ||
    asset.priceSource === "defillama-contract" ||
    asset.priceSource === "coinmarketcap" ||
    asset.priceSource === "dexscreener" ||
    asset.priceSource === "cached"
    ? "fallback_enrichment"
    : "primary_authoritative";
}

function isFixedPegValidationContext(context: PriceValidationContext): boolean {
  return context.pegClass === "usd" || context.pegClass === "fiat_fx" || context.pegClass === "commodity";
}

function allowsSevereDownsidePublication(input: PublishablePriceInput): boolean {
  if (!isSevereFixedPegDownside(input.price, input.validationContext, input.validationReferences, FIXED_PEG_SEVERE_DOWNSIDE_RATIO)) {
    return true;
  }

  if (isPricingSourceSoftGuardrailExempt(input.source)) {
    return true;
  }

  if (input.confidence === "high" && (input.agreeSources?.length ?? 0) >= 2) {
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
  if (input.candidatePrices) {
    const severeCount = Object.values(input.candidatePrices).filter(
      (p) => typeof p === "number" && Number.isFinite(p) && p > 0 &&
        isSevereFixedPegDownside(p, input.validationContext, input.validationReferences, FIXED_PEG_SEVERE_DOWNSIDE_RATIO),
    ).length;
    if (severeCount >= 2) return true;
  }

  return false;
}

function shouldQuarantineTemporalJump(input: PublishablePriceInput): boolean {
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

  const mid = (input.price + previousTrustedPrice) / 2;
  if (mid <= 0) return false;
  const moveBps = Math.abs(input.price - previousTrustedPrice) / mid * 10_000;
  return moveBps >= WEAK_FIXED_PEG_JUMP_QUARANTINE_BPS;
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

  if (shouldQuarantineTemporalJump(input)) {
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

export function validatePublishedAssetPrice(input: {
  asset: {
    price?: number | null | undefined;
    priceSource?: string | null;
    priceConfidence?: PriceConfidence | null;
    agreeSources?: string[];
  };
  validationContext: PriceValidationContext;
  validationReferences?: PriceValidationReferences;
  previousTrustedPrice?: TrustedPriceReference | null;
}): PublishablePriceDecision {
  return validatePriceForPublication({
    price: input.asset.price ?? 0,
    source: input.asset.priceSource,
    confidence: input.asset.priceConfidence ?? null,
    agreeSources: input.asset.agreeSources,
    mode: priceValidationModeForAsset(input.asset),
    validationContext: input.validationContext,
    validationReferences: input.validationReferences,
    previousTrustedPrice: input.previousTrustedPrice,
  });
}
