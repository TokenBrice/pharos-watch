import type { CacheStatus } from "@shared/types";
import { FRESHNESS_RATIOS, STATUS_CACHE_RATIO_THRESHOLDS } from "@shared/lib/status-thresholds";
import { getCache, setCacheIfNewer } from "./db-cache";

const FX_RATES_KEY = "fx-rates";
const FX_RATES_META_KEY = "fx-rates-meta";
const FX_SOURCE_DEGRADED_AGE_SEC = 6 * 3600;
const FX_SOURCE_STALE_AGE_SEC = 24 * 3600;

export type FxRateSyncMode = "live" | "cached-fallback";
export type FxRateSourceMode = "live" | "cached" | "hardcoded";
export type FxSourceStatus = "fresh" | "degraded" | "stale" | "none";

export interface FxRatesMeta {
  usableSyncAt: number;
  mode: FxRateSyncMode;
  sourceUpdatedAtByPeg: Record<string, number | null>;
  sourceModeByPeg: Record<string, FxRateSourceMode>;
  sources?: Record<string, string>;
  ecbDate?: string | null;
  previousCacheUpdatedAt?: number | null;
  consecutiveFallbackRuns: number;
}

export interface FxRateState {
  rates: Record<string, number>;
  usableSyncAt: number;
  usableAgeSec: number;
  mode: FxRateSyncMode;
  sourceUpdatedAtByPeg: Record<string, number | null>;
  sourceModeByPeg: Record<string, FxRateSourceMode>;
  sources?: Record<string, string>;
  ecbDate?: string | null;
  previousCacheUpdatedAt?: number | null;
  consecutiveFallbackRuns: number;
  bootstrapMetadata: boolean;
}

interface CacheRow {
  value: string;
  updatedAt: number;
}

function sanitizeFxRates(input: unknown): Record<string, number> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      out[key] = value;
    }
  }
  return out;
}

function sanitizeSourceUpdatedAtByPeg(input: unknown): Record<string, number | null> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] =
      typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : null;
  }
  return out;
}

function sanitizeSourceModeByPeg(input: unknown): Record<string, FxRateSourceMode> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, FxRateSourceMode> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === "live" || value === "cached" || value === "hardcoded") {
      out[key] = value;
    }
  }
  return out;
}

function sanitizeSources(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildBootstrapMeta(cache: CacheRow, rates: Record<string, number>): FxRatesMeta {
  const sourceUpdatedAtByPeg: Record<string, number | null> = {};
  const sourceModeByPeg: Record<string, FxRateSourceMode> = {};
  for (const pegKey of Object.keys(rates)) {
    sourceUpdatedAtByPeg[pegKey] = cache.updatedAt;
    sourceModeByPeg[pegKey] = "live";
  }
  return {
    usableSyncAt: cache.updatedAt,
    mode: "live",
    sourceUpdatedAtByPeg,
    sourceModeByPeg,
    previousCacheUpdatedAt: cache.updatedAt,
    consecutiveFallbackRuns: 0,
  };
}

function parseFxMeta(value: string, fallback: CacheRow, rates: Record<string, number>): FxRatesMeta | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const usableSyncAt =
      typeof parsed.usableSyncAt === "number" && Number.isFinite(parsed.usableSyncAt) && parsed.usableSyncAt > 0
        ? Math.floor(parsed.usableSyncAt)
        : fallback.updatedAt;
    const mode: FxRateSyncMode = parsed.mode === "cached-fallback" ? "cached-fallback" : "live";
    return {
      usableSyncAt,
      mode,
      sourceUpdatedAtByPeg: sanitizeSourceUpdatedAtByPeg(parsed.sourceUpdatedAtByPeg),
      sourceModeByPeg: sanitizeSourceModeByPeg(parsed.sourceModeByPeg),
      sources: sanitizeSources(parsed.sources),
      ecbDate: typeof parsed.ecbDate === "string" && parsed.ecbDate.length > 0 ? parsed.ecbDate : null,
      previousCacheUpdatedAt:
        typeof parsed.previousCacheUpdatedAt === "number" && Number.isFinite(parsed.previousCacheUpdatedAt)
          ? Math.floor(parsed.previousCacheUpdatedAt)
          : fallback.updatedAt,
      consecutiveFallbackRuns:
        typeof parsed.consecutiveFallbackRuns === "number" && Number.isFinite(parsed.consecutiveFallbackRuns) && parsed.consecutiveFallbackRuns >= 0
          ? Math.floor(parsed.consecutiveFallbackRuns)
          : 0,
    };
  } catch {
    return buildBootstrapMeta(fallback, rates);
  }
}

