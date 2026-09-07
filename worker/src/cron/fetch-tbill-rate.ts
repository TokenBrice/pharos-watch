import { toErrorMessage } from "@shared/lib/error-utils";
import { getCache, setCache } from "../lib/db-cache";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { FRED_EFFR_CSV_URL, FRED_TBILL_CSV_URL } from "../lib/constants";
import { logCronEvent, recordCronFailure, type CronResult } from "../lib/cron-logger";
import { cadenceBucketFor, claimCadenceBucket, completeCadenceBucket, failCadenceBucket } from "../lib/cadence-bucket";
import {
  buildRiskFreeRateCachePayload,
  buildRiskFreeRatesCachePayload,
  serializeRiskFreeRateCache,
  serializeRiskFreeRatesCache,
} from "./yield-sync/cache";
import {
  buildHardcodedUsdBenchmark,
  withYieldBenchmarkStaticMeta,
  type ParsedYieldBenchmarkMeta,
  type ParsedYieldBenchmarkRegistry,
} from "./yield-sync/benchmarks";
import { throwIfAborted } from "../lib/abort";
import { loadRiskFreeRateRegistry } from "./yield-sync/sources-riskfree";
import { isRecord, numberValue } from "@shared/lib/type-guards";
import type { YieldBenchmarkKey } from "@shared/types/yield";
import type { Env } from "../lib/env";


import type {
  BenchmarkDescriptor,
  BenchmarkFetchResult,
  BenchmarkProviderAttemptDiagnostic,
  BenchmarkProvider,
  BenchmarkProviderKey,
  StandardBenchmarkProviderKey,
} from "./tbill-sources/shared";
import { tryAlfredSoniaCompoundedIndex, tryFredCsv, tryFredSoniaCompoundedIndex } from "./tbill-sources/fred";
import { tryNyFedEffr } from "./tbill-sources/nyfed";
import { tryTreasuryXml } from "./tbill-sources/treasury";
import { tryEcbCompoundedEstrCsv } from "./tbill-sources/ecb";
import { tryBoeSoniaCompoundedIndex } from "./tbill-sources/boe";
import { tryBojCallRate } from "./tbill-sources/boj";
import { tryRbaCashRateTarget } from "./tbill-sources/rba";
import { trySixSar3mcCsv } from "./tbill-sources/six";
import { tryBanxicoCetes } from "./tbill-sources/banxico";
import { tryBcbSelic } from "./tbill-sources/bcb";
import { tryBocCorra } from "./tbill-sources/boc";
import { tryCbrtTlref } from "./tbill-sources/cbrt";
import { tryCbrKeyRate } from "./tbill-sources/cbr";

const RISK_FREE_RATES_CACHE_KEY = "risk_free_rates";
const LEGACY_USD_RISK_FREE_RATE_CACHE_KEY = "risk_free_rate";
const GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY = "fetch-tbill-rate:gbp-retained-fallback-streak";
const TREASURY_CIRCUIT_PREFIX = "TREASURY_RATES:";
const TBILL_WEEKLY_CADENCE_KEY = "fetch-tbill-rate:weekly";
const TBILL_WEEKLY_CADENCE_SEC = 7 * 24 * 60 * 60;
const TBILL_STALE_CLAIM_SEC = 12 * 60;
const DAILY_BENCHMARK_KEYS: Record<string, true> = {
  USD_EFFR: true,
};

interface FetchTbillRateOptions {
  scheduledAtSec?: number;
}

function benchmarkCircuitKey(key: string): string {
  return `${TREASURY_CIRCUIT_PREFIX}${key}`;
}
const GBP_RETAINED_FALLBACK_MODE = "gbp-sonia-compounded-index-failed-retained";
const GBP_RETAINED_FALLBACK_EVENT_THRESHOLD = 2;

