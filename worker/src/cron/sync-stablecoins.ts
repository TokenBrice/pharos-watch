import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import {
  enrichMissingPrices,
  hasMissingPrice,
  fetchPrimaryPrices,
  runGtProbePass,
} from "./enrich-prices";
import type { PeggedAsset } from "./enrich-prices";
import {
  applyTrackedAssetOverrides,
  detectPriceStaleness,
  fillMissingSupplyHistory,
} from "./sync-stablecoins/stages";
import { type CoinGeckoMcapData } from "./sync-stablecoins/supplemental-assets";
import {
  buildSyncMetadata,
  loadFreshFxRates,
  loadPreviousStablecoinsById,
  stampPriceMetadata,
  type CronResult,
} from "./sync-stablecoins/shared";
import {
  runPostEnrichmentPricePipeline,
  validateAndWriteStablecoinsCache,
  runDepegPipeline,
  isAbortResult,
} from "./sync-stablecoins/post-enrichment";
import { loadStablecoinsIntake } from "./sync-stablecoins/intake";
import { buildStablecoinsSyncResult } from "./sync-stablecoins/metadata";
import {
  applyGtProbeResults,
  applyPrimaryPriceResults,
  applyProtocolPriceOverrides,
  buildDlListPrices,
  buildPreviousTrustedPriceLookup,
  createValidationContextResolver,
  prevalidatePrices,
  priceValidationModeForAsset,
  validatePublishablePrice,
} from "./sync-stablecoins/pricing";
import { queueTrackedAdditionsNotice } from "./sync-stablecoins/telegram-tracked-additions";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { createEmptyGtProbeStats } from "../lib/geckoterminal-price-probe";
import { MIN_VALID_ASSET_COUNT, CIRCUIT_SOURCE } from "../lib/constants";
import { recordOutcome } from "../lib/circuit-breaker";
import { fetchAuthoritativeLivePriceOverrides } from "../lib/authoritative-price-sources";

function abortResult(signal: AbortSignal | undefined, stage: string): CronResult {
  const reasonRaw = signal?.reason;
  const reason =
    reasonRaw instanceof Error
      ? reasonRaw.message
      : typeof reasonRaw === "string" && reasonRaw.length > 0
        ? reasonRaw
        : "aborted";
  return {
    status: "degraded",
    itemCount: 0,
    metadata: buildSyncMetadata({ reason: "aborted", stage, detail: reason }),
  };
}

function returnIfAborted(signal: AbortSignal | undefined, stage: string): CronResult | null {
  if (!signal?.aborted) return null;
  return abortResult(signal, stage);
}

/**
 * CoinGecko supply fallback: when DefiLlama stablecoins API is down,
 * use CG market cap as a proxy for circulating supply.
 * Renamed from fallbackToCgSupply (Q-009) — this is a full sync path,
 * not just a supply fallback.
 */
