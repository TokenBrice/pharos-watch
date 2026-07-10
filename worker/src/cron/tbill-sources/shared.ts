import { fetchTextWithRetry } from "../../lib/fetch-retry";
import { BENCHMARK_FETCH_TIMEOUT_MS, BENCHMARK_FETCH_MAX_RETRIES } from "../../lib/constants";
import { rethrowIfAborted } from "../../lib/abort";
import { logWorkerEvent } from "../../lib/structured-log";
import type { YieldBenchmarkKey } from "@shared/types/yield";

export interface BenchmarkResponseDiagnostic {
  status: number | null;
  contentType: string | null;
  bodyBytes: number;
  parsed: boolean;
  recordDate: string | null;
  failure: "transport-failed" | "http-status" | "empty-body" | "parse-failed" | null;
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
export type StandardBenchmarkProviderKey = Exclude<BenchmarkProviderKey, "MXN">;

export interface BenchmarkProvider {
  key: StandardBenchmarkProviderKey;
  fetch: (params: {
    signal?: AbortSignal;
  }) => Promise<BenchmarkProviderFetchOutcome | null>;
  source: string;
  fallbackMode: string;
}

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
    const contentType = result.response.headers.get("Content-Type");
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
        level: "warn",
        code: "benchmark_parse_failed",
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