function buildMetadata(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

type MetadataBenchmarkKey = Exclude<YieldBenchmarkKey, "SGD">;

function buildFallbackBenchmarkMetadata(benchmarks: ParsedYieldBenchmarkRegistry): Array<Record<string, unknown>> {
  return BENCHMARK_METADATA_DESCRIPTORS.flatMap(({ key }) => {
    const benchmark = benchmarks[key];
    if (!benchmark?.isFallback) return [];
    return [
      {
        key,
        currency: benchmark.currency,
        source: benchmark.source,
        fallbackMode: benchmark.fallbackMode,
        rate: benchmark.rate,
        recordDate: benchmark.recordDate,
        fetchedAt: benchmark.fetchedAt,
        lastMarketSource: benchmark.lastMarketSource,
        lastMarketRecordDate: benchmark.lastMarketRecordDate,
        lastMarketFetchedAt: benchmark.lastMarketFetchedAt,
        retained: typeof benchmark.fallbackMode === "string" && benchmark.fallbackMode.endsWith("-retained"),
      },
    ];
  });
}

interface GbpRetainedFallbackStreak {
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

function parseGbpRetainedFallbackStreak(value: string | null | undefined): GbpRetainedFallbackStreak {
  if (!value) {
    return {
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
    };
  }
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) throw new Error("not an object");
    const consecutiveRetainedRuns = numberValue(parsed.consecutiveRetainedRuns) ?? 0;
    const consecutiveFreshRuns = numberValue(parsed.consecutiveFreshRuns) ?? 0;
    return {
      consecutiveRetainedRuns: Math.max(0, Math.floor(consecutiveRetainedRuns)),
      consecutiveFreshRuns: Math.max(0, Math.floor(consecutiveFreshRuns)),
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
    };
  } catch {
    return {
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
    };
  }
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

async function updateGbpRetainedFallbackMonitor(params: {
  db: D1Database;
  benchmark: ParsedYieldBenchmarkMeta | null;
  fetchedAt: number;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const { db, benchmark, fetchedAt, signal } = params;
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

      const thresholdReached = consecutiveRetainedRuns >= GBP_RETAINED_FALLBACK_EVENT_THRESHOLD;
      if (thresholdReached) {
        await logCronEvent(db, {
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
        });
      }

      await setCache(db, GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY, JSON.stringify(streak), signal);
      return {
        gbpRetainedFallbackActive: true,
        gbpRetainedFallbackStreak: consecutiveRetainedRuns,
        gbpRetainedFallbackEventThreshold: GBP_RETAINED_FALLBACK_EVENT_THRESHOLD,
        gbpFreshPublicationStreak: 0,
      };
    }

    if (!isFreshGbpBenchmark(benchmark)) {
      const unavailable: GbpRetainedFallbackStreak = {
        ...previous,
        consecutiveFreshRuns: 0,
      };
      await setCache(db, GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY, JSON.stringify(unavailable), signal);
      return {
        gbpRetainedFallbackActive: false,
        gbpRetainedFallbackStreak: previous.consecutiveRetainedRuns,
        gbpRetainedFallbackEventThreshold: GBP_RETAINED_FALLBACK_EVENT_THRESHOLD,
        gbpFreshPublicationStreak: 0,
      };
    }

    const consecutiveFreshRuns = previous.consecutiveFreshRuns + 1;
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
    await setCache(db, GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY, JSON.stringify(recovered), signal);

    if (previous.consecutiveRetainedRuns >= GBP_RETAINED_FALLBACK_EVENT_THRESHOLD) {
      await logCronEvent(db, {
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
      });
    }
    return {
      gbpRetainedFallbackActive: false,
      gbpRetainedFallbackStreak: 0,
      gbpRetainedFallbackEventThreshold: GBP_RETAINED_FALLBACK_EVENT_THRESHOLD,
      gbpRetainedFallbackRecoveredAt: recovered.recoveredAt ?? null,
      gbpFreshPublicationStreak: consecutiveFreshRuns,
      gbpFreshPublicationVerifiedTwice: consecutiveFreshRuns >= 2,
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
    return {};
  }
}

function buildBenchmarkRunMetadata(params: {
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
  fields.fallbackBenchmarks = fallbackBenchmarks;
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
  });
}

async function writeStructuredBenchmarks(db: D1Database, benchmarks: ParsedYieldBenchmarkRegistry) {
  const cacheEntries = Object.fromEntries(
    BENCHMARK_DESCRIPTORS
      .filter((descriptor) => descriptor.includeInCache)
      .map(({ key }) => [key, toCacheEntry(benchmarks[key] ?? null)]),
  ) as Parameters<typeof buildRiskFreeRatesCachePayload>[0];
  await setCache(
    db,
    RISK_FREE_RATES_CACHE_KEY,
    serializeRiskFreeRatesCache(
      buildRiskFreeRatesCachePayload(cacheEntries),
    ),
  );
  await setCache(db, LEGACY_USD_RISK_FREE_RATE_CACHE_KEY, serializeRiskFreeRateCache(toCacheEntry(benchmarks.USD)!));
}