async function syncViaCoingeckoFallback(
  db: D1Database,
  cgData: CoinGeckoMcapData,
  cmcApiKey: string | undefined,
  syncStartSec: number,
  signal?: AbortSignal,
  alertWebhookUrl?: string | null,
  coingeckoApiKey?: string | null,
): Promise<CronResult> {
  const aborted = returnIfAborted(signal, "fallback-start");
  if (aborted) return aborted;
  console.warn("[sync-stablecoins] Using CoinGecko supply fallback");

  // Build asset list from tracked stablecoins with geckoId
  const assets: PeggedAsset[] = [];
  for (const meta of ACTIVE_STABLECOINS) {
    if (!meta.geckoId) continue;
    const mcap = cgData[meta.geckoId]?.usd_market_cap;
    if (!mcap || mcap <= 0) continue;

    const pKey = `pegged${meta.flags.pegCurrency}`;
    const price = cgData[meta.geckoId]?.usd ?? null;

    assets.push({
      id: meta.id,
      name: meta.name,
      symbol: meta.symbol,
      geckoId: meta.geckoId,
      pegType: pKey,
      pegMechanism: meta.flags.backing,
      price,
      priceSource: "coingecko",
      priceConfidence: "single-source",
      priceUpdatedAt: syncStartSec,
      supplySource: "coingecko-fallback",
      circulating: { [pKey]: mcap },
      circulatingPrevDay: null,
      circulatingPrevWeek: null,
      circulatingPrevMonth: null,
      chainCirculating: {},
      chains: [],
    });
  }

  if (assets.length < MIN_VALID_ASSET_COUNT) {
    console.error(`[sync-stablecoins] CG fallback only got ${assets.length} assets (need ${MIN_VALID_ASSET_COUNT}+), skipping cache write`);
    return {
      metadata: buildSyncMetadata({
        rowsRead: assets.length,
        rowsWritten: 0,
        rowsDropped: 0,
        sourceCoverage: { defillama: false, coingeckoFallbackAssets: assets.length },
        fallbackMode: "coingecko-supply-fallback",
        validationFailures: 1,
      }, {
        capabilities: {
          stablecoinsCache: false,
          depegPipeline: false,
        },
      }),
    };
  }

  // Try to restore stale chainCirculating from previous DL cache
  const previousAssetsById = await loadPreviousStablecoinsById(db);
  try {
    for (const asset of assets) {
      const prev = previousAssetsById.get(String(asset.id));
      if (prev?.chainCirculating) {
        asset.chainCirculating = prev.chainCirculating;
        asset.chains = prev.chains ?? [];
      }
      // Restore historical supply if available
      if (prev?.circulatingPrevDay) asset.circulatingPrevDay = prev.circulatingPrevDay;
      if (prev?.circulatingPrevWeek) asset.circulatingPrevWeek = prev.circulatingPrevWeek;
      if (prev?.circulatingPrevMonth) asset.circulatingPrevMonth = prev.circulatingPrevMonth;
    }
  } catch (e) {
    console.warn("[sync-stablecoins] Failed to restore stale cache data:", e);
  }

  applyTrackedAssetOverrides(assets);

  const { fxFallbackRates, validationReferences } = await loadFreshFxRates(db, syncStartSec, "[sync-stablecoins:fallback]");
  const validationContexts = createValidationContextResolver();
  const previousTrustedPrices = buildPreviousTrustedPriceLookup(previousAssetsById, syncStartSec);
  const authoritativeOverrides = await fetchAuthoritativeLivePriceOverrides(assets, signal);
  const authoritativeOverrideCount = applyProtocolPriceOverrides({
    assets,
    overrides: authoritativeOverrides,
    previousTrustedPrices,
    validationContexts,
    validationReferences,
    syncStartSec,
    validatePublishablePrice,
  });

  for (const asset of assets) {
    if (!asset.supplySource) {
      asset.supplySource = "coingecko-fallback";
    }
  }

  prevalidatePrices({
    assets,
    previousTrustedPrices,
    validationContexts,
    validationReferences,
    validatePublishablePrice,
    modeResolver: () => "primary_authoritative",
    logLabel: "Pre-rejected fallback price",
  });

  const missingBefore = new Set(assets.filter(hasMissingPrice).map((asset) => asset.id));

  // Enrich missing prices
  const enrichAbort = returnIfAborted(signal, "fallback-enrich-prices");
  if (enrichAbort) return enrichAbort;
  const enrichStats = await enrichMissingPrices(assets, cmcApiKey, db, signal);

  for (const asset of assets) {
    if (missingBefore.has(asset.id) && !hasMissingPrice(asset) && !asset.priceConfidence) {
      stampPriceMetadata(asset, asset.priceSource || "unknown", "fallback", syncStartSec);
    }
  }

  // --- Shared post-enrichment pipeline ---
  const priceResult = await runPostEnrichmentPricePipeline({
    assets,
    missingBefore,
    db,
    syncStartSec,
    signal,
    fxFallbackRates,
    validationReferences,
    validationContexts,
    priceValidationModeForAsset,
    validatePublishablePrice,
    previousTrustedPrices,
    returnIfAborted,
    abortResult,
  }, "fallback-");
  if (isAbortResult(priceResult)) return priceResult;
  const { rejectedCount, cachedFallbackCount } = priceResult;

  const cacheResult = await validateAndWriteStablecoinsCache({
    assets,
    fxFallbackRates,
    db,
    syncStartSec,
    signal,
    alertWebhookUrl,
    validationContext: "fallback",
    returnIfAborted,
    abortResult,
  }, (stablecoinsCacheAgeSec) => ({
    status: "degraded",
    itemCount: assets.length,
    metadata: buildSyncMetadata({
      rowsRead: assets.length,
      rowsWritten: 0,
      rowsDropped: 0,
      sourceCoverage: { defillama: false, coingeckoFallbackAssets: assets.length },
      fallbackMode: "coingecko-supply-fallback",
      validationFailures: 1,
      validationContext: "fallback",
      stablecoinsCacheAgeSec,
      cacheWriteMode: "blocked-invalid-payload",
    }, {
      cacheWriteMode: "blocked-invalid-payload",
      capabilities: {
        stablecoinsCache: false,
        depegPipeline: false,
      },
    }),
  }));
  if (isAbortResult(cacheResult)) return cacheResult;
  if (!cacheResult.written) return cacheResult.blockedResult!;
  await queueTrackedAdditionsNotice(db, previousAssetsById.keys(), assets);

  const depegResult = await runDepegPipeline(
    db, assets, fxFallbackRates, signal, coingeckoApiKey,
    returnIfAborted, abortResult, "fallback-", " (CG fallback)",
  );
  if (isAbortResult(depegResult)) return depegResult;
  const { depegErrorCount } = depegResult;

  return {
    status: depegErrorCount > 0 ? "degraded" : "ok",
    itemCount: assets.length,
    metadata: buildSyncMetadata({
      rowsRead: assets.length,
      rowsWritten: assets.length,
      rowsDropped: 0,
      sourceCoverage: { defillama: false, coingeckoFallbackAssets: assets.length },
      fallbackMode: "coingecko-supply-fallback",
      validationFailures: 0,
      enrichment: enrichStats,
      rejectedPrices: rejectedCount,
      cachedFallbackPrices: cachedFallbackCount,
      authoritativeOverrides: authoritativeOverrideCount,
    }, {
      cacheWriteMode: "fallback-write",
      capabilities: {
        stablecoinsCache: true,
        depegPipeline: depegErrorCount === 0,
      },
    }),
  };
}

