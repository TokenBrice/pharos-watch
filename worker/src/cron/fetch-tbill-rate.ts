import { setCache } from "../lib/db-cache";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import {
  CIRCUIT_SOURCE,
  FRED_EFFR_CSV_URL,
  FRED_TBILL_CSV_URL,
  BENCHMARK_FETCH_TIMEOUT_MS,
  BENCHMARK_FETCH_MAX_RETRIES,
} from "../lib/constants";
import type { CronResult } from "../lib/cron-logger";
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
import {
  ETHERFUSE_CETES_BENCHMARK_SOURCE,
  fetchEtherfuseCetesIssuance,
} from "./yield-sync/etherfuse-cetes";
import { loadRiskFreeRateRegistry } from "./yield-sync/sources-riskfree";
import type { YieldBenchmarkKey } from "@shared/types/yield";
import type { Env } from "../lib/env";

import {
  isValidBenchmarkRate,
  type BenchmarkFetchResult,
  type BenchmarkProvider,
  type BenchmarkProviderKey,
  type StandardBenchmarkProviderKey,
} from "./tbill-sources/shared";
import { tryFredCsv } from "./tbill-sources/fred";
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

// Parsers live in ./tbill-sources/* alongside their fetch adapters; re-exported
// here so the existing fetch-tbill-rate test suite can keep importing them.
export { parseFredLatest } from "./tbill-sources/fred";
export { parseTreasuryYieldXml } from "./tbill-sources/treasury";
export { parseEcbCompoundedEstrCsv } from "./tbill-sources/ecb";
export { parseBoeSoniaCsv, parseBoeSoniaCompoundedIndexCsv } from "./tbill-sources/boe";
export { parseBojCallRateJson } from "./tbill-sources/boj";
export { parseRbaF1MoneyMarketCsv } from "./tbill-sources/rba";
export { parseSixSar3mcCsv } from "./tbill-sources/six";
export { parseBanxicoSeries } from "./tbill-sources/banxico";
export { parseBcbSelicSeries } from "./tbill-sources/bcb";
export { parseBocValetSeries } from "./tbill-sources/boc";
export { parseCbrtEvdsSeries } from "./tbill-sources/cbrt";
export { parseCbrKeyRateXml } from "./tbill-sources/cbr";

const RISK_FREE_RATES_CACHE_KEY = "risk_free_rates";
const LEGACY_USD_RISK_FREE_RATE_CACHE_KEY = "risk_free_rate";

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

