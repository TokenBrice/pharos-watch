/**
 * Shared post-enrichment pipeline stages used by both the main DefiLlama
 * sync path and the CoinGecko supply fallback path.
 *
 * Extracted to eliminate code duplication (Q-002, Q-011, CC-001).
 */
import { isPricingSourceSoftGuardrailExempt } from "@shared/lib/pricing-source-registry";
import { splitCompositePriceSource } from "@shared/lib/pricing-sources";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins";
import { fetchAuthoritativeLivePriceOverrides } from "../../lib/authoritative-price-sources";
import { setCacheIfNewer, getPriceCache, savePriceCache } from "../../lib/db-cache";
import { validatePayloadWithSchema } from "../../lib/api-utils";
import { sendAlert } from "../../lib/alerts";
import { detectDepegEvents } from "../detect-depegs";
import { confirmPendingDepegs } from "../confirm-pending-depegs";
import { enrichMissingPrices, hasMissingPrice, type PrimaryPriceResult } from "./enrich-prices";
import type { PeggedAsset } from "./enrich-prices";
import {
  type PriceValidationContext,
  type PriceValidationReferences,
} from "../../lib/price-validation";
import {
  type TrustedPriceReference,
  validateFallbackPriceCandidate,
  validatePublishedAssetPrice,
} from "../../lib/price-publish-policy";
import {
  COINGECKO_NATIVE_IMPLIED_SOURCE,
  computePriceDivergenceBps,
  fetchCurrentNativePegImpliedUsdQuotes,
  NATIVE_PEG_PRICE_GUARD_MAX_DRIFT_BPS,
} from "../../lib/native-peg-implied-prices";
import {
  clearPriceMetadata,
  StablecoinListResponseSchema,
  normalizeStablecoinsPayload,
  stampPriceMetadata,
  summarizeValidationIssues,
  getStablecoinsCacheAgeSec,
  writeInvalidStablecoinsDiagnostic,
  type StablecoinsPayload,
  type CronResult,
} from "./shared";
import {
  countDepegAuthoritativeSources,
  getPriceCacheMaxAgeSec,
  isReplaySafePriceSource,
  isSingleSourceDepegAuthoritative,
} from "../../lib/pricing-source-policy";
import {
  applyAcceptedPriceCandidate,
  applyProtocolPriceOverrides,
  getPrimaryCandidatePricesForCurrentAsset,
  type ProtocolPriceOverride,
} from "./pricing";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";

const PRICE_CACHE_TTL = 6 * 60 * 60;

// ---------------------------------------------------------------------------
// Input / output interfaces
// ---------------------------------------------------------------------------

export interface PostEnrichmentInput {
  assets: PeggedAsset[];
  missingBefore: Set<string>;
  db: D1Database;
  syncStartSec: number;
  signal?: AbortSignal;
  coingeckoApiKey?: string | null;
  fxFallbackRates?: Record<string, number>;
  validationReferences?: PriceValidationReferences;
  validationContexts: { get: (asset: PeggedAsset) => PriceValidationContext };
  primaryPriceResults?: Map<string, PrimaryPriceResult>;
  previousTrustedPrices?: Map<string, TrustedPriceReference>;
  returnIfAborted: (signal: AbortSignal | undefined, stage: string) => CronResult | null;
  abortResult: (signal: AbortSignal | undefined, stage: string) => CronResult;
}

export interface PriceValidationResult {
  rejectedCount: number;
  cachedFallbackCount: number;
  nativePegCorrectionCount: number;
  nativePegFillCount: number;
}

export interface SharedPriceCompletionInput extends Omit<PostEnrichmentInput, "missingBefore"> {
  missingBefore: Set<string>;
  authoritativeOverrides?: Map<string, ProtocolPriceOverride>;
}

export interface SharedPriceCompletionResult extends PriceValidationResult {
  authoritativeOverrideCount: number;
}

export interface MissingPriceEnrichmentInput {
  assets: PeggedAsset[];
  db: D1Database;
  syncStartSec: number;
  signal?: AbortSignal;
  cmcApiKey?: string;
  returnIfAborted: (signal: AbortSignal | undefined, stage: string) => CronResult | null;
}

export interface MissingPriceEnrichmentResult {
  missingBefore: Set<string>;
  enrichStats: Awaited<ReturnType<typeof enrichMissingPrices>>;
}

export interface DepegPipelineResult {
  depegErrorCount: number;
  depegErrors: string[];
  providerDiagnostics: PricingProviderAttemptDiagnostic[];
}

