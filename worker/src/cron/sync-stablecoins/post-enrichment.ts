import type { FxRateState } from "../../lib/fx-rate-state";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { logWorkerEventArgs } from "../../lib/structured-log";
/**
 * Shared post-enrichment pipeline stages used by both the main DefiLlama
 * sync path and the CoinGecko supply fallback path.
 *
 * Extracted to eliminate code duplication (Q-002, Q-011, CC-001).
 */
import { DIVERGENCE_THRESHOLD_BPS } from "@shared/lib/pricing-pipeline-constants";
import { pricesAgreeWithinBps } from "../../lib/price-divergence";
import { loadPriceCorroborationObservations, type PriceObservationEffectiveness } from "./price-corroboration-observations";
import {
  COINGECKO_MICRO_VOLUME_OUTLIER_REASON,
  getPriceCacheMaxAgeSec,
  isCoingeckoAggregatorSource,
  isReplaySafePriceSource,
} from "@shared/lib/pricing-source-policy";
import { evaluateCoingeckoMicroVolumeOutlier } from "../../lib/coingecko-simple-price";
import { HIVE_MARKET_POLICY } from "../../lib/hive-market-price";
import { splitCompositePriceSource } from "@shared/lib/pricing-sources";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  type AuthoritativeLivePriceOverrideStats,
  fetchAuthoritativeLivePriceOverrides,
} from "../../lib/authoritative-price-sources";
import { priceCacheObservationClock, type PriceCacheEntry, type PriceCacheWriteEntry } from "../../lib/price-cache";
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
import type { NativePegQuoteSession } from "../../lib/native-peg-quotes";
import {
  assetPriceObservationClock,
  chainlinkNavAgeForAsset,
  clearPriceMetadata,
  validateAssetPricingSourceFreshness,
  type CronResult,
} from "./shared";
import {
  applyAcceptedPriceCandidate,
  applyProtocolPriceOverrides,
  getFiatPremiumEvidenceForCurrentAsset,
  getPostEnrichmentCandidatePricesForCurrentAsset,
  recordProtocolPriceOverridePublicationRejection,
  settleNominalPriceReferences,
  type ProtocolPriceOverride,
} from "./pricing";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import type { BinanceFetchSession } from "../../lib/cex-tickers";
import { abortResult, returnIfAborted } from "./runtime";

const PRICE_CACHE_TTL = 6 * 60 * 60;


export interface PostEnrichmentInput {
  assets: PeggedAsset[];
  db: D1Database;
  syncStartSec: number;
  signal?: AbortSignal;
  fxFallbackRates?: Record<string, number>;
  validationReferences?: PriceValidationReferences;
  validationContexts: { get: (asset: PeggedAsset) => PriceValidationContext };
  primaryPriceResults?: Map<string, PrimaryPriceResult>;
  previousTrustedPrices?: Map<string, TrustedPriceReference>;
  authoritativeOverrides: Map<string, ProtocolPriceOverride>;
  authoritativeOverrideStats: AuthoritativeLivePriceOverrideStats;
  /** The same replay snapshot used to establish trusted-price continuity. */
  priceCache: ReadonlyMap<string, PriceCacheEntry>;
  rejectedCgReasons?: ReadonlyMap<string, string>;
  hiveVetoPrice?: number | null;
}