function buildRetainedBenchmark(
  previous: ParsedYieldBenchmarkMeta | null,
  fallbackMode: string,
): ParsedYieldBenchmarkMeta | null {
  if (
    previous?.lastMarketRate != null &&
    previous.lastMarketSource &&
    previous.lastMarketSource !== "hardcoded-fallback"
  ) {
    const retainedSource = previous.source ?? previous.lastMarketSource;
    const retained = withYieldBenchmarkStaticMeta(previous.key ?? "USD", {
      rate: previous.lastMarketRate,
      recordDate: previous.lastMarketRecordDate,
      fetchedAt: previous.lastMarketFetchedAt,
      ageSeconds:
        previous.lastMarketFetchedAt != null
          ? Math.max(0, Math.floor(Date.now() / 1000) - previous.lastMarketFetchedAt)
          : null,
      source: retainedSource,
      isFallback: true,
      fallbackMode: `${fallbackMode}-retained`,
    });
    return {
      ...retained,
      isProxy: previous.isProxy,
      lastMarketRate: previous.lastMarketRate,
      lastMarketRecordDate: previous.lastMarketRecordDate,
      lastMarketFetchedAt: previous.lastMarketFetchedAt,
      lastMarketSource: previous.lastMarketSource,
    };
  }

  return null;
}

function buildResolvedBenchmark(params: {
  key: YieldBenchmarkKey;
  rate: number;
  recordDate: string;
  fetchedAt: number;
  source: string;
  isFallback?: boolean;
  fallbackMode?: string | null;
  isProxy?: boolean;
}): ParsedYieldBenchmarkMeta {
  const resolved = withYieldBenchmarkStaticMeta(params.key, {
    rate: params.rate,
    recordDate: params.recordDate,
    fetchedAt: params.fetchedAt,
    ageSeconds: 0,
    source: params.source,
    isFallback: params.isFallback ?? false,
    fallbackMode: params.fallbackMode ?? null,
  });
  const marketFields = params.isFallback
    ? {
        lastMarketRate: null,
        lastMarketRecordDate: null,
        lastMarketFetchedAt: null,
        lastMarketSource: null,
      }
    : {
        lastMarketRate: params.rate,
        lastMarketRecordDate: params.recordDate,
        lastMarketFetchedAt: params.fetchedAt,
        lastMarketSource: params.source,
      };

  return {
    ...resolved,
    isProxy: params.isProxy ?? resolved.isProxy,
    ...marketFields,
  };
}

interface ResolvedBenchmarkProvider {
  key: BenchmarkProviderKey;
  parsed: BenchmarkFetchResult | null;
  meta: ParsedYieldBenchmarkMeta | null;
  failureMode: string | null;
  responseDiagnostics?: BenchmarkProviderAttemptDiagnostic[];
}

async function tryUsdEffrBenchmark(signal?: AbortSignal): Promise<BenchmarkFetchResult | null> {
  const nyFed = await tryNyFedEffr(signal);
  if (nyFed) return nyFed;

  const fred = await tryFredCsv(FRED_EFFR_CSV_URL, signal);
  return fred ? { ...fred, source: "fred-dff" } : null;
}

function standardBenchmarkDescriptor(
  key: StandardBenchmarkProviderKey,
  metadataPrefix: string,
  fetchOrder: number,
  degradationOrder: number,
  fetch: BenchmarkProvider["fetch"],
  source: string,
  fallbackMode: string,
): BenchmarkDescriptor {
  return {
    key,
    metadataPrefix,
    fetchOrder,
    degradationOrder,
    provider: { key, fetch, source, fallbackMode },
    includeInCache: true,
  };
}

