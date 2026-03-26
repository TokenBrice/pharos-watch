import { fetchWithRetry } from "../lib/fetch-retry";
import { getCache, setCache } from "../lib/db-cache";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import {
  CIRCUIT_SOURCE,
  USER_AGENT,
  FRED_TBILL_CSV_URL,
  FRED_ESTR_CSV_URL,
  TREASURY_YIELD_XML_URL,
  SNB_CURRENT_RATES_URL,
  FRED_FETCH_TIMEOUT_MS,
  FRED_FETCH_MAX_RETRIES,
} from "../lib/constants";
import type { CronResult } from "../lib/cron-logger";
import {
  buildRiskFreeRateCachePayload,
  buildRiskFreeRatesCachePayload,
  parseRiskFreeRateCache,
  parseRiskFreeRatesCache,
  serializeRiskFreeRateCache,
  serializeRiskFreeRatesCache,
} from "./yield-sync/cache";
import {
  buildHardcodedUsdBenchmark,
  withYieldBenchmarkStaticMeta,
  type ParsedYieldBenchmarkMeta,
  type ParsedYieldBenchmarkRegistry,
} from "./yield-sync/benchmarks";

const RISK_FREE_RATES_CACHE_KEY = "risk_free_rates";
const LEGACY_USD_RISK_FREE_RATE_CACHE_KEY = "risk_free_rate";

function buildMetadata(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

function parseRate(rateRaw: string | number | null | undefined): number {
  if (typeof rateRaw === "number") return rateRaw;
  if (typeof rateRaw !== "string") return Number.NaN;
  return parseFloat(rateRaw);
}

function isValidBenchmarkRate(rate: number): boolean {
  return Number.isFinite(rate) && rate >= -10 && rate <= 20;
}

function parseFredLatest(csv: string): { recordDate: string; rate: number } | null {
  const lines = csv.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const [recordDate, rateRaw] = line.split(",");
    if (!recordDate || !rateRaw) continue;
    const rate = parseRate(rateRaw);
    if (!isValidBenchmarkRate(rate)) continue;
    return { recordDate, rate };
  }
  return null;
}

/** Parse the latest 3-month yield from Treasury.gov yield curve XML. */
export function parseTreasuryYieldXml(xml: string): { recordDate: string; rate: number } | null {
  const blockPattern =
    /<G_NEW_DATE>[\s\S]*?<BC_3MONTH>([\d.]+)<\/BC_3MONTH>[\s\S]*?<NEW_DATE>([\d/-]+)<\/NEW_DATE>[\s\S]*?<\/G_NEW_DATE>/g;
  let lastRate: number | null = null;
  let lastDateRaw: string | null = null;

  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(xml)) !== null) {
    const rate = parseFloat(match[1]);
    if (isValidBenchmarkRate(rate)) {
      lastRate = rate;
      lastDateRaw = match[2];
    }
  }

  if (lastRate == null || lastDateRaw == null) return null;

  const parts = lastDateRaw.split("-");
  if (parts.length !== 3) return null;
  const recordDate = `${parts[2]}-${parts[0]}-${parts[1]}`;

  return { recordDate, rate: lastRate };
}

function parseSnbDate(dateRaw: string): string | null {
  const match = dateRaw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

export function parseSnbPolicyRateHtml(html: string): { recordDate: string; rate: number } | null {
  const match = html.match(/SNB policy rate\s+(-?[\d.]+)%\s+valid from\s+(\d{2}\.\d{2}\.\d{4})/i);
  if (!match) return null;

  const rate = parseFloat(match[1]);
  if (!isValidBenchmarkRate(rate)) return null;

  const recordDate = parseSnbDate(match[2]);
  if (!recordDate) return null;

  return { recordDate, rate };
}

async function loadPreviousBenchmarks(db: D1Database): Promise<ParsedYieldBenchmarkRegistry> {
  const multiCache = await getCache(db, RISK_FREE_RATES_CACHE_KEY);
  if (multiCache) {
    const parsed = parseRiskFreeRatesCache(multiCache.value, multiCache.updatedAt);
    if (parsed) return parsed;
  }

  const legacyUsdCache = await getCache(db, LEGACY_USD_RISK_FREE_RATE_CACHE_KEY);
  if (legacyUsdCache) {
    const parsedUsd = parseRiskFreeRateCache(
      legacyUsdCache.value,
      legacyUsdCache.updatedAt,
      Math.floor(Date.now() / 1000),
      { key: "USD" },
    );
    if (parsedUsd) {
      return {
        USD: parsedUsd,
        EUR: null,
        CHF: null,
      };
    }
  }

  return {
    USD: buildHardcodedUsdBenchmark(
      multiCache || legacyUsdCache ? "invalid-cache" : "missing-cache",
    ),
    EUR: null,
    CHF: null,
  };
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
        EUR: toCacheEntry(benchmarks.EUR),
        CHF: toCacheEntry(benchmarks.CHF),
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
    return {
      ...withYieldBenchmarkStaticMeta(previous.key ?? "USD", {
        rate: previous.lastMarketRate,
        recordDate: previous.lastMarketRecordDate,
        fetchedAt: previous.lastMarketFetchedAt,
        ageSeconds: previous.lastMarketFetchedAt != null
          ? Math.max(0, Math.floor(Date.now() / 1000) - previous.lastMarketFetchedAt)
          : null,
        source: previous.lastMarketSource,
        isFallback: true,
        fallbackMode: `${fallbackMode}-retained`,
      }),
      lastMarketRate: previous.lastMarketRate,
      lastMarketRecordDate: previous.lastMarketRecordDate,
      lastMarketFetchedAt: previous.lastMarketFetchedAt,
      lastMarketSource: previous.lastMarketSource,
    };
  }

  return null;
}

