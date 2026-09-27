import type { CacheStatus } from "@shared/types/status";
import { FRESHNESS_RATIOS, STATUS_CACHE_RATIO_THRESHOLDS } from "@shared/lib/status-thresholds";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { formatIsoDate } from "@shared/lib/format";
import { sha256Hex } from "@shared/lib/sha256";
import { getCaches, type CacheWriteResult } from "./db-cache";
import { executeAtomicBatch } from "./db";
import { logWorkerEvent } from "./structured-log";
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
/** A persisted per-peg source time further ahead of the reader clock than this is not admissible provenance. */
const FX_SOURCE_MAX_FUTURE_SKEW_SEC = 5 * 60;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export type FxRateSyncMode = "live" | "cached-fallback";
export type FxRateSourceMode = "live" | "cached";
export type { FxSourceCadence } from "./fx-cadence";
export type FxSourceStatus = "fresh" | "degraded" | "stale" | "none";

/**
 * How the `fx-rates-meta` row was bound to the `fx-rates` row it describes.
 * - `verified`: both rows carry one `updated_at` and the metadata's `ratesSha256`
 *   matches the stored rates bytes, so the pair is one publication even when two
 *   runs share a clock second.
 * - `legacy-timestamp`: metadata written before `ratesSha256` existed; accepted only
 *   when both rows carry one `updated_at`. Transitional: the first publication by the
 *   current producer replaces it with a verified pair.
 * - `missing` / `malformed` / `generation-mismatch`: the rates are usable numbers,
 *   but no per-peg provenance can be attached to them.
 */
export type FxMetadataIdentity = "verified" | "legacy-timestamp" | "missing" | "malformed" | "generation-mismatch";
export type FxUnverifiableMetadataIdentity = Exclude<FxMetadataIdentity, "verified" | "legacy-timestamp">;

function isFxMetadataUnverifiable(identity: FxMetadataIdentity): identity is FxUnverifiableMetadataIdentity {
  return identity !== "verified" && identity !== "legacy-timestamp";
}

/**
 * Why a present non-USD rate has no admissible source provenance. Shared by pricing
 * (`getFxReferenceTypeFromState`) and health (`buildFxCacheStatus`) so the two can
 * never disagree about an unknown source.
 */
export type FxPegAdmissionIssue =
  | `metadata-${FxUnverifiableMetadataIdentity}`
  | "source-provenance-missing"
  | "source-time-missing"
  | "source-time-future";

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
  metadataIdentity: FxMetadataIdentity;
}

interface CacheRow {
  value: string;
  updatedAt: number;
}

export function sanitizeFxRates(input: unknown): Record<string, number> {
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
    value === "live" || value === "cached" ? value : undefined
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

/**
 * Rates without an attachable metadata row keep their real publication clock
 * (`usableSyncAt` = the rates row's `updated_at`) but no per-peg source provenance:
 * the cache write time is never substituted for a source observation time.
 */
function buildUnverifiableMeta(ratesCache: CacheRow, rates: Record<string, number>): FxRatesMeta {
  return {
    usableSyncAt: ratesCache.updatedAt,
    mode: "live",
    sourceUpdatedAtByPeg: Object.fromEntries(Object.keys(rates).map((pegKey) => [pegKey, null])),
    sourceModeByPeg: {},
    previousCacheUpdatedAt: ratesCache.updatedAt,
    consecutiveFallbackRuns: 0,
  };
}

function parseFxMeta(
  value: string,
  ratesCache: CacheRow,
): { meta: FxRatesMeta; ratesSha256: string | null } | null {
  const decoded = decodeJsonString<{ meta: FxRatesMeta; ratesSha256: string | null }, "json-parse-failed" | "invalid-payload">(value, {
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: "invalid-payload" };
      }

      const record = parsed as Record<string, unknown>;
      // Absent digest = legacy writer; a present but unusable digest is corrupt metadata.
      if (record.ratesSha256 !== undefined && (typeof record.ratesSha256 !== "string" || !SHA256_HEX_PATTERN.test(record.ratesSha256))) {
        return { ok: false, reason: "invalid-payload" };
      }
      const usableSyncAt =
        typeof record.usableSyncAt === "number" && Number.isFinite(record.usableSyncAt) && record.usableSyncAt > 0
          ? Math.floor(record.usableSyncAt)
          : ratesCache.updatedAt;
      const mode: FxRateSyncMode = record.mode === "cached-fallback" ? "cached-fallback" : "live";
      return {
        ok: true,
        payload: {
          ratesSha256: typeof record.ratesSha256 === "string" ? record.ratesSha256 : null,
          meta: {
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
                : ratesCache.updatedAt,
            consecutiveFallbackRuns:
              typeof record.consecutiveFallbackRuns === "number" && Number.isFinite(record.consecutiveFallbackRuns) && record.consecutiveFallbackRuns >= 0
                ? Math.floor(record.consecutiveFallbackRuns)
                : 0,
          },
        },
      };
    },
  });
  return decoded.ok ? decoded.payload : null;
}