async function tryGbpBenchmark({ signal }: { signal?: AbortSignal }) {
  const responseDiagnostics: BenchmarkProviderAttemptDiagnostic[] = [];
  const observe = (provider: string) => (diagnostic: Omit<BenchmarkProviderAttemptDiagnostic, "provider">) => {
    responseDiagnostics.push({ provider, ...diagnostic });
  };
  const fred = await tryFredSoniaCompoundedIndex(signal, observe("fred-sonia-compounded-index"));
  if (fred) return { ...fred, source: "fred-sonia-compounded-index", responseDiagnostics };
  const alfred = await tryAlfredSoniaCompoundedIndex(signal, observe("alfred-sonia-compounded-index"));
  if (alfred) return { ...alfred, source: "alfred-sonia-compounded-index", responseDiagnostics };
  const boe = await tryBoeSoniaCompoundedIndex(signal, observe("boe-sonia-compounded-index"));
  return boe
    ? { ...boe, source: "boe-sonia-compounded-index", responseDiagnostics }
    : { result: null, responseDiagnostics };
}

// Descriptor order is the serialized registry/cache order. AUD intentionally fetches
// before MXN/BRL but degrades after them; USD, credentialed MXN, and unfetched SGD
// retain their exceptional paths.
const BENCHMARK_DESCRIPTORS: readonly BenchmarkDescriptor[] = [
  { key: "USD", metadataPrefix: "usd", fetchOrder: 0, degradationOrder: 0, provider: "USD", includeInCache: true },
  standardBenchmarkDescriptor("USD_EFFR", "usdEffr", 1, 1, ({ signal }) => tryUsdEffrBenchmark(signal), "nyfed-effr", "usd-effr-sources-failed"),
  standardBenchmarkDescriptor("EUR", "eur", 2, 2, ({ signal }) => tryEcbCompoundedEstrCsv(signal), "ecb-estr-3m", "ecb-failed"),
  standardBenchmarkDescriptor("CHF", "chf", 3, 3, ({ signal }) => trySixSar3mcCsv(signal), "six-sar3mc", "six-saron-failed"),
  standardBenchmarkDescriptor("GBP", "gbp", 4, 4, tryGbpBenchmark, "fred-sonia-compounded-index", "gbp-sonia-compounded-index-failed"),
  standardBenchmarkDescriptor("JPY", "jpy", 5, 5, ({ signal }) => tryBojCallRate(signal), "boj-call-rate", "jpy-call-rate-failed"),
  { key: "MXN", metadataPrefix: "mxn", fetchOrder: 7, degradationOrder: 6, provider: "MXN", includeInCache: true },
  standardBenchmarkDescriptor("BRL", "brl", 8, 7, ({ signal }) => tryBcbSelic(signal), "bcb-selic", "bcb-selic-failed"),
  standardBenchmarkDescriptor("AUD", "aud", 6, 8, ({ signal }) => tryRbaCashRateTarget(signal), "rba-cash-rate-target", "aud-cash-rate-failed"),
  standardBenchmarkDescriptor("CAD", "cad", 9, 9, ({ signal }) => tryBocCorra(signal), "boc-valet-v122530", "boc-corra-failed"),
  standardBenchmarkDescriptor("RUB", "rub", 10, 10, ({ signal }) => tryCbrKeyRate(signal), "cbr-key-rate", "cbr-key-rate-failed"),
  standardBenchmarkDescriptor("TRY", "try", 11, 11, ({ signal }) => tryCbrtTlref(signal), "cbrt-evds-tlref", "cbrt-tlref-failed"),
  { key: "SGD", metadataPrefix: null, fetchOrder: null, degradationOrder: null, provider: "SGD", includeInCache: true },
];

type MetadataBenchmarkDescriptor = BenchmarkDescriptor & {
  key: MetadataBenchmarkKey;
  metadataPrefix: string;
};
type FetchBenchmarkDescriptor = BenchmarkDescriptor & {
  key: BenchmarkProviderKey;
  fetchOrder: number;
  provider: BenchmarkProvider | "MXN";
};

const BENCHMARK_METADATA_DESCRIPTORS = BENCHMARK_DESCRIPTORS.filter(
  (descriptor): descriptor is MetadataBenchmarkDescriptor => descriptor.metadataPrefix != null,
);
const BENCHMARK_FETCH_DESCRIPTORS = BENCHMARK_DESCRIPTORS
  .filter((descriptor): descriptor is FetchBenchmarkDescriptor => (
    descriptor.fetchOrder != null && descriptor.provider !== "USD" && descriptor.provider !== "SGD"
  ))
  .sort((a, b) => a.fetchOrder - b.fetchOrder);
