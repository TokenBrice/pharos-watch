import type { ChainRpcConfig } from "../../lib/chain-registry";
import { logWorkerEventArgs } from "../../lib/structured-log";
/**
 * Shared post-enrichment pipeline stages used by both the main DefiLlama
 * sync path and the CoinGecko supply fallback path.
 *
 * Extracted to eliminate code duplication (Q-002, Q-011, CC-001).
 */
import { getPricingSourceRegistryEntry, isPricingSourceSoftGuardrailExempt } from "@shared/lib/pricing-source-registry";
import { DIVERGENCE_THRESHOLD_BPS } from "@shared/lib/pricing-pipeline-constants";
import { pricesAgreeWithinBps } from "../../lib/price-divergence";
import { loadPriceCorroborationObservations, type PriceObservationEffectiveness } from "./price-corroboration-observations";
import {
  countDepegAuthoritativeSources,
  getPriceCacheMaxAgeSec,
  isReplaySafePriceSource,
  isSingleSourceDepegAuthoritative,
} from "@shared/lib/pricing-source-policy";
import { splitCompositePriceSource } from "@shared/lib/pricing-sources";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  type AuthoritativeLivePriceOverrideStats,
  fetchAuthoritativeLivePriceOverrides,
} from "../../lib/authoritative-price-sources";
import type { PriceCacheEntry, PriceCacheWriteEntry } from "../../lib/db-cache";
import { detectDepegEvents } from "../detect-depegs";
import { confirmPendingDepegs } from "../confirm-pending-depegs";
import type {
  DepegHoldReason,
  DepegObservationCensus,
  DepegObservationUnavailableReason,
} from "../depeg-detection/types";
import {
  hasMissingPrice,
  type PrimaryPriceResult,
} from "./enrich-prices";
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
import type { NativePegQuoteSession } from "../../lib/native-peg-quotes";
import {
  clearPriceMetadata,
  type CronResult,
} from "./shared";
import {
  applyAcceptedPriceCandidate,
  applyProtocolPriceOverrides,
  getPostEnrichmentCandidatePricesForCurrentAsset,
  recordProtocolPriceOverridePublicationRejection,
  settleNominalPriceReferences,
  type ProtocolPriceOverride,
} from "./pricing";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import type { BinanceFetchSession } from "../../lib/cex-tickers";
import { abortResult, returnIfAborted } from "./runtime";

const PRICE_CACHE_TTL = 6 * 60 * 60;

// ---------------------------------------------------------------------------
// Input / output interfaces
// ---------------------------------------------------------------------------

export interface PostEnrichmentInput {
  assets: PeggedAsset[];
  db: D1Database;
  syncStartSec: number;
  signal?: AbortSignal;
  coingeckoApiKey?: string | null;
  fxFallbackRates?: Record<string, number>;
  validationReferences?: PriceValidationReferences;
  validationContexts: { get: (asset: PeggedAsset) => PriceValidationContext };
  primaryPriceResults?: Map<string, PrimaryPriceResult>;
  previousTrustedPrices?: Map<string, TrustedPriceReference>;
  authoritativeOverrides: Map<string, ProtocolPriceOverride>;
  authoritativeOverrideStats: AuthoritativeLivePriceOverrideStats;
  /** The same replay snapshot used to establish trusted-price continuity. */
  priceCache: ReadonlyMap<string, PriceCacheEntry>;
  nativePegSession?: NativePegQuoteSession;
}

export interface PriceValidationResult {
  priceObservationEffectiveness?: PriceObservationEffectiveness;
  rejectedCount: number;
  cachedFallbackCount: number;
  nativePegCorrectionCount: number;
  nativePegFillCount: number;
  priceCacheEntries: PriceCacheWriteEntry[];
  providerDiagnostics: PricingProviderAttemptDiagnostic[];
}

export interface SharedPriceCompletionInput extends PostEnrichmentInput {
  chainRpcs?: Map<string, ChainRpcConfig>;
  previousMissingGenerationsById?: ReadonlyMap<string, number>;
}

export interface SharedPriceCompletionResult extends PriceValidationResult {
  authoritativeOverrideCount: number;
  authoritativeOverrideStats: AuthoritativeLivePriceOverrideStats;
}


export interface DepegPipelineResult {
  depegErrorCount: number;
  depegErrors: string[];
  depegHeldReason?: DepegHoldReason;
  /** Null when detection stopped before a census existed; the reason names why. */
  depegObservation: DepegObservationCensus | null;
  depegObservationUnavailableReason?: DepegObservationUnavailableReason;
  providerDiagnostics: PricingProviderAttemptDiagnostic[];
}


