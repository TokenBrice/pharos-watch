import { StablecoinListResponseSchema } from "@shared/types/market";
import type { PriceSourceHealth } from "@shared/types/status";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { sumPegBuckets } from "@shared/lib/supply";
import { setCacheIfNewer, getCache, getPriceCache, type PriceCacheEntry } from "../../lib/db-cache";
import type { CronResult } from "../../lib/cron-logger";
import type { PeggedAsset } from "./enrich-prices-shared";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { loadFxRateState, getFxReferenceTypeFromState } from "../../lib/fx-rate-state";

export { sumPegBuckets };

const INVALID_STABLECOINS_CACHE_KEY = "stablecoins:invalid-last";
const VALIDATION_ISSUES_MAX_CHARS = 400;
const FX_REFERENCE_MAX_AGE_SEC = 6 * 3600;
const MISSING_PRICE_SOURCE = "missing";
const SUPPLEMENTAL_TRACKED_IDS = new Set(
  ACTIVE_STABLECOINS.filter(
    (meta) =>
      (meta.flags.pegCurrency === "GOLD" && !!meta.geckoId) ||
      (meta.flags.pegCurrency === "SILVER" && !!meta.geckoId) ||
      meta.detailProvider === "coingecko",
  ).map((meta) => meta.id),
);

export type StablecoinsPayload = {
  peggedAssets: PeggedAsset[];
  fxFallbackRates?: Record<string, number>;
};

export type SyncCacheWriteMode = "published" | "skipped-newer" | "blocked-invalid-payload" | "no-write";

interface SyncCapabilities {
  stablecoinsCache: boolean;
  depegPipeline: boolean;
}

export function parseStablecoinsCachePayload(value: string): StablecoinsPayload | null {
  try {
    const parsed = JSON.parse(value) as { peggedAssets?: PeggedAsset[]; fxFallbackRates?: Record<string, number> };
    if (!Array.isArray(parsed.peggedAssets)) return null;
    return {
      peggedAssets: parsed.peggedAssets,
      fxFallbackRates: parsed.fxFallbackRates,
    };
  } catch {
    return null;
  }
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

function normalizeOptionalTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeStablecoinsPayload(payload: StablecoinsPayload): StablecoinsPayload {
  return {
    ...payload,
    peggedAssets: payload.peggedAssets.map((asset) => {
      const {
        gecko_id: _ignoredSnakeCase,
        supplyObservedAt: _ignoredSupplyObservedAt,
        supplyRestored: _ignoredSupplyRestored,
        ...rest
      } = asset as PeggedAsset & { gecko_id?: unknown };
      const hasUsablePrice = typeof asset.price === "number" && Number.isFinite(asset.price) && asset.price > 0;
      const confidence = asset.priceConfidence;
      const priceUpdatedAt =
        typeof asset.priceUpdatedAt === "number" && Number.isFinite(asset.priceUpdatedAt) ? asset.priceUpdatedAt : null;
      const priceObservedAt =
        typeof asset.priceObservedAt === "number" && Number.isFinite(asset.priceObservedAt)
          ? asset.priceObservedAt
          : priceUpdatedAt;
      const priceObservedAtMode =
        asset.priceObservedAtMode === "upstream" ||
        asset.priceObservedAtMode === "local_fetch" ||
        asset.priceObservedAtMode === "unknown"
          ? asset.priceObservedAtMode
          : null;
      const priceSyncedAt =
        typeof asset.priceSyncedAt === "number" && Number.isFinite(asset.priceSyncedAt) ? asset.priceSyncedAt : null;
      const priceSelectedSource = !hasUsablePrice
        ? null
        : typeof asset.priceSelectedSource === "string" && asset.priceSelectedSource.length > 0
          ? asset.priceSelectedSource
          : (asset.priceSource ?? MISSING_PRICE_SOURCE);
      const normalizedConfidence =
        confidence === "high" || confidence === "single-source" || confidence === "low" || confidence === "fallback"
          ? confidence
          : null;
      const supplyObservedAt = normalizeOptionalTimestamp(asset.supplyObservedAt);

      return {
        ...rest,
        geckoId: resolveGeckoId(asset),
        price: hasUsablePrice ? asset.price : null,
        priceSource: hasUsablePrice ? (asset.priceSource ?? MISSING_PRICE_SOURCE) : MISSING_PRICE_SOURCE,
        priceConfidence: hasUsablePrice ? normalizedConfidence : null,
        priceUpdatedAt: hasUsablePrice ? (priceObservedAt ?? priceUpdatedAt) : null,
        priceObservedAt: hasUsablePrice ? priceObservedAt : null,
        priceObservedAtMode: hasUsablePrice ? priceObservedAtMode : null,
        priceSyncedAt: hasUsablePrice ? priceSyncedAt : null,
        priceSelectedSource,
        consensusSources: hasUsablePrice ? (asset.consensusSources ?? []) : [],
        agreeSources: hasUsablePrice ? (asset.agreeSources ?? []) : [],
        priceSourceConfidenceProfile: hasUsablePrice ? (asset.priceSourceConfidenceProfile ?? null) : null,
        ...(supplyObservedAt != null ? { supplyObservedAt } : {}),
        ...(asset.supplyRestored === true ? { supplyRestored: true } : {}),
        circulatingPrevDay: toPegBuckets(asset.circulatingPrevDay),
        circulatingPrevWeek: toPegBuckets(asset.circulatingPrevWeek),
        circulatingPrevMonth: toPegBuckets(asset.circulatingPrevMonth),
      };
    }),
  };
}

export function summarizeValidationIssues(issues: string): string {
  if (issues.length <= VALIDATION_ISSUES_MAX_CHARS) return issues;
  return `${issues.slice(0, VALIDATION_ISSUES_MAX_CHARS)}...`;
}

export function buildSyncMetadata(
  metadata: Record<string, unknown>,
  options?: {
    cacheWriteMode?: SyncCacheWriteMode;
    casSkipped?: boolean;
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
    casSkipped: options?.casSkipped ?? options?.cacheWriteMode === "skipped-newer",
    downstreamSafe: capabilities.stablecoinsCache,
    capabilities,
  });
}

