import { fetchWithRetry } from "../lib/fetch-retry";
import { setCache } from "../lib/db-cache";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import {
  CIRCUIT_SOURCE,
  USER_AGENT,
  ECB_ESTR_3M_CSV_URL,
  FRED_EFFR_CSV_URL,
  FRED_TBILL_CSV_URL,
  TREASURY_YIELD_XML_URL,
  SIX_BROWSER_USER_AGENT,
  SIX_OAUTH_TOKEN_URL,
  SIX_REPORT_DOWNLOAD_URL,
  SIX_SARON_3M_CSV_URL,
  SIX_SARON_COMPOUND_RATES_REFERER_URL,
  BOE_SONIA_CSV_BASE_URL,
  BOJ_CALL_RATE_JSON_BASE_URL,
  RBA_F1_MONEY_MARKET_CSV_URL,
  BANXICO_CETES_28D_URL,
  BCB_SELIC_URL,
  BOC_CORRA_URL,
  CBRT_EVDS_FE_URL,
  CBRT_TLREF_SERIES_CODE,
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
import { rethrowIfAborted, throwIfAborted } from "../lib/abort";
import {
  ETHERFUSE_CETES_BENCHMARK_SOURCE,
  fetchEtherfuseCetesIssuance,
} from "./yield-sync/etherfuse-cetes";
import { loadRiskFreeRateRegistry } from "./yield-sync/sources-riskfree";
import type { YieldBenchmarkKey } from "@shared/types/yield";
import type { Env } from "../lib/env";

const RISK_FREE_RATES_CACHE_KEY = "risk_free_rates";
const LEGACY_USD_RISK_FREE_RATE_CACHE_KEY = "risk_free_rate";
const BOE_SONIA_COMPOUNDED_INDEX_SERIES_CODE = "IUDZOS2";
const BOE_COMPOUNDED_SONIA_WINDOW_DAYS = 90;
const BOE_COMPOUNDED_SONIA_LOOKBACK_DAYS = 140;

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

function parseRate(rateRaw: string | number | null | undefined): number {
  if (typeof rateRaw === "number") return rateRaw;
  if (typeof rateRaw !== "string") return Number.NaN;
  return parseFloat(rateRaw);
}

function isValidBenchmarkRateForKey(key: YieldBenchmarkKey, rate: number): boolean {
  const maxRate = key === "TRY" ? 100 : 20;
  return Number.isFinite(rate) && rate >= -10 && rate <= maxRate;
}

function isValidBenchmarkRate(rate: number): boolean {
  return isValidBenchmarkRateForKey("USD", rate);
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

function parseEnglishDate(dateRaw: string): string | null {
  const match = dateRaw.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2}|\d{4})$/);
  if (!match) return null;
  const month = {
    Jan: "01",
    Feb: "02",
    Mar: "03",
    Apr: "04",
    May: "05",
    Jun: "06",
    Jul: "07",
    Aug: "08",
    Sep: "09",
    Oct: "10",
    Nov: "11",
    Dec: "12",
  }[match[2]];
  if (!month) return null;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${month}-${match[1].padStart(2, "0")}`;
}

export function parseBoeSoniaCsv(csv: string): { recordDate: string; rate: number } | null {
  const lines = csv.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const [dateRaw, rateRaw] = line.split(",");
    const recordDate = dateRaw ? parseEnglishDate(dateRaw) : null;
    const rate = parseRate(rateRaw);
    if (!recordDate || !isValidBenchmarkRate(rate)) continue;
    return { recordDate, rate };
  }
  return null;
}

function parseIsoDateMs(recordDate: string): number {
  const parsed = Date.parse(`${recordDate}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function parseBoeSoniaCompoundedIndexCsv(csv: string): { recordDate: string; rate: number } | null {
  const observations = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const [dateRaw, indexRaw] = line.split(",");
      const recordDate = dateRaw ? parseEnglishDate(dateRaw) : null;
      const indexValue = parseRate(indexRaw);
      const timestampMs = recordDate ? parseIsoDateMs(recordDate) : Number.NaN;
      return recordDate && Number.isFinite(timestampMs) && Number.isFinite(indexValue) && indexValue > 0
        ? [{ recordDate, indexValue, timestampMs }]
        : [];
    })
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const latest = observations[observations.length - 1];
  if (!latest) return null;

  const targetStartMs = latest.timestampMs - BOE_COMPOUNDED_SONIA_WINDOW_DAYS * 86_400_000;
  const start = [...observations].reverse().find((entry) => entry.timestampMs <= targetStartMs);
  if (!start || start.indexValue <= 0) return null;

  const dayCount = (latest.timestampMs - start.timestampMs) / 86_400_000;
  if (!Number.isFinite(dayCount) || dayCount < 80) return null;

  const rate = ((latest.indexValue / start.indexValue - 1) * 365 / dayCount) * 100;
  if (!isValidBenchmarkRate(rate)) return null;

  return { recordDate: latest.recordDate, rate };
}

