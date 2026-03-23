import {
  buildPriceValidationContext,
  isSevereFixedPegDownside,
  validatePriceCandidate,
  type PriceValidationContext,
  type PriceValidationReferences,
} from "../../lib/price-validation";
import { FIXED_PEG_SEVERE_DOWNSIDE_RATIO } from "../../lib/pricing-source-policy";
import type { PeggedAsset, PrimaryPriceResult } from "../enrich-prices";
import { stampPriceMetadata } from "./shared";
import { classifyPrimaryDepegTrust } from "../../lib/depeg-helpers";
import { hasDepegAuthoritativeSource } from "../../lib/pricing-source-policy";
import type { PriceCacheEntry } from "../../lib/db-cache";

export interface ValidationContextResolver {
  get: (asset: PeggedAsset) => PriceValidationContext;
}

export interface PublishablePriceDecision {
  accepted: boolean;
  reason: string;
}

export interface PreviousTrustedPrice {
  price: number;
  source: string | null;
  confidence: PeggedAsset["priceConfidence"];
  observedAt: number | null;
  agreeSources: string[];
}

export interface ValidatePublishablePriceInput {
  price: number;
  source: string | null | undefined;
  confidence: PeggedAsset["priceConfidence"];
  agreeSources?: string[];
  mode: "primary_authoritative" | "fallback_enrichment";
  validationContext: PriceValidationContext;
  validationReferences?: PriceValidationReferences;
  previousTrustedPrice?: PreviousTrustedPrice | null;
}

export type ValidatePublishablePrice = (
  input: ValidatePublishablePriceInput,
) => PublishablePriceDecision;

export interface ProtocolPriceOverride {
  price: number;
  source: string;
  confidence: PeggedAsset["priceConfidence"];
}

const WEAK_FIXED_PEG_JUMP_QUARANTINE_BPS = 2_000;

export function priceValidationModeForAsset(asset: PeggedAsset): "primary_authoritative" | "fallback_enrichment" {
  return asset.priceConfidence === "fallback" ||
    asset.priceSource === "defillama-contract" ||
    asset.priceSource === "coinmarketcap" ||
    asset.priceSource === "dexscreener" ||
    asset.priceSource === "cached"
    ? "fallback_enrichment"
    : "primary_authoritative";
}

export function createValidationContextResolver(): ValidationContextResolver {
  const cache = new Map<string, PriceValidationContext>();
  return {
    get(asset: PeggedAsset): PriceValidationContext {
      const key = String(asset.id);
      const existing = cache.get(key);
      if (existing) return existing;
      const context = buildPriceValidationContext({
        stablecoinId: key,
        pegType: asset.pegType as string | undefined,
        navToken: asset.navToken,
        commodityOunces: asset.commodityOunces,
      });
      cache.set(key, context);
      return context;
    },
  };
}

function allowsSevereDownsidePublication(input: {
  price: number;
  source: string | null | undefined;
  confidence: PeggedAsset["priceConfidence"];
  agreeSources?: string[];
  context: PriceValidationContext;
  references?: PriceValidationReferences;
  previousTrustedPrice?: PreviousTrustedPrice | null;
}): boolean {
  if (!isSevereFixedPegDownside(input.price, input.context, input.references, FIXED_PEG_SEVERE_DOWNSIDE_RATIO)) {
    return true;
  }

  if (input.source === "protocol-redeem" || input.source === "pool-tvl-weighted") {
    return true;
  }

  // Strong corroboration: multiple authoritative sources agree
  if (input.confidence === "high" && (input.agreeSources?.length ?? 0) >= 2) {
    return true;
  }

  // Previously confirmed depeg: if the last trusted price was also severely
  // depegged, the current candidate is consistent with a confirmed ongoing depeg.
  // Accept it to prevent price data gaps for genuinely depegged assets (e.g. USR
  // flapping between N/A and a valid price when source corroboration is intermittent).
  if (
    input.previousTrustedPrice &&
    isSevereFixedPegDownside(
      input.previousTrustedPrice.price,
      input.context,
      input.references,
      FIXED_PEG_SEVERE_DOWNSIDE_RATIO,
    )
  ) {
    return true;
  }

  return false;
}