export async function syncStablecoins(db: D1Database, cmcApiKey?: string, signal?: AbortSignal, alertWebhookUrl?: string | null, coingeckoApiKey?: string | null, chainRpcs?: Map<string, ChainRpcConfig>): Promise<CronResult> {
  const startAbort = returnIfAborted(signal, "start");
  if (startAbort) return startAbort;
  const syncStartSec = Math.floor(Date.now() / 1000);

  const preFetchAbort = returnIfAborted(signal, "fetch-stablecoins-and-supplementals");
  if (preFetchAbort) return preFetchAbort;
  const intake = await loadStablecoinsIntake({
    db,
    signal,
    syncStartSec,
    coingeckoApiKey,
    chainRpcs,
    fallbackToCoingecko: (cgData) =>
      syncViaCoingeckoFallback(db, cgData, cmcApiKey, syncStartSec, signal, alertWebhookUrl, coingeckoApiKey),
  });

  if (intake.kind === "fallback") {
    if (intake.result.itemCount && intake.result.itemCount > 0) {
      return intake.result;
    }
    throw new Error(intake.errorMessage);
  }
  const {
    assets,
    rawAssetCount,
    droppedMalformedAssets,
    canonicalDeduplication,
  } = intake;
  const previousAssetsById = intake.previousAssetsById;
  let fxFallbackRates = intake.fxFallbackRates;

  // Load FX rates early for dynamic price bounds in validatePriceCandidate
  const { fxFallbackRates: freshFxFallbackRates, validationReferences } = await loadFreshFxRates(db, syncStartSec);
  if (freshFxFallbackRates) {
    fxFallbackRates = freshFxFallbackRates;
  }
  const validationContexts = createValidationContextResolver();
  const previousTrustedPrices = buildPreviousTrustedPriceLookup(previousAssetsById, syncStartSec);
  let gtProbe = { updatedCount: 0, stats: createEmptyGtProbeStats() };
  const dlListPrices = buildDlListPrices(assets);
  // --- Primary price validation ---
  // Cross-validate CG and independent sources for higher confidence
  const primaryPricesAbort = returnIfAborted(signal, "primary-prices");
  if (primaryPricesAbort) return primaryPricesAbort;
  const { results: primaryPriceResults, stats: priceValidationStats } = await fetchPrimaryPrices(
    assets, db, signal, validationReferences, coingeckoApiKey, chainRpcs, dlListPrices,
  );
  const protocolPriceOverrides = await fetchAuthoritativeLivePriceOverrides(assets, signal);
  applyPrimaryPriceResults({
    assets,
    primaryPriceResults,
    previousTrustedPrices,
    validationContexts,
    validationReferences,
    syncStartSec,
    validatePublishablePrice,
  });
  prevalidatePrices({
    assets,
    previousTrustedPrices,
    validationContexts,
    validationReferences,
    validatePublishablePrice,
    modeResolver: () => "primary_authoritative",
    logLabel: "Pre-rejected bad price",
  });
  // Enrich any assets that still have missing prices
  const missingBefore = new Set(
    assets.filter(hasMissingPrice).map((a) => a.id)
  );
  const enrichAbort = returnIfAborted(signal, "enrich-prices");
  if (enrichAbort) return enrichAbort;
  const enrichStats = await enrichMissingPrices(assets, cmcApiKey, db, signal);
  // Tag enriched assets with fallback confidence
  for (const asset of assets) {
    if (missingBefore.has(asset.id) && !hasMissingPrice(asset) && !asset.priceConfidence) {
      stampPriceMetadata(asset, asset.priceSource || "unknown", "fallback", syncStartSec);
    }
  }

  // Keep missing-price recovery on the critical path; the GT CG-only cross-check
  // is slower and does not affect assets that were missing outright.
  const gtProbeAbort = returnIfAborted(signal, "gt-probe");
  if (gtProbeAbort) return gtProbeAbort;
  try {
    gtProbe = await runGtProbePass(
      assets, primaryPriceResults, db, signal, validationReferences, coingeckoApiKey,
    );
    const { updatedCount: gtUpdated } = gtProbe;
    if (gtUpdated > 0) {
      applyGtProbeResults({
        assets,
        primaryPriceResults,
        previousTrustedPrices,
        validationContexts,
        validationReferences,
        syncStartSec,
        validatePublishablePrice,
      });
      console.log(`[sync-stablecoins] GT probe updated ${gtUpdated} asset prices`);
    }
  } catch (err) {
    if (signal?.aborted) return abortResult(signal, "gt-probe");
    console.warn("[sync-stablecoins] GT probe failed (non-fatal):", err);
  }

  const protocolOverrideCount = applyProtocolPriceOverrides({
    assets,
    overrides: protocolPriceOverrides,
    previousTrustedPrices,
    validationContexts,
    validationReferences,
    syncStartSec,
    validatePublishablePrice,
  });
  if (protocolOverrideCount > 0) {
    console.log(`[sync-stablecoins] Applied ${protocolOverrideCount} protocol-backed price override${protocolOverrideCount === 1 ? "" : "s"}`);
  }

  // --- Shared post-enrichment price pipeline ---
  const priceResult = await runPostEnrichmentPricePipeline({
    assets,
    missingBefore,
    db,
    syncStartSec,
    signal,
    fxFallbackRates,
    validationReferences,
    validationContexts,
    priceValidationModeForAsset,
    validatePublishablePrice,
    previousTrustedPrices,
    returnIfAborted,
    abortResult,
  }, "");
  if (isAbortResult(priceResult)) return priceResult;
  const { rejectedCount, cachedFallbackCount } = priceResult;
  if (rejectedCount > 0) {
    console.log(`[sync-stablecoins] Rejected ${rejectedCount} unreasonable prices`);
  }
  if (cachedFallbackCount > 0) {
    console.log(`[sync-stablecoins] Applied ${cachedFallbackCount} cached fallback prices`);
  }

  // --- Fill missing circulatingPrev* from supply_history snapshots ---
  try {
    const fillAbort = returnIfAborted(signal, "fill-supply-history");
    if (fillAbort) return fillAbort;
    const fillCount = await fillMissingSupplyHistory(db, assets, signal);
    if (fillCount > 0) {
      console.log(`[sync-stablecoins] Filled ${fillCount} missing supply changes from supply_history`);
    }
  } catch (err) {
    if (signal?.aborted) return abortResult(signal, "fill-supply-history");
    console.warn("[sync-stablecoins] supply_history fallback failed:", err);
  }

  // --- Staleness detection: compare prices against previous cache ---
  let stalenessWarning = false;
  try {
    const stalenessAbort = returnIfAborted(signal, "detect-price-staleness");
    if (stalenessAbort) return stalenessAbort;
    const staleness = await detectPriceStaleness(db, assets, signal);
    if (staleness?.stale) {
      stalenessWarning = true;
      console.warn(
        `[sync-stablecoins] STALENESS WARNING: ${staleness.identical}/${staleness.compared} prices ` +
        `(${(staleness.identical / staleness.compared * 100).toFixed(1)}%) are identical to previous cache — possible upstream stale data`,
      );
    }
  } catch (e) {
    if (signal?.aborted) return abortResult(signal, "detect-price-staleness");
    console.warn("[sync-stablecoins] Staleness check failed:", e);
  }

  const validationAbort = returnIfAborted(signal, "validate-stablecoins-payload");
  if (validationAbort) return validationAbort;
  const cacheResult = await validateAndWriteStablecoinsCache({
    assets,
    fxFallbackRates,
    db,
    syncStartSec,
    signal,
    alertWebhookUrl,
    validationContext: "main",
    returnIfAborted,
    abortResult,
  }, (stablecoinsCacheAgeSec) => ({
    status: "degraded",
    itemCount: assets.length,
    metadata: buildSyncMetadata({
      rowsRead: rawAssetCount,
      rowsWritten: 0,
      rowsDropped: droppedMalformedAssets,
      sourceCoverage: { defillama: true },
      fallbackMode: null,
      validationFailures: 1,
      validationContext: "main",
      stablecoinsCacheAgeSec,
      cacheWriteMode: "blocked-invalid-payload",
    }, {
      cacheWriteMode: "blocked-invalid-payload",
      capabilities: {
        stablecoinsCache: false,
        depegPipeline: false,
      },
    }),
  }));
  if (isAbortResult(cacheResult)) return cacheResult;
  if (!cacheResult.written) {
    await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    return cacheResult.blockedResult!;
  }
  await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, true);
  await queueTrackedAdditionsNotice(db, previousAssetsById.keys(), assets);

  const depegResult = await runDepegPipeline(
    db, assets, fxFallbackRates, signal, coingeckoApiKey,
    returnIfAborted, abortResult, "", "",
  );
  if (isAbortResult(depegResult)) return depegResult;
  const { depegErrorCount, depegErrors } = depegResult;

  return buildStablecoinsSyncResult({
    assets,
    rawAssetCount,
    droppedMalformedAssets,
    canonicalDeduplication,
    enrichStats,
    priceValidationStats,
    rejectedCount,
    stalenessWarning,
    gtProbe,
    depegErrorCount,
    depegErrors,
  });
}
