import { logWorkerEventArgs } from "../../../lib/structured-log";
import type { YieldBenchmarkKey } from "@shared/types/yield";
import { isFiniteNumber, isRecord } from "@shared/lib/type-guards";
import { RISK_FREE_RATE_FALLBACK } from "../../../lib/constants";
import { toFiniteNumber } from "../../../lib/number-utils";
import {
  getYieldBenchmarkStaticMeta,
  type ParsedYieldBenchmarkMeta,
  type ParsedYieldBenchmarkRegistry,
} from "../benchmarks";
import { toErrorMessage } from "../../../lib/error-utils";

// ---------------------------------------------------------------------------
// Coercion primitives shared by every cache submodule.
// ---------------------------------------------------------------------------

export function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function toNonNegativeInteger(value: unknown): number {
  const parsed = toFiniteNumber(value);
  if (parsed == null || parsed < 0) return 0;
  return Math.floor(parsed);
}

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

export { isFiniteNumber };

export function isNullableFiniteNumber(value: unknown): value is number | null | undefined {
  return value == null || isFiniteNumber(value);
}

export function isNullableNonNegativeFiniteNumber(
  value: unknown,
): value is number | null | undefined {
  return value == null || (isFiniteNumber(value) && value >= 0);
}

export function isNullableStringValue(value: unknown): value is string | null | undefined {
  return value == null || typeof value === "string";
}

export function isObservedAt(value: unknown, nowSec: number): value is number | null | undefined {
  return value == null || (isFiniteNumber(value) && value >= 0 && value <= nowSec);
}

export function parseCachePayloadUpdatedAt(
  value: unknown,
  cacheUpdatedAt: number,
  nowSec: number,
): number | null {
  const updatedAt = toFiniteNumber(value) ?? cacheUpdatedAt;
  return updatedAt <= nowSec ? updatedAt : null;
}

export function summarizeInvalidRows(
  rows: unknown[],
  getKey: (row: unknown, index: number) => string,
): string[] {
  return rows.slice(0, 5).map(getKey);
}

// ---------------------------------------------------------------------------
// Risk-free rate (benchmark) payload normalization — single benchmark.
// ---------------------------------------------------------------------------

interface RiskFreeRateCachePayload {
  key?: YieldBenchmarkKey;
  label?: string;
  currency?: string;
  rate: number;
  recordDate: string | null;
  fetchedAt: number | null;
  source: string;
  isFallback: boolean;
  fallbackMode: string | null;
  isProxy?: boolean;
  lastMarketRate: number | null;
  lastMarketRecordDate: string | null;
  lastMarketFetchedAt: number | null;
  lastMarketSource: string | null;
}

interface RiskFreeRatesCachePayload {
  version: 1;
  benchmarks: {
    USD: RiskFreeRateCachePayload;
    USD_EFFR?: RiskFreeRateCachePayload | null;
    EUR: RiskFreeRateCachePayload | null;
    CHF: RiskFreeRateCachePayload | null;
    GBP: RiskFreeRateCachePayload | null;
    JPY: RiskFreeRateCachePayload | null;
    MXN: RiskFreeRateCachePayload | null;
    BRL: RiskFreeRateCachePayload | null;
    AUD: RiskFreeRateCachePayload | null;
    CAD: RiskFreeRateCachePayload | null;
    RUB: RiskFreeRateCachePayload | null;
    TRY: RiskFreeRateCachePayload | null;
    SGD: RiskFreeRateCachePayload | null;
  };
}

type RiskFreeRateParseDefaults = {
  key?: YieldBenchmarkKey;
  label?: string;
  currency?: string;
  isProxy?: boolean;
};

export function buildRiskFreeRateCachePayload(
  fields: Partial<RiskFreeRateCachePayload> & Pick<RiskFreeRateCachePayload, "rate" | "source">,
): RiskFreeRateCachePayload {
  const inferredLastMarketRate =
    fields.lastMarketRate ??
    (fields.isFallback === true || fields.source === "hardcoded-fallback" ? null : fields.rate);
  const inferredLastMarketRecordDate =
    fields.lastMarketRecordDate ??
    (inferredLastMarketRate != null ? fields.recordDate ?? null : null);
  const inferredLastMarketFetchedAt =
    fields.lastMarketFetchedAt ??
    (inferredLastMarketRate != null ? fields.fetchedAt ?? null : null);
  const inferredLastMarketSource =
    fields.lastMarketSource ??
    (inferredLastMarketRate != null ? fields.source : null);
  const staticMeta =
    fields.key != null
      ? getYieldBenchmarkStaticMeta(fields.key)
      : getYieldBenchmarkStaticMeta("USD");
  return {
    key: fields.key ?? "USD",
    label: fields.label ?? staticMeta.label,
    currency: fields.currency ?? staticMeta.currency,
    rate: fields.rate,
    recordDate: fields.recordDate ?? null,
    fetchedAt: fields.fetchedAt ?? null,
    source: fields.source,
    isFallback: fields.isFallback ?? false,
    fallbackMode: fields.fallbackMode ?? null,
    isProxy: fields.isProxy ?? staticMeta.isProxy,
    lastMarketRate: inferredLastMarketRate,
    lastMarketRecordDate: inferredLastMarketRecordDate,
    lastMarketFetchedAt: inferredLastMarketFetchedAt,
    lastMarketSource: inferredLastMarketSource,
  };
}

