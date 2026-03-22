/**
 * Shared post-enrichment pipeline stages used by both the main DefiLlama
 * sync path and the CoinGecko supply fallback path.
 *
 * Extracted to eliminate code duplication (Q-002, Q-011, CC-001).
 */
import { setCacheIfNewer, getPriceCache, savePriceCache } from "../../lib/db-cache";
import { validatePayloadWithSchema } from "../../lib/api-utils";
import { sendAlert } from "../../lib/alerts";
import { detectDepegEvents } from "../detect-depegs";
import { confirmPendingDepegs } from "../confirm-pending-depegs";
import { hasMissingPrice } from "../enrich-prices";
import type { PeggedAsset } from "../enrich-prices";
import {
  type PriceValidationContext,
  type PriceValidationReferences,
} from "../../lib/price-validation";
import {
  StablecoinListResponseSchema,
  normalizeStablecoinsPayload,
  stampPriceMetadata,
  summarizeValidationIssues,
  getStablecoinsCacheAgeSec,
  writeInvalidStablecoinsDiagnostic,
  type StablecoinsPayload,
  type CronResult,
} from "./shared";
import { isReplaySafePriceSource } from "../../lib/pricing-source-policy";
import type { PreviousTrustedPrice } from "./pricing";

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
  fxFallbackRates?: Record<string, number>;
  validationReferences?: PriceValidationReferences;
  validationContexts: { get: (asset: PeggedAsset) => PriceValidationContext };
  previousTrustedPrices?: Map<string, PreviousTrustedPrice>;
  priceValidationModeForAsset: (asset: PeggedAsset) => "primary_authoritative" | "fallback_enrichment";
  validatePublishablePrice: (input: {
    price: number;
    source: string | null | undefined;
    confidence: PeggedAsset["priceConfidence"];
    agreeSources?: string[];
    mode: "primary_authoritative" | "fallback_enrichment";
    validationContext: PriceValidationContext;
    validationReferences?: PriceValidationReferences;
    previousTrustedPrice?: PreviousTrustedPrice | null;
  }) => { accepted: boolean; reason: string };
  returnIfAborted: (signal: AbortSignal | undefined, stage: string) => CronResult | null;
  abortResult: (signal: AbortSignal | undefined, stage: string) => CronResult;
}

export interface PriceValidationResult {
  rejectedCount: number;
  cachedFallbackCount: number;
}

export interface DepegPipelineResult {
  depegErrorCount: number;
  depegErrors: string[];
}

export interface CacheValidationResult {
  /** Whether the schema validation succeeded and the cache was written. */
  written: boolean;
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
    missingBefore,
    db,
    signal,
    validationReferences,
    validationContexts,
    previousTrustedPrices,
    priceValidationModeForAsset,
    validatePublishablePrice,
    returnIfAborted,
  } = input;

  // --- Reject unreasonable prices BEFORE caching ---
  let rejectedCount = 0;
  for (const asset of assets) {
    if (asset.price == null || typeof asset.price !== "number") continue;
    const decision = validatePublishablePrice({
      price: asset.price,
      source: asset.priceSource,
      confidence: asset.priceConfidence ?? null,
      agreeSources: asset.agreeSources,
      mode: priceValidationModeForAsset(asset),
      validationContext: validationContexts.get(asset),
      validationReferences,
      previousTrustedPrice: previousTrustedPrices?.get(asset.id) ?? null,
    });
    if (!decision.accepted) {
      console.warn(
        `[sync-stablecoins] Rejected unreasonable price for ${asset.symbol} (id=${asset.id}): ` +
        `$${asset.price} (${decision.reason})`,
      );
      asset.price = null;
      asset.priceUpdatedAt = null;
      asset.priceObservedAt = null;
      asset.priceSyncedAt = null;
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
      syncedAt: asset.priceSyncedAt ?? input.syncStartSec,
      agreeSources: asset.agreeSources ?? [],
      consensusSources: asset.consensusSources ?? [],
    })));
  }

  // --- Apply cached fallback prices for assets still missing ---
  const now = Math.floor(Date.now() / 1000);
  const stillMissing = assets.filter(
    (asset) => missingBefore.has(asset.id) && hasMissingPrice(asset),
  );
  let cachedFallbackCount = 0;
  if (stillMissing.length > 0) {
    const priceCacheReadAbort = returnIfAborted(signal, `${abortStagePrefix}read-price-cache`);
    if (priceCacheReadAbort) return priceCacheReadAbort;
    const priceCache = await getPriceCache(db);
    for (const asset of stillMissing) {
      const cached = priceCache.get(asset.id);
      if (!cached || (now - cached.updatedAt) >= PRICE_CACHE_TTL) continue;
      const decision = validatePublishablePrice({
        price: cached.price,
        source: "cached",
        confidence: "fallback",
        agreeSources: ["cached"],
        mode: "fallback_enrichment",
        validationContext: validationContexts.get(asset),
        validationReferences,
        previousTrustedPrice: previousTrustedPrices?.get(asset.id) ?? null,
      });
      if (!decision.accepted) continue;

      asset.price = cached.price;
      stampPriceMetadata(
        asset,
        "cached",
        "fallback",
        cached.observedAt ?? cached.updatedAt,
        cached.consensusSources,
        cached.agreeSources,
        cached.syncedAt ?? cached.updatedAt,
      );
      cachedFallbackCount++;
    }
  }

  return { rejectedCount, cachedFallbackCount };
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
 * stablecoins cache. Returns `{ written: true }` on success or
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
    return { written: false, blockedResult: buildBlockedResult(stablecoinsCacheAgeSec) };
  }

  const cacheWriteAbort = returnIfAborted(signal, validationContext === "fallback" ? "fallback-cache-write" : "persist-main-cache");
  if (cacheWriteAbort) return cacheWriteAbort;
  await setCacheIfNewer(db, "stablecoins", JSON.stringify(validation.data), syncStartSec);
  console.log(`[sync-stablecoins] ${validationContext === "fallback" ? "CG fallback: cached" : "Cached"} ${assets.length} assets`);

  return { written: true };
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

  try {
    const depegAbort = returnIfAborted(signal, `${abortStagePrefix}depeg-detection`);
    if (depegAbort) return depegAbort;
    await detectDepegEvents(db, assets, fxFallbackRates, signal);
  } catch (err) {
    if (signal?.aborted) return abortResult(signal, `${abortStagePrefix}depeg-detection`);
    console.error(`[sync-stablecoins] Depeg detection failed${logContext}:`, err);
    depegErrorCount++;
    depegErrors.push(`detection: ${String(err).slice(0, 200)}`);
  }

  try {
    const confirmAbort = returnIfAborted(signal, `${abortStagePrefix}depeg-confirmation`);
    if (confirmAbort) return confirmAbort;
    await confirmPendingDepegs(db, assets, fxFallbackRates, signal, coingeckoApiKey);
  } catch (err) {
    if (signal?.aborted) return abortResult(signal, `${abortStagePrefix}depeg-confirmation`);
    console.error(`[sync-stablecoins] Pending depeg confirmation failed${logContext}:`, err);
    depegErrorCount++;
    depegErrors.push(`confirmation: ${String(err).slice(0, 200)}`);
  }

  return { depegErrorCount, depegErrors };
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
