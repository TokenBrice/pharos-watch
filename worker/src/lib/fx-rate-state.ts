import type { CacheStatus } from "@shared/types/status";
import { FRESHNESS_RATIOS, STATUS_CACHE_RATIO_THRESHOLDS } from "@shared/lib/status-thresholds";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { formatIsoDate } from "@shared/lib/format";
import { getCache, setCacheIfNewer, type CacheWriteResult } from "./db-cache";
import { decodeJsonString } from "./cache-json";
import { sanitizeRecordValues } from "./normalizers";
import { inferFxSourceCadence, type FxSourceCadence } from "./fx-cadence";
import { startOfUtcDaySec } from "@shared/lib/time-buckets";
import { IsolateLocalState } from "./isolate-local-state";

const FX_RATES_KEY = "fx-rates";
const FX_RATES_META_KEY = "fx-rates-meta";
const FX_INTRADAY_SOURCE_DEGRADED_AGE_SEC = 6 * 3600;
const FX_INTRADAY_SOURCE_STALE_AGE_SEC = 24 * 3600;
const FX_CALENDAR_DAILY_ROLLOVER_HOUR_UTC = 6;
const FX_BUSINESS_DAILY_PUBLISH_HOUR_UTC = 16;

export type FxRateSyncMode = "live" | "cached-fallback";
export type FxRateSourceMode = "live" | "cached" | "hardcoded";
export type { FxSourceCadence } from "./fx-cadence";
export type FxSourceStatus = "fresh" | "degraded" | "stale" | "none";

export interface FxRatesMeta {
  usableSyncAt: number;
  mode: FxRateSyncMode;
  sourceUpdatedAtByPeg: Record<string, number | null>;
  sourceModeByPeg: Record<string, FxRateSourceMode>;
  sourceCadenceByPeg?: Record<string, FxSourceCadence>;
  sourceDateByPeg?: Record<string, string | null>;
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
  sourceCadenceByPeg: Record<string, FxSourceCadence>;
  sourceDateByPeg: Record<string, string | null>;
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
  return sanitizeRecordValues(input, (value) => (
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
  ));
}

function sanitizeSourceUpdatedAtByPeg(input: unknown): Record<string, number | null> {
  return sanitizeRecordValues(input, (value) => (
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : null
  ));
}

function sanitizeSourceModeByPeg(input: unknown): Record<string, FxRateSourceMode> {
  return sanitizeRecordValues(input, (value) => (
    value === "live" || value === "cached" || value === "hardcoded" ? value : undefined
  ));
}

function sanitizeSourceCadenceByPeg(input: unknown): Record<string, FxSourceCadence> {
  return sanitizeRecordValues(input, (value) => (
    value === "intraday" || value === "calendar-daily" || value === "business-daily" ? value : undefined
  ));
}

function sanitizeSourceDateByPeg(input: unknown): Record<string, string | null> {
  return sanitizeRecordValues(input, (value) => (
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
  ));
}

function sanitizeSources(input: unknown): Record<string, string> | undefined {
  const out = sanitizeRecordValues(input, (value) => (
    typeof value === "string" && value.length > 0 ? value : undefined
  ));
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildBootstrapMeta(cache: CacheRow, rates: Record<string, number>): FxRatesMeta {
  const sourceUpdatedAtByPeg: Record<string, number | null> = {};
  const sourceModeByPeg: Record<string, FxRateSourceMode> = {};
  const sourceCadenceByPeg: Record<string, FxSourceCadence> = {};
  const sourceDateByPeg: Record<string, string | null> = {};
  for (const pegKey of Object.keys(rates)) {
    sourceUpdatedAtByPeg[pegKey] = cache.updatedAt;
    sourceModeByPeg[pegKey] = "live";
    sourceCadenceByPeg[pegKey] = "intraday";
    sourceDateByPeg[pegKey] = null;
  }
  return {
    usableSyncAt: cache.updatedAt,
    mode: "live",
    sourceUpdatedAtByPeg,
    sourceModeByPeg,
    sourceCadenceByPeg,
    sourceDateByPeg,
    previousCacheUpdatedAt: cache.updatedAt,
    consecutiveFallbackRuns: 0,
  };
}

function parseFxMeta(value: string, fallback: CacheRow, rates: Record<string, number>): FxRatesMeta {
  const decoded = decodeJsonString<FxRatesMeta, "json-parse-failed" | "invalid-payload">(value, {
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: "invalid-payload" };
      }

      const record = parsed as Record<string, unknown>;
      const usableSyncAt =
        typeof record.usableSyncAt === "number" && Number.isFinite(record.usableSyncAt) && record.usableSyncAt > 0
          ? Math.floor(record.usableSyncAt)
          : fallback.updatedAt;
      const mode: FxRateSyncMode = record.mode === "cached-fallback" ? "cached-fallback" : "live";
      return {
        ok: true,
        payload: {
          usableSyncAt,
          mode,
          sourceUpdatedAtByPeg: sanitizeSourceUpdatedAtByPeg(record.sourceUpdatedAtByPeg),
          sourceModeByPeg: sanitizeSourceModeByPeg(record.sourceModeByPeg),
          sourceCadenceByPeg: sanitizeSourceCadenceByPeg(record.sourceCadenceByPeg),
          sourceDateByPeg: sanitizeSourceDateByPeg(record.sourceDateByPeg),
          sources: sanitizeSources(record.sources),
          ecbDate: typeof record.ecbDate === "string" && record.ecbDate.length > 0 ? record.ecbDate : null,
          previousCacheUpdatedAt:
            typeof record.previousCacheUpdatedAt === "number" && Number.isFinite(record.previousCacheUpdatedAt)
              ? Math.floor(record.previousCacheUpdatedAt)
              : fallback.updatedAt,
          consecutiveFallbackRuns:
            typeof record.consecutiveFallbackRuns === "number" && Number.isFinite(record.consecutiveFallbackRuns) && record.consecutiveFallbackRuns >= 0
              ? Math.floor(record.consecutiveFallbackRuns)
              : 0,
        },
      };
    },
  });

  if (decoded.ok) {
    return decoded.payload;
  }
  return buildBootstrapMeta(fallback, rates);
}

