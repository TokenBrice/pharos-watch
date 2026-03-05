import { setCacheIfNewer, getCache, getPriceCache, savePriceCache } from "../lib/db";
import { fetchWithRetry } from "../lib/fetch-retry";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { enrichMissingPrices, hasMissingPrice, isReasonablePrice, fetchDualPrimaryPrices } from "./enrich-prices";
import type { PeggedAsset } from "./enrich-prices";
import type { CronResult } from "../lib/db";
import { detectDepegEvents } from "./detect-depegs";
import { confirmPendingDepegs } from "./confirm-pending-depegs";
import {
  applyTrackedAssetOverrides,
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

import { DEFILLAMA_BASE, MIN_VALID_ASSET_COUNT, CIRCUIT_SOURCE } from "../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { StablecoinListResponseSchema } from "@shared/types";
import { validatePayloadWithSchema } from "../lib/api-utils";
import { sendAlert } from "../lib/alerts";

const INVALID_STABLECOINS_CACHE_KEY = "stablecoins:invalid-last";
const VALIDATION_ISSUES_MAX_CHARS = 400;

type StablecoinsPayload = {
  peggedAssets: PeggedAsset[];
  fxFallbackRates?: Record<string, number>;
};

function resolveGeckoId(asset: PeggedAsset): string | undefined {
  if (typeof asset.geckoId === "string" && asset.geckoId.length > 0) {
    return asset.geckoId;
  }
  const snakeCase = asset["gecko_id"];
  if (typeof snakeCase === "string" && snakeCase.length > 0) {
    return snakeCase;
  }
  return undefined;
}

function toPegBuckets(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = raw;
    }
  }
  return out;
}

function normalizeStablecoinsPayload(payload: StablecoinsPayload): StablecoinsPayload {
  return {
    ...payload,
    peggedAssets: payload.peggedAssets.map((asset) => {
      const { gecko_id: _ignoredSnakeCase, ...rest } = asset as PeggedAsset & { gecko_id?: unknown };
      const confidence = asset.priceConfidence;
      const normalizedConfidence =
        confidence === "high" || confidence === "single-source" || confidence === "low" || confidence === "fallback"
          ? confidence
          : null;

      return {
        ...rest,
        geckoId: resolveGeckoId(asset),
        priceConfidence: normalizedConfidence,
        circulatingPrevDay: toPegBuckets(asset.circulatingPrevDay),
        circulatingPrevWeek: toPegBuckets(asset.circulatingPrevWeek),
        circulatingPrevMonth: toPegBuckets(asset.circulatingPrevMonth),
      };
    }),
  };
}

function summarizeValidationIssues(issues: string): string {
  if (issues.length <= VALIDATION_ISSUES_MAX_CHARS) return issues;
  return `${issues.slice(0, VALIDATION_ISSUES_MAX_CHARS)}...`;
}

async function getStablecoinsCacheAgeSec(db: D1Database): Promise<number | null> {
  const stablecoinsCache = await getCache(db, "stablecoins");
  if (!stablecoinsCache) return null;
  return Math.max(0, Math.floor(Date.now() / 1000) - stablecoinsCache.updatedAt);
}

async function writeInvalidStablecoinsDiagnostic(
  db: D1Database,
  syncStartSec: number,
  context: "main" | "fallback",
  payload: StablecoinsPayload,
  validationIssues: string,
  stablecoinsCacheAgeSec: number | null,
): Promise<void> {
  await setCacheIfNewer(
    db,
    INVALID_STABLECOINS_CACHE_KEY,
    JSON.stringify({
      context,
      detectedAt: syncStartSec,
      stablecoinsCacheAgeSec,
      validationIssues: summarizeValidationIssues(validationIssues),
      payload,
    }),
    syncStartSec,
  );
}

function hydrateGeckoIdAliases(assets: PeggedAsset[]): void {
  for (const asset of assets) {
    if (typeof asset.geckoId === "string" && asset.geckoId.length > 0) continue;
    const geckoId = resolveGeckoId(asset);
    if (geckoId) asset.geckoId = geckoId;
  }
}

