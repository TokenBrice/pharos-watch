import { fetchTextWithRetry } from "../../lib/fetch-retry";
import { rethrowIfAborted } from "../../lib/abort";
import { logWorkerEvent } from "../../lib/structured-log";
import {
  SIX_BROWSER_USER_AGENT,
  SIX_OAUTH_TOKEN_URL,
  SIX_REPORT_DOWNLOAD_URL,
  SIX_SARON_3M_CSV_URL,
  SIX_SARON_COMPOUND_RATES_REFERER_URL,
  BENCHMARK_FETCH_TIMEOUT_MS,
  BENCHMARK_FETCH_MAX_RETRIES,
} from "../../lib/constants";
import { isValidBenchmarkRate, parseEuropeanDate, parseRate } from "./shared";

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
    const result = await fetchTextWithRetry(SIX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        ...buildSixGuestHeaders(),
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: "grant_type=client_credentials&client_id=default_consumer&scope=api_authentication",
      signal,
    }, BENCHMARK_FETCH_MAX_RETRIES, { timeoutMs: BENCHMARK_FETCH_TIMEOUT_MS });

    if (!result?.response.ok) {
      return null;
    }

    return parseSixOauthToken(result.body);
  } catch (err) {
    rethrowIfAborted(err, signal);
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      job: "fetch-tbill-rate",
      event: "benchmark_fetch_failed",
      source: "six_guest_token",
      message: "SIX guest token fetch failed",
      error: err,
    });
    return null;
  }
}

export async function trySixSar3mcCsv(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  const token = await trySixGuestToken(signal);
  if (!token) return null;

  try {
    const result = await fetchTextWithRetry(SIX_REPORT_DOWNLOAD_URL, {
      method: "POST",
      headers: {
        ...buildSixGuestHeaders(token),
        "Content-Type": "application/json;charset=UTF-8",
      },
      body: JSON.stringify({ furl: SIX_SARON_3M_CSV_URL }),
      signal,
    }, BENCHMARK_FETCH_MAX_RETRIES, { timeoutMs: BENCHMARK_FETCH_TIMEOUT_MS });

    if (!result?.response.ok) {
      return null;
    }

    const contentType = (result.response.headers.get("content-type") ?? "").toLowerCase();
    const body = result.body;
    if (contentType.includes("application/json")) {
      return null;
    }

    return parseSixSar3mcCsv(body);
  } catch (err) {
    rethrowIfAborted(err, signal);
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      job: "fetch-tbill-rate",
      event: "benchmark_fetch_failed",
      source: "six_sar3mc",
      message: "SIX SAR3MC fetch failed",
      error: err,
    });
    return null;
  }
}
