import { toErrorMessage } from "@shared/lib/error-utils";
import { getCache, setCache } from "../lib/db-cache";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE, FRED_EFFR_CSV_URL, FRED_TBILL_CSV_URL } from "../lib/constants";
import { logCronEvent, recordCronFailure, type CronResult } from "../lib/cron-logger";
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
const GBP_RETAINED_FALLBACK_MODE = "gbp-sonia-compounded-index-failed-retained";
const GBP_RETAINED_FALLBACK_EVENT_THRESHOLD = 2;

function buildMetadata(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

type MetadataBenchmarkKey = Exclude<YieldBenchmarkKey, "SGD">;

const BENCHMARK_METADATA_PREFIXES: Record<MetadataBenchmarkKey, string> = {
  USD: "usd",
  USD_EFFR: "usdEffr",
  EUR: "eur",
  CHF: "chf",
  GBP: "gbp",
  JPY: "jpy",
  MXN: "mxn",
  BRL: "brl",
  AUD: "aud",
  CAD: "cad",
  RUB: "rub",
  TRY: "try",
};

const BENCHMARK_METADATA_KEYS = Object.keys(BENCHMARK_METADATA_PREFIXES) as MetadataBenchmarkKey[];

function buildFallbackBenchmarkMetadata(benchmarks: ParsedYieldBenchmarkRegistry): Array<Record<string, unknown>> {
  return BENCHMARK_METADATA_KEYS.flatMap((key) => {
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
  for (const key of BENCHMARK_METADATA_KEYS) {
    const prefix = BENCHMARK_METADATA_PREFIXES[key];
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
  await setCache(
    db,
    RISK_FREE_RATES_CACHE_KEY,
    serializeRiskFreeRatesCache(
      buildRiskFreeRatesCachePayload({
        USD: toCacheEntry(benchmarks.USD)!,
        USD_EFFR: toCacheEntry(benchmarks.USD_EFFR ?? null),
        EUR: toCacheEntry(benchmarks.EUR),
        CHF: toCacheEntry(benchmarks.CHF),
        GBP: toCacheEntry(benchmarks.GBP),
        JPY: toCacheEntry(benchmarks.JPY),
        MXN: toCacheEntry(benchmarks.MXN),
        BRL: toCacheEntry(benchmarks.BRL),
        AUD: toCacheEntry(benchmarks.AUD),
        CAD: toCacheEntry(benchmarks.CAD),
        RUB: toCacheEntry(benchmarks.RUB),
        TRY: toCacheEntry(benchmarks.TRY),
        SGD: toCacheEntry(benchmarks.SGD),
      }),
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

const BENCHMARK_PROVIDER_BY_KEY: Record<StandardBenchmarkProviderKey, BenchmarkProvider> = {
  EUR: {
    key: "EUR",
    fetch: ({ signal }) => tryEcbCompoundedEstrCsv(signal),
    source: "ecb-estr-3m",
    fallbackMode: "ecb-failed",
  },
  CHF: {
    key: "CHF",
    fetch: ({ signal }) => trySixSar3mcCsv(signal),
    source: "six-sar3mc",
    fallbackMode: "six-saron-failed",
  },
  GBP: {
    key: "GBP",
    // Primary: St. Louis Fed mirrors of the SONIA Compounded Index (IUDZOS2).
    // The BoE IADB host blocks Cloudflare Worker egress, so BoE is last resort.
    fetch: async ({ signal }) => {
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
        : {
            result: null,
            responseDiagnostics,
          };
    },
    source: "fred-sonia-compounded-index",
    fallbackMode: "gbp-sonia-compounded-index-failed",
  },
  JPY: {
    key: "JPY",
    fetch: ({ signal }) => tryBojCallRate(signal),
    source: "boj-call-rate",
    fallbackMode: "jpy-call-rate-failed",
  },
  USD_EFFR: {
    key: "USD_EFFR",
    fetch: ({ signal }) => tryUsdEffrBenchmark(signal),
    source: "nyfed-effr",
    fallbackMode: "usd-effr-sources-failed",
  },
  AUD: {
    key: "AUD",
    fetch: ({ signal }) => tryRbaCashRateTarget(signal),
    source: "rba-cash-rate-target",
    fallbackMode: "aud-cash-rate-failed",
  },
  BRL: {
    key: "BRL",
    fetch: ({ signal }) => tryBcbSelic(signal),
    source: "bcb-selic",
    fallbackMode: "bcb-selic-failed",
  },
  CAD: {
    key: "CAD",
    fetch: ({ signal }) => tryBocCorra(signal),
    source: "boc-valet-v122530",
    fallbackMode: "boc-corra-failed",
  },
  RUB: {
    key: "RUB",
    fetch: ({ signal }) => tryCbrKeyRate(signal),
    source: "cbr-key-rate",
    fallbackMode: "cbr-key-rate-failed",
  },
  TRY: {
    key: "TRY",
    fetch: ({ signal }) => tryCbrtTlref(signal),
    source: "cbrt-evds-tlref",
    fallbackMode: "cbrt-tlref-failed",
  },
} as const;

const BENCHMARK_PROVIDER_ORDER = [
  "USD_EFFR",
  "EUR",
  "CHF",
  "GBP",
  "JPY",
  "AUD",
  "MXN",
  "BRL",
  "CAD",
  "RUB",
  "TRY",
] as const satisfies readonly BenchmarkProviderKey[];

// Degradation reporting keeps AUD below MXN/BRL even though fetch order queries AUD earlier.
const BENCHMARK_DEGRADATION_ORDER = [
  "USD_EFFR",
  "EUR",
  "CHF",
  "GBP",
  "JPY",
  "MXN",
  "BRL",
  "AUD",
  "CAD",
  "RUB",
  "TRY",
] as const satisfies readonly BenchmarkProviderKey[];

// Compile-time guard: the fetch order and degradation-reporting order must cover
// the identical key set (only the ordering may differ). Adding a benchmark to one
// array but not the other is a type error here.
type _AssertSameBenchmarkKeys =
  Exclude<(typeof BENCHMARK_PROVIDER_ORDER)[number], (typeof BENCHMARK_DEGRADATION_ORDER)[number]> extends never
    ? Exclude<(typeof BENCHMARK_DEGRADATION_ORDER)[number], (typeof BENCHMARK_PROVIDER_ORDER)[number]> extends never
      ? true
      : ["benchmark key in degradation order missing from provider order"]
    : ["benchmark key in provider order missing from degradation order"];
const _assertSameBenchmarkKeys: _AssertSameBenchmarkKeys = true;
void _assertSameBenchmarkKeys;

async function resolveBenchmarkProvider(params: {
  provider: BenchmarkProvider;
  previous: ParsedYieldBenchmarkRegistry;
  fetchedAt: number;
  signal?: AbortSignal;
}): Promise<ResolvedBenchmarkProvider> {
  const { provider, previous, fetchedAt, signal } = params;
  const outcome = await provider.fetch({ signal });
  const parsed = outcome && "result" in outcome ? outcome.result : outcome;
  const responseDiagnostics = outcome?.responseDiagnostics;
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
  previous: ParsedYieldBenchmarkRegistry;
  fetchedAt: number;
  env?: Pick<Env, "BANXICO_TOKEN">;
  signal?: AbortSignal;
}): Promise<ResolvedBenchmarkProvider> {
  const { previous, fetchedAt, env, signal } = params;
  const token = env?.BANXICO_TOKEN?.trim() || null;
  const banxicoParsed = token ? await tryBanxicoCetes(token, signal) : null;
  if (banxicoParsed) {
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
  const meta = buildRetainedBenchmark(previous.MXN, baseFallbackMode);
  return {
    key: "MXN",
    parsed: null,
    meta,
    failureMode: meta?.fallbackMode ?? baseFallbackMode,
  };
}

async function resolveBenchmarkProviderMap(params: {
  previous: ParsedYieldBenchmarkRegistry;
  fetchedAt: number;
  env?: Pick<Env, "BANXICO_TOKEN">;
  signal?: AbortSignal;
}): Promise<Record<BenchmarkProviderKey, ResolvedBenchmarkProvider>> {
  const resolvedProviders: ResolvedBenchmarkProvider[] = [];
  for (const key of BENCHMARK_PROVIDER_ORDER) {
    throwIfAborted(params.signal);
    resolvedProviders.push(
      key === "MXN"
        ? await resolveMxnBenchmarkProvider(params)
        : await resolveBenchmarkProvider({
            provider: BENCHMARK_PROVIDER_BY_KEY[key],
            previous: params.previous,
            fetchedAt: params.fetchedAt,
            signal: params.signal,
          }),
    );
  }

  return Object.fromEntries(resolvedProviders.map((entry) => [entry.key, entry])) as Record<
    BenchmarkProviderKey,
    ResolvedBenchmarkProvider
  >;
}

function buildBenchmarkRegistry(
  usdMeta: ParsedYieldBenchmarkMeta,
  resolvedByKey: Record<BenchmarkProviderKey, ResolvedBenchmarkProvider>,
): ParsedYieldBenchmarkRegistry {
  return {
    USD: usdMeta,
    USD_EFFR: resolvedByKey.USD_EFFR.meta,
    EUR: resolvedByKey.EUR.meta,
    CHF: resolvedByKey.CHF.meta,
    GBP: resolvedByKey.GBP.meta,
    JPY: resolvedByKey.JPY.meta,
    MXN: resolvedByKey.MXN.meta,
    BRL: resolvedByKey.BRL.meta,
    AUD: resolvedByKey.AUD.meta,
    CAD: resolvedByKey.CAD.meta,
    RUB: resolvedByKey.RUB.meta,
    TRY: resolvedByKey.TRY.meta,
    SGD: null,
  };
}

function buildBenchmarkDegradationReasons(
  usdMeta: ParsedYieldBenchmarkMeta,
  resolvedByKey: Record<BenchmarkProviderKey, ResolvedBenchmarkProvider>,
): string[] {
  const degradationReasons: string[] = [];
  if (usdMeta.isFallback) degradationReasons.push(`usd:${usdMeta.fallbackMode}`);
  for (const key of BENCHMARK_DEGRADATION_ORDER) {
    const failureMode = resolvedByKey[key].failureMode;
    if (failureMode) degradationReasons.push(`${key.toLowerCase()}:${failureMode}`);
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
): Promise<CronResult> {
  const previous = await loadRiskFreeRateRegistry(db);
  throwIfAborted(signal);
  const fetchedAt = Math.floor(Date.now() / 1000);

  if (!(await shouldAttemptFetch(db, CIRCUIT_SOURCE.TREASURY_RATES))) {
    throwIfAborted(signal);
    const usdRetained = buildRetainedBenchmark(previous.USD, "circuit-open");
    const usdBenchmark = usdRetained ?? buildHardcodedUsdBenchmark("circuit-open");
    const resolvedByKey = await resolveBenchmarkProviderMap({ previous, fetchedAt, env, signal });
    const benchmarks = buildBenchmarkRegistry(usdBenchmark, resolvedByKey);
    const gbpRetainedFallbackMonitor = await updateGbpRetainedFallbackMonitor({
      db,
      benchmark: benchmarks.GBP,
      fetchedAt,
      signal,
    });
    await writeStructuredBenchmarks(db, benchmarks);
    const degradationReasons = buildBenchmarkDegradationReasons(usdBenchmark, resolvedByKey);
    return {
      status: "degraded",
      itemCount: BENCHMARK_METADATA_KEYS.filter((key) => benchmarks[key] != null).length,
      metadata: buildBenchmarkRunMetadata({
        fallbackMode: degradationReasons.join(","),
        benchmarks,
        extraFields: {
          ...gbpRetainedFallbackMonitor,
          ...buildGbpResponseDiagnosticMetadata(resolvedByKey.GBP),
        },
      }),
    };
  }

  throwIfAborted(signal);

  const usdFred = await tryFredCsv(FRED_TBILL_CSV_URL, signal);
  const usdParsed = usdFred ?? (await tryTreasuryXml(signal));
  const usdSource = usdFred ? "fred-dgs3mo" : usdParsed ? "treasury-yield-xml" : null;
  const usdMeta =
    usdParsed && usdSource
      ? buildResolvedBenchmark({
          key: "USD",
          rate: usdParsed.rate,
          recordDate: usdParsed.recordDate,
          fetchedAt,
          source: usdSource,
        })
      : (buildRetainedBenchmark(previous.USD, "all-sources-failed") ??
        buildHardcodedUsdBenchmark("all-sources-failed"));

  if (usdParsed && usdSource) {
    await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, true);
  } else {
    await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
  }

  const resolvedByKey = await resolveBenchmarkProviderMap({ previous, fetchedAt, env, signal });

  // SGD: TODO — no stable public SORA endpoint identified yet; SGD pegs fall back to USD.
  const benchmarks = buildBenchmarkRegistry(usdMeta, resolvedByKey);

  const gbpRetainedFallbackMonitor = await updateGbpRetainedFallbackMonitor({
    db,
    benchmark: benchmarks.GBP,
    fetchedAt,
    signal,
  });
  await writeStructuredBenchmarks(db, benchmarks);

  const degradationReasons = buildBenchmarkDegradationReasons(usdMeta, resolvedByKey);

  return {
    status: degradationReasons.length > 0 ? "degraded" : "ok",
    itemCount: BENCHMARK_METADATA_KEYS.filter((key) => benchmarks[key] != null).length,
    metadata: buildBenchmarkRunMetadata({
      fallbackMode: degradationReasons.length > 0 ? degradationReasons.join(",") : null,
      benchmarks,
      includeDetails: true,
      extraFields: {
        ...gbpRetainedFallbackMonitor,
        ...buildGbpResponseDiagnosticMetadata(resolvedByKey.GBP),
      },
    }),
  };
}