function isFixedPegValidationContext(context: PriceValidationContext): boolean {
  return context.pegClass === "usd" || context.pegClass === "fiat_fx" || context.pegClass === "commodity";
}

function shouldQuarantineTemporalJump(input: ValidatePublishablePriceInput): boolean {
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
  if (hasAuthoritativeAgreement || input.source === "protocol-redeem" || input.source === "pool-tvl-weighted") {
    return false;
  }

  const mid = (input.price + previousTrustedPrice) / 2;
  if (mid <= 0) return false;
  const moveBps = Math.abs(input.price - previousTrustedPrice) / mid * 10_000;
  return moveBps >= WEAK_FIXED_PEG_JUMP_QUARANTINE_BPS;
}

export function validatePublishablePrice(input: ValidatePublishablePriceInput): PublishablePriceDecision {
  const decision = validatePriceCandidate(
    input.price,
    input.validationContext,
    input.mode,
    input.validationReferences,
  );
  if (!decision.accepted) {
    return { accepted: false, reason: decision.reasonCode };
  }

  if (!allowsSevereDownsidePublication({
    price: input.price,
    source: input.source,
    confidence: input.confidence,
    agreeSources: input.agreeSources,
    context: input.validationContext,
    references: input.validationReferences,
    previousTrustedPrice: input.previousTrustedPrice,
  })) {
    return { accepted: false, reason: "severe_downside_requires_corroboration" };
  }

  if (shouldQuarantineTemporalJump(input)) {
    return { accepted: false, reason: "temporal_jump_requires_corroboration" };
  }

  return { accepted: true, reason: decision.reasonCode };
}

export function buildDlListPrices(assets: PeggedAsset[]): Map<string, number> {
  const dlListPrices = new Map<string, number>();
  for (const asset of assets) {
    if (
      asset.price != null &&
      typeof asset.price === "number" &&
      Number.isFinite(asset.price) &&
      asset.price > 0
    ) {
      dlListPrices.set(asset.id, asset.price);
    }
  }
  return dlListPrices;
}

function stampExistingSingleSource(asset: PeggedAsset, syncStartSec: number): void {
  const source = asset.priceSource || "defillama";
  stampPriceMetadata(
    asset,
    source,
    "single-source",
    asset.priceObservedAt ?? asset.priceUpdatedAt ?? null,
    [source],
    [source],
    syncStartSec,
  );
}

export function buildPreviousTrustedPriceLookup(
  previousAssetsById: Map<string, PeggedAsset>,
  nowSec: number,
  replayPriceCache?: Map<string, PriceCacheEntry>,
): Map<string, PreviousTrustedPrice> {
  const lookup = new Map<string, PreviousTrustedPrice>();

  const maybeStoreCandidate = (
    assetId: string,
    candidate: {
      price: number | null | undefined;
      source: string | null | undefined;
      confidence: PeggedAsset["priceConfidence"] | undefined;
      observedAt: number | null | undefined;
      updatedAt: number | null | undefined;
      agreeSources: string[] | null | undefined;
    },
  ) => {
    if (classifyPrimaryDepegTrust({
      price: candidate.price,
      priceSource: candidate.source ?? null,
      priceConfidence: candidate.confidence ?? null,
      priceObservedAt: candidate.observedAt ?? candidate.updatedAt ?? null,
      priceUpdatedAt: candidate.updatedAt ?? candidate.observedAt ?? null,
      agreeSources: candidate.agreeSources ?? [],
    }, nowSec) !== "authoritative") {
      return;
    }

    if (candidate.price == null || typeof candidate.price !== "number" || !Number.isFinite(candidate.price) || candidate.price <= 0) {
      return;
    }

    const nextObservedAt = candidate.observedAt ?? candidate.updatedAt ?? null;
    const existingObservedAt = lookup.get(assetId)?.observedAt ?? null;
    if (
      existingObservedAt != null &&
      nextObservedAt != null &&
      existingObservedAt >= nextObservedAt
    ) {
      return;
    }

    lookup.set(assetId, {
      price: candidate.price,
      source: candidate.source ?? null,
      confidence: candidate.confidence ?? null,
      observedAt: nextObservedAt,
      agreeSources: candidate.agreeSources ?? [],
    });
  };

  for (const [assetId, asset] of previousAssetsById) {
    maybeStoreCandidate(assetId, {
      price: asset.price,
      source: asset.priceSource ?? null,
      confidence: asset.priceConfidence ?? null,
      observedAt: asset.priceObservedAt ?? asset.priceUpdatedAt ?? null,
      updatedAt: asset.priceUpdatedAt ?? asset.priceObservedAt ?? null,
      agreeSources: asset.agreeSources ?? [],
    });
  }

  if (replayPriceCache) {
    for (const [assetId, cached] of replayPriceCache) {
      maybeStoreCandidate(assetId, {
        price: cached.price,
        source: cached.source ?? null,
        confidence: cached.confidence ?? null,
        observedAt: cached.observedAt ?? cached.updatedAt,
        updatedAt: cached.updatedAt,
        agreeSources: cached.agreeSources ?? [],
      });
    }
  }

  return lookup;
}