function parseCompactDate(dateRaw: number | string | null | undefined): string | null {
  const value = String(dateRaw ?? "");
  const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function parseBojCallRateJson(json: string): { recordDate: string; rate: number } | null {
  try {
    const parsed = JSON.parse(json) as {
      RESULTSET?: Array<{
        SERIES_CODE?: unknown;
        VALUES?: {
          SURVEY_DATES?: Array<number | string>;
          VALUES?: Array<number | string | null>;
        };
      }>;
    };
    const series = parsed.RESULTSET?.find((entry) => entry.SERIES_CODE === "STRDCLUCON") ?? parsed.RESULTSET?.[0];
    const dates = series?.VALUES?.SURVEY_DATES;
    const values = series?.VALUES?.VALUES;
    if (!Array.isArray(dates) || !Array.isArray(values)) return null;
    for (let i = Math.min(dates.length, values.length) - 1; i >= 0; i--) {
      const recordDate = parseCompactDate(dates[i]);
      const rate = parseRate(values[i]);
      if (!recordDate || !isValidBenchmarkRate(rate)) continue;
      return { recordDate, rate };
    }
    return null;
  } catch {
    return null;
  }
}

export function parseRbaF1MoneyMarketCsv(csv: string): { recordDate: string; rate: number } | null {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || !/^\d{2}-[A-Za-z]{3}-\d{4},/.test(line)) continue;
    const columns = line.split(",");
    const recordDate = parseEnglishDate((columns[0] ?? "").replace(/-/g, " "));
    const cashRateTarget = parseRate(columns[1]);
    const interbankOvernightRate = parseRate(columns[3]);
    const rate = isValidBenchmarkRate(cashRateTarget) ? cashRateTarget : interbankOvernightRate;
    if (!recordDate || !isValidBenchmarkRate(rate)) continue;
    return { recordDate, rate };
  }
  return null;
}