export function serializeRiskFreeRateCache(payload: RiskFreeRateCachePayload): string {
  return JSON.stringify(payload);
}

export function buildRiskFreeRatesCachePayload(
  benchmarks: RiskFreeRatesCachePayload["benchmarks"],
): RiskFreeRatesCachePayload {
  return {
    version: 1,
    benchmarks,
  };
}

export function serializeRiskFreeRatesCache(payload: RiskFreeRatesCachePayload): string {
  return JSON.stringify(payload);
}

function parseRiskFreeRateRecord(
  parsed: unknown,
  cacheUpdatedAt: number,
  nowSec: number,
  defaults?: RiskFreeRateParseDefaults,
  legacyFallbackValue: unknown = parsed,
): ParsedYieldBenchmarkMeta | null {
  if (isRecord(parsed)) {
    const rate = toFiniteNumber(parsed.rate);
    const fetchedAt = toFiniteNumber(parsed.fetchedAt);
    if (rate != null) {
      const effectiveFetchedAt = fetchedAt ?? cacheUpdatedAt;
      const isFallback = parsed.isFallback === true;
      const source = toNullableString(parsed.source) ?? "unknown";
      const parsedKey = toNullableString(parsed.key) as YieldBenchmarkKey | null;
      const key = defaults?.key ?? parsedKey ?? "USD";
      const staticMeta = getYieldBenchmarkStaticMeta(key);
      const lastMarketRate =
        toFiniteNumber(parsed.lastMarketRate) ??
        (!isFallback && source !== "hardcoded-fallback" ? rate : null);
      return {
        key,
        label: defaults?.label ?? toNullableString(parsed.label) ?? staticMeta.label,
        currency: defaults?.currency ?? toNullableString(parsed.currency) ?? staticMeta.currency,
        rate,
        recordDate: toNullableString(parsed.recordDate),
        fetchedAt: effectiveFetchedAt,
        ageSeconds: effectiveFetchedAt != null ? Math.max(0, nowSec - effectiveFetchedAt) : null,
        source,
        isFallback,
        fallbackMode: toNullableString(parsed.fallbackMode),
        isProxy: defaults?.isProxy ?? (typeof parsed.isProxy === "boolean" ? parsed.isProxy : staticMeta.isProxy),
        lastMarketRate,
        lastMarketRecordDate:
          toNullableString(parsed.lastMarketRecordDate) ??
          (lastMarketRate != null ? toNullableString(parsed.recordDate) : null),
        lastMarketFetchedAt:
          toFiniteNumber(parsed.lastMarketFetchedAt) ??
          (lastMarketRate != null ? effectiveFetchedAt : null),
        lastMarketSource:
          toNullableString(parsed.lastMarketSource) ??
          (lastMarketRate != null ? source : null),
      };
    }
  }

  const legacyRate = toFiniteNumber(legacyFallbackValue);
  if (legacyRate == null) return null;
  const key = defaults?.key ?? "USD";
  const staticMeta = getYieldBenchmarkStaticMeta(key);
  return {
    key,
    label: defaults?.label ?? staticMeta.label,
    currency: defaults?.currency ?? staticMeta.currency,
    rate: legacyRate,
    recordDate: null,
    fetchedAt: cacheUpdatedAt,
    ageSeconds: Math.max(0, nowSec - cacheUpdatedAt),
    source: "legacy-scalar",
    isFallback: legacyRate === RISK_FREE_RATE_FALLBACK,
    fallbackMode: legacyRate === RISK_FREE_RATE_FALLBACK ? "legacy-scalar-fallback" : null,
    isProxy: defaults?.isProxy ?? staticMeta.isProxy,
    lastMarketRate: legacyRate === RISK_FREE_RATE_FALLBACK ? null : legacyRate,
    lastMarketRecordDate: null,
    lastMarketFetchedAt: legacyRate === RISK_FREE_RATE_FALLBACK ? null : cacheUpdatedAt,
    lastMarketSource: legacyRate === RISK_FREE_RATE_FALLBACK ? null : "legacy-scalar",
  };
}

export function parseRiskFreeRateCache(
  raw: string,
  cacheUpdatedAt: number,
  nowSec = Math.floor(Date.now() / 1000),
  defaults?: RiskFreeRateParseDefaults,
): ParsedYieldBenchmarkMeta | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parseRiskFreeRateRecord(parsed, cacheUpdatedAt, nowSec, defaults, raw);
  } catch { /* expected: legacy scalar format — fall through to numeric parsing */
  }

  return parseRiskFreeRateRecord(raw, cacheUpdatedAt, nowSec, defaults, raw);
}