export interface CacheValidationResult {
  /** Whether the schema validation succeeded and the cache was written. */
  written: boolean;
  /** Whether the write was skipped because a newer canonical cache already exists. */
  skippedBecauseNewer: boolean;
  cacheKey: string;
  syncStartSec: number;
  /** If validation failed, the degraded CronResult to return. */
  blockedResult?: CronResult;
}

// ---------------------------------------------------------------------------
// Stage 1: Post-enrichment price validation + price cache
// ---------------------------------------------------------------------------

/**
 * Runs the shared post-enrichment price pipeline:
 *   1. Reject unreasonable prices (so bad prices don't persist in cache)
 *   2. Save all valid prices to price_cache
 *   3. Apply cached fallback prices for assets still missing
 */
export async function runPostEnrichmentPricePipeline(
  input: PostEnrichmentInput,
  abortStagePrefix: string,
): Promise<PriceValidationResult | CronResult> {
  const {
    assets,
    db,
    signal,
    coingeckoApiKey,
    validationReferences,
    validationContexts,
    previousTrustedPrices,
    returnIfAborted,
  } = input;

  const getCurrentSourceParts = (asset: PeggedAsset): string[] => (
    asset.agreeSources && asset.agreeSources.length > 0
      ? asset.agreeSources
      : asset.priceSource
        ? splitCompositePriceSource(asset.priceSource)
        : []
  );

  const hasStrongNativePegBypassAuthority = (asset: PeggedAsset): boolean => {
    if (isPricingSourceSoftGuardrailExempt(asset.priceSource)) {
      return true;
    }

    const currentSourceParts = getCurrentSourceParts(asset);
    if (asset.priceConfidence === "single-source") {
      return currentSourceParts.length === 1 &&
        isSingleSourceDepegAuthoritative(currentSourceParts[0], asset.priceObservedAtMode);
    }

    if (asset.priceConfidence === "high") {
      return countDepegAuthoritativeSources(currentSourceParts) >= 2;
    }

    return false;
  };

  const nativePegHardeningCandidates = assets.filter((asset) => (
    validationContexts.get(asset).pegClass === "fiat_fx"
  ));

  const nativePegImpliedUsdQuotes = await fetchCurrentNativePegImpliedUsdQuotes(
    nativePegHardeningCandidates.map((asset) => {
      const meta = ACTIVE_META_BY_ID.get(asset.id);
      const validationContext = validationContexts.get(asset);
      return {
        stablecoinId: asset.id,
        geckoId: meta?.geckoId ?? asset.geckoId ?? null,
        pegCurrency: meta?.flags?.pegCurrency ?? null,
        pegType: validationContext.pegType ?? null,
      };
    }),
    validationReferences,
    signal,
    coingeckoApiKey,
  );

  // --- Reject unreasonable prices BEFORE caching ---
  let rejectedCount = 0;
  let nativePegCorrectionCount = 0;
  let nativePegFillCount = 0;
  for (const asset of assets) {
    const nativePegImpliedUsd = nativePegImpliedUsdQuotes.get(asset.id);
    const currentHasPrice = asset.price != null && typeof asset.price === "number";
    const currentHasStrongBypassAuthority = currentHasPrice && hasStrongNativePegBypassAuthority(asset);
    const nativePegDivergenceBps =
      currentHasPrice && nativePegImpliedUsd != null
        ? computePriceDivergenceBps(asset.price as number, nativePegImpliedUsd.priceUsd)
        : null;

    const tryApplyNativePegImpliedPrice = (reason: "fill" | "correction"): boolean => {
      if (nativePegImpliedUsd == null) return false;
      const nativeDecision = validatePublishedAssetPrice({
        asset: {
          price: nativePegImpliedUsd.priceUsd,
          priceSource: COINGECKO_NATIVE_IMPLIED_SOURCE,
          priceConfidence: "single-source",
          agreeSources: [COINGECKO_NATIVE_IMPLIED_SOURCE],
        },
        validationContext: validationContexts.get(asset),
        validationReferences,
        previousTrustedPrice: previousTrustedPrices?.get(asset.id) ?? null,
      });
      if (!nativeDecision.accepted) {
        const action = reason === "fill" ? "fill" : "correction";
        console.warn(
          `[sync-stablecoins] Skipped native-peg ${action} for ${asset.symbol} (id=${asset.id}): ` +
          `${nativeDecision.reason}`,
        );
        return false;
      }

      if (reason === "fill") {
        console.warn(
          `[sync-stablecoins] Filled missing non-USD fiat price for ${asset.symbol} (id=${asset.id}): ` +
          `$${nativePegImpliedUsd.priceUsd.toFixed(6)} via direct ${nativePegImpliedUsd.pegCurrency} quote`,
        );
        nativePegFillCount++;
      } else {
        console.warn(
          `[sync-stablecoins] Corrected weak non-USD fiat price for ${asset.symbol} (id=${asset.id}): ` +
          `$${asset.price} from ${asset.priceSource ?? "unknown"} -> $${nativePegImpliedUsd.priceUsd.toFixed(6)} ` +
          `via direct ${nativePegImpliedUsd.pegCurrency} quote (${nativePegDivergenceBps}bps divergence)`,
        );
        nativePegCorrectionCount++;
      }

      applyAcceptedPriceCandidate({
        asset,
        price: nativePegImpliedUsd.priceUsd,
        source: COINGECKO_NATIVE_IMPLIED_SOURCE,
        confidence: "single-source",
        observedAt: nativePegImpliedUsd.updatedAt,
        observedAtMode: "local_fetch",
        consensusSources: [COINGECKO_NATIVE_IMPLIED_SOURCE],
        agreeSources: [COINGECKO_NATIVE_IMPLIED_SOURCE],
        syncedAt: input.syncStartSec,
        selectedSource: COINGECKO_NATIVE_IMPLIED_SOURCE,
      });
      return true;
    };

    if (!currentHasPrice) {
      tryApplyNativePegImpliedPrice("fill");
    } else if (
      !currentHasStrongBypassAuthority &&
      nativePegImpliedUsd != null &&
      nativePegDivergenceBps != null &&
      nativePegDivergenceBps > NATIVE_PEG_PRICE_GUARD_MAX_DRIFT_BPS
    ) {
      tryApplyNativePegImpliedPrice("correction");
    }

    if (asset.price == null || typeof asset.price !== "number") continue;

    const decision = validatePublishedAssetPrice({
      asset: {
        ...asset,
        candidatePrices: getPrimaryCandidatePricesForCurrentAsset(asset, input.primaryPriceResults),
      },
      validationContext: validationContexts.get(asset),
      validationReferences,
      previousTrustedPrice: previousTrustedPrices?.get(asset.id) ?? null,
    });
    if (!decision.accepted) {
      console.warn(
        `[sync-stablecoins] Rejected unreasonable price for ${asset.symbol} (id=${asset.id}): ` +
        `$${asset.price} (${decision.reason})`,
      );
      clearPriceMetadata(asset);
      rejectedCount++;
    }
  }

  // --- Save replay-safe assets with valid prices to price_cache ---
  const withValidPrices = assets.filter(
    (asset) =>
      asset.price != null &&
      typeof asset.price === "number" &&
      asset.price > 0 &&
      asset.priceConfidence !== "fallback" &&
      asset.priceConfidence !== "low" &&
      isReplaySafePriceSource(asset.priceSource),
  );
  if (withValidPrices.length > 0) {
    const priceCacheWriteAbort = returnIfAborted(signal, `${abortStagePrefix}save-price-cache`);
    if (priceCacheWriteAbort) return priceCacheWriteAbort;
    await savePriceCache(db, withValidPrices.map((asset) => ({
      id: asset.id,
      price: asset.price! as number,
      source: asset.priceSource ?? null,
      confidence: asset.priceConfidence ?? null,
      observedAt: asset.priceObservedAt ?? asset.priceUpdatedAt ?? null,
      observedAtMode: asset.priceObservedAtMode ?? null,
      syncedAt: asset.priceSyncedAt ?? input.syncStartSec,
      agreeSources: asset.agreeSources ?? [],
      consensusSources: asset.consensusSources ?? [],
    })));
  }

  // --- Apply cached fallback prices for assets still missing ---
  const now = Math.floor(Date.now() / 1000);
  const stillMissing = assets.filter(
    (asset) => hasMissingPrice(asset),
  );
  let cachedFallbackCount = 0;
  if (stillMissing.length > 0) {
    const priceCacheReadAbort = returnIfAborted(signal, `${abortStagePrefix}read-price-cache`);
    if (priceCacheReadAbort) return priceCacheReadAbort;
    const priceCache = await getPriceCache(db);
    for (const asset of stillMissing) {
      const cached = priceCache.get(asset.id);
      if (!cached) continue;
      const maxAgeSec = getPriceCacheMaxAgeSec(cached.source, PRICE_CACHE_TTL);
      if (now - cached.updatedAt >= maxAgeSec) continue;
      const cachedAgreeSources =
        cached.agreeSources && cached.agreeSources.length > 0
          ? cached.agreeSources
          : cached.consensusSources && cached.consensusSources.length > 0
            ? cached.consensusSources
            : cached.source
              ? splitCompositePriceSource(cached.source)
              : [];
      const decision = validateFallbackPriceCandidate({
        price: cached.price,
        source: cached.source ?? "cached",
        confidence: cached.confidence ?? "fallback",
        agreeSources: cachedAgreeSources,
        validationContext: validationContexts.get(asset),
        validationReferences,
        previousTrustedPrice: previousTrustedPrices?.get(asset.id) ?? null,
      });
      if (!decision.accepted) continue;

      applyAcceptedPriceCandidate({
        asset,
        price: cached.price,
        source: "cached",
        confidence: "fallback",
        observedAt: cached.observedAt ?? cached.updatedAt,
        observedAtMode: cached.observedAtMode ?? null,
        consensusSources: cached.consensusSources,
        agreeSources: cached.agreeSources,
        syncedAt: cached.syncedAt ?? cached.updatedAt,
      });
      cachedFallbackCount++;
    }
  }

  return { rejectedCount, cachedFallbackCount, nativePegCorrectionCount, nativePegFillCount };
}