/**
 * Binds the metadata row to the rates row it describes. A row pair from two
 * different publications (legacy split writes, a failed second write, or two runs
 * sharing one clock second) never hydrates as matched provenance.
 */
function resolveFxMetadata(
  ratesCache: CacheRow,
  metaCache: CacheRow | null,
  rates: Record<string, number>,
): { meta: FxRatesMeta; identity: FxMetadataIdentity } {
  if (!metaCache) return { meta: buildUnverifiableMeta(ratesCache, rates), identity: "missing" };
  const parsed = parseFxMeta(metaCache.value, ratesCache);
  if (!parsed) return { meta: buildUnverifiableMeta(ratesCache, rates), identity: "malformed" };
  if (
    metaCache.updatedAt !== ratesCache.updatedAt
    || (parsed.ratesSha256 != null && parsed.ratesSha256 !== sha256Hex(ratesCache.value))
  ) {
    return { meta: buildUnverifiableMeta(ratesCache, rates), identity: "generation-mismatch" };
  }
  return { meta: parsed.meta, identity: parsed.ratesSha256 == null ? "legacy-timestamp" : "verified" };
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
  if (mode !== "live" && mode !== "cached") {
    return { status: "none", ageSec: null, cadence: null, warning: null };
  }

  const normalizedCadence = inferFxSourceCadence(pegKey, cadence);
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

export interface FxPegAdmission {
  /** Cadence-aware source freshness; `none` whenever `issue` is set. */
  status: FxSourceStatus;
  /** Non-null when the present rate has no admissible source provenance. */
  issue: FxPegAdmissionIssue | null;
  ageSec: number | null;
  cadence: FxSourceCadence | null;
  updatedAt: number | null;
  warning: string | null;
}

/**
 * The single per-peg admission assessment for a hydrated FX generation. Pricing
 * and health both derive their verdicts from it, so an unknown or unverifiable
 * source can never be healthy in one and unusable in the other.
 */
function assessFxPegAdmission(state: FxRateState, pegKey: string, nowSec: number): FxPegAdmission {
  if (isFxMetadataUnverifiable(state.metadataIdentity)) {
    return {
      status: "none",
      issue: `metadata-${state.metadataIdentity}`,
      ageSec: null,
      cadence: null,
      updatedAt: null,
      warning: null,
    };
  }
  const updatedAt = state.sourceUpdatedAtByPeg[pegKey] ?? null;
  if (updatedAt != null && updatedAt - nowSec > FX_SOURCE_MAX_FUTURE_SKEW_SEC) {
    return { status: "none", issue: "source-time-future", ageSec: null, cadence: null, updatedAt, warning: null };
  }
  const mode = state.sourceModeByPeg[pegKey];
  const freshness = evaluateFxSourceFreshness(
    pegKey,
    updatedAt,
    mode,
    state.sourceCadenceByPeg[pegKey],
    state.sourceDateByPeg[pegKey],
    nowSec,
  );
  if (freshness.status !== "none") return { ...freshness, issue: null, updatedAt };
  return {
    ...freshness,
    issue: mode === "live" || mode === "cached" ? "source-time-missing" : "source-provenance-missing",
    updatedAt,
  };
}

export function getFxReferenceTypeFromState(
  state: FxRateState | null,
  pegKey: string,
  maxAgeSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): "fresh" | "stale" | "none" {
  if (!state) return "none";
  const rate = state.rates[pegKey];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return "none";

  // Unverifiable metadata keeps its established pricing verdict: the rate exists
  // but can never be a fresh reference.
  if (isFxMetadataUnverifiable(state.metadataIdentity)) return "stale";
  const admission = assessFxPegAdmission(state, pegKey, nowSec);
  if (admission.issue) return "none";
  if (
    admission.status === "degraded" &&
    admission.cadence === "intraday" &&
    admission.ageSec != null &&
    admission.ageSec > maxAgeSec
  ) {
    return "stale";
  }
  return admission.status === "stale" ? "stale" : "fresh";
}

/**
 * Reads both FX rows in ONE statement, so a concurrent publication can never be
 * observed half-applied (both-old or both-new only).
 */
export async function loadFxRateState(db: D1Database): Promise<FxRateState | null> {
  const rows = await getCaches(db, [FX_RATES_KEY, FX_RATES_META_KEY]);
  return hydrateFxRateState(rows.get(FX_RATES_KEY) ?? null, rows.get(FX_RATES_META_KEY) ?? null);
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

  const { meta, identity } = resolveFxMetadata(ratesCache, metaCache, rates);

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
        inferFxSourceCadence(pegKey, meta.sourceCadenceByPeg?.[pegKey]),
      ]),
    ),
    sourceDateByPeg: Object.fromEntries(
      Object.keys(rates).map((pegKey) => [pegKey, meta.sourceDateByPeg?.[pegKey] ?? null]),
    ),
    sources: meta.sources,
    ecbDate: meta.ecbDate ?? null,
    previousCacheUpdatedAt: meta.previousCacheUpdatedAt ?? ratesCache.updatedAt,
    consecutiveFallbackRuns: meta.consecutiveFallbackRuns,
    metadataIdentity: identity,
  };
}

