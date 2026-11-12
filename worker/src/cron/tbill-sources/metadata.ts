import type { YieldBenchmarkKey } from "@shared/types/yield";
import { YIELD_BENCHMARK_RECORD_MAX_AGE_SEC, YIELD_BENCHMARK_RETAINED_RETRY_SEC, benchmarkRecordAgeSeconds } from "@shared/lib/yield-benchmark-freshness";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { ParsedYieldBenchmarkMeta, ParsedYieldBenchmarkRegistry } from "../yield-sync/benchmarks";
import type { BenchmarkProviderKey } from "./shared";
import { BENCHMARK_METADATA_DESCRIPTORS, BENCHMARK_DEGRADATION_DESCRIPTORS } from "./providers";
import type { ResolvedBenchmarkProvider } from "./resolve";
// Series whose next print lands after the following business day's 08:00 UTC fetch.
const REFRESH_AHEAD_BENCHMARK_KEYS: readonly YieldBenchmarkKey[] = ["USD", "USD_EFFR", "GBP"];

export function getBenchmarkRetryKeys(registry: ParsedYieldBenchmarkRegistry): YieldBenchmarkKey[] {
  return BENCHMARK_DEGRADATION_DESCRIPTORS.filter(({ key }) => registry[key] == null
    || registry[key]?.fallbackMode?.endsWith("-retained")).map(({ key }) => key);
}

export function buildMetadata(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}


function buildFallbackBenchmarkMetadata(benchmarks: ParsedYieldBenchmarkRegistry): Array<Record<string, unknown>> {
  return BENCHMARK_METADATA_DESCRIPTORS.flatMap(({ key }) => {
    const benchmark = benchmarks[key];
    if (!benchmark?.isFallback) return [];
    return [
      {
        key,
        source: benchmark.source,
        fallbackMode: benchmark.fallbackMode,
        fetchedAt: benchmark.fetchedAt,
        retained: typeof benchmark.fallbackMode === "string" && benchmark.fallbackMode.endsWith("-retained"),
      },
    ];
  });
}

/**
 * Decide whether the hourly yield-lane retry has to refresh the benchmark
 * registry. The age is measured from the newest *market* observation in the
 * registry, not from the cache row's write time: a run whose providers all
 * failed still rewrites the row with retained fallbacks, so a row-age test would
 * let two consecutive failures reach the 48h NR cliff. USD is evaluated on its
 * own because it is the reference hurdle every non-USD row is scored against —
 * a healthy peg feed must not mask a USD outage.
 *
 * FRED DGS3MO, NY Fed EFFR, and FRED's SONIA index publish a business day's
 * print after the next business day's 08:00 UTC fetch, so an ordinary Friday
 * print is still the newest one into Wednesday. Those series refresh hourly
 * once their observation is within a day of its record bound, picking up the
 * next print as soon as it is published instead of first crossing the bound.
 */
export function resolveBenchmarkRefreshNeed(params: {
  registry: ParsedYieldBenchmarkRegistry;
  nowSec: number;
  minRegistryAgeSec: number;
  lastAttemptAtSec?: number | null;
}): { refresh: boolean; retainedRetryKeys: YieldBenchmarkKey[]; newestMarketAgeSec: number | null; usdMarketAgeSec: number | null } {
  const { registry, nowSec, minRegistryAgeSec } = params;
  const marketFetchedAt: number[] = [];
  let usdMarketFetchedAt: number | null = null;
  let expiredUsdObservation = false;
  let nearingRecordBound = false;
  for (const [key, benchmark] of Object.entries(registry) as Array<[YieldBenchmarkKey, ParsedYieldBenchmarkMeta | null | undefined]>) {
    if (!benchmark?.lastMarketFetchedAt) continue;
    const observationAge = benchmarkRecordAgeSeconds(benchmark.lastMarketRecordDate, nowSec);
    if (key === "USD" && observationAge != null && observationAge > YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.USD) {
      expiredUsdObservation = true;
    }
    if (
      REFRESH_AHEAD_BENCHMARK_KEYS.includes(key)
      && observationAge != null
      && observationAge > YIELD_BENCHMARK_RECORD_MAX_AGE_SEC[key] - DAY_SECONDS
    ) {
      nearingRecordBound = true;
    }
    marketFetchedAt.push(benchmark.lastMarketFetchedAt);
    if (benchmark.key === "USD") usdMarketFetchedAt = benchmark.lastMarketFetchedAt;
  }
  const newest = marketFetchedAt.length > 0 ? Math.max(...marketFetchedAt) : null;
  const newestMarketAgeSec = newest == null ? null : Math.max(0, nowSec - newest);
  const usdMarketAgeSec = usdMarketFetchedAt == null ? null : Math.max(0, nowSec - usdMarketFetchedAt);
  const refreshAll =
      expiredUsdObservation
      || nearingRecordBound
      || newestMarketAgeSec == null
      || newestMarketAgeSec > minRegistryAgeSec
      || usdMarketAgeSec == null
      || usdMarketAgeSec > minRegistryAgeSec;
  const retainedRetryKeys = !refreshAll && params.lastAttemptAtSec != null
    && nowSec - params.lastAttemptAtSec >= YIELD_BENCHMARK_RETAINED_RETRY_SEC
    ? getBenchmarkRetryKeys(registry) : [];
  return {
    refresh: refreshAll || retainedRetryKeys.length > 0,
    retainedRetryKeys,
    newestMarketAgeSec,
    usdMarketAgeSec,
  };
}

