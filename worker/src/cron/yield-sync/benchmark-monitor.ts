import { toErrorMessage } from "@shared/lib/error-utils";
import { isRecord, numberValue } from "@shared/lib/type-guards";
import { getCache, type CacheEntryWrite } from "../../lib/db-cache";
import { recordCronFailure, type CronEventInput } from "../../lib/cron-logger";
import { throwIfAborted } from "../../lib/abort";
import { parseObjectMetadata } from "../../lib/json-metadata";
import { parseRiskFreeRatesCache } from "./cache";
import type { ParsedYieldBenchmarkMeta } from "./benchmarks";

export const RISK_FREE_RATES_CACHE_KEY = "risk_free_rates";
const GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY = "fetch-tbill-rate:gbp-retained-fallback-streak";
const USD_FRESH_STREAK_CACHE_KEY = "fetch-tbill-rate:usd-fresh-streak";
const GBP_RETAINED_FALLBACK_MODE = "gbp-sonia-compounded-index-failed-retained";
const GBP_RETAINED_FALLBACK_EVENT_THRESHOLD = 2;
export const REQUIRED_BENCHMARK_FRESH_PUBLICATIONS = 2;

function nextFreshPublicationCount(previous: BenchmarkFreshStreak, previousGenerationId: string | null): number {
  return previousGenerationId != null && previous.generationId === previousGenerationId
    ? previous.consecutiveFreshRuns + 1
    : 1;
}

interface GbpRetainedFallbackStreak {
  generationId?: string | null;
  consecutiveRetainedRuns: number;
  consecutiveFreshRuns: number;
  firstRetainedAt: number | null;
  lastRetainedAt: number | null;
  lastFreshAt: number | null;
  lastFreshSource: string | null;
  lastFreshRecordDate: string | null;
  lastFallbackMode: string | null;
  lastMarketSource: string | null;
  lastMarketRecordDate: string | null;
  lastMarketFetchedAt: number | null;
  recoveredAt?: number | null;
  recoveredSource?: string | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readStreakRecord<T>(
  value: string | null | undefined,
  empty: () => T,
  parse: (record: Record<string, unknown>) => T,
): T {
  if (!value) return empty();
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parse(parsed) : empty();
  } catch {
    return empty();
  }
}

function parseGbpRetainedFallbackStreak(value: string | null | undefined): GbpRetainedFallbackStreak {
  const empty = (): GbpRetainedFallbackStreak => ({
    consecutiveRetainedRuns: 0,
    consecutiveFreshRuns: 0,
    firstRetainedAt: null,
    lastRetainedAt: null,
    lastFreshAt: null,
    lastFreshSource: null,
    lastFreshRecordDate: null,
    lastFallbackMode: null,
    lastMarketSource: null,
    lastMarketRecordDate: null,
    lastMarketFetchedAt: null,
  });
  return readStreakRecord(value, empty, (parsed) => ({
    generationId: stringOrNull(parsed.generationId),
    consecutiveRetainedRuns: Math.max(
      0,
      Math.floor(numberValue(parsed.consecutiveRetainedRuns) ?? 0),
    ),
    consecutiveFreshRuns: Math.max(
      0,
      Math.floor(numberValue(parsed.consecutiveFreshRuns) ?? 0),
    ),
    firstRetainedAt: numberValue(parsed.firstRetainedAt),
    lastRetainedAt: numberValue(parsed.lastRetainedAt),
    lastFreshAt: numberValue(parsed.lastFreshAt),
    lastFreshSource: stringOrNull(parsed.lastFreshSource),
    lastFreshRecordDate: stringOrNull(parsed.lastFreshRecordDate),
    lastFallbackMode: stringOrNull(parsed.lastFallbackMode),
    lastMarketSource: stringOrNull(parsed.lastMarketSource),
    lastMarketRecordDate: stringOrNull(parsed.lastMarketRecordDate),
    lastMarketFetchedAt: numberValue(parsed.lastMarketFetchedAt),
    recoveredAt: numberValue(parsed.recoveredAt),
    recoveredSource: stringOrNull(parsed.recoveredSource),
  }));
}

