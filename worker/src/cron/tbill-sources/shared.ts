import { fetchTextWithRetry } from "../../lib/fetch-retry";

import { rethrowIfAborted } from "../../lib/abort";
import { logWorkerEvent } from "../../lib/structured-log";
import type { YieldBenchmarkKey } from "@shared/types/yield";

/** FRED 3-month Treasury yield series (DGS3MO), used by fetch-tbill-rate cron. */
export const FRED_TBILL_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS3MO";
/** Official New York Fed latest Effective Federal Funds Rate endpoint, used for EFFR-linked yield products. */
export const NYFED_EFFR_JSON_URL = "https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json";
/** FRED Effective Federal Funds Rate series (DFF), retained as the USD_EFFR fallback feed. */
export const FRED_EFFR_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFF";
/**
 * FRED mirror of the Bank of England SONIA Compounded Index (series IUDZOS2),
 * used as the primary GBP benchmark feed because the BoE IADB host blocks
 * Cloudflare Worker egress. Same series the BoE source derives from.
 */
export const FRED_SONIA_COMPOUNDED_INDEX_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=IUDZOS2";
/** ALFRED graph CSV mirror of the same Bank of England SONIA Compounded Index series. */
export const ALFRED_SONIA_COMPOUNDED_INDEX_CSV_URL = "https://alfred.stlouisfed.org/graph/alfredgraph.csv?id=IUDZOS2";
/** Official ECB data API endpoint for 3-month compounded €STR. */
export const ECB_ESTR_3M_CSV_URL =
  "https://data-api.ecb.europa.eu/service/data/EST/B.EU000A2QQF32.CR?lastNObservations=5&format=csvdata";
export const TREASURY_YIELD_XML_URL = "https://home.treasury.gov/sites/default/files/interest-rates/yield.xml";
/** SIX public OAuth endpoint used to fetch delayed SARON compound-rate downloads as a guest client. */
export const SIX_OAUTH_TOKEN_URL = "https://indexdata.six-group.com/pro/oauth/token";
/** SIX public download broker endpoint for delayed index and rate files. */
export const SIX_REPORT_DOWNLOAD_URL = "https://indexdata.six-group.com/pro/api/report-download";
/** Public browser route used as the referer/origin context for delayed SARON downloads. */
export const SIX_SARON_COMPOUND_RATES_REFERER_URL =
  "https://indexdata.six-group.com/swiss_reference_rates/compound_rates.html";
/** Full delayed public CSV URL for the 3-month compounded SARON series (SAR3MC). */
export const SIX_SARON_3M_CSV_URL = "https://indexdata.six-group.com/download/saron/h_sar3mc_delayed.csv";
/** SIX guest token and report-download endpoints reject the Pharos UA; use a browser-compatible UA instead. */
export const SIX_BROWSER_USER_AGENT = "Mozilla/5.0";
/** Bank of England SONIA dataset CSV endpoint (base path; date filters added at runtime). */
export const BOE_SONIA_CSV_BASE_URL = "https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp";
/** Bank of Japan daily call-rate JSON endpoint (base path; query filters added at runtime). */
export const BOJ_CALL_RATE_JSON_BASE_URL = "https://www.stat-search.boj.or.jp/api/v1/getDataCode";
/** Reserve Bank of Australia F1 money-market CSV endpoint. */
export const RBA_F1_MONEY_MARKET_CSV_URL = "https://www.rba.gov.au/statistics/tables/csv/f1-data.csv";
/** Banxico SIE API — CETES 28-day primary auction yield (series SF43936). Requires Bmx-Token header. */
export const BANXICO_CETES_28D_URL = "https://www.banxico.org.mx/SieAPIRest/service/v1/series/SF43936/datos/oportuno";
/** Banco Central do Brasil SGS — SELIC over (series 11), latest daily observation as JSON. */
export const BCB_SELIC_URL = "https://api.bcb.gov.br/dados/serie/bcdata.sgs.11/dados/ultimos/1?formato=json";
/** Same effective SELIC over instrument, already annualized on a 252-business-day basis. */
export const BCB_SELIC_ANNUALIZED_URL = "https://api.bcb.gov.br/dados/serie/bcdata.sgs.1178/dados/ultimos/1?formato=json";
/** Bank of Canada Valet — overnight repo rate (V122530), latest observation as JSON. */
export const BOC_CORRA_URL = "https://www.bankofcanada.ca/valet/observations/V122530/json?recent=1";
/** Central Bank of Russia DailyInfo SOAP endpoint for KeyRateXML observations. */
export const CBR_DAILY_INFO_SOAP_URL = "https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx";
/** CBRT EVDS3 frontend data endpoint used for BIST TLREF benchmark observations. */
export const CBRT_EVDS_FE_URL = "https://evds3.tcmb.gov.tr/igmevdsms-dis/fe";
/** EVDS series code for BIST TLREF, the Turkish Lira Overnight Reference Rate. */
export const CBRT_TLREF_SERIES_CODE = "TP.BISTTLREF.ORAN";
export const BENCHMARK_FETCH_TIMEOUT_MS = 15_000;
export const BENCHMARK_FETCH_MAX_RETRIES = 2;