export interface PriceValidationResult {
  priceObservationEffectiveness?: PriceObservationEffectiveness;
  rejectedCount: number;
  cachedFallbackCount: number;
  priceCacheEntries: PriceCacheWriteEntry[];
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
    validationReferences,
    validationContexts,
    previousTrustedPrices,
  } = input;

  // --- Reject unreasonable prices BEFORE caching ---
  let rejectedCount = 0;
  for (const asset of assets) {
    if (asset.price == null || typeof asset.price !== "number") continue;
    // Nominal par was validated when applied and carries no observation clock to age.
    if (asset.priceObservedAtMode === "nominal_reference") continue;

    const fiatPremiumEvidence = getFiatPremiumEvidenceForCurrentAsset(asset, input.primaryPriceResults);
    const candidatePrices = getPostEnrichmentCandidatePricesForCurrentAsset(asset, input.primaryPriceResults);
    const decision = validatePublishedAssetPrice({
      asset,
      candidatePrices,
      upstreamKeysBySource: candidatePrices && input.primaryPriceResults?.get(asset.id)?.upstreamKeysBySource,
      fiatPremiumEvidence,
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
      assetPriceObservationClock(asset) != null &&
      asset.priceConfidence !== "fallback" &&
      asset.priceConfidence !== "low" &&
      isReplaySafePriceSource(asset.priceSource),
  );
  const priceCacheEntries = withValidPrices.map((asset): PriceCacheWriteEntry => ({
    id: asset.id,
    price: asset.price! as number,
    source: asset.priceSource ?? null,
    confidence: asset.priceConfidence ?? null,
    observedAt: assetPriceObservationClock(asset),
    observedAtMode: asset.priceObservedAtMode ?? null,
    syncedAt: asset.priceSyncedAt ?? input.syncStartSec,
    agreeSources: asset.agreeSources ?? [],
    consensusSources: asset.consensusSources ?? [],
  }));

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
    const isWithheldByPrimaryQualityGate = (
      asset: PeggedAsset,
      source: string | null | undefined,
      price: number,
    ): boolean => {
      if (!isCoingeckoAggregatorSource(source)) return false;
      if (asset.id === "hbd-hive" && input.hiveVetoPrice != null) {
        return !pricesAgreeWithinBps(price, input.hiveVetoPrice, HIVE_MARKET_POLICY.cgDivergenceVetoMaxBps);
      }
      if (input.rejectedCgReasons?.get(asset.id) === COINGECKO_MICRO_VOLUME_OUTLIER_REASON) {
        return evaluateCoingeckoMicroVolumeOutlier({
          price,
          volume24hUsd: 0,
          context: validationContexts.get(asset),
          references: validationReferences,
        }).status === "rejected";
      }
      return false;
    };
    const priceCache = input.priceCache;
    for (const asset of stillMissing) {
      const candidates = staged.get(asset.id) ?? [];
      const datedCandidates = candidates.filter((candidate) => !candidate.recentActivity);
      const candidatePrices = Object.fromEntries(datedCandidates.map((candidate) => [candidate.source, candidate.price]));
      for (const [candidateIndex, candidate] of candidates.entries()) {
        if (isWithheldByPrimaryQualityGate(asset, candidate.source, candidate.price)) {
          priceObservationEffectiveness.publication.policyRejected++;
          continue;
        }
        const agreeSources = [...new Set([candidate.source, ...datedCandidates
          .filter((other) => pricesAgreeWithinBps(candidate.price, other.price, DIVERGENCE_THRESHOLD_BPS))
          .map((other) => other.source)])];
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
          consensusSources: candidates.map((row) => row.source),
          agreeSources,
          syncedAt: candidate.recentActivity?.collectedAt ?? input.syncStartSec,
        });
        cachedFallbackCount++;
        break;
      }
      if (!hasMissingPrice(asset)) continue;
      const cached = priceCache.get(asset.id);
      if (!cached) continue;
      if (isWithheldByPrimaryQualityGate(asset, cached.source, cached.price)) continue;
      const observedAt = priceCacheObservationClock(cached);
      if ((cached.source === "defillama" || cached.source === "defillama-list") &&
        (cached.observedAtMode !== "upstream" || cached.hasExplicitClocks === false || observedAt == null)) continue;
      // The cached USD value of a foreign NAV also contains the FX rate from that run.
      const navAge = cached.source === "chainlink-nav" && ACTIVE_META_BY_ID.get(asset.id)?.flags.pegCurrency === "USD"
        ? chainlinkNavAgeForAsset(asset.id) : undefined;
      if (navAge !== undefined) {
        if (observedAt == null || observedAt > now || cached.hasExplicitClocks === false || !validateAssetPricingSourceFreshness(asset.id, {
          source: "chainlink-nav", observedAt, observedAtMode: cached.observedAtMode, nowSec: now, requireObservedAt: true,
        }).accepted) continue;
      } else {
        const maxAgeSec = getPriceCacheMaxAgeSec(cached.source, PRICE_CACHE_TTL);
        if (cached.updatedAt > now || now - cached.updatedAt >= maxAgeSec) continue;
      }
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
        observedAt,
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
    priceCacheEntries,
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
      localRepairOnly: true,
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
  settleNominalPriceReferences(input.assets, input.syncStartSec, input.validationReferences);

  return {
    authoritativeOverrideCount,
    authoritativeOverrideStats,
    ...priceResult,
  };
}


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
  detectionFxState?: FxRateState | null,
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
    const detection = await detectDepegEvents(db, assets, fxFallbackRates, signal, coingeckoApiKey, nativePegSession, detectionFxState);
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
      nativePegSession, detectionFxState,
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
