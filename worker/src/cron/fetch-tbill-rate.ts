import { fetchWithRetry } from "../lib/fetch-retry";
import { getCache, setCache } from "../lib/db";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import {
  RISK_FREE_RATE_FALLBACK,
  CIRCUIT_SOURCE,
  USER_AGENT,
  FRED_TBILL_CSV_URL,
  FRED_FETCH_TIMEOUT_MS,
  FRED_FETCH_MAX_RETRIES,
} from "../lib/constants";
import type { CronResult } from "../lib/db";
import {
  buildRiskFreeRateCachePayload,
  parseRiskFreeRateCache,
  serializeRiskFreeRateCache,
} from "./yield-sync/cache";

function buildMetadata(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

function parseRate(rateRaw: string | number | null | undefined): number {
  if (typeof rateRaw === "number") return rateRaw;
  if (typeof rateRaw !== "string") return Number.NaN;
  return parseFloat(rateRaw);
}

function isValidRate(rate: number): boolean {
  return Number.isFinite(rate) && rate >= 0 && rate <= 20;
}

function parseFredLatest(csv: string): { recordDate: string; rate: number } | null {
  const lines = csv.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const [recordDate, rateRaw] = line.split(",");
    if (!recordDate || !rateRaw) continue;
    const rate = parseRate(rateRaw);
    if (!isValidRate(rate)) continue;
    return { recordDate, rate };
  }
  return null;
}

async function loadPreviousBenchmark(db: D1Database) {
  const cached = await getCache(db, "risk_free_rate");
  if (!cached) return null;
  return parseRiskFreeRateCache(cached.value, cached.updatedAt);
}

async function writeStructuredBenchmark(
  db: D1Database,
  fields: Parameters<typeof buildRiskFreeRateCachePayload>[0],
) {
  await setCache(db, "risk_free_rate", serializeRiskFreeRateCache(buildRiskFreeRateCachePayload(fields)));
}

async function handleDegradedFallback(
  db: D1Database,
  fallbackMode: string,
  extraMeta?: Record<string, unknown>,
): Promise<CronResult> {
  const previous = await loadPreviousBenchmark(db);
  if (previous && !previous.isFallback) {
    console.log(`[fetch-tbill-rate] ${fallbackMode}, retaining last known good rate`);
    await writeStructuredBenchmark(db, {
      rate: previous.rate,
      recordDate: previous.recordDate,
      fetchedAt: previous.fetchedAt,
      source: previous.source,
      isFallback: false,
      fallbackMode: `${fallbackMode}-retained`,
    });
    return {
      status: "degraded",
      metadata: buildMetadata({
        fallbackMode: `${fallbackMode}-retained`,
        wroteRate: previous.rate,
        recordDate: previous.recordDate,
        ...extraMeta,
      }),
    };
  }

  console.log(`[fetch-tbill-rate] ${fallbackMode}, using hardcoded fallback`);
  await writeStructuredBenchmark(db, {
    rate: RISK_FREE_RATE_FALLBACK,
    recordDate: null,
    fetchedAt: null,
    source: "hardcoded-fallback",
    isFallback: true,
    fallbackMode,
  });
  return {
    status: "degraded",
    metadata: buildMetadata({
      fallbackMode,
      wroteRate: RISK_FREE_RATE_FALLBACK,
      ...extraMeta,
    }),
  };
}

export async function fetchTbillRate(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  if (!await shouldAttemptFetch(db, CIRCUIT_SOURCE.TREASURY_RATES)) {
    return handleDegradedFallback(db, "circuit-open");
  }

  try {
    const res = await fetchWithRetry(FRED_TBILL_CSV_URL, {
      headers: { "User-Agent": USER_AGENT },
      signal,
    }, FRED_FETCH_MAX_RETRIES, { timeoutMs: FRED_FETCH_TIMEOUT_MS });

    if (!res?.ok) {
      await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
      return handleDegradedFallback(db, "fred-api-error", { apiStatus: res?.status ?? null });
    }

    const csv = await res.text();
    const parsed = parseFredLatest(csv);
    if (!parsed) {
      await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
      return handleDegradedFallback(db, "fred-invalid-data");
    }

    await writeStructuredBenchmark(db, {
      rate: parsed.rate,
      recordDate: parsed.recordDate,
      fetchedAt: Math.floor(Date.now() / 1000),
      source: "fred-dgs3mo",
      isFallback: false,
      fallbackMode: null,
    });
    await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, true);
    console.log(`[fetch-tbill-rate] FRED DGS3MO: ${parsed.rate}% (as of ${parsed.recordDate})`);
    return {
      status: "ok",
      itemCount: 1,
      metadata: buildMetadata({
        fallbackMode: null,
        source: "fred-dgs3mo",
        rate: parsed.rate,
        recordDate: parsed.recordDate,
      }),
    };
  } catch (err) {
    await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
    return handleDegradedFallback(db, "fred-exception", { error: String(err).slice(0, 240) });
  }
}
