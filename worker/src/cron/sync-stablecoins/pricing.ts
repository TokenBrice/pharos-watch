import { isSolomonPriceIdentityAllowed } from "../../lib/solomon-usdv-identity";
import { logWorkerEventArgs } from "../../lib/structured-log";
import { relativeBps } from "@shared/lib/depeg-signals";
import {
  buildPriceValidationContext,
  type PriceValidationContext,
  type PriceValidationReferences,
} from "../../lib/price-validation";
import type { PeggedAsset, PrimaryPriceResult } from "./enrich-prices-shared";
import { clearPriceMetadata, stampPriceMetadata } from "./shared";
import { classifyPrimaryDepegTrust } from "../../lib/depeg-trust-policy";
import { isPricingSourceProtocolOverride } from "@shared/lib/pricing-source-registry";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { normalizePricingSourceKeys } from "@shared/lib/pricing-sources";
import type { NominalPriceReference } from "@shared/types/core";
import type { PriceCacheEntry } from "../../lib/db-cache";
import type { DlListQuote } from "../../lib/primary-price-collector";
import {
  type TrustedPriceReference,
  validatePrimaryPriceCandidate,
  validatePublishedAssetPrice,
} from "../../lib/price-publish-policy";
import type { AuthoritativeLivePriceOverrideStats } from "../../lib/authoritative-price-sources";
import {
  getRegistryLivePriceDiagnosticTarget,
  type NominalFxProvenance,
} from "../../lib/authoritative-price-sources/helpers";
import {
  appendPricingAssetAttempts,
  createPricingAssetAttempt,
} from "../../lib/pricing-provider-diagnostics";
import { validateCompositePricingSourceFreshness } from "../../lib/pricing-source-freshness";

const MAX_AUTHORITATIVE_PUBLICATION_ASSET_ATTEMPTS = 512;

export function recordProtocolPriceOverridePublicationRejection(input: {
  asset: PeggedAsset;
  override: ProtocolPriceOverride;
  authoritativeOverrideStats?: AuthoritativeLivePriceOverrideStats;
  syncStartSec: number;
  reason: string;
}): void {
  const { asset, override, authoritativeOverrideStats, syncStartSec, reason } = input;
  if (!authoritativeOverrideStats) return;

  const target = getRegistryLivePriceDiagnosticTarget(asset.id);
  appendPricingAssetAttempts(
    authoritativeOverrideStats.assetAttempts,
    [
      createPricingAssetAttempt({
        assetId: asset.id,
        adapter: override.source,
        source: override.source,
        ...(target ?? {}),
        state: "attempted",
        result: "rejected",
        rejectionClass: reason,
        candidateAt: syncStartSec,
        observedAt: override.observedAt ?? null,
      }),
    ],
    MAX_AUTHORITATIVE_PUBLICATION_ASSET_ATTEMPTS,
  );
}

export interface ValidationContextResolver {
  get: (asset: PeggedAsset) => PriceValidationContext;
}

export type PreviousTrustedPrice = TrustedPriceReference;

export interface ProtocolPriceOverride {
  price: number;
  source: string;
  confidence: PeggedAsset["priceConfidence"];
  observedAt?: number | null;
  observedAtMode?: PeggedAsset["priceObservedAtMode"];
  nominalFx?: NominalFxProvenance;
}

export interface AcceptedPriceCandidate {
  asset: PeggedAsset;
  price: number;
  source: string;
  confidence: PeggedAsset["priceConfidence"];
  observedAt: number | null;
  observedAtMode?: PeggedAsset["priceObservedAtMode"];
  consensusSources?: string[];
  agreeSources?: string[];
  syncedAt?: number | null;
  selectedSource?: string | null;
  sourceConfidenceProfile?: PeggedAsset["priceSourceConfidenceProfile"];
}