export async function runSharedPriceCompletion(
  input: SharedPriceCompletionInput,
  abortStagePrefix: string,
): Promise<SharedPriceCompletionResult | CronResult> {
  const authoritativeOverrides =
    input.authoritativeOverrides ?? await fetchAuthoritativeLivePriceOverrides(input.assets, input.signal);
  const authoritativeOverrideCount = applyProtocolPriceOverrides({
    assets: input.assets,
    overrides: authoritativeOverrides,
    previousTrustedPrices: input.previousTrustedPrices,
    validationContexts: input.validationContexts,
    validationReferences: input.validationReferences,
    syncStartSec: input.syncStartSec,
  });

  const priceResult = await runPostEnrichmentPricePipeline({
    ...input,
    missingBefore: input.missingBefore,
  }, abortStagePrefix);
  if (isAbortResult(priceResult)) return priceResult;

  return {
    authoritativeOverrideCount,
    ...priceResult,
  };
}

export async function runMissingPriceEnrichmentPhase(
  input: MissingPriceEnrichmentInput,
  abortStagePrefix: string,
): Promise<MissingPriceEnrichmentResult | CronResult> {
  const missingBefore = new Set(input.assets.filter(hasMissingPrice).map((asset) => asset.id));

  const enrichAbort = input.returnIfAborted(input.signal, `${abortStagePrefix}enrich-prices`);
  if (enrichAbort) return enrichAbort;
  const enrichStats = await enrichMissingPrices(input.assets, input.cmcApiKey, input.db, input.signal);

  for (const asset of input.assets) {
    if (missingBefore.has(asset.id) && !hasMissingPrice(asset) && !asset.priceConfidence) {
      stampPriceMetadata(asset, asset.priceSource || "unknown", "fallback", input.syncStartSec);
    }
  }

  return {
    missingBefore,
    enrichStats,
  };
}