// ---------------------------------------------------------------------------
// Stage 1: Post-enrichment price validation + price cache
// ---------------------------------------------------------------------------

/**
 * Runs the shared post-enrichment price pipeline:
 *   1. Reject unreasonable prices (so bad prices don't persist in cache)
 *   2. Stage valid replay-safe prices for price_cache after canonical publication
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
    nativePegSession,
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

  const providerDiagnostics: PricingProviderAttemptDiagnostic[] = [];
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
    { diagnostics: providerDiagnostics, stage: "fallback" },
    nativePegSession,
  );

  // --- Reject unreasonable prices BEFORE caching ---
  let rejectedCount = 0;
  let nativePegCorrectionCount = 0;
  let nativePegFillCount = 0;
  const nativePegMaxTrustedAgeSec =
    getPricingSourceRegistryEntry(COINGECKO_NATIVE_IMPLIED_SOURCE)?.maxTrustedAgeSec ?? null;
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
      // The lane's own registry budget is the admission gate; the shared fetch
      // uses the wider depeg budget for its different consumers.
      if (nativePegMaxTrustedAgeSec == null
        || input.syncStartSec - nativePegImpliedUsd.updatedAt > nativePegMaxTrustedAgeSec) {
        logWorkerEventArgs("handler", "warn",
          `[sync-stablecoins] Skipped native-peg ${reason} for ${asset.symbol} (id=${asset.id}): ` +
          `quote is ${input.syncStartSec - nativePegImpliedUsd.updatedAt}s old, budget ${nativePegMaxTrustedAgeSec ?? "unknown"}s`,
        );
        return false;
      }
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
        logWorkerEventArgs("handler", "warn",
          `[sync-stablecoins] Skipped native-peg ${action} for ${asset.symbol} (id=${asset.id}): ` +
          `${nativeDecision.reason}`,
        );
        return false;
      }

      if (reason === "fill") {
        logWorkerEventArgs("handler", "warn",
          `[sync-stablecoins] Filled missing non-USD fiat price for ${asset.symbol} (id=${asset.id}): ` +
          `$${nativePegImpliedUsd.priceUsd.toFixed(6)} via direct ${nativePegImpliedUsd.pegCurrency} quote`,
        );
        nativePegFillCount++;
      } else {
        logWorkerEventArgs("handler", "warn",
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
        observedAtMode: "upstream",
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
      // Only a named source observation can outrank the native quote. An undated
      // incumbent has observedAt=null while priceUpdatedAt is merely this run's
      // application stamp, so it must stay correctable (it carries no evidence
      // that it is fresher than the native observation).
      nativePegImpliedUsd.updatedAt >= (asset.priceObservedAt ?? 0) &&
      nativePegDivergenceBps != null &&
      nativePegDivergenceBps > NATIVE_PEG_PRICE_GUARD_MAX_DRIFT_BPS
    ) {
      tryApplyNativePegImpliedPrice("correction");
    }

    if (asset.price == null || typeof asset.price !== "number") continue;
    // Nominal par was validated when applied and carries no observation clock to age.
    if (asset.priceObservedAtMode === "nominal_reference") continue;

    const decision = validatePublishedAssetPrice({
      asset,
      candidatePrices: getPostEnrichmentCandidatePricesForCurrentAsset(asset, input.primaryPriceResults),
      validationContext: validationContexts.get(asset),
      validationReferences,
      previousTrustedPrice: previousTrustedPrices?.get(asset.id) ?? null,
    });
    if (!decision.accepted) {
      const authoritativeOverride = input.authoritativeOverrides.get(asset.id);
      const currentPrice = asset.price;
      if (
        authoritativeOverride &&
        asset.priceSource === authoritativeOverride.source &&
        typeof currentPrice === "number" &&
        Number.isFinite(currentPrice)
      ) {
        const tolerance = Math.max(1e-12, Math.abs(authoritativeOverride.price) * 1e-9);
        if (Math.abs(currentPrice - authoritativeOverride.price) <= tolerance) {
          recordProtocolPriceOverridePublicationRejection({
            asset,
            override: authoritativeOverride,
            authoritativeOverrideStats: input.authoritativeOverrideStats,
            syncStartSec: input.syncStartSec,
            reason: decision.reason,
          });
        }
      }
      logWorkerEventArgs("handler", "warn",
        `[sync-stablecoins] Rejected unreasonable price for ${asset.symbol} (id=${asset.id}): ` +
        `$${asset.price} (${decision.reason})`,
      );
      clearPriceMetadata(asset);
      rejectedCount++;
    }
  }

  // --- Stage replay-safe assets with valid prices for post-publication price_cache commit ---
  const withValidPrices = assets.filter(
    (asset) =>
      asset.price != null &&
      typeof asset.price === "number" &&
      asset.price > 0 &&
      asset.priceConfidence !== "fallback" &&
      asset.priceConfidence !== "low" &&
      isReplaySafePriceSource(asset.priceSource),
  );
  const priceCacheEntries = withValidPrices.map((asset): PriceCacheWriteEntry => ({
    id: asset.id,
    price: asset.price! as number,
    source: asset.priceSource ?? null,
    confidence: asset.priceConfidence ?? null,
    observedAt: asset.priceObservedAt ?? asset.priceUpdatedAt ?? null,
    observedAtMode: asset.priceObservedAtMode ?? null,
    syncedAt: asset.priceSyncedAt ?? input.syncStartSec,
    agreeSources: asset.agreeSources ?? [],
    consensusSources: asset.consensusSources ?? [],
  }));

  // --- Apply cached fallback prices for assets still missing ---
  const now = Math.floor(Date.now() / 1000);
  const stillMissing = assets.filter(
    (asset) => hasMissingPrice(asset),
  );
  let cachedFallbackCount = 0;
  const priceCacheReadAbort = returnIfAborted(signal, `${abortStagePrefix}read-price-cache`);
  if (priceCacheReadAbort) return priceCacheReadAbort;
  const { byId: staged, summary: priceObservationEffectiveness } = await loadPriceCorroborationObservations(db, now, signal);
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  for (const [id, observations] of staged) {
    const asset = assetsById.get(id);
    if (!asset) priceObservationEffectiveness.publication.assetAbsent += observations.length;
    else if (!hasMissingPrice(asset)) priceObservationEffectiveness.publication.alreadyPriced += observations.length;
  }
  if (stillMissing.length > 0) {
    const priceCache = input.priceCache;
    for (const asset of stillMissing) {
      const candidates = staged.get(asset.id) ?? [];
      const candidatePrices = Object.fromEntries(candidates.map((candidate) => [candidate.source, candidate.price]));
      for (const [candidateIndex, candidate] of candidates.entries()) {
        const agreeSources = [...new Set(candidates
          .filter((other) => pricesAgreeWithinBps(candidate.price, other.price, DIVERGENCE_THRESHOLD_BPS))
          .map((other) => other.source))];
        const decision = validateFallbackPriceCandidate({
          price: candidate.price,
          source: candidate.source,
          confidence: "fallback",
          agreeSources,
          candidatePrices,
          validationContext: validationContexts.get(asset),
          validationReferences,
          previousTrustedPrice: previousTrustedPrices?.get(asset.id) ?? null,
          listFillDefault: asset.priceListFillDefault ?? null,
        });
        if (!decision.accepted) {
          priceObservationEffectiveness.publication.policyRejected++;
          continue;
        }
        priceObservationEffectiveness.publication.selected++;
        priceObservationEffectiveness.publication.notNeededAfterSelection += candidates.length - candidateIndex - 1;
        applyAcceptedPriceCandidate({
          asset,
          price: candidate.price,
          source: candidate.source,
          confidence: "fallback",
          observedAt: candidate.observedAt,
          observedAtMode: candidate.observedAtMode,
          consensusSources: Object.keys(candidatePrices),
          agreeSources,
          syncedAt: input.syncStartSec,
        });
        cachedFallbackCount++;
        break;
      }
      if (!hasMissingPrice(asset)) continue;
      const cached = priceCache.get(asset.id);
      if (!cached) continue;
      const maxAgeSec = getPriceCacheMaxAgeSec(cached.source, PRICE_CACHE_TTL);
      if (cached.updatedAt > now || now - cached.updatedAt >= maxAgeSec) continue;
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
        listFillDefault: asset.priceListFillDefault ?? null,
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

  return {
    priceObservationEffectiveness,
    rejectedCount,
    cachedFallbackCount,
    nativePegCorrectionCount,
    nativePegFillCount,
    priceCacheEntries,
    providerDiagnostics,
  };
}

export async function runSharedPriceCompletion(
  input: SharedPriceCompletionInput,
  abortStagePrefix: string,
): Promise<SharedPriceCompletionResult | CronResult> {
  const authoritativeOverrideStats = input.authoritativeOverrideStats;
  const authoritativeOverrides = new Map(input.authoritativeOverrides);
  const postFallbackLocalOverrides = await fetchAuthoritativeLivePriceOverrides(
    input.assets,
    input.signal,
    input.validationReferences,
    {
      db: input.db,
      stats: authoritativeOverrideStats,
      chainRpcs: input.chainRpcs,
      maxProviderLivePriority: 0,
      previousMissingGenerationsById: input.previousMissingGenerationsById,
    },
  );
  for (const [assetId, override] of postFallbackLocalOverrides) {
    authoritativeOverrides.set(assetId, override);
  }
  const authoritativeOverrideCount = applyProtocolPriceOverrides({
    assets: input.assets,
    overrides: authoritativeOverrides,
    previousTrustedPrices: input.previousTrustedPrices,
    validationContexts: input.validationContexts,
    validationReferences: input.validationReferences,
    syncStartSec: input.syncStartSec,
    authoritativeOverrideStats,
  });

  const priceResult = await runPostEnrichmentPricePipeline({
    ...input,
    authoritativeOverrides,
    authoritativeOverrideStats,
  }, abortStagePrefix);
  if (isAbortResult(priceResult)) return priceResult;
  settleNominalPriceReferences(input.assets, input.syncStartSec);

  return {
    authoritativeOverrideCount,
    authoritativeOverrideStats,
    ...priceResult,
  };
}


// ---------------------------------------------------------------------------
// Stage 2: Depeg detection + confirmation
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
  abortStagePrefix: string,
  logContext: string,
  binanceSession?: BinanceFetchSession,
  nativePegSession?: NativePegQuoteSession,
): Promise<DepegPipelineResult | CronResult> {
  let depegErrorCount = 0;
  const depegErrors: string[] = [];
  let depegHeldReason: DepegHoldReason | undefined;
  let depegObservation: DepegObservationCensus | null = null;
  let depegObservationUnavailableReason: DepegObservationUnavailableReason | undefined;
  const providerDiagnostics: PricingProviderAttemptDiagnostic[] = [];

  try {
    const depegAbort = returnIfAborted(signal, `${abortStagePrefix}depeg-detection`);
    if (depegAbort) return depegAbort;
    const detection = await detectDepegEvents(db, assets, fxFallbackRates, signal, coingeckoApiKey, nativePegSession);
    if (detection.status === "held") {
      depegHeldReason = detection.reason;
      if (detection.census == null) depegObservationUnavailableReason = detection.reason;
    }
    depegObservation = detection.census;
  } catch (err) {
    if (signal?.aborted) return abortResult(signal, `${abortStagePrefix}depeg-detection`);
    logWorkerEventArgs("handler", "error", `[sync-stablecoins] Depeg detection failed${logContext}:`, err);
    depegErrorCount++;
    depegErrors.push(`detection: ${String(err).slice(0, 200)}`);
    depegObservationUnavailableReason = "depeg-detection-error";
  }

  try {
    const confirmAbort = returnIfAborted(signal, `${abortStagePrefix}depeg-confirmation`);
    if (confirmAbort) return confirmAbort;
    const confirmation = await confirmPendingDepegs(
      db,
      assets,
      fxFallbackRates,
      signal,
      coingeckoApiKey,
      binanceSession,
      nativePegSession,
    );
    if (confirmation.status === "held") depegHeldReason = confirmation.reason;
    if (confirmation?.providerDiagnostics?.length) {
      providerDiagnostics.push(...confirmation.providerDiagnostics);
    }
  } catch (err) {
    if (signal?.aborted) return abortResult(signal, `${abortStagePrefix}depeg-confirmation`);
    logWorkerEventArgs("handler", "error", `[sync-stablecoins] Pending depeg confirmation failed${logContext}:`, err);
    depegErrorCount++;
    depegErrors.push(`confirmation: ${String(err).slice(0, 200)}`);
  }

  return {
    depegErrorCount,
    depegErrors,
    providerDiagnostics,
    ...(depegHeldReason ? { depegHeldReason } : {}),
    depegObservation,
    ...(depegObservationUnavailableReason ? { depegObservationUnavailableReason } : {}),
  };
}

/** Type guard: true when the pipeline returned the abort sentinel CronResult. */
export function isAbortResult(result: unknown): result is CronResult {
  return (
    typeof result === "object" &&
    result !== null &&
    "aborted" in result &&
    (result as { aborted?: unknown }).aborted === true
  );
}