function buildResolvedBenchmark(params: {
  key: "USD" | "EUR" | "CHF";
  rate: number;
  recordDate: string;
  fetchedAt: number;
  source: string;
}): ParsedYieldBenchmarkMeta {
  return {
    ...withYieldBenchmarkStaticMeta(params.key, {
      rate: params.rate,
      recordDate: params.recordDate,
      fetchedAt: params.fetchedAt,
      ageSeconds: 0,
      source: params.source,
      isFallback: false,
      fallbackMode: null,
    }),
    lastMarketRate: params.rate,
    lastMarketRecordDate: params.recordDate,
    lastMarketFetchedAt: params.fetchedAt,
    lastMarketSource: params.source,
  };
}

async function tryFredCsv(
  url: string,
  signal?: AbortSignal,
): Promise<{ rate: number; recordDate: string } | null> {
  try {
    const res = await fetchWithRetry(url, {
      headers: { "User-Agent": USER_AGENT },
      signal,
    }, FRED_FETCH_MAX_RETRIES, { timeoutMs: FRED_FETCH_TIMEOUT_MS });

    if (!res?.ok) {
      return null;
    }

    return parseFredLatest(await res.text());
  } catch (err) {
    console.warn(`[fetch-tbill-rate] FRED CSV failed: ${String(err).slice(0, 200)}`);
    return null;
  }
}

async function tryTreasuryXml(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  try {
    const res = await fetchWithRetry(TREASURY_YIELD_XML_URL, {
      headers: { "User-Agent": USER_AGENT },
      signal,
    }, 1, { timeoutMs: FRED_FETCH_TIMEOUT_MS });

    if (!res?.ok) {
      return null;
    }

    return parseTreasuryYieldXml(await res.text());
  } catch (err) {
    console.warn(`[fetch-tbill-rate] Treasury XML failed: ${String(err).slice(0, 200)}`);
    return null;
  }
}

async function trySnbPolicyRate(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  try {
    const res = await fetchWithRetry(SNB_CURRENT_RATES_URL, {
      headers: { "User-Agent": USER_AGENT },
      signal,
    }, 1, { timeoutMs: FRED_FETCH_TIMEOUT_MS });

    if (!res?.ok) {
      return null;
    }

    return parseSnbPolicyRateHtml(await res.text());
  } catch (err) {
    console.warn(`[fetch-tbill-rate] SNB policy rate fetch failed: ${String(err).slice(0, 200)}`);
    return null;
  }
}

export async function fetchTbillRate(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  const previous = await loadPreviousBenchmarks(db);

  if (!await shouldAttemptFetch(db, CIRCUIT_SOURCE.TREASURY_RATES)) {
    const usdRetained = buildRetainedBenchmark(previous.USD, "circuit-open");
    const eurRetained = buildRetainedBenchmark(previous.EUR, "circuit-open");
    const chfRetained = buildRetainedBenchmark(previous.CHF, "circuit-open");
    await writeStructuredBenchmarks(db, {
      USD: usdRetained ?? buildHardcodedUsdBenchmark("circuit-open"),
      EUR: eurRetained,
      CHF: chfRetained,
    });
    return {
      status: "degraded",
      metadata: buildMetadata({
        fallbackMode: "circuit-open",
        usdSource: usdRetained?.source ?? "hardcoded-fallback",
        eurSource: eurRetained?.source ?? null,
        chfSource: chfRetained?.source ?? null,
      }),
    };
  }

  const fetchedAt = Math.floor(Date.now() / 1000);

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

  const eurParsed = await tryFredCsv(FRED_ESTR_CSV_URL, signal);
  const eurMeta = eurParsed
    ? buildResolvedBenchmark({
      key: "EUR",
      rate: eurParsed.rate,
      recordDate: eurParsed.recordDate,
      fetchedAt,
      source: "fred-estr",
    })
    : buildRetainedBenchmark(previous.EUR, "fred-failed");

  const chfParsed = await trySnbPolicyRate(signal);
  const chfMeta = chfParsed
    ? buildResolvedBenchmark({
      key: "CHF",
      rate: chfParsed.rate,
      recordDate: chfParsed.recordDate,
      fetchedAt,
      source: "snb-policy-rate",
    })
    : buildRetainedBenchmark(previous.CHF, "snb-failed");

  await writeStructuredBenchmarks(db, {
    USD: usdMeta,
    EUR: eurMeta,
    CHF: chfMeta,
  });

  const degradationReasons: string[] = [];
  if (usdMeta.isFallback) degradationReasons.push(`usd:${usdMeta.fallbackMode}`);
  if (!eurMeta) {
    degradationReasons.push("eur:unavailable");
  } else if (eurMeta.isFallback) {
    degradationReasons.push(`eur:${eurMeta.fallbackMode}`);
  }
  if (!chfMeta) {
    degradationReasons.push("chf:unavailable");
  } else if (chfMeta.isFallback) {
    degradationReasons.push(`chf:${chfMeta.fallbackMode}`);
  }

  return {
    status: degradationReasons.length > 0 ? "degraded" : "ok",
    itemCount: [usdMeta, eurMeta, chfMeta].filter((entry) => entry != null).length,
    metadata: buildMetadata({
      fallbackMode: degradationReasons.length > 0 ? degradationReasons.join(",") : null,
      usdSource: usdMeta.source,
      usdRate: usdMeta.rate,
      usdRecordDate: usdMeta.recordDate,
      eurSource: eurMeta?.source ?? null,
      eurRate: eurMeta?.rate ?? null,
      eurRecordDate: eurMeta?.recordDate ?? null,
      chfSource: chfMeta?.source ?? null,
      chfRate: chfMeta?.rate ?? null,
      chfRecordDate: chfMeta?.recordDate ?? null,
    }),
  };
}