export function parseRiskFreeRatesCache(
  raw: string,
  cacheUpdatedAt: number,
  nowSec = Math.floor(Date.now() / 1000),
): ParsedYieldBenchmarkRegistry | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.benchmarks)) return null;
    const benchmarks = parsed.benchmarks as Record<string, unknown>;
    const usdRaw = benchmarks.USD;
    if (!usdRaw) return null;

    const parseBundledBenchmark = (
      raw: unknown,
      key: YieldBenchmarkKey,
    ): ParsedYieldBenchmarkMeta | null => {
      const legacyFallbackValue = isRecord(raw) ? raw : JSON.stringify(raw);
      return parseRiskFreeRateRecord(raw, cacheUpdatedAt, nowSec, { key }, legacyFallbackValue);
    };

    const usd = parseBundledBenchmark(usdRaw, "USD");
    if (!usd) return null;

    const parseOptional = (
      key: YieldBenchmarkKey,
    ): ParsedYieldBenchmarkMeta | null => {
      const raw = benchmarks[key];
      if (raw == null) return null;
      return parseBundledBenchmark(raw, key);
    };

    return {
      USD: usd,
      USD_EFFR: parseOptional("USD_EFFR"),
      EUR: parseOptional("EUR"),
      CHF: parseOptional("CHF"),
      GBP: parseOptional("GBP"),
      JPY: parseOptional("JPY"),
      MXN: parseOptional("MXN"),
      BRL: parseOptional("BRL"),
      AUD: parseOptional("AUD"),
      CAD: parseOptional("CAD"),
      RUB: parseOptional("RUB"),
      TRY: parseOptional("TRY"),
      SGD: parseOptional("SGD"),
    };
  } catch (err) {
    logWorkerEventArgs("handler", "warn", `[yield-sync] Failed to parse bundled benchmarks cache: ${toErrorMessage(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deterministic on-chain health state — normalization for cron health cache.
// ---------------------------------------------------------------------------

interface DeterministicOnChainHealthStateCachePayload {
  version: 1;
  consecutiveAllFailRuns: number;
  consecutiveMaskedAllFailRuns: number;
  cooldownUntil: number | null;
  lastAttemptedAt: number | null;
  lastAllFailedAt: number | null;
  lastSuccessAt: number | null;
  lastSkippedAt: number | null;
  lastFailureMissingIds: string[];
}

export interface DeterministicOnChainHealthState {
  consecutiveAllFailRuns: number;
  consecutiveMaskedAllFailRuns: number;
  cooldownUntil: number | null;
  lastAttemptedAt: number | null;
  lastAllFailedAt: number | null;
  lastSuccessAt: number | null;
  lastSkippedAt: number | null;
  lastFailureMissingIds: string[];
}

export function getDefaultDeterministicOnChainHealthState(): DeterministicOnChainHealthState {
  return {
    consecutiveAllFailRuns: 0,
    consecutiveMaskedAllFailRuns: 0,
    cooldownUntil: null,
    lastAttemptedAt: null,
    lastAllFailedAt: null,
    lastSuccessAt: null,
    lastSkippedAt: null,
    lastFailureMissingIds: [],
  };
}

export function serializeDeterministicOnChainHealthState(
  state: DeterministicOnChainHealthState,
): string {
  const payload: DeterministicOnChainHealthStateCachePayload = {
    version: 1,
    consecutiveAllFailRuns: state.consecutiveAllFailRuns,
    consecutiveMaskedAllFailRuns: state.consecutiveMaskedAllFailRuns,
    cooldownUntil: state.cooldownUntil,
    lastAttemptedAt: state.lastAttemptedAt,
    lastAllFailedAt: state.lastAllFailedAt,
    lastSuccessAt: state.lastSuccessAt,
    lastSkippedAt: state.lastSkippedAt,
    lastFailureMissingIds: state.lastFailureMissingIds,
  };
  return JSON.stringify(payload);
}

export function parseDeterministicOnChainHealthState(raw: string): DeterministicOnChainHealthState {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return getDefaultDeterministicOnChainHealthState();
    }

    return {
      consecutiveAllFailRuns: toNonNegativeInteger(parsed.consecutiveAllFailRuns),
      consecutiveMaskedAllFailRuns: toNonNegativeInteger(parsed.consecutiveMaskedAllFailRuns),
      cooldownUntil: toFiniteNumber(parsed.cooldownUntil),
      lastAttemptedAt: toFiniteNumber(parsed.lastAttemptedAt),
      lastAllFailedAt: toFiniteNumber(parsed.lastAllFailedAt),
      lastSuccessAt: toFiniteNumber(parsed.lastSuccessAt),
      lastSkippedAt: toFiniteNumber(parsed.lastSkippedAt),
      lastFailureMissingIds: toStringArray(parsed.lastFailureMissingIds),
    };
  } catch {
    // Expected when the health-state cache is missing, truncated, or from an older schema.
    return getDefaultDeterministicOnChainHealthState();
  }
}