// Pair-level generation fence: each row is written only while NEITHER FX row is
// newer than this publication's clock. Two independent per-key conditions would let
// a legacy split pair (one row newer, one older) accept exactly one of the writes.
const FX_PAIR_FENCED_UPSERT_SQL = `INSERT INTO cache (key, value, updated_at)
  SELECT ?, ?, ?
  WHERE NOT EXISTS (SELECT 1 FROM cache WHERE key IN (?, ?) AND updated_at > ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;

/**
 * Publishes the rates and their metadata as one generation: one atomic D1 batch
 * under a pair-level clock fence, with the metadata bound to the exact rates bytes
 * by `ratesSha256`. Either both rows advance or neither does; a failed statement
 * rolls back the whole pair.
 */
export async function persistFxRateState(
  db: D1Database,
  rates: Record<string, number>,
  meta: FxRatesMeta,
  syncStartSec: number,
): Promise<CacheWriteResult> {
  const ratesValue = JSON.stringify(rates);
  const metaValue = JSON.stringify({ ...meta, ratesSha256: sha256Hex(ratesValue) });
  const [ratesResult, metaResult] = await executeAtomicBatch(
    db,
    [
      [FX_RATES_KEY, ratesValue],
      [FX_RATES_META_KEY, metaValue],
    ].map(([key, value]) => db
      .prepare(FX_PAIR_FENCED_UPSERT_SQL)
      .bind(key, value, syncStartSec, FX_RATES_KEY, FX_RATES_META_KEY, syncStartSec)),
    { returnResults: true },
  );
  const ratesWritten = Number(ratesResult?.meta?.changes ?? 0) > 0;
  const metaWritten = Number(metaResult?.meta?.changes ?? 0) > 0;
  if (ratesWritten !== metaWritten) {
    // Unreachable under the pair fence inside one transaction; fail loudly rather
    // than report a split pair as published.
    throw new Error(`fx rate pair publication diverged (rates=${ratesWritten}, meta=${metaWritten})`);
  }
  if (!ratesWritten) {
    logWorkerEvent({
      scope: "lib",
      level: "info",
      event: "cache_write_skipped_newer",
      message: "Skipped FX rate pair publication because a newer FX generation exists",
      metadata: { key: FX_RATES_KEY, pairKey: FX_RATES_META_KEY, syncStartSec },
    });
  }
  return { written: ratesWritten, skippedBecauseNewer: !ratesWritten };
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
  let sourceStatus: FxSourceStatus = "none";
  let sourceWarning: string | null = null;
  let sourceStatusAgeSeconds: number | null = null;
  let sourceStatusUpdatedAt: number | null = null;
  const admissionIssues: Array<{ pegKey: string; issue: FxPegAdmissionIssue }> = [];

  const severityRank = (status: FxSourceStatus): number =>
    status === "stale" ? 3 : status === "degraded" ? 2 : status === "fresh" ? 1 : 0;

  for (const pegKey of Object.keys(state.rates)) {
    if (pegKey === "peggedUSD") continue;
    const admission = assessFxPegAdmission(state, pegKey, nowSec);
    if (admission.issue) {
      admissionIssues.push({ pegKey, issue: admission.issue });
      continue;
    }
    const { updatedAt } = admission;
    if (updatedAt != null) {
      oldestSourceUpdatedAt = oldestSourceUpdatedAt == null ? updatedAt : Math.min(oldestSourceUpdatedAt, updatedAt);
      const sourceAge = Math.max(0, nowSec - updatedAt);
      maxSourceAgeSeconds = maxSourceAgeSeconds == null ? sourceAge : Math.max(maxSourceAgeSeconds, sourceAge);
    }
    if (severityRank(admission.status) > severityRank(sourceStatus)) {
      sourceStatus = admission.status;
      sourceWarning = admission.warning;
      sourceStatusAgeSeconds = admission.ageSec;
      sourceStatusUpdatedAt = updatedAt;
    }
  }

  // A present non-USD rate without admissible provenance is at least degraded:
  // recency of the cache write can never make an unknown source healthy.
  let degradedReason: string | null = null;
  let admissionWarning: string | null = null;
  if (admissionIssues.length > 0) {
    if (isFxMetadataUnverifiable(state.metadataIdentity)) {
      degradedReason = `fx-metadata-${state.metadataIdentity}`;
      admissionWarning = `FX metadata ${state.metadataIdentity}: no verifiable source provenance for ${admissionIssues.length} rate${admissionIssues.length === 1 ? "" : "s"}`;
    } else {
      const perPeg = admissionIssues.map(({ pegKey, issue }) => `${pegKey}=${issue}`).join(",");
      degradedReason = `fx-source-provenance-unknown:${perPeg}`;
      admissionWarning = `source provenance unknown for ${admissionIssues.map(({ pegKey, issue }) => `${pegKey} (${issue})`).join(", ")}`;
    }
    if (severityRank(sourceStatus) < severityRank("degraded")) {
      sourceStatus = "degraded";
      sourceWarning = null;
      sourceStatusAgeSeconds = null;
      sourceStatusUpdatedAt = null;
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
  if (admissionWarning) warningParts.push(admissionWarning);

  const cacheStatus: CacheStatus = {
    ageSeconds,
    maxAge: maxAgeSec,
    healthy: ratio <= FRESHNESS_RATIOS.DEGRADED && admissionIssues.length === 0,
    degraded: admissionIssues.length > 0,
    degradedReason,
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
