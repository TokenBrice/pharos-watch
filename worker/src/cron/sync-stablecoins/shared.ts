import { StablecoinListResponseSchema } from "@shared/types";
import type { PriceSourceHealth } from "@shared/types";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { setCacheIfNewer, getCache } from "../../lib/db-cache";
import type { CronResult } from "../../lib/cron-logger";
import type { PeggedAsset } from "../enrich-prices";
import type { PriceValidationReferences } from "../../lib/price-validation";

const INVALID_STABLECOINS_CACHE_KEY = "stablecoins:invalid-last";
const VALIDATION_ISSUES_MAX_CHARS = 400;
const FX_REFERENCE_MAX_AGE_SEC = 6 * 3600;
const SUPPLEMENTAL_TRACKED_IDS = new Set(
  TRACKED_STABLECOINS
    .filter(
      (meta) =>
        !!meta.geckoId &&
        (meta.flags.pegCurrency === "GOLD" || meta.flags.pegCurrency === "SILVER" || meta.detailProvider === "coingecko"),
    )
    .map((meta) => meta.id),
);

export type StablecoinsPayload = {
  peggedAssets: PeggedAsset[];
  fxFallbackRates?: Record<string, number>;
};

export type SyncCacheWriteMode = "main-write" | "fallback-write" | "blocked-invalid-payload" | "no-write";

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

export function normalizeStablecoinsPayload(payload: StablecoinsPayload): StablecoinsPayload {
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

export function summarizeValidationIssues(issues: string): string {
  if (issues.length <= VALIDATION_ISSUES_MAX_CHARS) return issues;
  return `${issues.slice(0, VALIDATION_ISSUES_MAX_CHARS)}...`;
}

export function buildSyncMetadata(
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
  updatedAt: number | null,
): void {
  asset.priceSource = source;
  asset.priceConfidence = confidence ?? null;
  asset.priceUpdatedAt = updatedAt;
}

export function sumPegBuckets(buckets: Record<string, number> | undefined | null): number {
  if (!buckets) return 0;
  return Object.values(buckets).reduce(
    (sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0),
    0,
  );
}

function cloneCachedAsset(asset: PeggedAsset): PeggedAsset {
  return {
    ...asset,
    chains: Array.isArray(asset.chains) ? [...asset.chains] : asset.chains,
  };
}

export async function loadPreviousStablecoinsById(db: D1Database): Promise<Map<string, PeggedAsset>> {
  try {
    const prevCache = await getCache(db, "stablecoins");
    if (!prevCache) return new Map();
    const prevData = JSON.parse(prevCache.value) as { peggedAssets?: PeggedAsset[] };
    if (!Array.isArray(prevData.peggedAssets)) return new Map();
    return new Map(prevData.peggedAssets.map((asset) => [String(asset.id), asset]));
  } catch (err) {
    console.warn("[sync-stablecoins] Failed to parse previous stablecoins cache:", err);
    return new Map();
  }
}

export function mergeSupplementalLastKnownGood(
  supplementalAssets: PeggedAsset[],
  previousAssetsById: Map<string, PeggedAsset>,
  primaryAssetIds: Set<string>,
): { assets: PeggedAsset[]; restoredCount: number; skippedDuplicates: number } {
  const resolved = new Map<string, PeggedAsset>();
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
      const merged = cloneCachedAsset(previous);
      if (asset.price != null && typeof asset.price === "number" && asset.price > 0) {
        merged.price = asset.price;
        merged.priceSource = asset.priceSource;
        merged.priceConfidence = asset.priceConfidence ?? null;
        merged.priceUpdatedAt = asset.priceUpdatedAt ?? null;
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
    resolved.set(id, cloneCachedAsset(previous));
    restoredCount++;
  }

  return {
    assets: [...resolved.values()],
    restoredCount,
    skippedDuplicates,
  };
}

export async function loadFreshFxRates(
  db: D1Database,
  syncStartSec: number,
  logPrefix = "[sync-stablecoins]",
): Promise<{
  fxFallbackRates?: Record<string, number>;
  validationReferences?: PriceValidationReferences;
}> {
  const fxCache = await getCache(db, "fx-rates");
  if (!fxCache) {
    return {};
  }

  const fxAgeSec = Math.floor(Date.now() / 1000) - fxCache.updatedAt;
  if (fxAgeSec > FX_REFERENCE_MAX_AGE_SEC) {
    console.warn(`${logPrefix} Ignoring stale FX cache (${fxAgeSec}s old)`);
    return {};
  }

  try {
    const fxFallbackRates = JSON.parse(fxCache.value) as Record<string, number>;
    return {
      fxFallbackRates,
      validationReferences: {
        rates: fxFallbackRates,
        type: "fresh",
        updatedAt: fxCache.updatedAt ?? syncStartSec,
      },
    };
  } catch (err) {
    console.warn(`${logPrefix} Failed to parse FX cache:`, err);
    return {};
  }
}

export { StablecoinListResponseSchema };
export type { PriceSourceHealth, CronResult };