export function buildBenchmarkRunMetadata(params: {
  fallbackMode: string | null;
  benchmarks: ParsedYieldBenchmarkRegistry;
  includeDetails?: boolean;
  extraFields?: Record<string, unknown>;
}): string {
  const fields: Record<string, unknown> = { fallbackMode: params.fallbackMode };
  const fallbackBenchmarks = buildFallbackBenchmarkMetadata(params.benchmarks);
  const retainedFallbackBenchmarks = fallbackBenchmarks.filter((entry) => entry.retained === true);
  fields.fallbackBenchmarkCount = fallbackBenchmarks.length;
  fields.retainedFallbackBenchmarkCount = retainedFallbackBenchmarks.length;
  fields.fallbackBenchmarks = fallbackBenchmarks.filter((entry) => entry.retained !== true);
  fields.retainedFallbackBenchmarks = retainedFallbackBenchmarks;
  for (const { key, metadataPrefix: prefix } of BENCHMARK_METADATA_DESCRIPTORS) {
    const benchmark = params.benchmarks[key];
    fields[`${prefix}Source`] = benchmark?.source ?? null;
    if (params.includeDetails) {
      fields[`${prefix}Rate`] = benchmark?.rate ?? null;
      fields[`${prefix}RecordDate`] = benchmark?.recordDate ?? null;
    }
  }
  Object.assign(fields, params.extraFields);
  return buildMetadata(fields);
}

export function buildBenchmarkDegradationReasons(
  usdMeta: ParsedYieldBenchmarkMeta,
  resolvedByKey: Record<BenchmarkProviderKey, ResolvedBenchmarkProvider>,
): string[] {
  const degradationReasons: string[] = [];
  for (const descriptor of BENCHMARK_DEGRADATION_DESCRIPTORS) {
    if (descriptor.key === "USD") {
      if (usdMeta.isFallback) degradationReasons.push(`usd:${usdMeta.fallbackMode}`);
      continue;
    }
    const failureMode = resolvedByKey[descriptor.key as BenchmarkProviderKey].failureMode;
    if (failureMode) degradationReasons.push(`${descriptor.key.toLowerCase()}:${failureMode}`);
  }
  return degradationReasons;
}

export function buildGbpResponseDiagnosticMetadata(resolved: ResolvedBenchmarkProvider): Record<string, unknown> {
  const attempts = resolved.responseDiagnostics ?? [];
  return {
    gbpResponseAttemptCount: attempts.length,
    gbpResponseAttempts: attempts,
    gbpResponseResolvedProvider: resolved.parsed?.source ?? null,
  };
}

export function buildFailedBenchmarkResponseDiagnostics(
  resolved: ResolvedBenchmarkProvider[],
) {
  const failed = resolved.flatMap((entry) => {
    if (entry.parsed || !entry.failureMode) return [];
    const attempts = entry.responseDiagnostics ?? [];
    const retained = attempts.slice(-3).map(({ provider, status, failure }) => ({
      provider: provider.slice(0, 80), status, failure,
    }));
    return [{ key: entry.key, failureMode: entry.failureMode, attempts: retained,
      ...(attempts.length > retained.length ? {
        attemptCount: attempts.length, omittedAttemptCount: attempts.length - retained.length,
      } : {}),
    }];
  });
  return failed.length > 0 ? { failedBenchmarkResponseAttempts: failed } : {};
}