const BENCHMARK_DEGRADATION_DESCRIPTORS = BENCHMARK_DESCRIPTORS
  .filter((descriptor) => descriptor.degradationOrder != null)
  .sort((a, b) => a.degradationOrder! - b.degradationOrder!);

async function resolveBenchmarkProvider(params: {
  db: D1Database;
  provider: BenchmarkProvider;
  previous: ParsedYieldBenchmarkRegistry;
  fetchedAt: number;
  signal?: AbortSignal;
}): Promise<ResolvedBenchmarkProvider> {
  const { db, provider, previous, fetchedAt, signal } = params;
  const circuitSource = benchmarkCircuitKey(provider.key);
  if (!(await shouldAttemptFetch(db, circuitSource))) {
    const meta = buildRetainedBenchmark(previous[provider.key] ?? null, "circuit-open");
    return {
      key: provider.key,
      parsed: null,
      meta,
      failureMode: meta?.fallbackMode ?? "circuit-open",
    };
  }

  const outcome = await provider.fetch({ signal });
  const parsed = outcome && "result" in outcome ? outcome.result : outcome;
  const responseDiagnostics = outcome?.responseDiagnostics;
  await recordOutcome(db, circuitSource, parsed != null);
  const meta = parsed
    ? buildResolvedBenchmark({
        key: provider.key,
        rate: parsed.rate,
        recordDate: parsed.recordDate,
        fetchedAt,
        source: parsed.source ?? provider.source,
      })
    : buildRetainedBenchmark(previous[provider.key] ?? null, provider.fallbackMode);

  return {
    key: provider.key,
    parsed,
    meta,
    failureMode: parsed ? null : (meta?.fallbackMode ?? provider.fallbackMode),
    ...(responseDiagnostics ? { responseDiagnostics } : {}),
  };
}

async function resolveMxnBenchmarkProvider(params: {
  db: D1Database;
  previous: ParsedYieldBenchmarkRegistry;
  fetchedAt: number;
  env?: Pick<Env, "BANXICO_TOKEN">;
  signal?: AbortSignal;
}): Promise<ResolvedBenchmarkProvider> {
  const { db, previous, fetchedAt, env, signal } = params;
  const token = env?.BANXICO_TOKEN?.trim() || null;
  const circuitSource = benchmarkCircuitKey("MXN");
  if (!(await shouldAttemptFetch(db, circuitSource))) {
    const meta = buildRetainedBenchmark(previous.MXN, "circuit-open");
    return {
      key: "MXN",
      parsed: null,
      meta,
      failureMode: meta?.fallbackMode ?? "circuit-open",
    };
  }
  const banxicoParsed = token ? await tryBanxicoCetes(token, signal) : null;
  if (banxicoParsed) {
    await recordOutcome(db, circuitSource, true);
    return {
      key: "MXN",
      parsed: banxicoParsed,
      meta: buildResolvedBenchmark({
        key: "MXN",
        rate: banxicoParsed.rate,
        recordDate: banxicoParsed.recordDate,
        fetchedAt,
        source: "banxico-cetes-28d",
      }),
      failureMode: null,
    };
  }

  const baseFallbackMode = token ? "banxico-cetes-failed" : "banxico-token-missing";
  if (token) await recordOutcome(db, circuitSource, false);
  const meta = buildRetainedBenchmark(previous.MXN, baseFallbackMode);
  return {
    key: "MXN",
    parsed: null,
    meta,
    failureMode: meta?.fallbackMode ?? baseFallbackMode,
  };
}

async function resolveBenchmarkProviderMap(params: {
  db: D1Database;
  previous: ParsedYieldBenchmarkRegistry;
  fetchedAt: number;
  env?: Pick<Env, "BANXICO_TOKEN">;
  signal?: AbortSignal;
  descriptors?: readonly FetchBenchmarkDescriptor[];
}): Promise<Record<string, ResolvedBenchmarkProvider>> {
  const resolvedProviders: ResolvedBenchmarkProvider[] = [];
  for (const descriptor of params.descriptors ?? BENCHMARK_FETCH_DESCRIPTORS) {
    throwIfAborted(params.signal);
    resolvedProviders.push(
      descriptor.provider === "MXN"
        ? await resolveMxnBenchmarkProvider(params)
        : await resolveBenchmarkProvider({
            db: params.db,
            provider: descriptor.provider,
            previous: params.previous,
            fetchedAt: params.fetchedAt,
            signal: params.signal,
          }),
    );
  }

  return Object.fromEntries(resolvedProviders.map((entry) => [entry.key, entry]));
}

