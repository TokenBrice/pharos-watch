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

export interface ValidationContextResolver {
  get: (asset: PeggedAsset) => PriceValidationContext;
}

export interface PublishablePriceDecision {
  accepted: boolean;
  reason: string;
}

export interface ValidatePublishablePriceInput {
  price: number;
  source: string | null | undefined;
  confidence: PeggedAsset["priceConfidence"];
  agreeSources?: string[];
  mode: "primary_authoritative" | "fallback_enrichment";
  validationContext: PriceValidationContext;
  validationReferences?: PriceValidationReferences;
}

export type ValidatePublishablePrice = (
  input: ValidatePublishablePriceInput,
) => PublishablePriceDecision;

export interface ProtocolPriceOverride {
  price: number;
  source: string;
  confidence: PeggedAsset["priceConfidence"];
}

export function priceValidationModeForAsset(asset: PeggedAsset): "primary_authoritative" | "fallback_enrichment" {
  return asset.priceConfidence === "fallback" ||
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
}): boolean {
  if (!isSevereFixedPegDownside(input.price, input.context, input.references, FIXED_PEG_SEVERE_DOWNSIDE_RATIO)) {
    return true;
  }

  if (input.source === "protocol-redeem" || input.source === "pool-tvl-weighted") {
    return true;
  }

  return input.confidence === "high" && (input.agreeSources?.length ?? 0) >= 2;
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
  })) {
    return { accepted: false, reason: "severe_downside_requires_corroboration" };
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
  stampPriceMetadata(asset, source, "single-source", syncStartSec, [source], [source]);
}

export function applyPrimaryPriceResults(input: {
  assets: PeggedAsset[];
  primaryPriceResults: Map<string, PrimaryPriceResult>;
  validationContexts: ValidationContextResolver;
  validationReferences?: PriceValidationReferences;
  syncStartSec: number;
  validatePublishablePrice: ValidatePublishablePrice;
}): void {
  const {
    assets,
    primaryPriceResults,
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
      });
      if (decision.accepted) {
        asset.price = primary.price;
        stampPriceMetadata(asset, primary.source, primary.confidence, syncStartSec, primary.candidateSources, primary.agreeSources);
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
  validationContexts: ValidationContextResolver;
  validationReferences?: PriceValidationReferences;
  validatePublishablePrice: ValidatePublishablePrice;
  modeResolver: (asset: PeggedAsset) => "primary_authoritative" | "fallback_enrichment";
  logLabel: string;
}): void {
  const {
    assets,
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
  validationContexts: ValidationContextResolver;
  validationReferences?: PriceValidationReferences;
  syncStartSec: number;
  validatePublishablePrice: ValidatePublishablePrice;
}): void {
  const {
    assets,
    primaryPriceResults,
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
    });
    if (decision.accepted) {
      asset.price = primary.price;
      stampPriceMetadata(asset, primary.source, primary.confidence, syncStartSec, primary.candidateSources, primary.agreeSources);
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
  validationContexts: ValidationContextResolver;
  validationReferences?: PriceValidationReferences;
  syncStartSec: number;
  validatePublishablePrice: ValidatePublishablePrice;
}): number {
  const {
    assets,
    overrides,
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
    stampPriceMetadata(asset, override.source, override.confidence, syncStartSec, [override.source], [override.source]);
    appliedCount++;
  }

  return appliedCount;
}