export function applyPrimaryPriceResults(input: {
  assets: PeggedAsset[];
  primaryPriceResults: Map<string, PrimaryPriceResult>;
  previousTrustedPrices?: Map<string, PreviousTrustedPrice>;
  validationContexts: ValidationContextResolver;
  validationReferences?: PriceValidationReferences;
  syncStartSec: number;
  validatePublishablePrice: ValidatePublishablePrice;
}): void {
  const {
    assets,
    primaryPriceResults,
    previousTrustedPrices,
    validationContexts,
    validationReferences,
    syncStartSec,
    validatePublishablePrice: validate,
  } = input;

  for (const asset of assets) {
    const primary = primaryPriceResults.get(asset.id);
    if (primary) {
      const decision = validate({
        price: primary.price,
        source: primary.source,
        confidence: primary.confidence,
        agreeSources: primary.agreeSources,
        mode: "primary_authoritative",
        validationContext: validationContexts.get(asset),
        validationReferences,
        previousTrustedPrice: previousTrustedPrices?.get(asset.id) ?? null,
      });
      if (decision.accepted) {
        asset.price = primary.price;
        stampPriceMetadata(
          asset,
          primary.source,
          primary.confidence,
          primary.observedAt ?? null,
          primary.candidateSources,
          primary.agreeSources,
          syncStartSec,
        );
      } else if (asset.price != null && typeof asset.price === "number" && asset.price > 0) {
        console.warn(
          `[sync-stablecoins] Rejected primary consensus price for ${asset.symbol} (id=${asset.id}): ` +
          `$${primary.price} from ${primary.source} (${decision.reason})`,
        );
        stampExistingSingleSource(asset, syncStartSec);
      }
    } else if (asset.price != null && typeof asset.price === "number" && asset.price > 0) {
      stampExistingSingleSource(asset, syncStartSec);
    }

    if (!asset.supplySource) {
      asset.supplySource = "defillama";
    }
  }
}

export function prevalidatePrices(input: {
  assets: PeggedAsset[];
  previousTrustedPrices?: Map<string, PreviousTrustedPrice>;
  validationContexts: ValidationContextResolver;
  validationReferences?: PriceValidationReferences;
  validatePublishablePrice: ValidatePublishablePrice;
  modeResolver: (asset: PeggedAsset) => "primary_authoritative" | "fallback_enrichment";
  logLabel: string;
}): void {
  const {
    assets,
    previousTrustedPrices,
    validationContexts,
    validationReferences,
    validatePublishablePrice: validate,
    modeResolver,
    logLabel,
  } = input;

  for (const asset of assets) {
    if (asset.price == null || typeof asset.price !== "number" || asset.price === 0) continue;
    const decision = validate({
      price: asset.price,
      source: asset.priceSource,
      confidence: asset.priceConfidence ?? null,
      agreeSources: asset.agreeSources,
      mode: modeResolver(asset),
      validationContext: validationContexts.get(asset),
      validationReferences,
      previousTrustedPrice: previousTrustedPrices?.get(asset.id) ?? null,
    });
    if (!decision.accepted) {
      console.warn(
        `[sync-stablecoins] ${logLabel} for ${asset.symbol} (id=${asset.id}): ` +
        `$${asset.price} (${decision.reason})`,
      );
      asset.price = 0;
      stampPriceMetadata(asset, asset.priceSource || "unknown", null, null);
    }
  }
}