export function getFxRatesMetaKey(): string {
  return FX_RATES_META_KEY;
}

function formatUtcDate(dayStartSec: number): string {
  return formatIsoDate(dayStartSec);
}

function parseIsoDayStartSec(dateText: string | null | undefined): number | null {
  if (!dateText || !/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return null;
  const parsed = Date.parse(`${dateText}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed / 1000);
}

function isWeekendDay(dayStartSec: number): boolean {
  const day = new Date(dayStartSec * 1000).getUTCDay();
  return day === 0 || day === 6;
}

const _fxCalendar = new IsolateLocalState(() => ({
  targetClosingDaysByYear: new Map<number, Set<string>>(),
}));

function computeEasterSundayDayStartSec(year: number): number {
  // Meeus/Jones/Butcher Gregorian computus.
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Math.floor(Date.UTC(year, month - 1, day) / 1000);
}

function getTargetClosingDays(year: number): Set<string> {
  const byYear = _fxCalendar.state.targetClosingDaysByYear;
  const cached = byYear.get(year);
  if (cached) return cached;

  const easterSundaySec = computeEasterSundayDayStartSec(year);
  const closingDays = new Set<string>([
    `${year}-01-01`,
    `${year}-05-01`,
    `${year}-12-25`,
    `${year}-12-26`,
    formatUtcDate(easterSundaySec - (2 * DAY_SECONDS)),
    formatUtcDate(easterSundaySec + DAY_SECONDS),
  ]);
  byYear.set(year, closingDays);
  return closingDays;
}

function isTargetClosingDay(dayStartSec: number): boolean {
  const day = new Date(dayStartSec * 1000);
  return getTargetClosingDays(day.getUTCFullYear()).has(formatUtcDate(dayStartSec));
}

function isBusinessDailyPublishDay(dayStartSec: number): boolean {
  return !isWeekendDay(dayStartSec) && !isTargetClosingDay(dayStartSec);
}

function previousBusinessDailyPublishDaySec(dayStartSec: number): number {
  let current = dayStartSec - DAY_SECONDS;
  while (!isBusinessDailyPublishDay(current)) {
    current -= DAY_SECONDS;
  }
  return current;
}

function countBusinessDailyPublishesBehind(sourceDaySec: number, expectedDaySec: number): number {
  if (sourceDaySec >= expectedDaySec) return 0;
  let missed = 0;
  for (let cursor = sourceDaySec + DAY_SECONDS; cursor <= expectedDaySec; cursor += DAY_SECONDS) {
    if (isBusinessDailyPublishDay(cursor)) {
      missed++;
    }
  }
  return missed;
}

function resolveBusinessDailyExpectedDaySec(nowSec: number): number {
  const dayStartSec = startOfUtcDaySec(new Date(nowSec * 1000));
  if (!isBusinessDailyPublishDay(dayStartSec)) {
    return previousBusinessDailyPublishDaySec(dayStartSec);
  }
  const hourUtc = new Date(nowSec * 1000).getUTCHours();
  return hourUtc >= FX_BUSINESS_DAILY_PUBLISH_HOUR_UTC
    ? dayStartSec
    : previousBusinessDailyPublishDaySec(dayStartSec);
}

function resolveCalendarDailyExpectedDaySec(nowSec: number): number {
  const dayStartSec = startOfUtcDaySec(new Date(nowSec * 1000));
  const hourUtc = new Date(nowSec * 1000).getUTCHours();
  return hourUtc >= FX_CALENDAR_DAILY_ROLLOVER_HOUR_UTC
    ? dayStartSec
    : dayStartSec - DAY_SECONDS;
}

interface FxSourceFreshness {
  status: FxSourceStatus;
  ageSec: number | null;
  cadence: FxSourceCadence | null;
  warning: string | null;
}

function evaluateFxSourceFreshness(
  pegKey: string,
  updatedAt: number | null,
  mode: FxRateSourceMode | undefined,
  cadence: FxSourceCadence | undefined,
  sourceDate: string | null | undefined,
  nowSec: number,
): FxSourceFreshness {
  if (mode === "hardcoded") {
    return { status: "none", ageSec: null, cadence: null, warning: null };
  }

  const normalizedCadence = inferFxSourceCadence(pegKey, mode, cadence);
  const ageSec =
    updatedAt != null && Number.isFinite(updatedAt) && updatedAt > 0
      ? Math.max(0, nowSec - updatedAt)
      : null;
  const sourceDaySec = parseIsoDayStartSec(sourceDate);

  if (normalizedCadence === "business-daily" && sourceDaySec != null) {
    const expectedDaySec = resolveBusinessDailyExpectedDaySec(nowSec);
    const missedPublishes = countBusinessDailyPublishesBehind(sourceDaySec, expectedDaySec);
    if (missedPublishes === 0) {
      return { status: "fresh", ageSec, cadence: normalizedCadence, warning: null };
    }
    return {
      status: missedPublishes === 1 ? "degraded" : "stale",
      ageSec,
      cadence: normalizedCadence,
      warning:
        `${pegKey} business-daily reference is ${missedPublishes} publish` +
        `${missedPublishes === 1 ? "" : "es"} behind (latest ${formatUtcDate(sourceDaySec)}, expected ${formatUtcDate(expectedDaySec)})`,
    };
  }

  if (normalizedCadence === "calendar-daily" && sourceDaySec != null) {
    const expectedDaySec = resolveCalendarDailyExpectedDaySec(nowSec);
    const missedDays = Math.max(0, Math.floor((expectedDaySec - sourceDaySec) / DAY_SECONDS));
    if (missedDays <= 0) {
      return { status: "fresh", ageSec, cadence: normalizedCadence, warning: null };
    }
    return {
      status: missedDays === 1 ? "degraded" : "stale",
      ageSec,
      cadence: normalizedCadence,
      warning:
        `${pegKey} calendar-daily reference is ${missedDays} day` +
        `${missedDays === 1 ? "" : "s"} behind (latest ${formatUtcDate(sourceDaySec)}, expected ${formatUtcDate(expectedDaySec)})`,
    };
  }

  if (ageSec == null) {
    return { status: "none", ageSec: null, cadence: normalizedCadence, warning: null };
  }
  if (ageSec > FX_INTRADAY_SOURCE_STALE_AGE_SEC) {
    return {
      status: "stale",
      ageSec,
      cadence: normalizedCadence,
      warning: `${pegKey} intraday reference is ${Math.round(ageSec / 3600)}h old`,
    };
  }
  if (ageSec > FX_INTRADAY_SOURCE_DEGRADED_AGE_SEC) {
    return {
      status: "degraded",
      ageSec,
      cadence: normalizedCadence,
      warning: `${pegKey} intraday reference is ${Math.round(ageSec / 3600)}h old`,
    };
  }
  return { status: "fresh", ageSec, cadence: normalizedCadence, warning: null };
}

export function getFxSourceStatus(
  updatedAt: number | null,
  mode: FxRateSourceMode | undefined,
  nowSec = Math.floor(Date.now() / 1000),
  opts?: {
    pegKey?: string;
    cadence?: FxSourceCadence;
    sourceDate?: string | null;
  },
): FxSourceStatus {
  return evaluateFxSourceFreshness(
    opts?.pegKey ?? "unknown",
    updatedAt,
    mode,
    opts?.cadence,
    opts?.sourceDate,
    nowSec,
  ).status;
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
  const freshness = evaluateFxSourceFreshness(
    pegKey,
    updatedAt,
    mode,
    state.sourceCadenceByPeg[pegKey],
    state.sourceDateByPeg[pegKey],
    nowSec,
  );
  if (freshness.status === "none") return "none";
  if (
    freshness.status === "degraded" &&
    freshness.cadence === "intraday" &&
    updatedAt != null &&
    Math.max(0, nowSec - updatedAt) > maxAgeSec
  ) {
    return "stale";
  }
  return freshness.status === "stale" ? "stale" : "fresh";
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

  const decodedRates = decodeJsonString<Record<string, number>, "json-parse-failed">(
    ratesCache.value,
    {
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => ({ ok: true, payload: sanitizeFxRates(parsed) }),
    },
  );
  if (!decodedRates.ok) {
    return null;
  }
  const rates = decodedRates.payload;
  if (Object.keys(rates).length === 0) return null;

  const meta = metaCache
    ? parseFxMeta(metaCache.value, ratesCache, rates)
    : buildBootstrapMeta(ratesCache, rates);

  const nowSec = Math.floor(Date.now() / 1000);
  return {
    rates,
    usableSyncAt: meta.usableSyncAt,
    usableAgeSec: Math.max(0, nowSec - meta.usableSyncAt),
    mode: meta.mode,
    sourceUpdatedAtByPeg: meta.sourceUpdatedAtByPeg,
    sourceModeByPeg: meta.sourceModeByPeg,
    sourceCadenceByPeg: Object.fromEntries(
      Object.keys(rates).map((pegKey) => [
        pegKey,
        inferFxSourceCadence(pegKey, meta.sourceModeByPeg[pegKey], meta.sourceCadenceByPeg?.[pegKey]),
      ]),
    ),
    sourceDateByPeg: Object.fromEntries(
      Object.keys(rates).map((pegKey) => [pegKey, meta.sourceDateByPeg?.[pegKey] ?? null]),
    ),
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
): Promise<{
  rates: CacheWriteResult;
  meta: CacheWriteResult;
}> {
  const ratesResult = await setCacheIfNewer(db, FX_RATES_KEY, JSON.stringify(rates), syncStartSec);
  const metaResult = await setCacheIfNewer(db, FX_RATES_META_KEY, JSON.stringify(meta), syncStartSec);
  return { rates: ratesResult, meta: metaResult };
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
  let sourceStatus: FxSourceStatus = "none";
  let sourceWarning: string | null = null;
  let sourceStatusAgeSeconds: number | null = null;
  let sourceStatusUpdatedAt: number | null = null;

  const severityRank = (status: FxSourceStatus): number =>
    status === "stale" ? 3 : status === "degraded" ? 2 : status === "fresh" ? 1 : 0;

  for (const pegKey of Object.keys(state.rates)) {
    if (pegKey === "peggedUSD") continue;
    const sourceMode = state.sourceModeByPeg[pegKey];
    if (sourceMode === "hardcoded") {
      hardcodedPegs.push(pegKey);
      continue;
    }
    const updatedAt = state.sourceUpdatedAtByPeg[pegKey] ?? null;
    if (updatedAt != null && Number.isFinite(updatedAt) && updatedAt > 0) {
      oldestSourceUpdatedAt = oldestSourceUpdatedAt == null ? updatedAt : Math.min(oldestSourceUpdatedAt, updatedAt);
      const sourceAge = Math.max(0, nowSec - updatedAt);
      maxSourceAgeSeconds = maxSourceAgeSeconds == null ? sourceAge : Math.max(maxSourceAgeSeconds, sourceAge);
    }

    const freshness = evaluateFxSourceFreshness(
      pegKey,
      updatedAt,
      sourceMode,
      state.sourceCadenceByPeg[pegKey],
      state.sourceDateByPeg[pegKey],
      nowSec,
    );
    if (severityRank(freshness.status) > severityRank(sourceStatus)) {
      sourceStatus = freshness.status;
      sourceWarning = freshness.warning;
      sourceStatusAgeSeconds = freshness.ageSec;
      sourceStatusUpdatedAt = updatedAt;
    } else if (sourceStatus === "none" && freshness.status === "fresh") {
      sourceStatus = "fresh";
    }
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
  if ((sourceStatus === "degraded" || sourceStatus === "stale") && sourceWarning) {
    warningParts.push(sourceWarning);
  }
  if (hardcodedPegs.length > 0) {
    warningParts.push(`hardcoded source in use for ${hardcodedPegs.join(", ")}`);
  }

  const cacheStatus: CacheStatus = {
    ageSeconds,
    maxAge: maxAgeSec,
    healthy: ratio <= FRESHNESS_RATIOS.DEGRADED,
    mode: state.mode,
    sourceUpdatedAt:
      sourceStatus === "degraded" || sourceStatus === "stale"
        ? sourceStatusUpdatedAt
        : oldestSourceUpdatedAt,
    sourceAgeSeconds:
      sourceStatus === "degraded" || sourceStatus === "stale"
        ? sourceStatusAgeSeconds
        : maxSourceAgeSeconds,
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