export function applyAcceptedPriceCandidate(input: AcceptedPriceCandidate): void {
  input.asset.price = input.price;
  stampPriceMetadata(
    input.asset,
    input.source,
    input.confidence,
    input.observedAt,
    input.observedAtMode,
    input.consensusSources,
    input.agreeSources,
    input.syncedAt,
    input.selectedSource,
    input.sourceConfidenceProfile,
  );
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

export function buildDlListPrices(assets: PeggedAsset[]): Map<string, DlListQuote> {
  const dlListPrices = new Map<string, DlListQuote>();
  for (const asset of assets) {
    if (
      asset.supplySource !== "coingecko-fallback" &&
      asset.price != null &&
      typeof asset.price === "number" &&
      Number.isFinite(asset.price) &&
      asset.price > 0
    ) {
      dlListPrices.set(asset.id, {
        price: asset.price,
        observedAt: asset.priceObservedAt ?? asset.priceUpdatedAt ?? null,
        observedAtMode: asset.priceObservedAtMode ?? "unknown",
      });
    }
  }
  return dlListPrices;
}

function stampExistingSingleSource(asset: PeggedAsset, syncStartSec: number): void {
  const source = asset.priceSource || "defillama";
  // Carried-forward prices already needed an original timestamp in the restore
  // helpers; `supplyRestored` marks carried supply, so an undated current-run
  // list quote on a carried-supply row keeps its registry semantics here.
  if (!validateCompositePricingSourceFreshness({
    source,
    observedAt: asset.priceObservedAt ?? asset.priceUpdatedAt,
    observedAtMode: asset.priceObservedAtMode,
    nowSec: syncStartSec,
  }).accepted) {
    clearPriceMetadata(asset);
    return;
  }
  stampPriceMetadata(
    asset,
    source,
    asset.priceConfidence === "fallback" ? "fallback" : "single-source",
    asset.priceObservedAt ?? asset.priceUpdatedAt ?? null,
    asset.priceObservedAtMode ?? null,
    [source],
    [source],
    syncStartSec,
    asset.priceSelectedSource ?? source,
    null,
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
    candidatePrices: candidate.allPrices,
    validationContext,
    validationReferences,
    previousTrustedPrice,
  });
  if (!decision.accepted) {
    return decision.reason;
  }

  applyAcceptedPriceCandidate({
    asset,
    price: candidate.price,
    source: candidate.source,
    confidence: candidate.confidence,
    observedAt: candidate.observedAt ?? null,
    observedAtMode: candidate.observedAtMode ?? null,
    consensusSources: candidate.candidateSources,
    agreeSources: candidate.agreeSources,
    syncedAt: syncStartSec,
    selectedSource: candidate.selectedSource ?? candidate.source,
    sourceConfidenceProfile: candidate.priceSourceConfidenceProfile ?? null,
  });
  return null;
}

function hasCurrentAssetPrice(asset: PeggedAsset): boolean {
  return asset.price != null && typeof asset.price === "number" && asset.price > 0;
}

export function getPrimaryCandidatePricesForCurrentAsset(
  asset: PeggedAsset,
  primaryPriceResults?: Map<string, PrimaryPriceResult>,
): Record<string, number> | undefined {
  if (!primaryPriceResults || !hasCurrentAssetPrice(asset)) return undefined;

  const primaryPriceResult = primaryPriceResults.get(asset.id);
  if (!primaryPriceResult?.allPrices) return undefined;
  if (asset.priceSource !== primaryPriceResult.source) return undefined;
  if (asset.priceConfidence !== primaryPriceResult.confidence) return undefined;

  const currentPrice = asset.price as number;
  const tolerance = Math.max(1e-12, Math.abs(primaryPriceResult.price) * 1e-9);
  if (Math.abs(currentPrice - primaryPriceResult.price) > tolerance) return undefined;

  return primaryPriceResult.allPrices;
}