export function parseEcbCompoundedEstrCsv(csv: string): { recordDate: string; rate: number } | null {
  const lines = csv.split(/\r?\n/);
  const header = lines.find((line) => line.trim().length > 0);
  if (!header) return null;

  const headers = header.split(",").map((value) => value.trim());
  const dateIndex = headers.indexOf("TIME_PERIOD");
  const rateIndex = headers.indexOf("OBS_VALUE");
  if (dateIndex === -1 || rateIndex === -1) return null;

  const headerIndex = lines.indexOf(header);
  for (let i = lines.length - 1; i > headerIndex; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;

    const columns = line.split(",");
    const recordDate = columns[dateIndex]?.trim();
    const rate = parseRate(columns[rateIndex]?.trim());
    if (!recordDate || !isValidBenchmarkRate(rate)) continue;

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

function parseEuropeanDate(dateRaw: string): string | null {
  const match = dateRaw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function parseSlashDmyToIso(dateRaw: string): string | null {
  const match = dateRaw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function parseCbrtEvdsDate(dateRaw: string): string | null {
  const trimmed = dateRaw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const slashDmy = parseSlashDmyToIso(trimmed);
  if (slashDmy) return slashDmy;

  const match = trimmed.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return null;
  // EVDS3 returns this shape as MM-DD-YYYY when dateFormat=1 and lang=en.
  return `${match[3]}-${match[1]}-${match[2]}`;
}

function parseSixOauthToken(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return typeof parsed.access_token === "string" && parsed.access_token.trim() !== ""
      ? parsed.access_token
      : null;
  } catch {
    return null;
  }
}

export function parseSixSar3mcCsv(csv: string): { recordDate: string; rate: number } | null {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) return null;

  const headers = lines[0]?.split(";").map((value) => value.trim().toLowerCase()) ?? [];
  const dateIndex = headers.indexOf("date");
  const rateIndex = headers.indexOf("value");
  const symbolIndex = headers.indexOf("symbol");
  if (dateIndex === -1 || rateIndex === -1) return null;

  for (let i = 1; i < lines.length; i++) {
    const columns = lines[i]?.split(";").map((value) => value.trim()) ?? [];
    const symbol = symbolIndex === -1 ? null : columns[symbolIndex];
    if (symbolIndex !== -1 && symbol !== "SAR3MC") continue;

    const recordDate = parseEuropeanDate(columns[dateIndex] ?? "");
    const rate = parseRate(columns[rateIndex] ?? "");
    if (!recordDate || !isValidBenchmarkRate(rate)) continue;

    return { recordDate, rate };
  }

  return null;
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

type BenchmarkFetchResult = { rate: number; recordDate: string };
type BenchmarkProviderKey = Exclude<YieldBenchmarkKey, "USD" | "SGD">;
type StandardBenchmarkProviderKey = Exclude<BenchmarkProviderKey, "MXN">;

interface BenchmarkProvider {
  key: StandardBenchmarkProviderKey;
  fetch: (params: {
    signal?: AbortSignal;
  }) => Promise<BenchmarkFetchResult | null>;
  source: string;
  fallbackMode: string;
}

interface ResolvedBenchmarkProvider {
  key: BenchmarkProviderKey;
  parsed: BenchmarkFetchResult | null;
  meta: ParsedYieldBenchmarkMeta | null;
  failureMode: string | null;
}

async function fetchAndParseBenchmark<T>({
  url,
  headers,
  method = "GET",
  body,
  retries = BENCHMARK_FETCH_MAX_RETRIES,
  parse,
  warnLabel,
  signal,
}: {
  url: string;
  headers: Record<string, string>;
  method?: string;
  body?: BodyInit | null;
  retries?: number;
  parse: (body: string) => T | null;
  warnLabel: string;
  signal?: AbortSignal;
}): Promise<T | null> {
  try {
    const res = await fetchWithRetry(url, {
      method,
      headers,
      body: body ?? undefined,
      signal,
    }, retries, { timeoutMs: BENCHMARK_FETCH_TIMEOUT_MS });

    if (!res?.ok) return null;

    return parse(await res.text());
  } catch (err) {
    rethrowIfAborted(err, signal);
    console.warn(`[fetch-tbill-rate] ${warnLabel} failed: ${String(err).slice(0, 200)}`);
    return null;
  }
}

async function tryFredCsv(
  url: string,
  signal?: AbortSignal,
): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url,
    headers: { "User-Agent": USER_AGENT },
    parse: parseFredLatest,
    warnLabel: "FRED CSV",
    signal,
  });
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function formatBoeRequestDate(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(date.getUTCDate()).padStart(2, "0")}/${months[date.getUTCMonth()]}/${date.getUTCFullYear()}`;
}

function formatCbrtEvdsRequestDate(date: Date): string {
  return `${String(date.getUTCDate()).padStart(2, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${date.getUTCFullYear()}`;
}

function buildBoeIadbCsvUrl(seriesCode: string, now = new Date(), lookbackDays = 21): string {
  const url = new URL(BOE_SONIA_CSV_BASE_URL);
  url.searchParams.set("csv.x", "yes");
  url.searchParams.set("Datefrom", formatBoeRequestDate(addDays(now, -lookbackDays)));
  url.searchParams.set("Dateto", formatBoeRequestDate(now));
  url.searchParams.set("SeriesCodes", seriesCode);
  url.searchParams.set("UsingCodes", "Y");
  url.searchParams.set("VPD", "Y");
  url.searchParams.set("VFD", "N");
  return url.toString();
}

function buildBoeSoniaCompoundedIndexCsvUrl(now = new Date()): string {
  return buildBoeIadbCsvUrl(
    BOE_SONIA_COMPOUNDED_INDEX_SERIES_CODE,
    now,
    BOE_COMPOUNDED_SONIA_LOOKBACK_DAYS,
  );
}

function buildBojCallRateJsonUrl(now = new Date()): string {
  const start = addDays(now, -45);
  const url = new URL(BOJ_CALL_RATE_JSON_BASE_URL);
  url.searchParams.set("format", "json");
  url.searchParams.set("lang", "en");
  url.searchParams.set("db", "FM01");
  url.searchParams.set("code", "STRDCLUCON");
  url.searchParams.set(
    "startDate",
    `${start.getUTCFullYear()}${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
  );
  return url.toString();
}

async function tryBoeSoniaCompoundedIndex(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url: buildBoeSoniaCompoundedIndexCsvUrl(),
    headers: { "User-Agent": USER_AGENT },
    parse: parseBoeSoniaCompoundedIndexCsv,
    warnLabel: "BoE SONIA Compounded Index CSV",
    signal,
  });
}

