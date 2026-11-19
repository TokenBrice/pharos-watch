import { isSolomonPriceIdentityAllowed } from "./solomon-usdv-identity";
import {
  getPricingSourceRegistryEntry,
  isPricingSourceSoftGuardrailExempt,
} from "@shared/lib/pricing-source-registry";
import {
  FIXED_PEG_SEVERE_DOWNSIDE_RATIO,
  hasDepegAuthoritativeSource,
  isUncorroboratedDefiLlamaListFillQuote,
  isUncorroboratedDefiLlamaReferenceQuote,
  type DefiLlamaListFillDefaultQuote,
} from "@shared/lib/pricing-source-policy";
import { normalizePricingSourceKeys } from "@shared/lib/pricing-sources";
import { DIVERGENCE_THRESHOLD_BPS } from "@shared/lib/pricing-pipeline-constants";
import { pricesAgreeWithinBps } from "./price-divergence";
import { haveDisjointPriceInputs, type UpstreamKeysBySource } from "./price-consensus";
import {
  FIAT_UPPER_BAND_REQUIRES_CORROBORATION,
  getReferencePriceForContext,
  isFixedPegContext,
  isSevereFixedPegDownside,
  validatePriceCandidate,
  type PriceValidationContext,
  type PriceValidationDecision,
  type PriceValidationReferences,
} from "./price-validation";
import type { PriceConfidence, PriceObservedAtMode } from "@shared/types/price";

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
  upstreamKeysBySource?: UpstreamKeysBySource;
  fiatPremiumEvidence?: FiatPremiumEvidence;
  mode: "primary_authoritative" | "fallback_enrichment";
  validationContext: PriceValidationContext;
  validationReferences?: PriceValidationReferences;
  previousTrustedPrice?: TrustedPriceReference | null;
  /** Per-response DefiLlama list fill-default marker carried from intake. */
  listFillDefault?: DefiLlamaListFillDefaultQuote | null;
}

/** Dated USD candidates with all verified upstream price-formation identities. */
export type FiatPremiumEvidence = Readonly<Record<string, {
  priceUsd: number;
  observedAtSec: number;
  upstreamKeys: readonly string[];
} | undefined>>;

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
  if (!isFixedPegContext(input.validationContext)) return null;
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

function hasFiatPremiumCorroboration(input: PublishablePriceInput): boolean {
  const nowSec = Math.floor(Date.now() / 1000);
  const matchingQuotes = Object.entries(input.fiatPremiumEvidence ?? {}).flatMap(([source, quote]) => {
    const entry = getPricingSourceRegistryEntry(source);
    if (!quote || !entry || entry.isRetired || source === "mento-broker" ||
      (entry.trustTier !== "hard_market" && entry.trustTier !== "soft_dex" && source !== "curve-onchain") ||
      quote.priceUsd !== input.candidatePrices?.[source] ||
      !Number.isSafeInteger(quote.observedAtSec) || quote.observedAtSec <= 0 || quote.observedAtSec > nowSec ||
      nowSec - quote.observedAtSec >= (entry.maxTrustedAgeSec ?? 0) ||
      !pricesAgreeWithinBps(input.price, quote.priceUsd, DIVERGENCE_THRESHOLD_BPS)) return [];
    if (quote.upstreamKeys.length === 0 || quote.upstreamKeys.some((key) => !key || key !== key.trim())) return [];
    const upstream = new Set(quote.upstreamKeys);
    return [{ source, quote, upstream }];
  });
  const selectedSources = sourceParts(input.source);
  return matchingQuotes.some((selected) => selectedSources.includes(selected.source) &&
    matchingQuotes.some((other) => other.source !== selected.source &&
      [...other.upstream].every((key) => !selected.upstream.has(key)) &&
      pricesAgreeWithinBps(selected.quote.priceUsd, other.quote.priceUsd, DIVERGENCE_THRESHOLD_BPS)));
}