function isReasonablePriceForAsset(
  asset: PeggedAsset,
  price: number,
  fxRates?: Record<string, number>,
): boolean {
  const meta = TRACKED_META_BY_ID.get(String(asset.id));
  const navToken = !!meta?.flags?.navToken || !!asset.navToken;
  return isReasonablePrice(price, asset.pegType as string | undefined, fxRates, { navToken });
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
): Promise<CronResult> {
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
      metadata: JSON.stringify({
        rowsRead: assets.length,
        rowsWritten: 0,
        rowsDropped: 0,
        sourceCoverage: { defillama: false, coingeckoFallbackAssets: assets.length },
        fallbackMode: "coingecko-supply-fallback",
        validationFailures: 1,
      }),
    };
  }

  // Try to restore stale chainCirculating from previous DL cache
  try {
    const prevCache = await getCache(db, "stablecoins");
    if (prevCache) {
      const prevData = JSON.parse(prevCache.value) as { peggedAssets?: PeggedAsset[] };
      if (prevData.peggedAssets) {
        const prevMap = new Map(prevData.peggedAssets.map((a) => [String(a.id), a]));
        for (const asset of assets) {
          const prev = prevMap.get(String(asset.id));
          if (prev?.chainCirculating) {
            asset.chainCirculating = prev.chainCirculating;
            asset.chains = prev.chains ?? [];
          }
          // Restore historical supply if available
          if (prev?.circulatingPrevDay) asset.circulatingPrevDay = prev.circulatingPrevDay;
          if (prev?.circulatingPrevWeek) asset.circulatingPrevWeek = prev.circulatingPrevWeek;
          if (prev?.circulatingPrevMonth) asset.circulatingPrevMonth = prev.circulatingPrevMonth;
        }
      }
    }
  } catch (e) {
    console.warn("[sync-stablecoins] Failed to restore stale cache data:", e);
  }

  // Enrich missing prices
  const enrichStats = await enrichMissingPrices(assets, cmcApiKey, db);

  // Embed FX rates
  const fxCache = await getCache(db, "fx-rates");
  let fxFallbackRates: Record<string, number> | undefined;
  if (fxCache) {
    try {
      fxFallbackRates = JSON.parse(fxCache.value);
    } catch { /* ignore */ }
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
      metadata: JSON.stringify({
        rowsRead: assets.length,
        rowsWritten: 0,
        rowsDropped: 0,
        sourceCoverage: { defillama: false, coingeckoFallbackAssets: assets.length },
        fallbackMode: "coingecko-supply-fallback",
        validationFailures: 1,
        validationContext: "fallback",
        stablecoinsCacheAgeSec,
        cacheWriteMode: "blocked-invalid-payload",
      }),
    };
  }
  await setCacheIfNewer(db, "stablecoins", JSON.stringify(validation.data), syncStartSec);
  console.log(`[sync-stablecoins] CG fallback: cached ${assets.length} assets`);

  // Still run depeg detection
  try {
    await detectDepegEvents(db, assets, fxFallbackRates);
  } catch (err) {
    console.error("[sync-stablecoins] Depeg detection failed (CG fallback):", err);
  }

  return {
    itemCount: assets.length,
    metadata: JSON.stringify({
      rowsRead: assets.length,
      rowsWritten: assets.length,
      rowsDropped: 0,
      sourceCoverage: { defillama: false, coingeckoFallbackAssets: assets.length },
      fallbackMode: "coingecko-supply-fallback",
      validationFailures: 0,
      enrichment: enrichStats,
    }),
  };
}