const DAILY_FETCH_DESCRIPTORS = BENCHMARK_FETCH_DESCRIPTORS.filter(
  (descriptor) => DAILY_BENCHMARK_KEYS[descriptor.key] === true,
);
const WEEKLY_FETCH_DESCRIPTORS = BENCHMARK_FETCH_DESCRIPTORS.filter(
  (descriptor) => DAILY_BENCHMARK_KEYS[descriptor.key] !== true,
);

function preserveWeeklyBenchmark(
  descriptor: FetchBenchmarkDescriptor,
  previous: ParsedYieldBenchmarkRegistry,
): ResolvedBenchmarkProvider {
  const key = descriptor.key as BenchmarkProviderKey;
  const meta = previous[key] ?? null;
  const fallbackMode = descriptor.provider === "MXN"
    ? "weekly-not-yet-fetched"
    : descriptor.provider.fallbackMode;
  return {
    key,
    parsed: null,
    meta,
    failureMode: meta?.isFallback ? meta.fallbackMode : (meta ? null : fallbackMode),
  };
}

function buildBenchmarkRegistry(
  usdMeta: ParsedYieldBenchmarkMeta,
  resolvedByKey: Record<BenchmarkProviderKey, ResolvedBenchmarkProvider>,
): ParsedYieldBenchmarkRegistry {
  const registry: Partial<ParsedYieldBenchmarkRegistry> = {};
  for (const descriptor of BENCHMARK_DESCRIPTORS) {
    if (descriptor.provider === "USD") registry.USD = usdMeta;
    else if (descriptor.provider === "MXN") registry.MXN = resolvedByKey.MXN.meta;
    else if (descriptor.provider === "SGD") registry.SGD = null;
    else registry[descriptor.provider.key] = resolvedByKey[descriptor.provider.key].meta;
  }
  // The descriptor table is the exhaustive registry inventory; the loop assigns every key once.
  return registry as ParsedYieldBenchmarkRegistry;
}

function buildBenchmarkDegradationReasons(
  usdMeta: ParsedYieldBenchmarkMeta,
  resolvedByKey: Record<BenchmarkProviderKey, ResolvedBenchmarkProvider>,
): string[] {
  const degradationReasons: string[] = [];
  for (const descriptor of BENCHMARK_DEGRADATION_DESCRIPTORS) {
    if (descriptor.provider === "USD") {
      if (usdMeta.isFallback) degradationReasons.push(`usd:${usdMeta.fallbackMode}`);
      continue;
    }
    const failureMode = resolvedByKey[descriptor.key as BenchmarkProviderKey].failureMode;
    if (failureMode) degradationReasons.push(`${descriptor.key.toLowerCase()}:${failureMode}`);
  }
  return degradationReasons;
}

function buildGbpResponseDiagnosticMetadata(resolved: ResolvedBenchmarkProvider): Record<string, unknown> {
  const attempts = resolved.responseDiagnostics ?? [];
  return {
    gbpResponseAttemptCount: attempts.length,
    gbpResponseAttempts: attempts,
    gbpResponseResolvedProvider: resolved.parsed?.source ?? null,
  };
}