export function hasIndependentSevereCandidateCorroboration(
  input: Pick<PublishablePriceInput, "candidatePrices" | "upstreamKeysBySource" | "validationContext" | "validationReferences">,
  requireAuthoritative = false,
): boolean {
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

  const keys = input.upstreamKeysBySource;
  if (!keys) return hasIndependentSevereSourceFamilyCorroboration(severeSources);

  const candidates = severeSources.filter((source) => keys[source]?.length !== 0);
  return candidates.some((source, index) => candidates.slice(index + 1).some((other) =>
    hasIndependentSevereSourceFamilyCorroboration([source, other]) &&
    (!requireAuthoritative || hasDepegAuthoritativeSource([source, other])) &&
    haveDisjointPriceInputs({ upstreamKeys: keys[source] }, { upstreamKeys: keys[other] })));
}

function hasSevereDownsidePublicationCorroboration(input: PublishablePriceInput): boolean {
  if (!isSevereFixedPegDownside(input.price, input.validationContext, input.validationReferences, FIXED_PEG_SEVERE_DOWNSIDE_RATIO)) {
    return false;
  }

  if (isPricingSourceSoftGuardrailExempt(input.source)) {
    return true;
  }

  if (
    !input.upstreamKeysBySource &&
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
  if (!isFixedPegContext(input.validationContext)) return false;
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
  const needsFiatPremiumCorroboration = decision.reasonCode === FIAT_UPPER_BAND_REQUIRES_CORROBORATION;
  const corroboratedFiatPremium = needsFiatPremiumCorroboration && hasFiatPremiumCorroboration(input);
  if (!decision.accepted && !corroboratedFiatPremium) {
    return { ...base, accepted: false, reason: decision.reasonCode, gates: needsFiatPremiumCorroboration
      ? ["price-validation", "fiat-upper-band-corroboration"] : ["price-validation"] };
  }

  if (isUncorroboratedDefiLlamaReferenceQuote({
    price: input.price,
    referencePrice: base.referencePrice,
    sources: input.agreeSources && input.agreeSources.length > 0
      ? input.agreeSources
      : sourceParts(input.source),
  })) {
    return { ...base, accepted: false, reason: "exact_par_list_price_requires_corroboration", gates: ["price-validation", "exact-par-list-corroboration"] };
  }

  if (isUncorroboratedDefiLlamaListFillQuote({
    price: input.price,
    fillDefault: input.listFillDefault,
    sources: input.agreeSources && input.agreeSources.length > 0
      ? input.agreeSources
      : sourceParts(input.source),
  })) {
    return { ...base, accepted: false, reason: "list_fill_default_requires_corroboration", gates: ["price-validation", "list-fill-default-corroboration"] };
  }

  if (!allowsSevereDownsidePublication(input)) {
    return { ...base, accepted: false, reason: "severe_downside_requires_corroboration", gates: ["price-validation", "severe-downside-corroboration"] };
  }

  if (!allowsWeakFallbackFixedPegDepegPublication(input)) {
    return { ...base, accepted: false, reason: "weak_fallback_depeg_requires_corroboration", gates: ["price-validation", "fallback-depeg-corroboration"] };
  }

  if (!corroboratedFiatPremium && shouldWithholdTemporalJump(input)) {
    return { ...base, accepted: false, reason: "temporal_jump_requires_corroboration", gates: ["price-validation", "temporal-jump-corroboration"] };
  }

  return corroboratedFiatPremium
    ? { ...base, accepted: true, reason: "corroborated_fiat_premium", gates: ["price-validation", "fiat-upper-band-corroboration"] }
    : { ...base, accepted: true, reason: decision.reasonCode, gates: ["price-validation"] };
}

function validatePriceForPublication(input: PublishablePriceInput): PublishablePriceDecision {
  if (!isSolomonPriceIdentityAllowed(input.validationContext.stablecoinId, input.source, input.agreeSources)) {
    return { accepted: false, reason: "provider_identity_mismatch" };
  }
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
    priceListFillDefault?: DefiLlamaListFillDefaultQuote | null;
  };
  candidatePrices?: Record<string, number>;
  upstreamKeysBySource?: UpstreamKeysBySource;
  fiatPremiumEvidence?: FiatPremiumEvidence;
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
    upstreamKeysBySource: input.upstreamKeysBySource,
    fiatPremiumEvidence: input.fiatPremiumEvidence,
    mode: priceValidationModeForAsset(input.asset),
    validationContext: input.validationContext,
    validationReferences: input.validationReferences,
    previousTrustedPrice: input.previousTrustedPrice,
    listFillDefault: input.asset.priceListFillDefault ?? null,
  });
}