export async function syncStablecoins(db: D1Database, cmcApiKey?: string, signal?: AbortSignal): Promise<CronResult> {
  const syncStartSec = Math.floor(Date.now() / 1000);

  const cgData = await fetchCoinGeckoMarketData();

  // Check circuit breaker before DL fetch
  const dlAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_STABLECOINS);

  const [llamaRes, supplementalTokens] = await Promise.all([
    dlAllowed
      ? fetchWithRetry(`${DEFILLAMA_BASE}/stablecoins?includePrices=true`, signal ? { signal } : undefined)
      : Promise.resolve(null),
    fetchSupplementalTrackedTokens(cgData),
  ]);
  const { goldTokens, silverTokens, fiatCgTokens } = supplementalTokens;

  // Record DL outcome and fallback if needed
  if (dlAllowed) {
    if (!llamaRes?.ok) {
      console.error(`[sync-stablecoins] DefiLlama API error: ${llamaRes?.status ?? "no response"}`);
      await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
      const fallback = await fallbackToCgSupply(db, cgData, cmcApiKey, syncStartSec);
      if (fallback.itemCount && fallback.itemCount > 0) return fallback;
      throw new Error("DefiLlama stablecoins API failed and CoinGecko fallback was insufficient");
    }
  } else {
    console.warn("[sync-stablecoins] DL stablecoins circuit open — using CG supply fallback");
    const fallback = await fallbackToCgSupply(db, cgData, cmcApiKey, syncStartSec);
    if (fallback.itemCount && fallback.itemCount > 0) return fallback;
    throw new Error("DefiLlama stablecoins circuit open and CoinGecko fallback was insufficient");
  }

  const llamaData = await llamaRes!.json() as { peggedAssets: PeggedAsset[]; fxFallbackRates?: Record<string, number> };
  const rawAssetCount = llamaData.peggedAssets?.length ?? 0;

  if (!llamaData.peggedAssets || llamaData.peggedAssets.length < MIN_VALID_ASSET_COUNT) {
    console.error(`[sync-stablecoins] Unexpected asset count (${llamaData.peggedAssets?.length}), need ${MIN_VALID_ASSET_COUNT}+, skipping cache write`);
    await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    const fallback = await fallbackToCgSupply(db, cgData, cmcApiKey, syncStartSec);
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
    const fallback = await fallbackToCgSupply(db, cgData, cmcApiKey, syncStartSec);
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
  // dual-primary and enrichment passes can still use CoinGecko identifiers.
  hydrateGeckoIdAliases(llamaData.peggedAssets);

  // Normalize chainCirculating: DL returns peg-bucket objects ({peggedUSD: N})
  // for current/prev values — flatten to plain numbers so the frontend schema
  // and components can consume them directly.
  normalizeChainCirculating(llamaData.peggedAssets);

  if (goldTokens.length || silverTokens.length || fiatCgTokens.length) {
    llamaData.peggedAssets = [...llamaData.peggedAssets, ...goldTokens, ...silverTokens, ...fiatCgTokens];
  }

  // Always prefer curated metadata over DefiLlama fields; includes known address patches.
  applyTrackedAssetOverrides(llamaData.peggedAssets);

  // Load FX rates early for dynamic price bounds in isReasonablePrice
  let fxRates: Record<string, number> | undefined;
  const fxCacheEarly = await getCache(db, "fx-rates");
  const maxFxAgeSec = 6 * 3600;
  if (fxCacheEarly) {
    const fxAgeSec = Math.floor(Date.now() / 1000) - fxCacheEarly.updatedAt;
    if (fxAgeSec <= maxFxAgeSec) {
      try { fxRates = JSON.parse(fxCacheEarly.value); } catch { /* ignore */ }
    } else {
      console.warn(`[sync-stablecoins] Ignoring stale FX cache (${fxAgeSec}s old)`);
    }
  }

  // --- Dual-primary price validation ---
  // Cross-validate DL coins API and CG prices for higher confidence
  const { results: dualPriceResults, stats: dualPriceStats } = await fetchDualPrimaryPrices(
    llamaData.peggedAssets, db,
  );

  // Apply dual-primary results — these override the DL list endpoint prices
  for (const asset of llamaData.peggedAssets) {
    const dual = dualPriceResults.get(asset.id);
    if (dual && isReasonablePriceForAsset(asset, dual.price, fxRates)) {
      asset.price = dual.price;
      asset.priceSource = dual.source;
      asset.priceConfidence = dual.confidence;
    } else if (asset.price != null && typeof asset.price === "number" && asset.price > 0) {
      // DL list provided a price but no dual-primary result — single-source
      asset.priceSource = asset.priceSource || "defillama";
      asset.priceConfidence = "single-source";
    }
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
      asset.price !== 0 &&
      !isReasonablePriceForAsset(asset, asset.price, fxRates)
    ) {
      console.warn(`[sync-stablecoins] Pre-rejected bad price for ${asset.symbol} (id=${asset.id}): $${asset.price}`);
      asset.price = 0; // hasMissingPrice() treats 0 as missing
      asset.priceConfidence = null;
    }
  }

  // Enrich any assets that still have missing prices
  const missingBefore = new Set(
    llamaData.peggedAssets.filter(hasMissingPrice).map((a) => a.id)
  );
  const enrichStats = await enrichMissingPrices(llamaData.peggedAssets, cmcApiKey, db);

  // Tag enriched assets with fallback confidence
  for (const asset of llamaData.peggedAssets) {
    if (missingBefore.has(asset.id) && !hasMissingPrice(asset) && !asset.priceConfidence) {
      asset.priceConfidence = "fallback";
    }
  }

  // --- Reject unreasonable prices BEFORE caching ---
  // Must run before savePriceCache so bad prices don't persist for 24h
  let rejectedCount = 0;
  for (const asset of llamaData.peggedAssets) {
    if (asset.price != null && typeof asset.price === "number" && !isReasonablePriceForAsset(asset, asset.price, fxRates)) {
      console.warn(`[sync-stablecoins] Rejected unreasonable price for ${asset.symbol} (id=${asset.id}): $${asset.price}`);
      asset.price = null;
      rejectedCount++;
    }
  }
  if (rejectedCount > 0) {
    console.log(`[sync-stablecoins] Rejected ${rejectedCount} unreasonable prices`);
  }

  // --- Price cache: save successes, apply fallbacks ---
  const PRICE_CACHE_TTL = 24 * 60 * 60; // 24 hours
  const now = Math.floor(Date.now() / 1000);

  // Save ALL assets with valid prices so other crons (mint-burn sync) can look them up.
  // Previously only enriched assets were cached, starving mint-burn of price data.
  const withValidPrices = llamaData.peggedAssets.filter(
    (a) => a.price != null && typeof a.price === "number" && a.price > 0
  );
  if (withValidPrices.length > 0) {
    await savePriceCache(db, withValidPrices.map((a) => ({ id: a.id, price: a.price! as number })));
  }

  // Fallback: coins still missing — apply cached price if within TTL
  const stillMissing = llamaData.peggedAssets.filter(
    (a) => missingBefore.has(a.id) && hasMissingPrice(a)
  );
  if (stillMissing.length > 0) {
    const priceCache = await getPriceCache(db);
    let fallbackCount = 0;
    for (const asset of stillMissing) {
      const cached = priceCache.get(asset.id);
      if (cached && (now - cached.updatedAt) < PRICE_CACHE_TTL && isReasonablePriceForAsset(asset, cached.price, fxRates)) {
        asset.price = cached.price;
        fallbackCount++;
      }
    }
    if (fallbackCount > 0) {
      console.log(`[sync-stablecoins] Applied ${fallbackCount} cached fallback prices`);
    }
  }

  // --- Fill missing circulatingPrev* from supply_history snapshots ---
  try {
    const fillCount = await fillMissingSupplyHistory(db, llamaData.peggedAssets);
    if (fillCount > 0) {
      console.log(`[sync-stablecoins] Filled ${fillCount} missing supply changes from supply_history`);
    }
  } catch (err) {
    console.warn("[sync-stablecoins] supply_history fallback failed:", err);
  }

  // --- Staleness detection: compare prices against previous cache ---
  let stalenessWarning = false;
  try {
    const staleness = await detectPriceStaleness(db, llamaData.peggedAssets);
    if (staleness?.stale) {
      stalenessWarning = true;
      console.warn(
        `[sync-stablecoins] STALENESS WARNING: ${staleness.identical}/${staleness.compared} prices ` +
        `(${(staleness.identical / staleness.compared * 100).toFixed(1)}%) are identical to previous cache — possible upstream stale data`,
      );
    }
  } catch (e) {
    console.warn("[sync-stablecoins] Staleness check failed:", e);
  }

  // Embed live FX fallback rates if available (reuse earlier fetch)
  if (fxRates) {
    llamaData.fxFallbackRates = fxRates;
  }

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
      metadata: JSON.stringify({
        rowsRead: rawAssetCount,
        rowsWritten: 0,
        rowsDropped: droppedMalformedAssets,
        sourceCoverage: { defillama: true },
        fallbackMode: null,
        validationFailures: 1,
        validationContext: "main",
        stablecoinsCacheAgeSec,
        cacheWriteMode: "blocked-invalid-payload",
      }),
    };
  }

  await setCacheIfNewer(db, "stablecoins", JSON.stringify(validation.data), syncStartSec);
  await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, true);
  console.log(`[sync-stablecoins] Cached ${llamaData.peggedAssets.length} assets`);

  // Detect depeg events from current price data
  const depegErrors: string[] = [];
  try {
    await detectDepegEvents(db, llamaData.peggedAssets, llamaData.fxFallbackRates);
  } catch (err) {
    console.error("[sync-stablecoins] Depeg detection failed:", err);
    depegErrors.push(`detection: ${String(err).slice(0, 200)}`);
  }

  // Confirm or expire pending depeg events for >$1B coins
  try {
    await confirmPendingDepegs(db, llamaData.peggedAssets, llamaData.fxFallbackRates);
  } catch (err) {
    console.error("[sync-stablecoins] Pending depeg confirmation failed:", err);
    depegErrors.push(`confirmation: ${String(err).slice(0, 200)}`);
  }

  // Build metadata for cron_runs observability
  const finalMissing = llamaData.peggedAssets.filter(hasMissingPrice).length;
  const metadata: Record<string, unknown> = {
    rowsRead: rawAssetCount,
    rowsWritten: llamaData.peggedAssets.length,
    rowsDropped: droppedMalformedAssets,
    sourceCoverage: { defillama: true },
    fallbackMode: null,
    validationFailures: 0,
    assetCount: llamaData.peggedAssets.length,
    enrichment: enrichStats,
    dualPrimary: dualPriceStats,
    rejectedPrices: rejectedCount,
    missingPrices: finalMissing,
  };
  if (stalenessWarning) metadata.stalenessWarning = true;
  if (depegErrors.length > 0) metadata.depegErrors = depegErrors;

  return { itemCount: llamaData.peggedAssets.length, metadata: JSON.stringify(metadata) };
}