async function tryBojCallRate(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url: buildBojCallRateJsonUrl(),
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    parse: parseBojCallRateJson,
    warnLabel: "BOJ call-rate JSON",
    signal,
  });
}

async function tryRbaCashRateTarget(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url: RBA_F1_MONEY_MARKET_CSV_URL,
    headers: { "User-Agent": USER_AGENT },
    parse: parseRbaF1MoneyMarketCsv,
    warnLabel: "RBA F1 money-market CSV",
    signal,
  });
}

async function tryEcbCompoundedEstrCsv(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url: ECB_ESTR_3M_CSV_URL,
    headers: { "User-Agent": USER_AGENT },
    parse: parseEcbCompoundedEstrCsv,
    warnLabel: "ECB 3M compounded €STR CSV",
    signal,
  });
}

async function tryTreasuryXml(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url: TREASURY_YIELD_XML_URL,
    headers: { "User-Agent": USER_AGENT },
    retries: 1,
    parse: parseTreasuryYieldXml,
    warnLabel: "Treasury XML",
    signal,
  });
}

function buildSixGuestHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    Origin: "https://indexdata.six-group.com",
    Referer: SIX_SARON_COMPOUND_RATES_REFERER_URL,
    "User-Agent": SIX_BROWSER_USER_AGENT,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function trySixGuestToken(signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetchWithRetry(SIX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        ...buildSixGuestHeaders(),
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: "grant_type=client_credentials&client_id=default_consumer&scope=api_authentication",
      signal,
    }, BENCHMARK_FETCH_MAX_RETRIES, { timeoutMs: BENCHMARK_FETCH_TIMEOUT_MS });

    if (!res?.ok) {
      return null;
    }

    return parseSixOauthToken(await res.text());
  } catch (err) {
    rethrowIfAborted(err, signal);
    console.warn(`[fetch-tbill-rate] SIX guest token fetch failed: ${String(err).slice(0, 200)}`);
    return null;
  }
}

async function trySixSar3mcCsv(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  const token = await trySixGuestToken(signal);
  if (!token) return null;

  try {
    const res = await fetchWithRetry(SIX_REPORT_DOWNLOAD_URL, {
      method: "POST",
      headers: {
        ...buildSixGuestHeaders(token),
        "Content-Type": "application/json;charset=UTF-8",
      },
      body: JSON.stringify({ furl: SIX_SARON_3M_CSV_URL }),
      signal,
    }, BENCHMARK_FETCH_MAX_RETRIES, { timeoutMs: BENCHMARK_FETCH_TIMEOUT_MS });

    if (!res?.ok) {
      return null;
    }

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const body = await res.text();
    if (contentType.includes("application/json")) {
      return null;
    }

    return parseSixSar3mcCsv(body);
  } catch (err) {
    rethrowIfAborted(err, signal);
    console.warn(`[fetch-tbill-rate] SIX SAR3MC fetch failed: ${String(err).slice(0, 200)}`);
    return null;
  }
}