function isRetainedGbpFallback(benchmark: ParsedYieldBenchmarkMeta | null): boolean {
  return (
    benchmark?.key === "GBP" && benchmark.isFallback === true && benchmark.fallbackMode === GBP_RETAINED_FALLBACK_MODE
  );
}

function isFreshGbpBenchmark(benchmark: ParsedYieldBenchmarkMeta | null): boolean {
  return benchmark?.key === "GBP" && benchmark.isFallback !== true;
}

function retainedFallbackMonitorErrorMessage(error: unknown): string {
  return toErrorMessage(error);
}

interface BenchmarkFreshStreak {
  generationId?: string | null;
  consecutiveFreshRuns: number;
  lastFreshAt: number | null;
  lastFreshSource: string | null;
  lastFreshRecordDate: string | null;
}

export interface PreparedBenchmarkMonitor {
  entry?: CacheEntryWrite;
  metadata: Record<string, unknown>;
  event?: CronEventInput;
}

function parseBenchmarkFreshStreak(value: string | null | undefined): BenchmarkFreshStreak {
  return readStreakRecord<BenchmarkFreshStreak>(
    value,
    () => ({
      consecutiveFreshRuns: 0,
      lastFreshAt: null,
      lastFreshSource: null,
      lastFreshRecordDate: null,
    }),
    (parsed) => ({
      generationId: stringOrNull(parsed.generationId),
      consecutiveFreshRuns: Math.max(
        0,
        Math.floor(numberValue(parsed.consecutiveFreshRuns) ?? 0),
      ),
      lastFreshAt: numberValue(parsed.lastFreshAt),
      lastFreshSource: stringOrNull(parsed.lastFreshSource),
      lastFreshRecordDate: stringOrNull(parsed.lastFreshRecordDate),
    }),
  );
}

/**
 * Consecutive fresh USD publications, read by the `yield-usd-benchmark-current`
 * canary. GBP keeps its streak inside the retained-fallback monitor record
 * because it also drives that event feed; USD only needs the liveness counter
 * that turns "the producer silently stopped publishing" or "USD fell onto a
 * retained/hardcoded rate" into a visible failed check before the 48h NR cliff
 * is reached.
 */
