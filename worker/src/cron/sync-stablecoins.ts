import { setCacheIfNewer, getCache, getPriceCache, savePriceCache } from "../lib/db";
import { fetchWithRetry } from "../lib/fetch-retry";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { REGISTRY_BY_LLAMA_ID } from "@shared/lib/stablecoin-id-registry";
import {
  buildPriceReasonablenessOptions,
  computeShadowComparison,
  enrichMissingPrices,
  hasMissingPrice,
  isReasonablePrice,
  fetchPrimaryPrices,
} from "./enrich-prices";
import type { PeggedAsset, ShadowComparisonResult } from "./enrich-prices";
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

import { upsertDiscoveryCandidates } from "./discovery-scan";
import { DEFILLAMA_BASE, MIN_VALID_ASSET_COUNT, CIRCUIT_SOURCE } from "../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { StablecoinListResponseSchema } from "@shared/types";
import type { PriceSourceHealth } from "@shared/types";
import { validatePayloadWithSchema } from "../lib/api-utils";
import { sendAlert } from "../lib/alerts";
import {
  buildPriceValidationContext,
  validatePriceCandidate,
  type PriceValidationContext,
  type PriceValidationDecision,
  type PriceValidationReferences,
} from "../lib/price-validation";

const INVALID_STABLECOINS_CACHE_KEY = "stablecoins:invalid-last";
const VALIDATION_ISSUES_MAX_CHARS = 400;

type StablecoinsPayload = {
  peggedAssets: PeggedAsset[];
  fxFallbackRates?: Record<string, number>;
};

interface PriceValidationShadowMetadata {
  compared: number;
  matched: number;
  mismatched: number;
  mismatchRate: number;
  mismatchBreakdown: Record<string, number>;
  sampleMismatches: Array<{
    stage: string;
    id: string;
    symbol: string;
    price: number;
    legacyAccepted: boolean;
    newAccepted: boolean;
    reasonCode: string;
    referenceType: string;
  }>;
}

