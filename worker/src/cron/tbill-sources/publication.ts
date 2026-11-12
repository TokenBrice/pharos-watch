import { GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY, USD_FRESH_STREAK_CACHE_KEY, readBenchmarkPreviousGenerationId, prepareGbpRetainedFallbackMonitor, prepareUsdFreshStreakMonitor, RISK_FREE_RATES_CACHE_KEY, type PreparedBenchmarkMonitor } from "../yield-sync/benchmark-monitor";
import { getCache, prepareCacheUpsert, type CacheEntryWrite } from "../../lib/db-cache";
import { parseObjectMetadata } from "../../lib/json-metadata";
import type { YieldBenchmarkKey } from "@shared/types/yield";
import { logCronEvent, recordCronFailure } from "../../lib/cron-logger";
import { buildRiskFreeRateCachePayload, buildRiskFreeRatesCachePayload, serializeRiskFreeRateCache, serializeRiskFreeRatesCache } from "../yield-sync/cache";
import type { ParsedYieldBenchmarkMeta, ParsedYieldBenchmarkRegistry } from "../yield-sync/benchmarks";
import type { BenchmarkProviderKey } from "./shared";
import { throwIfAborted } from "../../lib/abort";
import { BENCHMARK_DESCRIPTORS } from "./providers";
import type { ResolvedBenchmarkProvider } from "./resolve";
const LEGACY_USD_RISK_FREE_RATE_CACHE_KEY = "risk_free_rate";

function toCacheEntry(benchmark: ParsedYieldBenchmarkMeta | null) {
  if (!benchmark) return null;
  return buildRiskFreeRateCachePayload({
    key: benchmark.key,
    label: benchmark.label,
    currency: benchmark.currency,
    rate: benchmark.rate,
    recordDate: benchmark.recordDate,
    fetchedAt: benchmark.fetchedAt,
    source: benchmark.source,
    isFallback: benchmark.isFallback,
    fallbackMode: benchmark.fallbackMode,
    isProxy: benchmark.isProxy,
    lastMarketRate: benchmark.lastMarketRate,
    lastMarketRecordDate: benchmark.lastMarketRecordDate,
    lastMarketFetchedAt: benchmark.lastMarketFetchedAt,
    lastMarketSource: benchmark.lastMarketSource,
    lastRejectedMarketRate: benchmark.lastRejectedMarketRate ?? null,
    lastRejectedMarketRecordDate: benchmark.lastRejectedMarketRecordDate ?? null,
    lastRejectedMarketFetchedAt: benchmark.lastRejectedMarketFetchedAt ?? null,
  });
}

function prepareStructuredBenchmarks(benchmarks: ParsedYieldBenchmarkRegistry, generationId: string): CacheEntryWrite[] {
  const cacheEntries = Object.fromEntries(
    BENCHMARK_DESCRIPTORS
      .filter((descriptor) => descriptor.includeInCache)
      .map(({ key }) => [key, toCacheEntry(benchmarks[key] ?? null)]),
  ) as Parameters<typeof buildRiskFreeRatesCachePayload>[0];
  const registryPayload = { ...buildRiskFreeRatesCachePayload(cacheEntries), generationId };
  return [
    {
      key: RISK_FREE_RATES_CACHE_KEY,
      value: serializeRiskFreeRatesCache(registryPayload),
    },
    {
      key: LEGACY_USD_RISK_FREE_RATE_CACHE_KEY,
      value: serializeRiskFreeRateCache(toCacheEntry(benchmarks.USD)!),
    },
  ];
}

export function buildBenchmarkRegistry(
  usdMeta: ParsedYieldBenchmarkMeta,
  resolvedByKey: Record<BenchmarkProviderKey, ResolvedBenchmarkProvider>,
): ParsedYieldBenchmarkRegistry {
  const registry: Partial<ParsedYieldBenchmarkRegistry> = {};
  for (const { key } of BENCHMARK_DESCRIPTORS) {
    if (key === "USD") registry.USD = usdMeta;
    else if (key === "SGD") registry.SGD = null;
    else registry[key] = resolvedByKey[key].meta;
  }
  // The descriptor table is the exhaustive registry inventory; the loop assigns every key once.
  return registry as ParsedYieldBenchmarkRegistry;
}