export async function prepareUsdFreshStreakMonitor(params: {
  db: D1Database;
  benchmark: ParsedYieldBenchmarkMeta | null;
  fetchedAt: number;
  generationId: string;
  previousGenerationId: string | null;
  signal?: AbortSignal;
}): Promise<PreparedBenchmarkMonitor> {
  const { db, benchmark, fetchedAt, generationId, previousGenerationId, signal } = params;
  try {
    const cached = await getCache(db, USD_FRESH_STREAK_CACHE_KEY);
    throwIfAborted(signal);
    const previous = parseBenchmarkFreshStreak(cached?.value);
    const isFresh = benchmark != null && benchmark.isFallback !== true;
    const streak: BenchmarkFreshStreak = isFresh
      ? {
          consecutiveFreshRuns: nextFreshPublicationCount(previous, previousGenerationId),
          lastFreshAt: fetchedAt,
          lastFreshSource: benchmark.source ?? null,
          lastFreshRecordDate: benchmark.recordDate ?? null,
        }
      : { ...previous, consecutiveFreshRuns: 0 };

    return {
      entry: { key: USD_FRESH_STREAK_CACHE_KEY, value: JSON.stringify({ ...streak, generationId }) },
      metadata: {
        usdFreshPublicationStreak: streak.consecutiveFreshRuns,
        usdFreshPublicationVerifiedTwice: isFresh && streak.consecutiveFreshRuns >= REQUIRED_BENCHMARK_FRESH_PUBLICATIONS,
        usdLastFreshAt: streak.lastFreshAt,
        usdLastFreshSource: streak.lastFreshSource,
        usdLastFreshRecordDate: streak.lastFreshRecordDate,
      },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    recordCronFailure("fetch-tbill-rate", error, {
      metadata: {
        stage: "usd-fresh-streak-monitor",
        message: retainedFallbackMonitorErrorMessage(error).slice(0, 200),
      },
    });
    return { metadata: {} };
  }
}

export async function prepareGbpRetainedFallbackMonitor(params: {
  db: D1Database;
  benchmark: ParsedYieldBenchmarkMeta | null;
  fetchedAt: number;
  generationId: string;
  previousGenerationId: string | null;
  signal?: AbortSignal;
}): Promise<PreparedBenchmarkMonitor> {
  const { db, benchmark, fetchedAt, generationId, previousGenerationId, signal } = params;
  try {
    const cached = await getCache(db, GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY);
    throwIfAborted(signal);
    const previous = parseGbpRetainedFallbackStreak(cached?.value);

    if (benchmark && isRetainedGbpFallback(benchmark)) {
      const consecutiveRetainedRuns = previous.consecutiveRetainedRuns + 1;
      const streak: GbpRetainedFallbackStreak = {
        consecutiveRetainedRuns,
        consecutiveFreshRuns: 0,
        firstRetainedAt: previous.firstRetainedAt ?? fetchedAt,
        lastRetainedAt: fetchedAt,
        lastFreshAt: previous.lastFreshAt,
        lastFreshSource: previous.lastFreshSource,
        lastFreshRecordDate: previous.lastFreshRecordDate,
        lastFallbackMode: benchmark.fallbackMode,
        lastMarketSource: benchmark.lastMarketSource ?? benchmark.source ?? null,
        lastMarketRecordDate: benchmark.lastMarketRecordDate ?? benchmark.recordDate ?? null,
        lastMarketFetchedAt: benchmark.lastMarketFetchedAt ?? benchmark.fetchedAt ?? null,
      };

      const event: PreparedBenchmarkMonitor["event"] = consecutiveRetainedRuns >= GBP_RETAINED_FALLBACK_EVENT_THRESHOLD
        ? {
          job: "fetch-tbill-rate",
          eventType: "gbp-retained-fallback-repeated",
          severity: "warning",
          message: "GBP SONIA benchmark retained the previous market rate for consecutive fetch-tbill-rate runs.",
          metadata: {
            consecutiveRetainedRuns,
            threshold: GBP_RETAINED_FALLBACK_EVENT_THRESHOLD,
            fallbackMode: benchmark.fallbackMode,
            retainedSource: benchmark.source,
            lastMarketSource: benchmark.lastMarketSource,
            lastMarketRecordDate: benchmark.lastMarketRecordDate,
            lastMarketFetchedAt: benchmark.lastMarketFetchedAt,
          },
        }
        : undefined;

      return {
        entry: { key: GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY, value: JSON.stringify({ ...streak, generationId }) },
        event,
        metadata: {
          gbpRetainedFallbackActive: true,
          gbpRetainedFallbackStreak: consecutiveRetainedRuns,
          gbpRetainedFallbackEventThreshold: GBP_RETAINED_FALLBACK_EVENT_THRESHOLD,
          gbpFreshPublicationStreak: 0,
        },
      };
    }

    if (!isFreshGbpBenchmark(benchmark)) {
      const unavailable: GbpRetainedFallbackStreak = {
        ...previous,
        consecutiveFreshRuns: 0,
      };
      return {
        entry: { key: GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY, value: JSON.stringify({ ...unavailable, generationId }) },
        metadata: {
          gbpRetainedFallbackActive: false,
          gbpRetainedFallbackStreak: previous.consecutiveRetainedRuns,
          gbpRetainedFallbackEventThreshold: GBP_RETAINED_FALLBACK_EVENT_THRESHOLD,
          gbpFreshPublicationStreak: 0,
        },
      };
    }

    const consecutiveFreshRuns = nextFreshPublicationCount(previous, previousGenerationId);
    const recovered: GbpRetainedFallbackStreak = {
      consecutiveRetainedRuns: 0,
      consecutiveFreshRuns,
      firstRetainedAt: null,
      lastRetainedAt: null,
      lastFreshAt: fetchedAt,
      lastFreshSource: benchmark!.source,
      lastFreshRecordDate: benchmark!.recordDate,
      lastFallbackMode: previous.lastFallbackMode,
      lastMarketSource: previous.lastMarketSource,
      lastMarketRecordDate: previous.lastMarketRecordDate,
      lastMarketFetchedAt: previous.lastMarketFetchedAt,
      recoveredAt: previous.consecutiveRetainedRuns > 0 ? fetchedAt : previous.recoveredAt,
      recoveredSource: benchmark?.source ?? null,
    };
    const event: PreparedBenchmarkMonitor["event"] = previous.consecutiveRetainedRuns >= GBP_RETAINED_FALLBACK_EVENT_THRESHOLD
      ? {
        job: "fetch-tbill-rate",
        eventType: "gbp-retained-fallback-recovered",
        severity: "info",
        message: "GBP SONIA benchmark recovered from repeated retained fallback.",
        metadata: {
          previousConsecutiveRetainedRuns: previous.consecutiveRetainedRuns,
          recoveredSource: benchmark?.source ?? null,
          recoveredRecordDate: benchmark?.recordDate ?? null,
          lastFallbackMode: previous.lastFallbackMode,
          lastMarketSource: previous.lastMarketSource,
        },
      }
      : undefined;
    return {
      entry: { key: GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY, value: JSON.stringify({ ...recovered, generationId }) },
      event,
      metadata: {
        gbpRetainedFallbackActive: false,
        gbpRetainedFallbackStreak: 0,
        gbpRetainedFallbackEventThreshold: GBP_RETAINED_FALLBACK_EVENT_THRESHOLD,
        gbpRetainedFallbackRecoveredAt: recovered.recoveredAt ?? null,
        gbpFreshPublicationStreak: consecutiveFreshRuns,
        gbpFreshPublicationVerifiedTwice: consecutiveFreshRuns >= REQUIRED_BENCHMARK_FRESH_PUBLICATIONS,
      },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    recordCronFailure("fetch-tbill-rate", error, {
      metadata: {
        stage: "gbp-retained-fallback-monitor",
        message: retainedFallbackMonitorErrorMessage(error).slice(0, 200),
      },
    });
    return { metadata: {} };
  }
}

export async function readBenchmarkMonitorPublication(
  db: D1Database,
  currency: "GBP" | "USD",
  observedAt: number,
) {
  const ratesCache = await getCache(db, RISK_FREE_RATES_CACHE_KEY);
  if (!ratesCache) return null;
  const registry = parseRiskFreeRatesCache(ratesCache.value, ratesCache.updatedAt, observedAt);
  const registryMetadata = parseObjectMetadata(ratesCache.value);
  const generationId = typeof registryMetadata?.generationId === "string" && registryMetadata.generationId.length > 0
    ? registryMetadata.generationId
    : null;
  const benchmark = registry?.[currency] ?? null;
  const streakCacheKey = currency === "GBP" ? GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY : USD_FRESH_STREAK_CACHE_KEY;
  const streakCache = generationId == null ? null : await getCache(db, streakCacheKey);
  const streak = parseObjectMetadata(streakCache?.value ?? null);
  const streakGenerationId = typeof streak?.generationId === "string" ? streak.generationId : null;
  const consecutiveFreshRuns = typeof streak?.consecutiveFreshRuns === "number"
    && Number.isSafeInteger(streak.consecutiveFreshRuns) && streak.consecutiveFreshRuns >= 0
    ? streak.consecutiveFreshRuns
    : null;
  return { registry, benchmark, generationId, streakGenerationId, consecutiveFreshRuns };
}

export async function readBenchmarkPreviousGenerationId(db: D1Database): Promise<string | null> {
  const previousCache = await getCache(db, RISK_FREE_RATES_CACHE_KEY);
  const previousRecord = readStreakRecord<Record<string, unknown>>(previousCache?.value, () => ({}), (record) => record);
  return stringOrNull(previousRecord.generationId);
}