type SyncCacheWriteMode = "main-write" | "fallback-write" | "blocked-invalid-payload" | "no-write";
interface SyncCapabilities {
  stablecoinsCache: boolean;
  depegPipeline: boolean;
}

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
      const priceUpdatedAt =
        typeof asset.priceUpdatedAt === "number" && Number.isFinite(asset.priceUpdatedAt)
          ? asset.priceUpdatedAt
          : null;
      const normalizedConfidence =
        confidence === "high" || confidence === "single-source" || confidence === "low" || confidence === "fallback"
          ? confidence
          : null;

      return {
        ...rest,
        geckoId: resolveGeckoId(asset),
        priceConfidence: normalizedConfidence,
        priceUpdatedAt,
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

function createPriceValidationShadowMetadata(): PriceValidationShadowMetadata {
  return {
    compared: 0,
    matched: 0,
    mismatched: 0,
    mismatchRate: 0,
    mismatchBreakdown: {},
    sampleMismatches: [],
  };
}

function shadowDecisionModeForAsset(asset: PeggedAsset): "primary_authoritative" | "fallback_enrichment" {
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

function recordPriceValidationShadow(
  stats: PriceValidationShadowMetadata,
  stage: string,
  asset: PeggedAsset,
  price: number,
  legacyAccepted: boolean,
  decision: PriceValidationDecision,
): void {
  stats.compared += 1;
  if (legacyAccepted === decision.accepted) {
    stats.matched += 1;
  } else {
    stats.mismatched += 1;
    stats.mismatchBreakdown[stage] = (stats.mismatchBreakdown[stage] ?? 0) + 1;
    if (stats.sampleMismatches.length < 10) {
      stats.sampleMismatches.push({
        stage,
        id: String(asset.id),
        symbol: asset.symbol,
        price,
        legacyAccepted,
        newAccepted: decision.accepted,
        reasonCode: decision.reasonCode,
        referenceType: decision.referenceType,
      });
    }
  }
}

function buildSyncMetadata(
  metadata: Record<string, unknown>,
  options?: {
    cacheWriteMode?: SyncCacheWriteMode;
    downstreamSafe?: boolean;
    capabilities?: Partial<SyncCapabilities>;
  },
): string {
  const capabilities: SyncCapabilities = {
    stablecoinsCache: options?.capabilities?.stablecoinsCache ?? options?.downstreamSafe ?? false,
    depegPipeline: options?.capabilities?.depegPipeline ?? false,
  };
  return JSON.stringify({
    ...metadata,
    cacheWriteMode: options?.cacheWriteMode ?? "no-write",
    downstreamSafe: capabilities.stablecoinsCache,
    capabilities,
  });
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
  return isReasonablePrice(
    price,
    asset.pegType as string | undefined,
    fxRates,
    buildPriceReasonablenessOptions({
      navToken: meta?.flags?.navToken ?? asset.navToken,
      commodityOunces: meta?.commodityOunces ?? asset.commodityOunces,
    }),
  );
}

function stampPriceMetadata(
  asset: PeggedAsset,
  source: string,
  confidence: PeggedAsset["priceConfidence"],
  updatedAt: number | null,
): void {
  asset.priceSource = source;
  asset.priceConfidence = confidence ?? null;
  asset.priceUpdatedAt = updatedAt;
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
  const enrichAbort = returnIfAborted(signal, "fallback-enrich-prices");
  if (enrichAbort) return enrichAbort;
  const enrichStats = await enrichMissingPrices(assets, cmcApiKey, db, signal);

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

  // Still run depeg detection
  try {
    const depegAbort = returnIfAborted(signal, "fallback-depeg-detection");
    if (depegAbort) return depegAbort;
    await detectDepegEvents(db, assets, fxFallbackRates, signal);
  } catch (err) {
    if (signal?.aborted) return abortResult(signal, "fallback-depeg-detection");
    console.error("[sync-stablecoins] Depeg detection failed (CG fallback):", err);
  }

  return {
    itemCount: assets.length,
      metadata: buildSyncMetadata({
        rowsRead: assets.length,
        rowsWritten: assets.length,
      rowsDropped: 0,
      sourceCoverage: { defillama: false, coingeckoFallbackAssets: assets.length },
      fallbackMode: "coingecko-supply-fallback",
      validationFailures: 0,
      enrichment: enrichStats,
      }, {
        cacheWriteMode: "fallback-write",
        capabilities: {
          stablecoinsCache: false,
          depegPipeline: false,
        },
      }),
    };
  }

export async function syncStablecoins(db: D1Database, cmcApiKey?: string, signal?: AbortSignal): Promise<CronResult> {
  const startAbort = returnIfAborted(signal, "start");
  if (startAbort) return startAbort;
  const syncStartSec = Math.floor(Date.now() / 1000);

  const cgData = await fetchCoinGeckoMarketData(signal);

  // Check circuit breaker before DL fetch
  const dlAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_STABLECOINS);

  const preFetchAbort = returnIfAborted(signal, "fetch-stablecoins-and-supplementals");
  if (preFetchAbort) return preFetchAbort;
  const [llamaRes, supplementalTokens] = await Promise.all([
    dlAllowed
      ? fetchWithRetry(`${DEFILLAMA_BASE}/stablecoins?includePrices=true`, signal ? { signal } : undefined)
      : Promise.resolve(null),
    fetchSupplementalTrackedTokens(cgData, signal),
  ]);
  const { goldTokens, silverTokens, fiatCgTokens } = supplementalTokens;

  // Record DL outcome and fallback if needed
  if (dlAllowed) {
    if (!llamaRes?.ok) {
      console.error(`[sync-stablecoins] DefiLlama API error: ${llamaRes?.status ?? "no response"}`);
      await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
      const fallback = await fallbackToCgSupply(db, cgData, cmcApiKey, syncStartSec, signal);
      if (fallback.itemCount && fallback.itemCount > 0) return fallback;
      throw new Error("DefiLlama stablecoins API failed and CoinGecko fallback was insufficient");
    }
  } else {
    console.warn("[sync-stablecoins] DL stablecoins circuit open — using CG supply fallback");
    const fallback = await fallbackToCgSupply(db, cgData, cmcApiKey, syncStartSec, signal);
    if (fallback.itemCount && fallback.itemCount > 0) return fallback;
    throw new Error("DefiLlama stablecoins circuit open and CoinGecko fallback was insufficient");
  }

  const parseAbort = returnIfAborted(signal, "parse-defillama-payload");
  if (parseAbort) return parseAbort;
  const llamaData = await llamaRes!.json() as { peggedAssets: PeggedAsset[]; fxFallbackRates?: Record<string, number> };
  const rawAssetCount = llamaData.peggedAssets?.length ?? 0;

  if (!llamaData.peggedAssets || llamaData.peggedAssets.length < MIN_VALID_ASSET_COUNT) {
    console.error(`[sync-stablecoins] Unexpected asset count (${llamaData.peggedAssets?.length}), need ${MIN_VALID_ASSET_COUNT}+, skipping cache write`);
    await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    const fallback = await fallbackToCgSupply(db, cgData, cmcApiKey, syncStartSec, signal);
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
    const fallback = await fallbackToCgSupply(db, cgData, cmcApiKey, syncStartSec, signal);
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
  const validationReferences: PriceValidationReferences | undefined = fxRates
    ? { rates: fxRates, type: "fresh", updatedAt: fxCacheEarly?.updatedAt ?? syncStartSec }
    : undefined;
  const priceValidationShadow = createPriceValidationShadowMetadata();
  const validationContexts = createValidationContextResolver();

  // --- Primary price validation ---
  // Cross-validate DL coins API and CG prices for higher confidence
  const primaryPricesAbort = returnIfAborted(signal, "primary-prices");
  if (primaryPricesAbort) return primaryPricesAbort;
  const { results: primaryPriceResults, stats: priceValidationStats } = await fetchPrimaryPrices(
    llamaData.peggedAssets, db, signal, validationReferences,
  );

  // Regression monitor: compare CG primary prices against DL list endpoint prices.
  // This tracks divergence between our primary source and the DL ecosystem baseline.
  let shadowComparison: ShadowComparisonResult | null = null;
  try {
    // Extract CG prices from primary results (already fetched — no extra API call)
    const shadowCgPrices = new Map<string, number>();
    const oldPrices = new Map<string, number>();
    for (const asset of llamaData.peggedAssets) {
      if (!asset.geckoId) continue;
      const primary = primaryPriceResults.get(asset.id);
      if (primary?.cgPrice != null && primary.cgPrice > 0) {
        shadowCgPrices.set(asset.geckoId, primary.cgPrice);
      }
      // Old pipeline price = DL list endpoint price (what we'd lose if CG becomes primary)
      if (asset.price != null && typeof asset.price === "number" && asset.price > 0) {
        oldPrices.set(asset.geckoId, asset.price);
      }
    }

    if (shadowCgPrices.size > 0) {
      shadowComparison = computeShadowComparison(oldPrices, shadowCgPrices);
      console.log(
        `[shadow] Compared ${shadowComparison.totalCompared} prices: ` +
        `mean=${shadowComparison.meanDivergenceBps}bps, p95=${shadowComparison.p95DivergenceBps}bps, ` +
        `max=${shadowComparison.maxDivergenceBps}bps, lost=${shadowComparison.coverageLost}, gained=${shadowComparison.coverageGained}`,
      );
    } else {
      // CG was unavailable (circuit breaker open or fetch failed) — record explicitly
      shadowComparison = computeShadowComparison(oldPrices, new Map());
    }
  } catch (err) {
    console.warn("[shadow] Shadow comparison failed:", err);
  }

  // Apply primary price results — these override the DL list endpoint prices
  for (const asset of llamaData.peggedAssets) {
    const primary = primaryPriceResults.get(asset.id);
    if (primary) {
      const legacyAccepted = isReasonablePriceForAsset(asset, primary.price, fxRates);
      const decision = validatePriceCandidate(
        primary.price,
        validationContexts.get(asset),
        "primary_authoritative",
        validationReferences,
      );
      recordPriceValidationShadow(priceValidationShadow, "dual_primary_apply", asset, primary.price, legacyAccepted, decision);
      if (decision.accepted) {
        asset.price = primary.price;
        stampPriceMetadata(asset, primary.source, primary.confidence, syncStartSec);
      } else if (asset.price != null && typeof asset.price === "number" && asset.price > 0) {
        stampPriceMetadata(asset, asset.priceSource || "defillama", "single-source", syncStartSec);
      }
    } else if (asset.price != null && typeof asset.price === "number" && asset.price > 0) {
      // DL list provided a price but no primary price result — single-source
      stampPriceMetadata(asset, asset.priceSource || "defillama", "single-source", syncStartSec);
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
      asset.price !== 0
    ) {
      const legacyAccepted = isReasonablePriceForAsset(asset, asset.price, fxRates);
      const decision = validatePriceCandidate(
        asset.price,
        validationContexts.get(asset),
        "primary_authoritative",
        validationReferences,
      );
      recordPriceValidationShadow(priceValidationShadow, "pre_reject", asset, asset.price, legacyAccepted, decision);
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
      const legacyAccepted = isReasonablePriceForAsset(asset, asset.price, fxRates);
      const decision = validatePriceCandidate(
        asset.price,
        validationContexts.get(asset),
        shadowDecisionModeForAsset(asset),
        validationReferences,
      );
      recordPriceValidationShadow(priceValidationShadow, "post_enrichment_reject", asset, asset.price, legacyAccepted, decision);
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
  const PRICE_CACHE_TTL = 24 * 60 * 60; // 24 hours
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
        const legacyAccepted = isReasonablePriceForAsset(asset, cached.price, fxRates);
        const decision = validatePriceCandidate(
          cached.price,
          validationContexts.get(asset),
          "fallback_enrichment",
          validationReferences,
        );
        recordPriceValidationShadow(priceValidationShadow, "cached_fallback", asset, cached.price, legacyAccepted, decision);
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
    await confirmPendingDepegs(db, llamaData.peggedAssets, llamaData.fxFallbackRates, signal);
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

  const finalMissing = llamaData.peggedAssets.filter(hasMissingPrice).length;

  // Build price source health from primary price + enrichment stats
  const priceSourceHealth: PriceSourceHealth = {
    sourceDistribution: {
      coingecko: enrichStats.pass3, // CG direct (enrichment pass 3)
      "coingecko+defillama": priceValidationStats.high,
      defillama: priceValidationStats.singleSource,
      "defillama-contract": enrichStats.pass1 + enrichStats.pass1b,
      coinmarketcap: enrichStats.passCmc,
      dexscreener: enrichStats.pass4,
      cached: enrichStats.pass2, // DL coins API proxy (pass 2) — effectively a cache of CG
      missing: enrichStats.finalMissing,
    },
    confidenceDistribution: {
      high: priceValidationStats.high,
      "single-source": priceValidationStats.singleSource,
      low: priceValidationStats.low,
      fallback: enrichStats.passCmc + enrichStats.pass4,
    },
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
    assetCount: llamaData.peggedAssets.length,
    enrichment: enrichStats,
    priceValidation: priceValidationStats,
    rejectedPrices: rejectedCount,
    missingPrices: finalMissing,
    priceSourceHealth,
    shadowComparison,
    priceValidationShadow: {
      ...priceValidationShadow,
      mismatchRate: priceValidationShadow.compared > 0
        ? priceValidationShadow.mismatched / priceValidationShadow.compared
        : 0,
    },
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