export async function getStablecoinsCacheAgeSec(db: D1Database): Promise<number | null> {
  const stablecoinsCache = await getCache(db, "stablecoins");
  if (!stablecoinsCache) return null;
  return Math.max(0, Math.floor(Date.now() / 1000) - stablecoinsCache.updatedAt);
}

export async function writeInvalidStablecoinsDiagnostic(
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

export function hydrateGeckoIdAliases(assets: PeggedAsset[]): void {
  for (const asset of assets) {
    if (typeof asset.geckoId === "string" && asset.geckoId.length > 0) continue;
    const geckoId = resolveGeckoId(asset);
    if (geckoId) asset.geckoId = geckoId;
  }
}

export function stampPriceMetadata(
  asset: PeggedAsset,
  source: string,
  confidence: PeggedAsset["priceConfidence"],
  observedAt: number | null,
  observedAtMode?: PeggedAsset["priceObservedAtMode"],
  consensusSources?: string[],
  agreeSources?: string[],
  syncedAt?: number | null,
  selectedSource?: string | null,
  sourceConfidenceProfile?: PeggedAsset["priceSourceConfidenceProfile"],
): void {
  asset.priceSource = source;
  asset.priceSelectedSource = selectedSource ?? source;
  asset.priceConfidence = confidence ?? null;
  asset.priceObservedAt = observedAt;
  asset.priceObservedAtMode = observedAtMode ?? null;
  asset.priceSyncedAt = syncedAt ?? observedAt ?? null;
  asset.priceUpdatedAt = observedAt ?? syncedAt ?? null;
  if (consensusSources !== undefined) {
    asset.consensusSources = consensusSources;
  }
  if (agreeSources !== undefined) {
    asset.agreeSources = agreeSources;
  }
  if (sourceConfidenceProfile !== undefined) {
    asset.priceSourceConfidenceProfile = sourceConfidenceProfile;
  }
}

export function clearPriceMetadata(asset: PeggedAsset): void {
  asset.price = null;
  asset.priceSource = undefined;
  asset.priceSelectedSource = null;
  asset.priceConfidence = null;
  asset.priceUpdatedAt = null;
  asset.priceObservedAt = null;
  asset.priceObservedAtMode = null;
  asset.priceSyncedAt = null;
  asset.consensusSources = [];
  asset.agreeSources = [];
  asset.priceSourceConfidenceProfile = null;
}

function cloneCachedAsset(asset: PeggedAsset): PeggedAsset {
  return {
    ...asset,
    chains: Array.isArray(asset.chains) ? [...asset.chains] : asset.chains,
  };
}

function stampPreviousSupplyObservedAt(asset: PeggedAsset, cacheUpdatedAt: number | null): PeggedAsset {
  const cloned = cloneCachedAsset(asset);
  if (sumPegBuckets(cloned.circulating) <= 0) {
    return cloned;
  }
  cloned.supplyObservedAt = normalizeOptionalTimestamp(asset.supplyObservedAt) ?? cacheUpdatedAt;
  return cloned;
}

function markRestoredSupply(asset: PeggedAsset): PeggedAsset {
  const restored = cloneCachedAsset(asset);
  restored.supplyRestored = true;
  restored.supplyObservedAt = normalizeOptionalTimestamp(asset.supplyObservedAt);
  return restored;
}

export async function loadPreviousStablecoinsById(db: D1Database): Promise<Map<string, PeggedAsset>> {
  try {
    const prevCache = await getCache(db, "stablecoins");
    if (!prevCache) return new Map();
    const prevData = parseStablecoinsCachePayload(prevCache.value);
    if (!prevData) return new Map();
    const cacheUpdatedAt = normalizeOptionalTimestamp(prevCache.updatedAt);
    return new Map(
      prevData.peggedAssets.map((asset) => [String(asset.id), stampPreviousSupplyObservedAt(asset, cacheUpdatedAt)]),
    );
  } catch (err) {
    console.warn("[sync-stablecoins] Failed to parse previous stablecoins cache:", err);
    return new Map();
  }
}

export async function loadReplayPriceCacheForTrustedContinuity(db: D1Database): Promise<Map<string, PriceCacheEntry>> {
  try {
    return await getPriceCache(db);
  } catch (error) {
    console.warn("[sync-stablecoins] Failed to load replay price cache for trusted-price continuity:", error);
    return new Map<string, PriceCacheEntry>();
  }
}

/**
 * Carry-forward ceiling for last-known-good supplemental supply. Restores
 * preserve the original supplyObservedAt, so age compounds run-over-run;
 * without a ceiling a weeks-stale XAUT/PAXG supply would keep publishing into
 * homepage totals indistinguishable from fresh. Past the ceiling the asset
 * publishes with its real (empty) supply and the expiry is reported.
 */
export const SUPPLEMENTAL_RESTORE_MAX_AGE_SEC = 7 * 86400;

export function replaceZeroSupplyPrimaryAssets(
  primaryAssets: readonly PeggedAsset[],
  supplementalAssets: readonly PeggedAsset[],
): { assets: PeggedAsset[]; replacedIds: string[] } {
  const positiveSupplementalById = new Map(
    supplementalAssets
      .filter((asset) => sumPegBuckets(asset.circulating) > 0)
      .map((asset) => [String(asset.id), asset] as const),
  );
  const replacedIds: string[] = [];
  const assets = primaryAssets.map((asset) => {
    if (sumPegBuckets(asset.circulating) > 0) return asset;
    const replacement = positiveSupplementalById.get(String(asset.id));
    if (!replacement) return asset;
    replacedIds.push(String(asset.id));
    return replacement;
  });

  return { assets, replacedIds: [...new Set(replacedIds)].sort() };
}

function isWithinRestoreCeiling(previous: PeggedAsset, nowSec: number): boolean {
  const observedAt = normalizeOptionalTimestamp(previous.supplyObservedAt);
  // Rows without provenance get one restore; the cache read path stamps
  // supplyObservedAt from the cache row, so age accrues from there.
  if (observedAt == null) return true;
  return nowSec - observedAt <= SUPPLEMENTAL_RESTORE_MAX_AGE_SEC;
}

export function mergeSupplementalLastKnownGood(
  supplementalAssets: PeggedAsset[],
  previousAssetsById: Map<string, PeggedAsset>,
  primaryAssetIds: Set<string>,
  nowSec: number = Math.floor(Date.now() / 1000),
): { assets: PeggedAsset[]; restoredCount: number; skippedDuplicates: number; expiredRestoreIds: string[] } {
  const resolved = new Map<string, PeggedAsset>();
  const expiredRestoreIds: string[] = [];
  let restoredCount = 0;
  let skippedDuplicates = 0;

  for (const asset of supplementalAssets) {
    const id = String(asset.id);
    if (primaryAssetIds.has(id)) {
      skippedDuplicates++;
      continue;
    }

    if (sumPegBuckets(asset.circulating) > 0) {
      resolved.set(id, asset);
      continue;
    }

    const previous = previousAssetsById.get(id);
    if (previous && sumPegBuckets(previous.circulating) > 0) {
      if (!isWithinRestoreCeiling(previous, nowSec)) {
        expiredRestoreIds.push(id);
        resolved.set(id, asset);
        continue;
      }
      const merged = markRestoredSupply(previous);
      if (asset.price != null && typeof asset.price === "number" && asset.price > 0) {
        merged.price = asset.price;
        merged.priceSource = asset.priceSource;
        merged.priceSelectedSource = asset.priceSelectedSource ?? null;
        merged.priceConfidence = asset.priceConfidence ?? null;
        merged.priceUpdatedAt = asset.priceUpdatedAt ?? null;
        merged.priceObservedAt = asset.priceObservedAt ?? asset.priceUpdatedAt ?? null;
        merged.priceObservedAtMode = asset.priceObservedAtMode ?? null;
        merged.priceSyncedAt = asset.priceSyncedAt ?? null;
        merged.consensusSources = asset.consensusSources;
        merged.agreeSources = asset.agreeSources;
      }
      resolved.set(id, merged);
      restoredCount++;
      continue;
    }

    resolved.set(id, asset);
  }

  for (const id of SUPPLEMENTAL_TRACKED_IDS) {
    if (primaryAssetIds.has(id) || resolved.has(id)) continue;
    const previous = previousAssetsById.get(id);
    if (!previous || sumPegBuckets(previous.circulating) <= 0) continue;
    if (!isWithinRestoreCeiling(previous, nowSec)) {
      expiredRestoreIds.push(id);
      continue;
    }
    resolved.set(id, markRestoredSupply(previous));
    restoredCount++;
  }

  return {
    assets: [...resolved.values()],
    restoredCount,
    skippedDuplicates,
    expiredRestoreIds,
  };
}

const ACTIVE_TRACKED_IDS = new Set(ACTIVE_STABLECOINS.map((meta) => meta.id));

export interface TrackedCoverageRestoreResult {
  assets: PeggedAsset[];
  restoredIds: string[];
  droppedIds: string[];
}

/**
 * Restore-or-degrade for tracked-id coverage regressions: when the DefiLlama
 * list omits an active tracked coin that was published last cycle, re-publish
 * the previous row (marked supplyRestored, same 7-day ceiling as supplemental
 * carry-forward) instead of silently dropping the coin for a cycle. Past the
 * ceiling — or with no previous row or usable previous supply — the coin stays
 * out and is reported as dropped. droppedIds is derived from the active
 * tracked universe (not the previous payload), so an already-dropped coin
 * keeps reporting every cycle instead of going silent after one run.
 */
export function restoreMissingTrackedAssets(
  currentAssets: PeggedAsset[],
  previousAssetsById: Map<string, PeggedAsset>,
  nowSec: number = Math.floor(Date.now() / 1000),
): TrackedCoverageRestoreResult {
  const presentIds = new Set(currentAssets.map((asset) => String(asset.id)));
  const restoredAssets: PeggedAsset[] = [];
  const restoredIds: string[] = [];
  const droppedIds: string[] = [];

  for (const id of ACTIVE_TRACKED_IDS) {
    if (presentIds.has(id)) continue;
    const previous = previousAssetsById.get(id);
    if (!previous || sumPegBuckets(previous.circulating) <= 0 || !isWithinRestoreCeiling(previous, nowSec)) {
      droppedIds.push(id);
      continue;
    }
    restoredAssets.push(markRestoredSupply(previous));
    restoredIds.push(id);
  }

  return { assets: restoredAssets, restoredIds, droppedIds };
}

export async function loadFreshFxRates(
  db: D1Database,
  logPrefix = "[sync-stablecoins]",
): Promise<{
  fxFallbackRates?: Record<string, number>;
  validationReferences?: PriceValidationReferences;
}> {
  const fxState = await loadFxRateState(db);
  if (!fxState) {
    return {};
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const typeByPeg: Record<string, PriceValidationReferences["type"]> = {};
  const updatedAtByPeg: Record<string, number | null> = {};
  const freshOrStaticRates: Record<string, number> = {};
  let hasStalePeg = false;
  let globalType: PriceValidationReferences["type"] = "none";
  let globalUpdatedAt: number | null = null;

  for (const pegKey of Object.keys(fxState.rates)) {
    const type = getFxReferenceTypeFromState(fxState, pegKey, FX_REFERENCE_MAX_AGE_SEC, nowSec);
    typeByPeg[pegKey] = type;
    updatedAtByPeg[pegKey] = fxState.sourceUpdatedAtByPeg[pegKey] ?? null;
    if (type === "fresh" || type === "static") {
      freshOrStaticRates[pegKey] = fxState.rates[pegKey];
      globalType = type === "fresh" ? "fresh" : globalType === "none" ? "static" : globalType;
      if (updatedAtByPeg[pegKey] != null) {
        globalUpdatedAt =
          globalUpdatedAt == null
            ? updatedAtByPeg[pegKey]
            : Math.min(globalUpdatedAt, updatedAtByPeg[pegKey] as number);
      }
    } else if (type === "stale") {
      hasStalePeg = true;
      globalType = "stale";
    }
  }

  if (Object.keys(freshOrStaticRates).length === 0) {
    const ageDescriptor =
      fxState.mode === "cached-fallback"
        ? `${fxState.usableAgeSec}s usable age`
        : `${Math.max(0, nowSec - fxState.usableSyncAt)}s usable age`;
    console.warn(`${logPrefix} Ignoring FX references with no fresh source data (${ageDescriptor})`);
    return {};
  }

  if (hasStalePeg) {
    console.warn(`${logPrefix} Excluding stale FX source entries while keeping fresh/static references`);
  }

  return {
    fxFallbackRates: freshOrStaticRates,
    validationReferences: {
      rates: fxState.rates,
      type: globalType,
      updatedAt: globalUpdatedAt,
      updatedAtByPeg,
      typeByPeg,
    },
  };
}

export { StablecoinListResponseSchema };
export type { PriceSourceHealth, CronResult };
