import { setCacheIfNewer, getPriceCache, savePriceCache } from "../lib/db-cache";
import { fetchWithRetry } from "../lib/fetch-retry";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { REGISTRY_BY_LLAMA_ID } from "@shared/lib/stablecoin-id-registry";
import {
  enrichMissingPrices,
  hasMissingPrice,
  fetchPrimaryPrices,
} from "./enrich-prices";
import type { PeggedAsset } from "./enrich-prices";
import { detectDepegEvents } from "./detect-depegs";
import { confirmPendingDepegs } from "./confirm-pending-depegs";
import {
  applyTrackedAssetOverrides,
  dedupeCanonicalAssets,
  detectPriceStaleness,
  fillMissingSupplyHistory,
  filterStructurallyValidAssets,
  normalizeChainCirculating,
} from "./sync-stablecoins/stages";
import {
  fetchCoinGeckoMarketData,
  fetchSupplementalTrackedTokens,
  type CoinGeckoMcapData,
} from "./sync-stablecoins/supplemental-assets";
import {
  StablecoinListResponseSchema,
  buildSyncMetadata,
  getStablecoinsCacheAgeSec,
  hydrateGeckoIdAliases,
  loadFreshFxRates,
  loadPreviousStablecoinsById,
  mergeSupplementalLastKnownGood,
  normalizeStablecoinsPayload,
  stampPriceMetadata,
  summarizeValidationIssues,
  writeInvalidStablecoinsDiagnostic,
  type StablecoinsPayload,
  type CronResult,
  type PriceSourceHealth,
} from "./sync-stablecoins/shared";

import { upsertDiscoveryCandidates } from "./discovery-scan";
import { DEFILLAMA_BASE, MIN_VALID_ASSET_COUNT, CIRCUIT_SOURCE } from "../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { validatePayloadWithSchema } from "../lib/api-utils";
import { sendAlert } from "../lib/alerts";
import { fetchAuthoritativeLivePriceOverrides } from "../lib/authoritative-price-sources";
import {
  buildPriceValidationContext,
  validatePriceCandidate,
  type PriceValidationContext,
} from "../lib/price-validation";
const PRICE_CACHE_TTL = 24 * 60 * 60;

function priceValidationModeForAsset(asset: PeggedAsset): "primary_authoritative" | "fallback_enrichment" {
  return asset.priceConfidence === "fallback" ||
    asset.priceSource === "coinmarketcap" ||
    asset.priceSource === "dexscreener" ||
    asset.priceSource === "cached"
    ? "fallback_enrichment"
    : "primary_authoritative";
}

