import { hasMissingPrice } from "./enrich-prices";
import {
  applyTrackedAssetOverrides,
  fillMissingSupplyHistory,
} from "./phase-helpers";
import type { CoinGeckoMcapData } from "./supplemental-assets";
import {
  buildSyncMetadata,
  loadFreshFxRates,
  loadPreviousStablecoinsById,
  type CronResult,
} from "./shared";
import {
  runMissingPriceEnrichmentPhase,
  runSharedPriceCompletion,
  validateAndWriteStablecoinsCache,
  runDepegPipeline,
  isAbortResult,
} from "./post-enrichment";
import {
  applyProtocolPriceOverrides,
  buildPreviousTrustedPriceLookup,
  createValidationContextResolver,
  prevalidatePrices,
} from "./pricing";
import { fetchAuthoritativeLivePriceOverrides } from "../../lib/authoritative-price-sources";
import { queueTrackedAdditionsNotice } from "./telegram-tracked-additions";
import {
  abortResult,
  checkStablecoinsPriceStaleness,
  reportStablecoinsStage,
  returnIfAborted,
} from "./runtime";
import { MIN_VALID_ASSET_COUNT } from "../../lib/constants";
import type { CronProgressReporter } from "../../lib/cron-logger";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { PeggedAsset } from "./enrich-prices";

