import { fetchWithRetry } from "../../lib/fetch-retry";
import { BENCHMARK_FETCH_TIMEOUT_MS, BENCHMARK_FETCH_MAX_RETRIES } from "../../lib/constants";
import { rethrowIfAborted } from "../../lib/abort";
import { logWorkerEvent } from "../../lib/structured-log";
import type { YieldBenchmarkKey } from "@shared/types/yield";

export type BenchmarkFetchResult = { rate: number; recordDate: string };
export type BenchmarkProviderKey = Exclude<YieldBenchmarkKey, "USD" | "SGD">;
export type StandardBenchmarkProviderKey = Exclude<BenchmarkProviderKey, "MXN">;

export interface BenchmarkProvider {
  key: StandardBenchmarkProviderKey;
  fetch: (params: {
    signal?: AbortSignal;
  }) => Promise<BenchmarkFetchResult | null>;
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
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      job: "fetch-tbill-rate",
      event: "benchmark_fetch_failed",
      message: `${warnLabel} failed`,
      error: err,
    });
    return null;
  }
}