export function getFxRatesMetaKey(): string {
  return FX_RATES_META_KEY;
}

export function getFxSourceStatus(
  updatedAt: number | null,
  mode: FxRateSourceMode | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): FxSourceStatus {
  if (mode === "hardcoded") return "none";
  if (updatedAt == null || !Number.isFinite(updatedAt) || updatedAt <= 0) return "none";
  const ageSec = Math.max(0, nowSec - updatedAt);
  if (ageSec > FX_SOURCE_STALE_AGE_SEC) return "stale";
  if (ageSec > FX_SOURCE_DEGRADED_AGE_SEC) return "degraded";
  return "fresh";
}

export function getFxReferenceTypeFromState(
  state: FxRateState | null,
  pegKey: string,
  maxAgeSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): "fresh" | "stale" | "static" | "none" {
  if (!state) return "none";
  const rate = state.rates[pegKey];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return "none";

  const mode = state.sourceModeByPeg[pegKey];
  if (mode === "hardcoded") return "static";

  const updatedAt = state.sourceUpdatedAtByPeg[pegKey] ?? null;
  if (updatedAt == null || !Number.isFinite(updatedAt) || updatedAt <= 0) return "none";
  return Math.max(0, nowSec - updatedAt) <= maxAgeSec ? "fresh" : "stale";
}

export async function loadFxRateState(db: D1Database): Promise<FxRateState | null> {
  const [ratesCache, metaCache] = await Promise.all([
    getCache(db, FX_RATES_KEY),
    getCache(db, FX_RATES_META_KEY),
  ]);
  return hydrateFxRateState(ratesCache, metaCache);
}

export function hydrateFxRateState(
  ratesCache: CacheRow | null,
  metaCache: CacheRow | null,
): FxRateState | null {
  if (!ratesCache) return null;

  let rates: Record<string, number>;
  try {
    rates = sanitizeFxRates(JSON.parse(ratesCache.value));
  } catch {
    return null;
  }
  if (Object.keys(rates).length === 0) return null;

  const meta = metaCache
    ? parseFxMeta(metaCache.value, ratesCache, rates)
    : buildBootstrapMeta(ratesCache, rates);
  if (!meta) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  return {
    rates,
    usableSyncAt: meta.usableSyncAt,
    usableAgeSec: Math.max(0, nowSec - meta.usableSyncAt),
    mode: meta.mode,
    sourceUpdatedAtByPeg: meta.sourceUpdatedAtByPeg,
    sourceModeByPeg: meta.sourceModeByPeg,
    sources: meta.sources,
    ecbDate: meta.ecbDate ?? null,
    previousCacheUpdatedAt: meta.previousCacheUpdatedAt ?? ratesCache.updatedAt,
    consecutiveFallbackRuns: meta.consecutiveFallbackRuns,
    bootstrapMetadata: !metaCache,
  };
}

export async function persistFxRateState(
  db: D1Database,
  rates: Record<string, number>,
  meta: FxRatesMeta,
  syncStartSec: number,
): Promise<void> {
  await setCacheIfNewer(db, FX_RATES_KEY, JSON.stringify(rates), syncStartSec);
  await setCacheIfNewer(db, FX_RATES_META_KEY, JSON.stringify(meta), syncStartSec);
}