function buildBenchmarkRunMetadata(params: {
  fallbackMode: string | null;
  benchmarks: ParsedYieldBenchmarkRegistry;
  includeDetails?: boolean;
}): string {
  const fields: Record<string, unknown> = { fallbackMode: params.fallbackMode };
  for (const key of BENCHMARK_METADATA_KEYS) {
    const prefix = BENCHMARK_METADATA_PREFIXES[key];
    const benchmark = params.benchmarks[key];
    fields[`${prefix}Source`] = benchmark?.source ?? null;
    if (params.includeDetails) {
      fields[`${prefix}Rate`] = benchmark?.rate ?? null;
      fields[`${prefix}RecordDate`] = benchmark?.recordDate ?? null;
    }
  }
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

async function writeStructuredBenchmarks(
  db: D1Database,
  benchmarks: ParsedYieldBenchmarkRegistry,
) {
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
  await setCache(
    db,
    LEGACY_USD_RISK_FREE_RATE_CACHE_KEY,
    serializeRiskFreeRateCache(toCacheEntry(benchmarks.USD)!),
  );
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
    const retained = withYieldBenchmarkStaticMeta(previous.key ?? "USD", {
      rate: previous.lastMarketRate,
      recordDate: previous.lastMarketRecordDate,
      fetchedAt: previous.lastMarketFetchedAt,
      ageSeconds: previous.lastMarketFetchedAt != null
        ? Math.max(0, Math.floor(Date.now() / 1000) - previous.lastMarketFetchedAt)
        : null,
      source: previous.lastMarketSource,
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
  return {
    ...resolved,
    isProxy: params.isProxy ?? resolved.isProxy,
    lastMarketRate: params.rate,
    lastMarketRecordDate: params.recordDate,
    lastMarketFetchedAt: params.fetchedAt,
    lastMarketSource: params.source,
  };
}

interface ResolvedBenchmarkProvider {
  key: BenchmarkProviderKey;
  parsed: BenchmarkFetchResult | null;
  meta: ParsedYieldBenchmarkMeta | null;
  failureMode: string | null;
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
    fetch: ({ signal }) => tryBoeSoniaCompoundedIndex(signal),
    source: "boe-sonia-compounded-index",
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
    fetch: ({ signal }) => tryFredCsv(FRED_EFFR_CSV_URL, signal),
    source: "fred-dff",
    fallbackMode: "fred-dff-failed",
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
  const parsed = await provider.fetch({ signal });
  const meta = parsed
    ? buildResolvedBenchmark({
      key: provider.key,
      rate: parsed.rate,
      recordDate: parsed.recordDate,
      fetchedAt,
      source: provider.source,
    })
    : buildRetainedBenchmark(previous[provider.key] ?? null, provider.fallbackMode);

  return {
    key: provider.key,
    parsed,
    meta,
    failureMode: parsed ? null : (meta?.fallbackMode ?? provider.fallbackMode),
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
  const etherfuseIssuance = await fetchEtherfuseCetesIssuance({
    signal,
    timeoutMs: BENCHMARK_FETCH_TIMEOUT_MS,
    retries: BENCHMARK_FETCH_MAX_RETRIES,
  });

  if (etherfuseIssuance && isValidBenchmarkRate(etherfuseIssuance.apyPercent)) {
    const fallbackMode = `${baseFallbackMode}-etherfuse-stablebond`;
    const parsed = {
      rate: etherfuseIssuance.apyPercent,
      recordDate: etherfuseIssuance.recordDate,
    };
    return {
      key: "MXN",
      parsed,
      meta: buildResolvedBenchmark({
        key: "MXN",
        rate: parsed.rate,
        recordDate: parsed.recordDate,
        fetchedAt,
        source: ETHERFUSE_CETES_BENCHMARK_SOURCE,
        isFallback: true,
        fallbackMode,
        isProxy: true,
      }),
      failureMode: fallbackMode,
    };
  }

  const meta = buildRetainedBenchmark(previous.MXN, baseFallbackMode);
  return {
    key: "MXN",
    parsed: null,
    meta,
    failureMode: meta?.fallbackMode ?? baseFallbackMode,
  };
}

export async function fetchTbillRate(
  db: D1Database,
  signal?: AbortSignal,
  env?: Pick<Env, "BANXICO_TOKEN">,
): Promise<CronResult> {
  const previous = await loadRiskFreeRateRegistry(db);
  throwIfAborted(signal);

  if (!await shouldAttemptFetch(db, CIRCUIT_SOURCE.TREASURY_RATES)) {
    throwIfAborted(signal);
    const usdRetained = buildRetainedBenchmark(previous.USD, "circuit-open");
    const usdBenchmark = usdRetained ?? buildHardcodedUsdBenchmark("circuit-open");
    const uniformBenchmarks = {} as Record<BenchmarkProviderKey, ParsedYieldBenchmarkMeta | null>;
    for (const key of BENCHMARK_PROVIDER_ORDER) {
      uniformBenchmarks[key] = buildRetainedBenchmark(previous[key] ?? null, "circuit-open");
    }
    const benchmarks: ParsedYieldBenchmarkRegistry = {
      USD: usdBenchmark,
      ...uniformBenchmarks,
      SGD: null,
    };
    await writeStructuredBenchmarks(db, benchmarks);
    return {
      status: "degraded",
      metadata: buildBenchmarkRunMetadata({
        fallbackMode: "circuit-open",
        benchmarks,
      }),
    };
  }

  const fetchedAt = Math.floor(Date.now() / 1000);
  throwIfAborted(signal);

  const usdFred = await tryFredCsv(FRED_TBILL_CSV_URL, signal);
  const usdParsed = usdFred ?? await tryTreasuryXml(signal);
  const usdSource = usdFred ? "fred-dgs3mo" : (usdParsed ? "treasury-yield-xml" : null);
  const usdMeta = usdParsed && usdSource
    ? buildResolvedBenchmark({
      key: "USD",
      rate: usdParsed.rate,
      recordDate: usdParsed.recordDate,
      fetchedAt,
      source: usdSource,
    })
    : (buildRetainedBenchmark(previous.USD, "all-sources-failed") ?? buildHardcodedUsdBenchmark("all-sources-failed"));

  if (usdParsed && usdSource) {
    await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, true);
  } else {
    await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
  }

  const resolvedProviders: ResolvedBenchmarkProvider[] = [];
  for (const key of BENCHMARK_PROVIDER_ORDER) {
    throwIfAborted(signal);
    resolvedProviders.push(
      key === "MXN"
        ? await resolveMxnBenchmarkProvider({ previous, fetchedAt, env, signal })
        : await resolveBenchmarkProvider({
          provider: BENCHMARK_PROVIDER_BY_KEY[key],
          previous,
          fetchedAt,
          signal,
        }),
    );
  }
  const resolvedByKey = Object.fromEntries(
    resolvedProviders.map((entry) => [entry.key, entry]),
  ) as Record<BenchmarkProviderKey, ResolvedBenchmarkProvider>;

  // SGD: TODO — no stable public SORA endpoint identified yet; SGD pegs fall back to USD.
  const benchmarks: ParsedYieldBenchmarkRegistry = {
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

  await writeStructuredBenchmarks(db, benchmarks);

  const degradationReasons: string[] = [];
  if (usdMeta.isFallback) degradationReasons.push(`usd:${usdMeta.fallbackMode}`);
  for (const key of BENCHMARK_DEGRADATION_ORDER) {
    const failureMode = resolvedByKey[key].failureMode;
    if (failureMode) degradationReasons.push(`${key.toLowerCase()}:${failureMode}`);
  }

  return {
    status: degradationReasons.length > 0 ? "degraded" : "ok",
    itemCount: BENCHMARK_METADATA_KEYS.filter((key) => benchmarks[key] != null).length,
    metadata: buildBenchmarkRunMetadata({
      fallbackMode: degradationReasons.length > 0 ? degradationReasons.join(",") : null,
      benchmarks,
      includeDetails: true,
    }),
  };
}