export interface BenchmarkResponseDiagnostic {
  status: number | null;
  contentType: string | null;
  bodyBytes: number;
  parsed: boolean;
  recordDate: string | null;
  failure: "transport-failed" | "http-status" | "empty-body" | "parse-failed" | "upstream-error"
    | "html-body" | "stale-record" | "future-record" | null;
  upstreamStatus?: number;
}
export interface BenchmarkProviderAttemptDiagnostic extends BenchmarkResponseDiagnostic {
  provider: string;
}
export type BenchmarkFetchResult = {
  rate: number;
  recordDate: string;
  source?: string;
  responseDiagnostics?: BenchmarkProviderAttemptDiagnostic[];
};
export interface BenchmarkFetchFailure {
  result: null;
  responseDiagnostics: BenchmarkProviderAttemptDiagnostic[];
}
export type BenchmarkProviderFetchOutcome = BenchmarkFetchResult | BenchmarkFetchFailure;
export type BenchmarkProviderKey = Exclude<YieldBenchmarkKey, "USD" | "SGD">;
export function parseRate(rateRaw: string | number | null | undefined): number {
  if (typeof rateRaw === "number") return rateRaw;
  if (typeof rateRaw !== "string") return Number.NaN;
  return parseFloat(rateRaw);
}

export function isValidBenchmarkRateForKey(key: YieldBenchmarkKey, rate: number): boolean {
  const maxRate = key === "TRY" || key === "RUB" ? 100 : 20;
  return Number.isFinite(rate) && rate >= -10 && rate <= maxRate;
}

export function isValidBenchmarkRate(rate: number): boolean {
  return isValidBenchmarkRateForKey("USD", rate);
}

export function parseEnglishDate(dateRaw: string): string | null {
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

export function parseIsoDateMs(recordDate: string): number {
  const parsed = Date.parse(`${recordDate}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function parseEuropeanDate(dateRaw: string): string | null {
  const match = dateRaw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

export function parseSlashDmyToIso(dateRaw: string): string | null {
  const match = dateRaw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

export function parseCompactDate(dateRaw: number | string | null | undefined): string | null {
  const value = String(dateRaw ?? "");
  const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

export async function fetchAndParseBenchmark<T>({
  url,
  headers,
  method = "GET",
  body,
  retries = BENCHMARK_FETCH_MAX_RETRIES,
  maxResponseBytes,
  parse,
  warnLabel,
  signal,
  onDiagnostic,
}: {
  url: string;
  headers: Record<string, string>;
  method?: string;
  body?: BodyInit | null;
  retries?: number;
  maxResponseBytes?: number;
  parse: (body: string) => T | null;
  warnLabel: string;
  signal?: AbortSignal;
  onDiagnostic?: (diagnostic: BenchmarkResponseDiagnostic) => void;
}): Promise<T | null> {
  try {
    const result = await fetchTextWithRetry(url, {
      method,
      headers,
      body: body ?? undefined,
      signal,
    }, retries, {
      timeoutMs: BENCHMARK_FETCH_TIMEOUT_MS,
      maxResponseBytes,
      returnFinalResponse: onDiagnostic != null,
    });

    if (!result) {
      onDiagnostic?.({
        status: null,
        contentType: null,
        bodyBytes: 0,
        parsed: false,
        recordDate: null,
        failure: "transport-failed",
      });
      return null;
    }

    const bodyBytes = new TextEncoder().encode(result.body).length;
    const contentType = result.response.headers.get("Content-Type")?.split(";")[0].trim().slice(0, 100) ?? null;
    if (!result.response.ok) {
      onDiagnostic?.({
        status: result.response.status,
        contentType,
        bodyBytes,
        parsed: false,
        recordDate: null,
        failure: "http-status",
      });
      return null;
    }

    if (bodyBytes === 0) {
      onDiagnostic?.({
        status: result.response.status,
        contentType,
        bodyBytes,
        parsed: false,
        recordDate: null,
        failure: "empty-body",
      });
      return null;
    }

    let parsed: T | null;
    try {
      parsed = parse(result.body);
    } catch (error) {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "benchmark_parse_failed",
        message: `${warnLabel} parse failed`,
        error,
      });
      onDiagnostic?.({
        status: result.response.status,
        contentType,
        bodyBytes,
        parsed: false,
        recordDate: null,
        failure: "parse-failed",
      });
      return null;
    }
    const recordDate = parsed != null && typeof parsed === "object" && "recordDate" in parsed
      && typeof parsed.recordDate === "string"
      ? parsed.recordDate
      : null;
    onDiagnostic?.({
      status: result.response.status,
      contentType,
      bodyBytes,
      parsed: parsed != null,
      recordDate,
      failure: parsed == null ? "parse-failed" : null,
    });
    return parsed;
  } catch (err) {
    rethrowIfAborted(err, signal);
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      job: "fetch-tbill-rate",
      event: "benchmark_fetch_failed",
      message: `${warnLabel} failed`,
      error: err,
    });
    onDiagnostic?.({
      status: null,
      contentType: null,
      bodyBytes: 0,
      parsed: false,
      recordDate: null,
      failure: "transport-failed",
    });
    return null;
  }
}