/**
 * Parse a Banxico SIE response. Shape:
 *   { bmx: { series: [{ datos: [{ fecha: "DD/MM/YYYY", dato: "11.43" }] }] } }
 * Dates use `DD/MM/YYYY` (Banxico) — normalize to ISO `YYYY-MM-DD`.
 */
export function parseBanxicoSeries(json: string): { recordDate: string; rate: number } | null {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const bmx = parsed.bmx as Record<string, unknown> | undefined;
    const series = (bmx?.series as Array<Record<string, unknown>> | undefined)?.[0];
    const datos = series?.datos as Array<{ fecha?: unknown; dato?: unknown }> | undefined;
    if (!Array.isArray(datos) || datos.length === 0) return null;
    for (let i = datos.length - 1; i >= 0; i--) {
      const row = datos[i];
      const rate = parseRate(typeof row?.dato === "string" ? row.dato : null);
      const fechaRaw = typeof row?.fecha === "string" ? row.fecha : null;
      if (!fechaRaw || !isValidBenchmarkRate(rate)) continue;
      const recordDate = parseSlashDmyToIso(fechaRaw);
      if (!recordDate) continue;
      return { rate, recordDate };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse a BCB SGS response. Shape:
 *   [{ data: "DD/MM/YYYY", valor: "12.75" }]
 * BCB returns SELIC over as a daily rate; we treat it directly as a daily APY proxy.
 */
export function parseBcbSelicSeries(json: string): { recordDate: string; rate: number } | null {
  try {
    const parsed = JSON.parse(json) as Array<{ data?: unknown; valor?: unknown }>;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    for (let i = parsed.length - 1; i >= 0; i--) {
      const row = parsed[i];
      const rate = parseRate(typeof row?.valor === "string" ? row.valor : null);
      const dataRaw = typeof row?.data === "string" ? row.data : null;
      if (!dataRaw || !isValidBenchmarkRate(rate)) continue;
      const recordDate = parseSlashDmyToIso(dataRaw);
      if (!recordDate) continue;
      return { rate, recordDate };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse a Bank of Canada Valet observations response. Shape:
 *   { observations: [{ d: "YYYY-MM-DD", V122530: { v: "4.75" } }] }
 */
export function parseBocValetSeries(
  json: string,
  seriesCode: string,
): { recordDate: string; rate: number } | null {
  try {
    const parsed = JSON.parse(json) as { observations?: Array<Record<string, unknown>> };
    const observations = parsed.observations;
    if (!Array.isArray(observations) || observations.length === 0) return null;
    for (let i = observations.length - 1; i >= 0; i--) {
      const obs = observations[i];
      const d = typeof obs?.d === "string" ? obs.d : null;
      const cell = obs?.[seriesCode] as { v?: unknown } | undefined;
      const rate = parseRate(typeof cell?.v === "string" ? cell.v : null);
      if (!d || !isValidBenchmarkRate(rate)) continue;
      return { rate, recordDate: d };
    }
    return null;
  } catch {
    return null;
  }
}

export function parseCbrtEvdsSeries(
  json: string,
  seriesCode = CBRT_TLREF_SERIES_CODE,
): { recordDate: string; rate: number } | null {
  try {
    const parsed = JSON.parse(json) as { items?: Array<Record<string, unknown>> };
    const items = parsed.items;
    if (!Array.isArray(items) || items.length === 0) return null;

    const seriesField = seriesCode.replace(/\./g, "_");
    let latest: { recordDate: string; rate: number } | null = null;
    for (const row of items) {
      const dateRaw = typeof row?.Tarih === "string"
        ? row.Tarih
        : typeof row?.DATE === "string"
          ? row.DATE
          : null;
      const valueRaw = row?.[seriesField];
      const rate = parseRate(
        typeof valueRaw === "string" || typeof valueRaw === "number" ? valueRaw : null,
      );
      const recordDate = dateRaw ? parseCbrtEvdsDate(dateRaw) : null;
      if (!recordDate || !isValidBenchmarkRateForKey("TRY", rate)) continue;
      if (!latest || recordDate > latest.recordDate) {
        latest = { recordDate, rate };
      }
    }
    return latest;
  } catch {
    return null;
  }
}

async function tryBanxicoCetes(
  banxicoToken: string | null,
  signal?: AbortSignal,
): Promise<{ rate: number; recordDate: string } | null> {
  if (!banxicoToken) return null;
  return fetchAndParseBenchmark({
    url: BANXICO_CETES_28D_URL,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      "Bmx-Token": banxicoToken,
    },
    parse: parseBanxicoSeries,
    warnLabel: "Banxico CETES",
    signal,
  });
}

async function tryBcbSelic(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url: BCB_SELIC_URL,
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    parse: parseBcbSelicSeries,
    warnLabel: "BCB SELIC",
    signal,
  });
}

async function tryBocCorra(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  return fetchAndParseBenchmark({
    url: BOC_CORRA_URL,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    parse: (body) => parseBocValetSeries(body, "V122530"),
    warnLabel: "BoC Valet CORRA",
    signal,
  });
}

async function tryCbrtTlref(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  const now = new Date();
  const body = JSON.stringify({
    type: "json",
    series: CBRT_TLREF_SERIES_CODE,
    aggregationTypes: "avg",
    formulas: "0",
    startDate: formatCbrtEvdsRequestDate(addDays(now, -14)),
    endDate: formatCbrtEvdsRequestDate(now),
    frequency: "2",
    decimalSeperator: ".",
    decimal: "2",
    dateFormat: "1",
    lang: "en",
    yon: "desc",
    sira: "Tarih",
    ozelFormuller: [],
    groupSeperator: true,
    isRaporSayfasi: false,
  });

  return fetchAndParseBenchmark({
    url: CBRT_EVDS_FE_URL,
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      "Content-Type": "application/json;charset=UTF-8",
      Origin: "https://evds3.tcmb.gov.tr",
      Referer: "https://evds3.tcmb.gov.tr/",
    },
    body,
    parse: (responseBody) => parseCbrtEvdsSeries(responseBody, CBRT_TLREF_SERIES_CODE),
    warnLabel: "CBRT EVDS TLREF",
    signal,
  });
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
  TRY: {
    key: "TRY",
    fetch: ({ signal }) => tryCbrtTlref(signal),
    source: "cbrt-evds-tlref",
    fallbackMode: "cbrt-tlref-failed",
  },
} as const;

const BENCHMARK_PROVIDER_ORDER: readonly BenchmarkProviderKey[] = [
  "USD_EFFR",
  "EUR",
  "CHF",
  "GBP",
  "JPY",
  "AUD",
  "MXN",
  "BRL",
  "CAD",
  "TRY",
] as const;

const BENCHMARK_DEGRADATION_ORDER: readonly BenchmarkProviderKey[] = [
  "USD_EFFR",
  "EUR",
  "CHF",
  "GBP",
  "JPY",
  "MXN",
  "BRL",
  "AUD",
  "CAD",
  "TRY",
] as const;

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
    const benchmarks: ParsedYieldBenchmarkRegistry = {
      USD: usdBenchmark,
      USD_EFFR: buildRetainedBenchmark(previous.USD_EFFR ?? null, "circuit-open"),
      EUR: buildRetainedBenchmark(previous.EUR, "circuit-open"),
      CHF: buildRetainedBenchmark(previous.CHF, "circuit-open"),
      GBP: buildRetainedBenchmark(previous.GBP, "circuit-open"),
      JPY: buildRetainedBenchmark(previous.JPY, "circuit-open"),
      MXN: buildRetainedBenchmark(previous.MXN, "circuit-open"),
      BRL: buildRetainedBenchmark(previous.BRL, "circuit-open"),
      AUD: buildRetainedBenchmark(previous.AUD, "circuit-open"),
      CAD: buildRetainedBenchmark(previous.CAD, "circuit-open"),
      TRY: buildRetainedBenchmark(previous.TRY, "circuit-open"),
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