export async function publishBenchmarks(params: {
  db: D1Database;
  benchmarks: ParsedYieldBenchmarkRegistry;
  fetchedAt: number;
  registryCacheWrite: "written" | "skipped-unreadable-cache";
  signal?: AbortSignal;
  retainedRetryKeys?: readonly YieldBenchmarkKey[];
}) {
  const { db, benchmarks, fetchedAt, registryCacheWrite, signal } = params;
  let gbpRetainedFallbackMonitor: PreparedBenchmarkMonitor = { metadata: {} };
  let usdFreshStreakMonitor: PreparedBenchmarkMonitor = { metadata: {} };
  let generationId: string | null = null;
  let previousGenerationId: string | null = null;
  let previousGenerationUnavailableReason: string | null = null;
  if (registryCacheWrite === "written") {
    generationId = crypto.randomUUID();
    try {
      previousGenerationId = await readBenchmarkPreviousGenerationId(db);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      previousGenerationUnavailableReason = "benchmark-previous-generation-read-failed";
      recordCronFailure("fetch-tbill-rate", error, {
        metadata: { stage: "benchmark-previous-generation", reason: previousGenerationUnavailableReason },
      });
    }
    throwIfAborted(signal);
    // Rebinding an untouched monitor preserves its evidence; a retry of EUR
    // cannot certify another fresh USD/GBP observation.
    async function carryMonitor(currency: "gbp" | "usd"): Promise<PreparedBenchmarkMonitor> {
      try {
        const key = currency === "gbp" ? GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY : USD_FRESH_STREAK_CACHE_KEY;
        const row = await getCache(db, key);
        throwIfAborted(signal);
        const previous = parseObjectMetadata(row?.value ?? null);
        return previousGenerationId != null && previous?.generationId === previousGenerationId
          ? { metadata: {}, entry: { key, value: JSON.stringify({ ...previous, generationId }) } }
          : { metadata: {} };
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        recordCronFailure("fetch-tbill-rate", error, { metadata: { stage: "benchmark-monitor-carry" } });
        return { metadata: {} };
      }
    }
    gbpRetainedFallbackMonitor = params.retainedRetryKeys && !params.retainedRetryKeys.includes("GBP")
      ? await carryMonitor("gbp") : await prepareGbpRetainedFallbackMonitor({
      db, benchmark: benchmarks.GBP, fetchedAt, generationId, previousGenerationId, signal,
    });
    usdFreshStreakMonitor = params.retainedRetryKeys && !params.retainedRetryKeys.includes("USD")
      ? await carryMonitor("usd") : await prepareUsdFreshStreakMonitor({
      db, benchmark: benchmarks.USD, fetchedAt, generationId, previousGenerationId, signal,
    });
    const entries = [
      ...[gbpRetainedFallbackMonitor.entry, usdFreshStreakMonitor.entry]
        .filter((entry): entry is CacheEntryWrite => entry != null),
      ...prepareStructuredBenchmarks(benchmarks, generationId),
    ];
    const statements = entries.map((entry) => prepareCacheUpsert(db, { ...entry, updatedAt: fetchedAt }));
    throwIfAborted(signal);
    // One bounded transaction: preparing a marker never certifies an unpublished candidate.
    // An ambiguous acknowledgement propagates without emitting a recovery event.
    const results = await db.batch(statements);
    if (results.length !== statements.length || results.some((result) => !result.success)) {
      throw new Error("benchmark-publication-unconfirmed");
    }
    for (const monitor of [gbpRetainedFallbackMonitor, usdFreshStreakMonitor]) {
      if (!monitor.event) continue;
      try {
        await logCronEvent(db, monitor.event);
      } catch (error) {
        recordCronFailure("fetch-tbill-rate", error, { metadata: { stage: "benchmark-monitor-event" } });
      }
    }
  }

  return { gbpRetainedFallbackMonitor, usdFreshStreakMonitor, generationId, previousGenerationId, previousGenerationUnavailableReason };
}