// ---------------------------------------------------------------------------
// Stage 2: Validate, cache-write, depeg pipeline
// ---------------------------------------------------------------------------

export interface ValidateAndCacheInput {
  assets: PeggedAsset[];
  fxFallbackRates?: Record<string, number>;
  db: D1Database;
  syncStartSec: number;
  signal?: AbortSignal;
  alertWebhookUrl?: string | null;
  /** "main" or "fallback" — controls log messages and alert context */
  validationContext: "main" | "fallback";
  returnIfAborted: (signal: AbortSignal | undefined, stage: string) => CronResult | null;
  abortResult: (signal: AbortSignal | undefined, stage: string) => CronResult;
}

/**
 * Normalizes the payload, validates against the schema, and writes to the
 * stablecoins cache. Returns the CAS outcome on valid payloads or
 * `{ written: false, blockedResult }` on validation failure.
 */
export async function validateAndWriteStablecoinsCache(
  input: ValidateAndCacheInput,
  buildBlockedResult: (stablecoinsCacheAgeSec: number | null) => CronResult,
): Promise<CacheValidationResult | CronResult> {
  const {
    assets,
    fxFallbackRates,
    db,
    syncStartSec,
    signal,
    alertWebhookUrl,
    validationContext,
    returnIfAborted,
  } = input;

  const llamaData: StablecoinsPayload = { peggedAssets: assets, fxFallbackRates };
  const normalizedPayload = normalizeStablecoinsPayload(llamaData);
  const validationLabel = validationContext === "fallback"
    ? "sync-stablecoins:stablecoins:fallback"
    : "sync-stablecoins:stablecoins";
  const validation = validatePayloadWithSchema(
    StablecoinListResponseSchema,
    normalizedPayload,
    validationLabel,
  );

  if (!validation.ok) {
    const issueSummary = summarizeValidationIssues(validation.issues);
    const stablecoinsCacheAgeSec = await getStablecoinsCacheAgeSec(db);
    console.error(`[sync-stablecoins] Schema validation failed${validationContext === "fallback" ? " in CG fallback" : ""}; blocking stablecoins cache write:`, issueSummary);
    await sendAlert(
      alertWebhookUrl ?? null,
      "Stablecoins schema validation warning",
      `context=${validationContext}; blocked stablecoins cache write; issues=${issueSummary}; stablecoinsCacheAgeSec=${stablecoinsCacheAgeSec ?? "missing"}`,
    );
    await writeInvalidStablecoinsDiagnostic(
      db,
      syncStartSec,
      validationContext,
      normalizedPayload,
      validation.issues,
      stablecoinsCacheAgeSec,
    );
    return {
      written: false,
      skippedBecauseNewer: false,
      cacheKey: "stablecoins",
      syncStartSec,
      blockedResult: buildBlockedResult(stablecoinsCacheAgeSec),
    };
  }

  const cacheWriteAbort = returnIfAborted(signal, validationContext === "fallback" ? "fallback-cache-write" : "persist-main-cache");
  if (cacheWriteAbort) return cacheWriteAbort;
  const cacheResult = await setCacheIfNewer(db, "stablecoins", JSON.stringify(validation.data), syncStartSec);
  if (cacheResult.written) {
    console.log(`[sync-stablecoins] ${validationContext === "fallback" ? "CG fallback: cached" : "Cached"} ${assets.length} assets`);
  } else {
    console.log(
      `[sync-stablecoins] Skipped stablecoins cache write; newer canonical cache already exists ` +
      `(syncStartSec=${syncStartSec})`,
    );
  }

  return {
    ...cacheResult,
    cacheKey: "stablecoins",
    syncStartSec,
  };
}