export function getPostEnrichmentCandidatePricesForCurrentAsset(
  asset: PeggedAsset,
  primaryPriceResults?: Map<string, PrimaryPriceResult>,
): Record<string, number> | undefined {
  const primaryPriceResult = primaryPriceResults?.get(asset.id);
  if (
    asset.priceConfidence === "fallback" &&
    hasCurrentAssetPrice(asset) &&
    asset.priceSource &&
    primaryPriceResult?.allPrices
  ) {
    return {
      ...primaryPriceResult.allPrices,
      [asset.priceSource]: asset.price as number,
    };
  }

  return getPrimaryCandidatePricesForCurrentAsset(asset, primaryPriceResults);
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
    if (!isSolomonPriceIdentityAllowed(assetId, candidate.source, candidate.agreeSources ?? [])) return;
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

export function prevalidatePrices(input: {
  assets: PeggedAsset[];
  primaryPriceResults?: Map<string, PrimaryPriceResult>;
  previousTrustedPrices?: Map<string, PreviousTrustedPrice>;
  validationContexts: ValidationContextResolver;
  validationReferences?: PriceValidationReferences;
  logLabel: string;
}): void {
  const {
    assets,
    primaryPriceResults,
    previousTrustedPrices,
    validationContexts,
    validationReferences,
    logLabel,
  } = input;

  for (const asset of assets) {
    if (asset.price == null || typeof asset.price !== "number" || asset.price === 0) continue;
    const decision = validatePublishedAssetPrice({
      asset,
      candidatePrices: getPrimaryCandidatePricesForCurrentAsset(asset, primaryPriceResults),
      validationContext: validationContexts.get(asset),
      validationReferences,
      previousTrustedPrice: previousTrustedPrices?.get(asset.id) ?? null,
    });
    if (!decision.accepted) {
      logWorkerEventArgs("handler", "warn",
        `[sync-stablecoins] ${logLabel} for ${asset.symbol} (id=${asset.id}): ` +
        `$${asset.price} (${decision.reason})`,
      );
      clearPriceMetadata(asset);
    }
  }
}

/**
 * Applies primary consensus results to assets.
 *
 * Full primary pass: retains existing prices only within their source freshness
 * budget using the original observation, and defaults `supplySource` to `"defillama"`.
 */
export function applyConsensusResults(input: {
  assets: PeggedAsset[];
  primaryPriceResults: Map<string, PrimaryPriceResult>;
  previousTrustedPrices?: Map<string, PreviousTrustedPrice>;
  validationContexts: ValidationContextResolver;
  validationReferences?: PriceValidationReferences;
  syncStartSec: number;
  reason: "primary";
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
    const primaryPriceResult = primaryPriceResults.get(asset.id);

    if (!primaryPriceResult) {
      if (hasCurrentAssetPrice(asset)) {
        stampExistingSingleSource(asset, syncStartSec);
      }
    } else {
      const rejectionReason = applyPrimaryCandidate({
        asset,
        candidate: primaryPriceResult,
        previousTrustedPrice: previousTrustedPrices?.get(asset.id) ?? null,
        validationContext: validationContexts.get(asset),
        validationReferences,
        syncStartSec,
      });

      if (rejectionReason) {
        logWorkerEventArgs("handler", "warn",
          `[sync-stablecoins] Rejected primary consensus price for ${asset.symbol} (id=${asset.id}): ` +
            `$${primaryPriceResult.price} from ${primaryPriceResult.source} (${rejectionReason})`,
        );

        if (hasCurrentAssetPrice(asset)) {
          stampExistingSingleSource(asset, syncStartSec);
        }
      }
    }

    if (!asset.supplySource) {
      asset.supplySource = "defillama";
    }
  }
}

/**
 * DEC-02 trusted-market admission. The incumbent wins over a nominal reference
 * only when the depeg detector itself would act on it without confirmation:
 * `classifyPrimaryDepegTrust === "authoritative"`. That requires an observed
 * price within `DEPEG_PRIMARY_PRICE_MAX_AGE_SEC`, not cached/fallback/low, and
 * source authority from the registry: at `high` confidence two depeg-authoritative
 * sources or one upstream-timestamped depeg-authoritative source; at
 * `single-source` a registry source allowed to stand alone with an upstream
 * observation time. Soft aggregators (CoinGecko, DefiLlama, CMC) are never
 * depeg-authoritative, so their agreement alone cannot displace par, and
 * protocol or nominal provenance is never a market quote.
 */
export function isTrustedMarketQuote(asset: PeggedAsset, nowSec: number): boolean {
  if (!hasCurrentAssetPrice(asset)) return false;
  const sources = normalizePricingSourceKeys([...(asset.agreeSources ?? []), asset.priceSource]);
  if (sources.some(isPricingSourceProtocolOverride)) return false;
  return classifyPrimaryDepegTrust(asset, nowSec) === "authoritative";
}

/** Publishes par explicitly as a nominal reference: no observation clock, no confidence, no consensus. */
function publishNominalPriceReference(asset: PeggedAsset, reference: NominalPriceReference, syncStartSec: number): void {
  asset.price = reference.price;
  asset.priceSource = reference.source;
  asset.priceSelectedSource = reference.source;
  asset.priceConfidence = null;
  asset.priceObservedAt = null;
  asset.priceObservedAtMode = "nominal_reference";
  asset.priceUpdatedAt = null;
  asset.priceSyncedAt = syncStartSec;
  asset.consensusSources = [];
  asset.agreeSources = [];
  asset.priceSourceConfidenceProfile = null;
}

/**
 * Applies protocol-backed live overrides. Nominal par overrides
 * (`observedAtMode: "nominal_reference"`) never become observed prices: each
 * sets the asset's `nominalPriceReference`, and the reference is published as
 * the price only while no trusted market quote is admitted
 * (`isTrustedMarketQuote`). References and nominal prices are derived from this
 * pass only: an asset without an accepted nominal override loses any carried
 * reference and any carried nominal price.
 */
export function applyProtocolPriceOverrides(input: {
  assets: PeggedAsset[];
  overrides: Map<string, ProtocolPriceOverride>;
  previousTrustedPrices?: Map<string, PreviousTrustedPrice>;
  validationContexts: ValidationContextResolver;
  validationReferences?: PriceValidationReferences;
  syncStartSec: number;
  authoritativeOverrideStats?: AuthoritativeLivePriceOverrideStats;
}): number {
  const {
    assets,
    overrides,
    previousTrustedPrices,
    validationContexts,
    validationReferences,
    syncStartSec,
    authoritativeOverrideStats,
  } = input;

  let appliedCount = 0;
  for (const asset of assets) {
    const override = overrides.get(asset.id);
    delete asset.nominalPriceReference;
    if (hasCurrentAssetPrice(asset) && !isObservedPrice(asset)) clearPriceMetadata(asset);
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
      recordProtocolPriceOverridePublicationRejection({
        asset,
        override,
        authoritativeOverrideStats,
        syncStartSec,
        reason: decision.reason,
      });
      logWorkerEventArgs("handler", "warn",
        `[sync-stablecoins] Rejected protocol-backed override for ${asset.symbol} (id=${asset.id}): ` +
        `$${override.price} (${decision.reason})`,
      );
      continue;
    }

    const trustedMarket = isTrustedMarketQuote(asset, syncStartSec);
    if (asset.price != null && asset.price > 0 && override.price > 0) {
      const divergenceBps = relativeBps(override.price, asset.price)!.absBps;
      if (divergenceBps > 100) {
        logWorkerEventArgs("handler", "warn",
          `[sync] Protocol override for ${asset.symbol} diverges ${divergenceBps}bps from ` +
          `${trustedMarket ? "trusted market quote (market published)" : "consensus"} ` +
          `(override=$${override.price.toFixed(4)}, consensus=$${asset.price.toFixed(4)})`,
        );
      }
    }

    if (override.observedAtMode === "nominal_reference") {
      asset.nominalPriceReference = {
        price: override.price,
        source: override.source,
        mode: "nominal_reference",
        ...override.nominalFx,
      };
      if (trustedMarket) continue;
      publishNominalPriceReference(asset, asset.nominalPriceReference, syncStartSec);
      appliedCount++;
      continue;
    }

    applyAcceptedPriceCandidate({
      asset,
      price: override.price,
      source: override.source,
      confidence: override.confidence,
      observedAt: override.observedAt ?? syncStartSec,
      observedAtMode: override.observedAtMode ?? "local_fetch",
      consensusSources: [override.source],
      agreeSources: [override.source],
      syncedAt: syncStartSec,
      selectedSource: override.source,
      sourceConfidenceProfile: null,
    });
    appliedCount++;
  }

  return appliedCount;
}

/**
 * Final DEC-02 precedence after post-enrichment validation and cached fallback:
 * an asset carrying this run's nominal reference publishes it unless its
 * current price is still a trusted market quote. A rejected market quote, or a
 * cached/fallback fill, never displaces par.
 */
export function settleNominalPriceReferences(assets: PeggedAsset[], syncStartSec: number): void {
  for (const asset of assets) {
    const reference = asset.nominalPriceReference;
    if (!reference || asset.priceObservedAtMode === "nominal_reference") continue;
    if (isTrustedMarketQuote(asset, syncStartSec)) continue;
    publishNominalPriceReference(asset, reference, syncStartSec);
  }
}