export function buildFxCacheStatus(
  state: FxRateState | null,
  maxAgeSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): { cacheStatus: CacheStatus; statusFloor: "healthy" | "degraded" | "stale"; warning?: string } {
  if (!state) {
    return {
      cacheStatus: { ageSeconds: null, maxAge: maxAgeSec, healthy: false },
      statusFloor: "stale",
    };
  }

  const ageSeconds = Math.max(0, nowSec - state.usableSyncAt);
  const ratio = ageSeconds / maxAgeSec;
  let statusFloor: "healthy" | "degraded" | "stale" =
    ratio > STATUS_CACHE_RATIO_THRESHOLDS.stale
      ? "stale"
      : ratio > STATUS_CACHE_RATIO_THRESHOLDS.degraded
        ? "degraded"
        : "healthy";

  let oldestSourceUpdatedAt: number | null = null;
  let maxSourceAgeSeconds: number | null = null;
  const hardcodedPegs: string[] = [];

  for (const pegKey of Object.keys(state.rates)) {
    if (pegKey === "peggedUSD") continue;
    const sourceMode = state.sourceModeByPeg[pegKey];
    if (sourceMode === "hardcoded") {
      hardcodedPegs.push(pegKey);
      continue;
    }
    const updatedAt = state.sourceUpdatedAtByPeg[pegKey] ?? null;
    if (updatedAt == null || !Number.isFinite(updatedAt) || updatedAt <= 0) continue;
    oldestSourceUpdatedAt = oldestSourceUpdatedAt == null ? updatedAt : Math.min(oldestSourceUpdatedAt, updatedAt);
    const sourceAge = Math.max(0, nowSec - updatedAt);
    maxSourceAgeSeconds = maxSourceAgeSeconds == null ? sourceAge : Math.max(maxSourceAgeSeconds, sourceAge);
  }

  let sourceStatus: FxSourceStatus = "none";
  if (maxSourceAgeSeconds != null) {
    sourceStatus =
      maxSourceAgeSeconds > FX_SOURCE_STALE_AGE_SEC
        ? "stale"
        : maxSourceAgeSeconds > FX_SOURCE_DEGRADED_AGE_SEC
          ? "degraded"
          : "fresh";
  }

  if (sourceStatus === "stale") {
    statusFloor = "stale";
  } else if (
    sourceStatus === "degraded" ||
    (state.mode === "cached-fallback" && state.consecutiveFallbackRuns >= 4)
  ) {
    statusFloor = statusFloor === "stale" ? "stale" : "degraded";
  }

  const warningParts: string[] = [];
  if (state.mode === "cached-fallback") {
    warningParts.push(`using cached fallback FX rates (${state.consecutiveFallbackRuns} consecutive run${state.consecutiveFallbackRuns === 1 ? "" : "s"})`);
  }
  if (sourceStatus === "degraded" && maxSourceAgeSeconds != null) {
    warningParts.push(`oldest non-USD source is ${Math.round(maxSourceAgeSeconds / 3600)}h old`);
  } else if (sourceStatus === "stale" && maxSourceAgeSeconds != null) {
    warningParts.push(`oldest non-USD source is ${Math.round(maxSourceAgeSeconds / 3600)}h old`);
  }
  if (hardcodedPegs.length > 0) {
    warningParts.push(`hardcoded source in use for ${hardcodedPegs.join(", ")}`);
  }

  const cacheStatus: CacheStatus = {
    ageSeconds,
    maxAge: maxAgeSec,
    healthy: ratio <= FRESHNESS_RATIOS.DEGRADED,
    mode: state.mode,
    sourceUpdatedAt: oldestSourceUpdatedAt,
    sourceAgeSeconds: maxSourceAgeSeconds,
    sourceStatus,
    warning: warningParts.length > 0 ? warningParts.join("; ") : null,
    consecutiveFallbackRuns: state.consecutiveFallbackRuns,
  };

  return {
    cacheStatus,
    statusFloor,
    warning: cacheStatus.warning ?? undefined,
  };
}