// ---------------------------------------------------------------------------
// Stage 3: Depeg detection + confirmation
// ---------------------------------------------------------------------------

/**
 * Runs depeg detection and pending depeg confirmation. Errors are caught
 * and counted rather than propagated — the sync pipeline should not fail
 * because depeg detection failed.
 */
export async function runDepegPipeline(
  db: D1Database,
  assets: PeggedAsset[],
  fxFallbackRates: Record<string, number> | undefined,
  signal: AbortSignal | undefined,
  coingeckoApiKey: string | null | undefined,
  returnIfAborted: (signal: AbortSignal | undefined, stage: string) => CronResult | null,
  abortResult: (signal: AbortSignal | undefined, stage: string) => CronResult,
  abortStagePrefix: string,
  logContext: string,
): Promise<DepegPipelineResult | CronResult> {
  let depegErrorCount = 0;
  const depegErrors: string[] = [];
  const providerDiagnostics: PricingProviderAttemptDiagnostic[] = [];

  try {
    const depegAbort = returnIfAborted(signal, `${abortStagePrefix}depeg-detection`);
    if (depegAbort) return depegAbort;
    await detectDepegEvents(db, assets, fxFallbackRates, signal, coingeckoApiKey);
  } catch (err) {
    if (signal?.aborted) return abortResult(signal, `${abortStagePrefix}depeg-detection`);
    console.error(`[sync-stablecoins] Depeg detection failed${logContext}:`, err);
    depegErrorCount++;
    depegErrors.push(`detection: ${String(err).slice(0, 200)}`);
  }

  try {
    const confirmAbort = returnIfAborted(signal, `${abortStagePrefix}depeg-confirmation`);
    if (confirmAbort) return confirmAbort;
    const confirmation = await confirmPendingDepegs(db, assets, fxFallbackRates, signal, coingeckoApiKey);
    if (confirmation?.providerDiagnostics?.length) {
      providerDiagnostics.push(...confirmation.providerDiagnostics);
    }
  } catch (err) {
    if (signal?.aborted) return abortResult(signal, `${abortStagePrefix}depeg-confirmation`);
    console.error(`[sync-stablecoins] Pending depeg confirmation failed${logContext}:`, err);
    depegErrorCount++;
    depegErrors.push(`confirmation: ${String(err).slice(0, 200)}`);
  }

  return { depegErrorCount, depegErrors, providerDiagnostics };
}

/** Type guard: true when the pipeline returned a CronResult (abort). */
export function isAbortResult(result: unknown): result is CronResult {
  return (
    typeof result === "object" &&
    result !== null &&
    "metadata" in result &&
    !("rejectedCount" in result) &&
    !("depegErrorCount" in result) &&
    !("written" in result)
  );
}