function createValidationContextResolver(): {
  get: (asset: PeggedAsset) => PriceValidationContext;
} {
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
 */
async function fallbackToCgSupply(
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
  for (const meta of TRACKED_STABLECOINS) {
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
  const authoritativeOverrides = await fetchAuthoritativeLivePriceOverrides(assets, signal);
  let authoritativeOverrideCount = 0;
  for (const asset of assets) {
    const override = authoritativeOverrides.get(asset.id);
    if (!override) continue;

    const decision = validatePriceCandidate(
      override.price,
      validationContexts.get(asset),
      "primary_authoritative",
      validationReferences,
    );
    if (!decision.accepted) continue;

    asset.price = override.price;
    stampPriceMetadata(asset, override.source, override.confidence, syncStartSec, [override.source], [override.source]);
    authoritativeOverrideCount++;
  }

  for (const asset of assets) {
    if (!asset.supplySource) {
      asset.supplySource = "coingecko-fallback";
    }
  }

  for (const asset of assets) {
    if (asset.price == null || typeof asset.price !== "number" || asset.price === 0) continue;
    const decision = validatePriceCandidate(
      asset.price,
      validationContexts.get(asset),
      "primary_authoritative",
      validationReferences,
    );
    if (!decision.accepted) {
      console.warn(`[sync-stablecoins] Pre-rejected fallback price for ${asset.symbol} (id=${asset.id}): $${asset.price}`);
      asset.price = 0;
      stampPriceMetadata(asset, asset.priceSource || "unknown", null, null);
    }
  }

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

  let rejectedCount = 0;
  for (const asset of assets) {
    if (asset.price == null || typeof asset.price !== "number") continue;
    const decision = validatePriceCandidate(
      asset.price,
      validationContexts.get(asset),
      priceValidationModeForAsset(asset),
      validationReferences,
    );
    if (!decision.accepted) {
      console.warn(`[sync-stablecoins] Rejected unreasonable fallback price for ${asset.symbol} (id=${asset.id}): $${asset.price}`);
      asset.price = null;
      asset.priceUpdatedAt = null;
      rejectedCount++;
    }
  }

  const withValidPrices = assets.filter(
    (asset) => asset.price != null && typeof asset.price === "number" && asset.price > 0,
  );
  if (withValidPrices.length > 0) {
    const priceCacheWriteAbort = returnIfAborted(signal, "fallback-save-price-cache");
    if (priceCacheWriteAbort) return priceCacheWriteAbort;
    await savePriceCache(db, withValidPrices.map((asset) => ({ id: asset.id, price: asset.price! as number })));
  }

  const now = Math.floor(Date.now() / 1000);
  const stillMissing = assets.filter(
    (asset) => missingBefore.has(asset.id) && hasMissingPrice(asset),
  );
  let cachedFallbackCount = 0;
  if (stillMissing.length > 0) {
    const priceCacheReadAbort = returnIfAborted(signal, "fallback-read-price-cache");
    if (priceCacheReadAbort) return priceCacheReadAbort;
    const priceCache = await getPriceCache(db);
    for (const asset of stillMissing) {
      const cached = priceCache.get(asset.id);
      if (!cached || (now - cached.updatedAt) >= PRICE_CACHE_TTL) continue;
      const decision = validatePriceCandidate(
        cached.price,
        validationContexts.get(asset),
        "fallback_enrichment",
        validationReferences,
      );
      if (!decision.accepted) continue;

      asset.price = cached.price;
      stampPriceMetadata(asset, "cached", "fallback", cached.updatedAt);
      cachedFallbackCount++;
    }
  }

  const llamaData: StablecoinsPayload = { peggedAssets: assets, fxFallbackRates };
  const normalizedPayload = normalizeStablecoinsPayload(llamaData);
  const validation = validatePayloadWithSchema(
    StablecoinListResponseSchema,
    normalizedPayload,
    "sync-stablecoins:stablecoins:fallback",
  );
  if (!validation.ok) {
    const issueSummary = summarizeValidationIssues(validation.issues);
    const stablecoinsCacheAgeSec = await getStablecoinsCacheAgeSec(db);
    console.error("[sync-stablecoins] Schema validation failed in CG fallback; blocking stablecoins cache write:", issueSummary);
    await sendAlert(
      alertWebhookUrl ?? null,
      "Stablecoins schema validation warning",
      `context=fallback; blocked stablecoins cache write; issues=${issueSummary}; stablecoinsCacheAgeSec=${stablecoinsCacheAgeSec ?? "missing"}`,
    );
    await writeInvalidStablecoinsDiagnostic(
      db,
      syncStartSec,
      "fallback",
      normalizedPayload,
      validation.issues,
      stablecoinsCacheAgeSec,
    );
    return {
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
    };
  }
  const cacheWriteAbort = returnIfAborted(signal, "fallback-cache-write");
  if (cacheWriteAbort) return cacheWriteAbort;
  await setCacheIfNewer(db, "stablecoins", JSON.stringify(validation.data), syncStartSec);
  console.log(`[sync-stablecoins] CG fallback: cached ${assets.length} assets`);

  let depegErrorCount = 0;
  try {
    const depegAbort = returnIfAborted(signal, "fallback-depeg-detection");
    if (depegAbort) return depegAbort;
    await detectDepegEvents(db, assets, fxFallbackRates, signal);
  } catch (err) {
    if (signal?.aborted) return abortResult(signal, "fallback-depeg-detection");
    console.error("[sync-stablecoins] Depeg detection failed (CG fallback):", err);
    depegErrorCount++;
  }

  try {
    const confirmAbort = returnIfAborted(signal, "fallback-depeg-confirmation");
    if (confirmAbort) return confirmAbort;
    await confirmPendingDepegs(db, assets, fxFallbackRates, signal, coingeckoApiKey);
  } catch (err) {
    if (signal?.aborted) return abortResult(signal, "fallback-depeg-confirmation");
    console.error("[sync-stablecoins] Pending depeg confirmation failed (CG fallback):", err);
    depegErrorCount++;
  }

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

export async function syncStablecoins(db: D1Database, cmcApiKey?: string, signal?: AbortSignal, alertWebhookUrl?: string | null, coingeckoApiKey?: string | null): Promise<CronResult> {
  const startAbort = returnIfAborted(signal, "start");
  if (startAbort) return startAbort;
  const syncStartSec = Math.floor(Date.now() / 1000);

  const previousAssetsById = await loadPreviousStablecoinsById(db);
  const cgData = await fetchCoinGeckoMarketData(db, signal, coingeckoApiKey);

  // Check circuit breaker before DL fetch
  const dlAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_STABLECOINS);

  const preFetchAbort = returnIfAborted(signal, "fetch-stablecoins-and-supplementals");
  if (preFetchAbort) return preFetchAbort;
  const [llamaRes, supplementalTokens] = await Promise.all([
    dlAllowed
      ? fetchWithRetry(`${DEFILLAMA_BASE}/stablecoins?includePrices=true`, signal ? { signal } : undefined)
      : Promise.resolve(null),
    fetchSupplementalTrackedTokens(cgData, signal, coingeckoApiKey),
  ]);
  const { goldTokens, silverTokens, fiatCgTokens } = supplementalTokens;

  // Record DL outcome and fallback if needed
  if (dlAllowed) {
    if (!llamaRes?.ok) {
      console.error(`[sync-stablecoins] DefiLlama API error: ${llamaRes?.status ?? "no response"}`);
      await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
      const fallback = await fallbackToCgSupply(db, cgData, cmcApiKey, syncStartSec, signal, alertWebhookUrl, coingeckoApiKey);
      if (fallback.itemCount && fallback.itemCount > 0) return fallback;
      throw new Error("DefiLlama stablecoins API failed and CoinGecko fallback was insufficient");
    }
  } else {
    console.warn("[sync-stablecoins] DL stablecoins circuit open — using CG supply fallback");
    const fallback = await fallbackToCgSupply(db, cgData, cmcApiKey, syncStartSec, signal, alertWebhookUrl, coingeckoApiKey);
    if (fallback.itemCount && fallback.itemCount > 0) return fallback;
    throw new Error("DefiLlama stablecoins circuit open and CoinGecko fallback was insufficient");
  }

  const parseAbort = returnIfAborted(signal, "parse-defillama-payload");
  if (parseAbort) return parseAbort;
  const llamaData = await llamaRes!.json() as { peggedAssets: PeggedAsset[]; fxFallbackRates?: Record<string, number> };
  const rawAssetCount = llamaData.peggedAssets?.length ?? 0;

  if (llamaData.peggedAssets === undefined) console.warn("[sync] DefiLlama response missing peggedAssets field — possible API contract change");
  if (!llamaData.peggedAssets || llamaData.peggedAssets.length < MIN_VALID_ASSET_COUNT) {
    console.error(`[sync-stablecoins] Unexpected asset count (${llamaData.peggedAssets?.length}), need ${MIN_VALID_ASSET_COUNT}+, skipping cache write`);
    await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    const fallback = await fallbackToCgSupply(db, cgData, cmcApiKey, syncStartSec, signal, alertWebhookUrl, coingeckoApiKey);
    if (fallback.itemCount && fallback.itemCount > 0) return fallback;
    throw new Error(
      `DefiLlama payload was structurally invalid (asset count=${llamaData.peggedAssets?.length ?? 0}) and fallback failed`,
    );
  }

  // Structural validation: ensure assets have required fields
  const { validAssets, droppedMalformedAssets } = filterStructurallyValidAssets(llamaData.peggedAssets);
  if (validAssets.length < MIN_VALID_ASSET_COUNT) {
    console.error(`[sync-stablecoins] Only ${validAssets.length} valid assets (need ${MIN_VALID_ASSET_COUNT}+), skipping cache write`);
    await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    const fallback = await fallbackToCgSupply(db, cgData, cmcApiKey, syncStartSec, signal, alertWebhookUrl, coingeckoApiKey);
    if (fallback.itemCount && fallback.itemCount > 0) return fallback;
    throw new Error(
      `DefiLlama payload had too many malformed assets (valid=${validAssets.length}) and fallback failed`,
    );
  }
  if (validAssets.length < llamaData.peggedAssets.length) {
    console.warn(`[sync-stablecoins] Dropped ${llamaData.peggedAssets.length - validAssets.length} malformed assets`);
    llamaData.peggedAssets = validAssets;
  }

  // DefiLlama may emit `gecko_id` (snake_case). Hydrate `geckoId` early so
  // primary price and enrichment passes can still use CoinGecko identifiers.
  hydrateGeckoIdAliases(llamaData.peggedAssets);

  // Normalize chainCirculating: DL returns peg-bucket objects ({peggedUSD: N})
  // for current/prev values — flatten to plain numbers so the frontend schema
  // and components can consume them directly.
  normalizeChainCirculating(llamaData.peggedAssets);

  // Discovery Source A: DL residuals — upsert untracked coins with circulating > $5M
  const dlResiduals = llamaData.peggedAssets
    .filter((a) => !REGISTRY_BY_LLAMA_ID.has(String(a.id)))
    .filter((a) => {
      const circ = a.circulating;
      if (!circ || typeof circ !== "object") return false;
      const total = Object.values(circ).reduce((sum: number, v: unknown) => sum + (typeof v === "number" ? v : 0), 0);
      return total >= 5_000_000;
    })
    .map((a) => ({
      llamaId: Number(a.id),
      name: a.name as string,
      symbol: a.symbol as string,
      marketCap: Object.values(a.circulating ?? {}).reduce((sum: number, v: unknown) => sum + (typeof v === "number" ? v : 0), 0),
      source: "defillama",
    }));

  if (dlResiduals.length > 0) {
    try {
      await upsertDiscoveryCandidates(db, dlResiduals);
      console.log(`[discovery] DL residuals: ${dlResiduals.length} untracked coins above $5M`);
    } catch (err) {
      console.warn("[discovery] DL residuals upsert failed:", err);
    }
  }

  // Remap DefiLlama numeric IDs to canonical IDs as early as possible.
  // Unmapped assets keep their original IDs and are filtered downstream.
  for (const asset of llamaData.peggedAssets) {
    const mapped = REGISTRY_BY_LLAMA_ID.get(String(asset.id));
    if (mapped) {
      asset.id = mapped.id;
    }
  }

  const canonicalDeduplication = dedupeCanonicalAssets(llamaData.peggedAssets);
  if (canonicalDeduplication.duplicateRows > 0) {
    console.warn(
      `[sync-stablecoins] Deduped ${canonicalDeduplication.duplicateRows} canonical duplicate row(s): ` +
      canonicalDeduplication.affectedIds.join(", "),
    );
    llamaData.peggedAssets = canonicalDeduplication.dedupedAssets;
  }
  if (llamaData.peggedAssets.length < MIN_VALID_ASSET_COUNT) {
    console.error(
      `[sync-stablecoins] Canonical dedupe reduced asset count to ${llamaData.peggedAssets.length} ` +
      `(need ${MIN_VALID_ASSET_COUNT}+), skipping cache write`,
    );
    await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    const fallback = await fallbackToCgSupply(db, cgData, cmcApiKey, syncStartSec, signal, alertWebhookUrl, coingeckoApiKey);
    if (fallback.itemCount && fallback.itemCount > 0) return fallback;
    throw new Error(
      `DefiLlama payload collapsed to ${llamaData.peggedAssets.length} unique canonical IDs and fallback failed`,
    );
  }

  const supplementalResolution = mergeSupplementalLastKnownGood(
    [...goldTokens, ...silverTokens, ...fiatCgTokens],
    previousAssetsById,
    new Set(llamaData.peggedAssets.map((asset) => String(asset.id))),
  );
  if (supplementalResolution.assets.length > 0) {
    llamaData.peggedAssets = [...llamaData.peggedAssets, ...supplementalResolution.assets];
  }
  if (supplementalResolution.restoredCount > 0 || supplementalResolution.skippedDuplicates > 0) {
    console.log(
      `[sync-stablecoins] Supplemental resolution: restored=${supplementalResolution.restoredCount}, ` +
      `skippedDuplicates=${supplementalResolution.skippedDuplicates}`,
    );
  }

  // Always prefer curated metadata over DefiLlama fields; includes known address patches.
  applyTrackedAssetOverrides(llamaData.peggedAssets);

  // Load FX rates early for dynamic price bounds in validatePriceCandidate
  const { fxFallbackRates: fxRates, validationReferences } = await loadFreshFxRates(db, syncStartSec);
  const validationContexts = createValidationContextResolver();

  // --- Primary price validation ---
  // Cross-validate DL coins API and CG prices for higher confidence
  const primaryPricesAbort = returnIfAborted(signal, "primary-prices");
  if (primaryPricesAbort) return primaryPricesAbort;
  const { results: primaryPriceResults, stats: priceValidationStats } = await fetchPrimaryPrices(
    llamaData.peggedAssets, db, signal, validationReferences, coingeckoApiKey,
  );
  const protocolPriceOverrides = await fetchAuthoritativeLivePriceOverrides(llamaData.peggedAssets, signal);
  const protocolOverrideCount = protocolPriceOverrides.size;

  // Apply primary price results — these override the DL list endpoint prices
  for (const asset of llamaData.peggedAssets) {
    const primary = primaryPriceResults.get(asset.id);
    if (primary) {
      const decision = validatePriceCandidate(
        primary.price,
        validationContexts.get(asset),
        "primary_authoritative",
        validationReferences,
      );
      if (decision.accepted) {
        asset.price = primary.price;
        stampPriceMetadata(asset, primary.source, primary.confidence, syncStartSec, primary.candidateSources, primary.agreeSources);
      } else if (asset.price != null && typeof asset.price === "number" && asset.price > 0) {
        stampPriceMetadata(asset, asset.priceSource || "defillama", "single-source", syncStartSec, [asset.priceSource || "defillama"], [asset.priceSource || "defillama"]);
      }
    } else if (asset.price != null && typeof asset.price === "number" && asset.price > 0) {
      // DL list provided a price but no primary price result — single-source
      stampPriceMetadata(asset, asset.priceSource || "defillama", "single-source", syncStartSec, [asset.priceSource || "defillama"], [asset.priceSource || "defillama"]);
    }
  }

  // Protocol-backed overrides supersede market-source prices when direct redemption
  // or protocol accounting provides a more authoritative mark.
  for (const asset of llamaData.peggedAssets) {
    const override = protocolPriceOverrides.get(asset.id);
    if (!override) continue;

    const decision = validatePriceCandidate(
      override.price,
      validationContexts.get(asset),
      "primary_authoritative",
      validationReferences,
    );
    if (!decision.accepted) continue;

    asset.price = override.price;
    stampPriceMetadata(asset, override.source, override.confidence, syncStartSec, [override.source], [override.source]);
  }
  if (protocolOverrideCount > 0) {
    console.log(`[sync-stablecoins] Applied ${protocolOverrideCount} protocol-backed price override${protocolOverrideCount === 1 ? "" : "s"}`);
  }

  // Tag all DL-sourced assets with supplySource
  for (const asset of llamaData.peggedAssets) {
    if (!asset.supplySource) {
      asset.supplySource = "defillama";
    }
  }

  // Pre-validate: route unreasonable prices through enrichment
  for (const asset of llamaData.peggedAssets) {
    if (
      asset.price != null &&
      typeof asset.price === "number" &&
      asset.price !== 0
    ) {
      const decision = validatePriceCandidate(
        asset.price,
        validationContexts.get(asset),
        "primary_authoritative",
        validationReferences,
      );
      if (!decision.accepted) {
        console.warn(`[sync-stablecoins] Pre-rejected bad price for ${asset.symbol} (id=${asset.id}): $${asset.price}`);
        asset.price = 0; // hasMissingPrice() treats 0 as missing
        stampPriceMetadata(asset, asset.priceSource || "unknown", null, null);
      }
    }
  }

  // Enrich any assets that still have missing prices
  const missingBefore = new Set(
    llamaData.peggedAssets.filter(hasMissingPrice).map((a) => a.id)
  );
  const enrichAbort = returnIfAborted(signal, "enrich-prices");
  if (enrichAbort) return enrichAbort;
  const enrichStats = await enrichMissingPrices(llamaData.peggedAssets, cmcApiKey, db, signal);

  // Tag enriched assets with fallback confidence
  for (const asset of llamaData.peggedAssets) {
    if (missingBefore.has(asset.id) && !hasMissingPrice(asset) && !asset.priceConfidence) {
      stampPriceMetadata(asset, asset.priceSource || "unknown", "fallback", syncStartSec);
    }
  }

  // --- Reject unreasonable prices BEFORE caching ---
  // Must run before savePriceCache so bad prices don't persist for 24h
  let rejectedCount = 0;
  for (const asset of llamaData.peggedAssets) {
    if (asset.price != null && typeof asset.price === "number") {
      const decision = validatePriceCandidate(
        asset.price,
        validationContexts.get(asset),
        priceValidationModeForAsset(asset),
        validationReferences,
      );
      if (!decision.accepted) {
        console.warn(`[sync-stablecoins] Rejected unreasonable price for ${asset.symbol} (id=${asset.id}): $${asset.price}`);
        asset.price = null;
        asset.priceUpdatedAt = null;
        rejectedCount++;
      }
    }
  }
  if (rejectedCount > 0) {
    console.log(`[sync-stablecoins] Rejected ${rejectedCount} unreasonable prices`);
  }

  // --- Price cache: save successes, apply fallbacks ---
  const now = Math.floor(Date.now() / 1000);

  // Save ALL assets with valid prices so other crons (mint-burn sync) can look them up.
  // Previously only enriched assets were cached, starving mint-burn of price data.
  const withValidPrices = llamaData.peggedAssets.filter(
    (a) => a.price != null && typeof a.price === "number" && a.price > 0
  );
  if (withValidPrices.length > 0) {
    const priceCacheWriteAbort = returnIfAborted(signal, "save-price-cache");
    if (priceCacheWriteAbort) return priceCacheWriteAbort;
    await savePriceCache(db, withValidPrices.map((a) => ({ id: a.id, price: a.price! as number })));
  }

  // Fallback: coins still missing — apply cached price if within TTL
  const stillMissing = llamaData.peggedAssets.filter(
    (a) => missingBefore.has(a.id) && hasMissingPrice(a)
  );
  if (stillMissing.length > 0) {
    const priceCacheReadAbort = returnIfAborted(signal, "read-price-cache");
    if (priceCacheReadAbort) return priceCacheReadAbort;
    const priceCache = await getPriceCache(db);
    let fallbackCount = 0;
    for (const asset of stillMissing) {
      const cached = priceCache.get(asset.id);
      if (cached && (now - cached.updatedAt) < PRICE_CACHE_TTL) {
        const decision = validatePriceCandidate(
          cached.price,
          validationContexts.get(asset),
          "fallback_enrichment",
          validationReferences,
        );
        if (decision.accepted) {
          asset.price = cached.price;
          stampPriceMetadata(asset, "cached", "fallback", cached.updatedAt);
          fallbackCount++;
        }
      }
    }
    if (fallbackCount > 0) {
      console.log(`[sync-stablecoins] Applied ${fallbackCount} cached fallback prices`);
    }
  }

  // --- Fill missing circulatingPrev* from supply_history snapshots ---
  try {
    const fillAbort = returnIfAborted(signal, "fill-supply-history");
    if (fillAbort) return fillAbort;
    const fillCount = await fillMissingSupplyHistory(db, llamaData.peggedAssets, signal);
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
    const staleness = await detectPriceStaleness(db, llamaData.peggedAssets, signal);
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

  // Embed live FX fallback rates if available (reuse earlier fetch)
  if (fxRates) {
    llamaData.fxFallbackRates = fxRates;
  }

  const validationAbort = returnIfAborted(signal, "validate-stablecoins-payload");
  if (validationAbort) return validationAbort;
  const normalizedPayload = normalizeStablecoinsPayload(llamaData);
  const validation = validatePayloadWithSchema(
    StablecoinListResponseSchema,
    normalizedPayload,
    "sync-stablecoins:stablecoins",
  );
  if (!validation.ok) {
    const issueSummary = summarizeValidationIssues(validation.issues);
    const stablecoinsCacheAgeSec = await getStablecoinsCacheAgeSec(db);
    console.error("[sync-stablecoins] Schema validation failed; blocking stablecoins cache write:", issueSummary);
    await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    await sendAlert(
      alertWebhookUrl ?? null,
      "Stablecoins schema validation warning",
      `context=main; blocked stablecoins cache write; issues=${issueSummary}; stablecoinsCacheAgeSec=${stablecoinsCacheAgeSec ?? "missing"}`,
    );
    await writeInvalidStablecoinsDiagnostic(
      db,
      syncStartSec,
      "main",
      normalizedPayload,
      validation.issues,
      stablecoinsCacheAgeSec,
    );
    return {
      status: "degraded",
      itemCount: llamaData.peggedAssets.length,
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
    };
  }

  const cachePersistAbort = returnIfAborted(signal, "persist-main-cache");
  if (cachePersistAbort) return cachePersistAbort;
  await setCacheIfNewer(db, "stablecoins", JSON.stringify(validation.data), syncStartSec);
  await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, true);
  console.log(`[sync-stablecoins] Cached ${llamaData.peggedAssets.length} assets`);

  // Detect depeg events from current price data
  let depegErrorCount = 0;
  const depegErrors: string[] = [];
  try {
    const depegDetectAbort = returnIfAborted(signal, "depeg-detection");
    if (depegDetectAbort) return depegDetectAbort;
    await detectDepegEvents(db, llamaData.peggedAssets, llamaData.fxFallbackRates, signal);
  } catch (err) {
    if (signal?.aborted) return abortResult(signal, "depeg-detection");
    console.error("[sync-stablecoins] Depeg detection failed:", err);
    depegErrorCount += 1;
    depegErrors.push(`detection: ${String(err).slice(0, 200)}`);
  }

  // Confirm or expire pending depeg events for >$1B coins
  try {
    const depegConfirmAbort = returnIfAborted(signal, "depeg-confirmation");
    if (depegConfirmAbort) return depegConfirmAbort;
    await confirmPendingDepegs(db, llamaData.peggedAssets, llamaData.fxFallbackRates, signal, coingeckoApiKey);
  } catch (err) {
    if (signal?.aborted) return abortResult(signal, "depeg-confirmation");
    console.error("[sync-stablecoins] Pending depeg confirmation failed:", err);
    depegErrorCount += 1;
    depegErrors.push(`confirmation: ${String(err).slice(0, 200)}`);
  }

  // Build metadata for cron_runs observability
  let status: CronResult["status"] = "ok";
  if (depegErrorCount > 0) {
    status = "degraded";
  }

  function mapSourceToBucket(
    source: string,
    dist: PriceSourceHealth["sourceDistribution"],
  ): keyof PriceSourceHealth["sourceDistribution"] | null {
    if (source in dist) return source as keyof typeof dist;
    const firstSource = source.split("+")[0];
    if (firstSource in dist) return firstSource as keyof typeof dist;
    return null;
  }

  const finalMissing = llamaData.peggedAssets.filter(hasMissingPrice).length;
  const finalSourceDistribution: PriceSourceHealth["sourceDistribution"] = {
    "coingecko+defillama": 0,
    coingecko: 0,
    defillama: 0,
    "protocol-redeem": 0,
    "defillama-contract": 0,
    coinmarketcap: 0,
    dexscreener: 0,
    pyth: 0,
    binance: 0,
    coinbase: 0,
    redstone: 0,
    "curve-onchain": 0,
    "dex-promoted": 0,
    cached: 0,
    missing: 0,
  };
  const finalConfidenceDistribution: PriceSourceHealth["confidenceDistribution"] = {
    high: 0,
    "single-source": 0,
    low: 0,
    fallback: 0,
  };

  for (const asset of llamaData.peggedAssets) {
    if (hasMissingPrice(asset)) {
      finalSourceDistribution.missing++;
      continue;
    }

    const source = asset.priceSource;
    const bucket = source ? mapSourceToBucket(source, finalSourceDistribution) : null;
    if (bucket) {
      finalSourceDistribution[bucket]++;
    }

    const confidence = asset.priceConfidence;
    if (confidence && confidence in finalConfidenceDistribution) {
      finalConfidenceDistribution[confidence as keyof typeof finalConfidenceDistribution]++;
    }
  }

  // Build price source health from the final resolved asset payload.
  const priceSourceHealth: PriceSourceHealth = {
    sourceDistribution: finalSourceDistribution,
    confidenceDistribution: finalConfidenceDistribution,
    divergences: priceValidationStats.divergences.slice(0, 10).map((d) => ({
      id: d.id,
      symbol: d.symbol,
      cgPrice: d.cgPrice,
      dlPrice: d.dlPrice,
      bps: d.bps,
    })),
    totalAssets: llamaData.peggedAssets.length,
    lastSync: Math.floor(Date.now() / 1000),
  };

  const metadata: Record<string, unknown> = {
    rowsRead: rawAssetCount,
    rowsWritten: llamaData.peggedAssets.length,
    rowsDropped: droppedMalformedAssets,
    sourceCoverage: { defillama: true },
    fallbackMode: null,
    validationFailures: 0,
    canonicalDeduplication,
    assetCount: llamaData.peggedAssets.length,
    enrichment: enrichStats,
    priceValidation: priceValidationStats,
    rejectedPrices: rejectedCount,
    missingPrices: finalMissing,
    priceSourceHealth,
  };
  if (stalenessWarning) metadata.stalenessWarning = true;
  if (depegErrorCount > 0) {
    metadata.depegErrorCount = depegErrorCount;
    metadata.depegErrors = depegErrors;
  }

  return {
    itemCount: llamaData.peggedAssets.length,
    status,
    metadata: buildSyncMetadata(metadata, {
      cacheWriteMode: "main-write",
      capabilities: {
        stablecoinsCache: true,
        depegPipeline: depegErrorCount === 0,
      },
    }),
  };
}