export async function fetchTbillRate(
  db: D1Database,
  signal?: AbortSignal,
  env?: Pick<Env, "BANXICO_TOKEN">,
  options: FetchTbillRateOptions = {},
): Promise<CronResult> {
  const previous = await loadRiskFreeRateRegistry(db);
  throwIfAborted(signal);
  const fetchedAt = Math.floor(Date.now() / 1000);
  const scheduledAtSec = options.scheduledAtSec ?? fetchedAt;
  const weeklyBucket = cadenceBucketFor(scheduledAtSec, TBILL_WEEKLY_CADENCE_SEC);
  const weeklyClaimResult = await claimCadenceBucket(db, {
    key: TBILL_WEEKLY_CADENCE_KEY,
    bucket: weeklyBucket,
    nowSec: fetchedAt,
    staleClaimAfterSec: TBILL_STALE_CLAIM_SEC,
  });
  const weeklyClaim = weeklyClaimResult.kind === "claimed" ? weeklyClaimResult.claim : null;
  let weeklyCompleted = weeklyClaim == null;

  try {
    throwIfAborted(signal);
    const usdCircuitSource = benchmarkCircuitKey("USD");
    const usdAllowed = await shouldAttemptFetch(db, usdCircuitSource);
    const usdFred = usdAllowed ? await tryFredCsv(FRED_TBILL_CSV_URL, signal) : null;
    const usdParsed = usdFred ?? (usdAllowed ? await tryTreasuryXml(signal) : null);
    const usdSource = usdFred ? "fred-dgs3mo" : usdParsed ? "treasury-yield-xml" : null;
    const usdFallbackMode = usdAllowed ? "all-sources-failed" : "circuit-open";
    const usdMeta =
      usdParsed && usdSource
        ? buildResolvedBenchmark({
            key: "USD",
            rate: usdParsed.rate,
            recordDate: usdParsed.recordDate,
            fetchedAt,
            source: usdSource,
          })
        : (buildRetainedBenchmark(previous.USD, usdFallbackMode) ??
          buildHardcodedUsdBenchmark(usdFallbackMode));

    if (usdAllowed) {
      await recordOutcome(db, usdCircuitSource, usdParsed != null);
    }

    const resolvedByKey = await resolveBenchmarkProviderMap({
      db,
      previous,
      fetchedAt,
      env,
      signal,
      descriptors: DAILY_FETCH_DESCRIPTORS,
    });
    if (weeklyClaim) {
      Object.assign(
        resolvedByKey,
        await resolveBenchmarkProviderMap({
          db,
          previous,
          fetchedAt,
          env,
          signal,
          descriptors: WEEKLY_FETCH_DESCRIPTORS,
        }),
      );
    } else {
      for (const descriptor of WEEKLY_FETCH_DESCRIPTORS) {
        resolvedByKey[descriptor.key] = preserveWeeklyBenchmark(descriptor, previous);
      }
    }

    // SGD: TODO — no stable public SORA endpoint identified yet; SGD pegs fall back to USD.
    const benchmarks = buildBenchmarkRegistry(usdMeta, resolvedByKey);

    const gbpRetainedFallbackMonitor = await updateGbpRetainedFallbackMonitor({
      db,
      benchmark: benchmarks.GBP,
      fetchedAt,
      signal,
    });
    await writeStructuredBenchmarks(db, benchmarks);

    if (weeklyClaim) {
      weeklyCompleted = await completeCadenceBucket(db, weeklyClaim, fetchedAt);
      if (!weeklyCompleted) {
        await logCronEvent(db, {
          job: "fetch-tbill-rate",
          eventType: "weekly-cadence-complete-skipped",
          severity: "warning",
          message: "Weekly T-bill cadence claim was superseded before completion.",
          metadata: { bucket: weeklyBucket },
        });
      }
    }

    const degradationReasons = buildBenchmarkDegradationReasons(usdMeta, resolvedByKey);
    return {
      status: degradationReasons.length > 0 || !weeklyCompleted ? "degraded" : "ok",
      itemCount: BENCHMARK_METADATA_DESCRIPTORS.filter(({ key }) => benchmarks[key] != null).length,
      metadata: buildBenchmarkRunMetadata({
        fallbackMode: degradationReasons.length > 0 ? degradationReasons.join(",") : null,
        benchmarks,
        includeDetails: true,
        extraFields: {
          ...gbpRetainedFallbackMonitor,
          ...buildGbpResponseDiagnosticMetadata(resolvedByKey.GBP),
          weeklyCadence: {
            bucket: weeklyBucket,
            claimed: weeklyClaim != null,
            completed: weeklyCompleted,
            reason: weeklyClaimResult.kind === "skip" ? weeklyClaimResult.reason : null,
          },
        },
      }),
    };
  } catch (error) {
    if (weeklyClaim) {
      try {
        await failCadenceBucket(db, weeklyClaim, fetchedAt);
      } catch (releaseError) {
        await logCronEvent(db, {
          job: "fetch-tbill-rate",
          eventType: "weekly-cadence-release-failed",
          severity: "warning",
          message: "Failed to release T-bill weekly cadence claim after publication failure.",
          metadata: { bucket: weeklyBucket, error: toErrorMessage(releaseError) },
        });
      }
    }
    throw error;
  }
}