export async function syncViaCoingeckoFallback(
  db: D1Database,
  cgData: CoinGeckoMcapData,
  cmcApiKey: string | undefined,
  syncStartSec: number,
  signal?: AbortSignal,
  alertWebhookUrl?: string | null,
  coingeckoApiKey?: string | null,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  const aborted = returnIfAborted(signal, "fallback-start");
  if (aborted) return aborted;
  console.warn("[sync-stablecoins] Using CoinGecko supply fallback");
  await reportStablecoinsStage(reportProgress, "fallback-intake", "Building CoinGecko fallback intake");

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
      priceObservedAt: syncStartSec,
      priceObservedAtMode: "local_fetch",
      priceSyncedAt: syncStartSec,
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
    console.error(
      `[sync-stablecoins] CG fallback only got ${assets.length} assets (need ${MIN_VALID_ASSET_COUNT}+), skipping cache write`,
    );
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

  const previousAssetsById = await loadPreviousStablecoinsById(db);
  try {
    for (const asset of assets) {
      const prev = previousAssetsById.get(String(asset.id));
      if (prev?.chainCirculating) {
        asset.chainCirculating = prev.chainCirculating;
        asset.chains = prev.chains ?? [];
      }
      if (prev?.circulatingPrevDay) asset.circulatingPrevDay = prev.circulatingPrevDay;
      if (prev?.circulatingPrevWeek) asset.circulatingPrevWeek = prev.circulatingPrevWeek;
      if (prev?.circulatingPrevMonth) asset.circulatingPrevMonth = prev.circulatingPrevMonth;
    }
  } catch (error) {
    console.warn("[sync-stablecoins] Failed to restore stale cache data:", error);
  }

  applyTrackedAssetOverrides(assets);

  const { fxFallbackRates, validationReferences } = await loadFreshFxRates(
    db,
    syncStartSec,
    "[sync-stablecoins:fallback]",
  );
  const validationContexts = createValidationContextResolver();
  const previousTrustedPrices = buildPreviousTrustedPriceLookup(previousAssetsById, syncStartSec);

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
    logLabel: "Pre-rejected fallback price",
  });
  const authoritativeOverrides = await fetchAuthoritativeLivePriceOverrides(assets, signal);
  applyProtocolPriceOverrides({
    assets,
    overrides: authoritativeOverrides,
    previousTrustedPrices,
    validationContexts,
    validationReferences,
    syncStartSec,
  });

  await reportStablecoinsStage(
    reportProgress,
    "fallback-price-enrichment",
    "Enriching CoinGecko fallback prices",
    { itemsTotal: assets.length },
  );
  const enrichmentPhase = await runMissingPriceEnrichmentPhase({
    assets,
    db,
    syncStartSec,
    signal,
    cmcApiKey,
    returnIfAborted,
  }, "fallback-");
  if (isAbortResult(enrichmentPhase)) return enrichmentPhase;
  const { missingBefore, enrichStats } = enrichmentPhase;

  const priceCompletion = await runSharedPriceCompletion({
    assets,
    missingBefore,
    db,
    syncStartSec,
    signal,
    coingeckoApiKey,
    fxFallbackRates,
    validationReferences,
    validationContexts,
    previousTrustedPrices,
    authoritativeOverrides,
    returnIfAborted,
    abortResult,
  }, "fallback-");
  if (isAbortResult(priceCompletion)) return priceCompletion;
  const {
    authoritativeOverrideCount,
    rejectedCount,
    cachedFallbackCount,
    nativePegCorrectionCount,
    nativePegFillCount,
  } = priceCompletion;
  await reportStablecoinsStage(
    reportProgress,
    "fallback-price-validation",
    "Validated CoinGecko fallback prices",
    {
      itemsDone: assets.length - assets.filter(hasMissingPrice).length,
      itemsTotal: assets.length,
      metadata: {
        authoritativeOverrides: authoritativeOverrideCount,
        rejectedPrices: rejectedCount,
        nativePegCorrections: nativePegCorrectionCount,
        nativePegFills: nativePegFillCount,
        cachedFallbackPrices: cachedFallbackCount,
      },
    },
  );

  try {
    const fillAbort = returnIfAborted(signal, "fallback-fill-supply-history");
    if (fillAbort) return fillAbort;
    await fillMissingSupplyHistory(db, assets, signal);
  } catch (error) {
    if (signal?.aborted) return abortResult(signal, "fallback-fill-supply-history");
    console.warn("[sync-stablecoins] supply_history fallback failed:", error);
  }

  const {
    stalenessWarning,
    stalenessSummary,
    blockedResult,
  } = await checkStablecoinsPriceStaleness({
    db,
    assets,
    signal,
    reportProgress,
    progressStage: "fallback-staleness-check",
    progressMessage: "Checking fallback price staleness",
    abortStage: "fallback-detect-price-staleness",
    warningLabel: "(fallback)",
    failureLabel: "Fallback staleness check",
    blockedResultFactory: (summary) => ({
      status: "degraded",
      itemCount: assets.length,
      metadata: buildSyncMetadata({
        rowsRead: assets.length,
        rowsWritten: 0,
        rowsDropped: 0,
        sourceCoverage: { defillama: false, coingeckoFallbackAssets: assets.length },
        fallbackMode: "coingecko-supply-fallback-stale-blocked",
        validationFailures: 1,
        upstreamFetchOk: false,
        payloadAccepted: false,
        cacheWriteSucceeded: false,
        depegPipelineSucceeded: false,
        stalenessWarning: true,
        priceStaleness: summary,
        staleWriteBlocked: true,
      }, {
        cacheWriteMode: "no-write",
        capabilities: {
          stablecoinsCache: false,
          depegPipeline: false,
        },
      }),
    }),
  });
  if (blockedResult) return blockedResult;

  await reportStablecoinsStage(
    reportProgress,
    "fallback-cache-validation",
    "Validating CoinGecko fallback payload",
    {
      itemsDone: assets.length,
      itemsTotal: assets.length,
    },
  );
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
  await reportStablecoinsStage(
    reportProgress,
    "fallback-cache-write",
    "Published CoinGecko fallback payload",
    {
      itemsDone: assets.length,
      itemsTotal: assets.length,
    },
  );
  await queueTrackedAdditionsNotice(db, previousAssetsById.keys(), assets);

  await reportStablecoinsStage(
    reportProgress,
    "fallback-depeg-pipeline",
    "Running fallback depeg pipeline",
    { itemsTotal: assets.length },
  );
  const depegResult = await runDepegPipeline(
    db,
    assets,
    fxFallbackRates,
    signal,
    coingeckoApiKey,
    returnIfAborted,
    abortResult,
    "fallback-",
    " (CG fallback)",
  );
  if (isAbortResult(depegResult)) return depegResult;
  const { depegErrorCount } = depegResult;

  const result: CronResult = {
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
      providerDiagnostics: enrichStats.providerDiagnostics ?? [],
      rejectedPrices: rejectedCount,
      nativePegCorrections: nativePegCorrectionCount,
      nativePegFills: nativePegFillCount,
      cachedFallbackPrices: cachedFallbackCount,
      authoritativeOverrides: authoritativeOverrideCount,
      stalenessWarning,
      priceStaleness: stalenessSummary,
      upstreamFetchOk: false,
      payloadAccepted: true,
      cacheWriteSucceeded: true,
      depegPipelineSucceeded: depegErrorCount === 0,
    }, {
      cacheWriteMode: "fallback-write",
      capabilities: {
        stablecoinsCache: true,
        depegPipeline: depegErrorCount === 0,
      },
    }),
  };
  await reportStablecoinsStage(reportProgress, "complete", "Completed stablecoins fallback sync", {
    itemsDone: assets.length,
    itemsTotal: assets.length,
    metadata: {
      path: "fallback",
      status: result.status ?? "ok",
    },
  });
  return result;
}
