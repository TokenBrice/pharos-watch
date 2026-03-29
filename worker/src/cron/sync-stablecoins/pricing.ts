import {
  buildPriceValidationContext,
  type PriceValidationContext,
  type PriceValidationReferences,
} from "../../lib/price-validation";
import type { PeggedAsset, PrimaryPriceResult } from "./enrich-prices";
import { clearPriceMetadata, stampPriceMetadata } from "./shared";
import { classifyPrimaryDepegTrust } from "../../lib/depeg-helpers";
import type { PriceCacheEntry } from "../../lib/db-cache";
import {
  type TrustedPriceReference,
  validatePrimaryPriceCandidate,
  validatePublishedAssetPrice,
} from "../../lib/price-publish-policy";

export interface ValidationContextResolver {
  get: (asset: PeggedAsset) => PriceValidationContext;
}

export type PreviousTrustedPrice = TrustedPriceReference;

export interface ProtocolPriceOverride {
  price: number;
  source: string;
  confidence: PeggedAsset["priceConfidence"];
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

export function buildDlListPrices(assets: PeggedAsset[]): Map<string, number> {
  const dlListPrices = new Map<string, number>();
  for (const asset of assets) {
    if (
      asset.supplySource !== "coingecko-fallback" &&
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
    asset.priceObservedAtMode ?? null,
    [source],
    [source],
    syncStartSec,
  );
}

interface ApplyPrimaryCandidateInput {
  asset: PeggedAsset;
  candidate: PrimaryPriceResult;
  previousTrustedPrice: PreviousTrustedPrice | null;
  validationContext: PriceValidationContext;
  validationReferences?: PriceValidationReferences;
  syncStartSec: number;
}

function applyPrimaryCandidate(input: ApplyPrimaryCandidateInput): string | null {
  const {
    asset,
    candidate,
    previousTrustedPrice,
    validationContext,
    validationReferences,
    syncStartSec,
  } = input;

  const decision = validatePrimaryPriceCandidate({
    price: candidate.price,
    source: candidate.source,
    confidence: candidate.confidence,
    agreeSources: candidate.agreeSources,
    validationContext,
    validationReferences,
    previousTrustedPrice,
  });
  if (!decision.accepted) {
    return decision.reason;
  }

  asset.price = candidate.price;
  stampPriceMetadata(
    asset,
    candidate.source,
    candidate.confidence,
    candidate.observedAt ?? null,
    candidate.observedAtMode ?? null,
    candidate.candidateSources,
    candidate.agreeSources,
    syncStartSec,
  );
  return null;
}

interface ApplyPriceResultForAssetInput {
  asset: PeggedAsset;
  primaryPriceResult: PrimaryPriceResult | undefined;
  previousTrustedPrice: PreviousTrustedPrice | null;
  validationContext: PriceValidationContext;
  validationReferences?: PriceValidationReferences;
  syncStartSec: number;
  rejectionLabel: string;
  requiredCandidateSource?: string;
  stampExistingWhenRejected?: boolean;
  stampExistingWhenMissing?: boolean;
}

function hasCurrentAssetPrice(asset: PeggedAsset): boolean {
  return asset.price != null && typeof asset.price === "number" && asset.price > 0;
}

function applyPriceResultForAsset(input: ApplyPriceResultForAssetInput): void {
  const {
    asset,
    primaryPriceResult,
    previousTrustedPrice,
    validationContext,
    validationReferences,
    syncStartSec,
    rejectionLabel,
    requiredCandidateSource,
    stampExistingWhenRejected = false,
    stampExistingWhenMissing = false,
  } = input;

  if (!primaryPriceResult) {
    if (stampExistingWhenMissing && hasCurrentAssetPrice(asset)) {
      stampExistingSingleSource(asset, syncStartSec);
    }
    return;
  }

  if (requiredCandidateSource && !primaryPriceResult.candidateSources.includes(requiredCandidateSource)) {
    return;
  }

  const rejectionReason = applyPrimaryCandidate({
    asset,
    candidate: primaryPriceResult,
    previousTrustedPrice,
    validationContext,
    validationReferences,
    syncStartSec,
  });
  if (!rejectionReason) return;

  console.warn(
    `[sync-stablecoins] Rejected ${rejectionLabel} for ${asset.symbol} (id=${asset.id}): ` +
      `$${primaryPriceResult.price} from ${primaryPriceResult.source} (${rejectionReason})`,
  );

  if (stampExistingWhenRejected && hasCurrentAssetPrice(asset)) {
    stampExistingSingleSource(asset, syncStartSec);
  }
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
      observedAtMode?: PeggedAsset["priceObservedAtMode"] | undefined;
      updatedAt: number | null | undefined;
      agreeSources: string[] | null | undefined;
    },
  ) => {
    if (classifyPrimaryDepegTrust({
      price: candidate.price,
      priceSource: candidate.source ?? null,
      priceConfidence: candidate.confidence ?? null,
      priceObservedAt: candidate.observedAt ?? candidate.updatedAt ?? null,
      priceObservedAtMode: candidate.observedAtMode ?? null,
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
      observedAtMode: candidate.observedAtMode ?? null,
      agreeSources: candidate.agreeSources ?? [],
    });
  };

  for (const [assetId, asset] of previousAssetsById) {
    maybeStoreCandidate(assetId, {
      price: asset.price,
      source: asset.priceSource ?? null,
      confidence: asset.priceConfidence ?? null,
      observedAt: asset.priceObservedAt ?? asset.priceUpdatedAt ?? null,
      observedAtMode: asset.priceObservedAtMode ?? null,
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
        observedAtMode: cached.observedAtMode ?? null,
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
}): void {
  const {
    assets,
    primaryPriceResults,
    previousTrustedPrices,
    validationContexts,
    validationReferences,
    syncStartSec,
  } = input;

  for (const asset of assets) {
    applyPriceResultForAsset({
      asset,
      primaryPriceResult: primaryPriceResults.get(asset.id),
      previousTrustedPrice: previousTrustedPrices?.get(asset.id) ?? null,
      validationContext: validationContexts.get(asset),
      validationReferences,
      syncStartSec,
      rejectionLabel: "primary consensus price",
      stampExistingWhenRejected: true,
      stampExistingWhenMissing: true,
    });

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
  logLabel: string;
}): void {
  const {
    assets,
    previousTrustedPrices,
    validationContexts,
    validationReferences,
    logLabel,
  } = input;

  for (const asset of assets) {
    if (asset.price == null || typeof asset.price !== "number" || asset.price === 0) continue;
    const decision = validatePublishedAssetPrice({
      asset,
      validationContext: validationContexts.get(asset),
      validationReferences,
      previousTrustedPrice: previousTrustedPrices?.get(asset.id) ?? null,
    });
    if (!decision.accepted) {
      console.warn(
        `[sync-stablecoins] ${logLabel} for ${asset.symbol} (id=${asset.id}): ` +
        `$${asset.price} (${decision.reason})`,
      );
      clearPriceMetadata(asset);
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
}): void {
  const {
    assets,
    primaryPriceResults,
    previousTrustedPrices,
    validationContexts,
    validationReferences,
    syncStartSec,
  } = input;

  for (const asset of assets) {
    applyPriceResultForAsset({
      asset,
      primaryPriceResult: primaryPriceResults.get(asset.id),
      previousTrustedPrice: previousTrustedPrices?.get(asset.id) ?? null,
      validationContext: validationContexts.get(asset),
      validationReferences,
      syncStartSec,
      rejectionLabel: "GT-probed price",
      requiredCandidateSource: "geckoterminal",
    });
  }
}

export function applyProtocolPriceOverrides(input: {
  assets: PeggedAsset[];
  overrides: Map<string, ProtocolPriceOverride>;
  previousTrustedPrices?: Map<string, PreviousTrustedPrice>;
  validationContexts: ValidationContextResolver;
  validationReferences?: PriceValidationReferences;
  syncStartSec: number;
}): number {
  const {
    assets,
    overrides,
    previousTrustedPrices,
    validationContexts,
    validationReferences,
    syncStartSec,
  } = input;

  let appliedCount = 0;
  for (const asset of assets) {
    const override = overrides.get(asset.id);
    if (!override) continue;

    const decision = validatePrimaryPriceCandidate({
      price: override.price,
      source: override.source,
      confidence: override.confidence,
      agreeSources: [override.source],
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
    stampPriceMetadata(asset, override.source, override.confidence, syncStartSec, "local_fetch", [override.source], [override.source], syncStartSec);
    appliedCount++;
  }

  return appliedCount;
}