export function applyGtProbeResults(input: {
  assets: PeggedAsset[];
  primaryPriceResults: Map<string, PrimaryPriceResult>;
  previousTrustedPrices?: Map<string, PreviousTrustedPrice>;
  validationContexts: ValidationContextResolver;
  validationReferences?: PriceValidationReferences;
  syncStartSec: number;
  validatePublishablePrice: ValidatePublishablePrice;
}): void {
  const {
    assets,
    primaryPriceResults,
    previousTrustedPrices,
    validationContexts,
    validationReferences,
    syncStartSec,
    validatePublishablePrice: validate,
  } = input;

  for (const asset of assets) {
    const primary = primaryPriceResults.get(asset.id);
    if (!primary || !primary.candidateSources.includes("geckoterminal")) continue;

    const decision = validate({
      price: primary.price,
      source: primary.source,
      confidence: primary.confidence,
      agreeSources: primary.agreeSources,
      mode: "primary_authoritative",
      validationContext: validationContexts.get(asset),
      validationReferences,
      previousTrustedPrice: previousTrustedPrices?.get(asset.id) ?? null,
    });
    if (decision.accepted) {
      asset.price = primary.price;
      stampPriceMetadata(
        asset,
        primary.source,
        primary.confidence,
        primary.observedAt ?? null,
        primary.candidateSources,
        primary.agreeSources,
        syncStartSec,
      );
    } else {
      console.warn(
        `[sync-stablecoins] Rejected GT-probed price for ${asset.symbol} (id=${asset.id}): ` +
        `$${primary.price} from ${primary.source} (${decision.reason})`,
      );
    }
  }
}

export function applyProtocolPriceOverrides(input: {
  assets: PeggedAsset[];
  overrides: Map<string, ProtocolPriceOverride>;
  previousTrustedPrices?: Map<string, PreviousTrustedPrice>;
  validationContexts: ValidationContextResolver;
  validationReferences?: PriceValidationReferences;
  syncStartSec: number;
  validatePublishablePrice: ValidatePublishablePrice;
}): number {
  const {
    assets,
    overrides,
    previousTrustedPrices,
    validationContexts,
    validationReferences,
    syncStartSec,
    validatePublishablePrice: validate,
  } = input;

  let appliedCount = 0;
  for (const asset of assets) {
    const override = overrides.get(asset.id);
    if (!override) continue;

    const decision = validate({
      price: override.price,
      source: override.source,
      confidence: override.confidence,
      agreeSources: [override.source],
      mode: "primary_authoritative",
      validationContext: validationContexts.get(asset),
      validationReferences,
      previousTrustedPrice: previousTrustedPrices?.get(asset.id) ?? null,
    });
    if (!decision.accepted) {
      console.warn(
        `[sync-stablecoins] Rejected protocol-backed override for ${asset.symbol} (id=${asset.id}): ` +
        `$${override.price} (${decision.reason})`,
      );
      continue;
    }

    if (asset.price != null && asset.price > 0 && override.price > 0) {
      const divergenceBps = Math.abs(Math.round(((override.price / asset.price) - 1) * 10000));
      if (divergenceBps > 100) {
        console.warn(
          `[sync] Protocol override for ${asset.symbol} diverges ${divergenceBps}bps from consensus ` +
          `(override=$${override.price.toFixed(4)}, consensus=$${asset.price.toFixed(4)})`,
        );
      }
    }

    asset.price = override.price;
    stampPriceMetadata(asset, override.source, override.confidence, syncStartSec, [override.source], [override.source], syncStartSec);
    appliedCount++;
  }

  return appliedCount;
}
