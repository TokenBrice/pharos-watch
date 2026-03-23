import { fetchWithRetry } from "../lib/fetch-retry";
import { getCache, setCache } from "../lib/db-cache";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import {
  RISK_FREE_RATE_FALLBACK,
  CIRCUIT_SOURCE,
  USER_AGENT,
  FRED_TBILL_CSV_URL,
  TREASURY_YIELD_XML_URL,
  FRED_FETCH_TIMEOUT_MS,
  FRED_FETCH_MAX_RETRIES,
} from "../lib/constants";
import type { CronResult } from "../lib/cron-logger";
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

/** Parse the latest 3-month yield from Treasury.gov yield curve XML. */
export function parseTreasuryYieldXml(xml: string): { recordDate: string; rate: number } | null {
  const blockPattern =
    /<G_NEW_DATE>[\s\S]*?<BC_3MONTH>([\d.]+)<\/BC_3MONTH>[\s\S]*?<NEW_DATE>([\d/-]+)<\/NEW_DATE>[\s\S]*?<\/G_NEW_DATE>/g;
  let lastRate: number | null = null;
  let lastDateRaw: string | null = null;

  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(xml)) !== null) {
    const rate = parseFloat(match[1]);
    if (isValidRate(rate)) {
      lastRate = rate;
      lastDateRaw = match[2];
    }
  }

  if (lastRate == null || lastDateRaw == null) return null;

  // Convert MM-DD-YYYY to YYYY-MM-DD
  const parts = lastDateRaw.split("-");
  if (parts.length !== 3) return null;
  const recordDate = `${parts[2]}-${parts[0]}-${parts[1]}`;

  return { recordDate, rate: lastRate };
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
  if (previous?.lastMarketRate != null && previous.lastMarketSource && previous.lastMarketSource !== "hardcoded-fallback") {
    console.log(`[fetch-tbill-rate] ${fallbackMode}, retaining last known good rate`);
    await writeStructuredBenchmark(db, {
      rate: previous.lastMarketRate,
      recordDate: previous.lastMarketRecordDate,
      fetchedAt: previous.lastMarketFetchedAt,
      source: previous.lastMarketSource,
      isFallback: true,
      fallbackMode: `${fallbackMode}-retained`,
      lastMarketRate: previous.lastMarketRate,
      lastMarketRecordDate: previous.lastMarketRecordDate,
      lastMarketFetchedAt: previous.lastMarketFetchedAt,
      lastMarketSource: previous.lastMarketSource,
    });
    return {
      status: "degraded",
      metadata: buildMetadata({
        fallbackMode: `${fallbackMode}-retained`,
        wroteRate: previous.lastMarketRate,
        recordDate: previous.lastMarketRecordDate,
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
    lastMarketRate: previous?.lastMarketRate ?? null,
    lastMarketRecordDate: previous?.lastMarketRecordDate ?? null,
    lastMarketFetchedAt: previous?.lastMarketFetchedAt ?? null,
    lastMarketSource: previous?.lastMarketSource ?? null,
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

async function tryFredCsv(signal?: AbortSignal): Promise<{ rate: number; recordDate: string } | null> {
  try {
    const res = await fetchWithRetry(FRED_TBILL_CSV_URL, {
      headers: { "User-Agent": USER_AGENT },
      signal,
    }, FRED_FETCH_MAX_RETRIES, { timeoutMs: FRED_FETCH_TIMEOUT_MS });

    if (!res?.ok) {
      console.warn(`[fetch-tbill-rate] FRED CSV returned ${res?.status ?? "null"}`);
      return null;
    }

    const csv = await res.text();
    return parseFredLatest(csv);
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
      console.warn(`[fetch-tbill-rate] Treasury XML returned ${res?.status ?? "null"}`);
      return null;
    }

    const xml = await res.text();
    return parseTreasuryYieldXml(xml);
  } catch (err) {
    console.warn(`[fetch-tbill-rate] Treasury XML failed: ${String(err).slice(0, 200)}`);
    return null;
  }
}

export async function fetchTbillRate(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  if (!await shouldAttemptFetch(db, CIRCUIT_SOURCE.TREASURY_RATES)) {
    return handleDegradedFallback(db, "circuit-open");
  }

  // Try FRED CSV first, then Treasury yield XML as fallback.
  const fredResult = await tryFredCsv(signal);
  const source = fredResult ? "fred-dgs3mo" : null;
  const parsed = fredResult ?? await tryTreasuryXml(signal);
  const effectiveSource = source ?? (parsed ? "treasury-yield-xml" : null);

  if (!parsed || !effectiveSource) {
    await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
    return handleDegradedFallback(db, "all-sources-failed");
  }

  const fetchedAt = Math.floor(Date.now() / 1000);
  await writeStructuredBenchmark(db, {
    rate: parsed.rate,
    recordDate: parsed.recordDate,
    fetchedAt,
    source: effectiveSource,
    isFallback: false,
    fallbackMode: null,
    lastMarketRate: parsed.rate,
    lastMarketRecordDate: parsed.recordDate,
    lastMarketFetchedAt: fetchedAt,
    lastMarketSource: effectiveSource,
  });
  await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, true);
  console.log(`[fetch-tbill-rate] ${effectiveSource}: ${parsed.rate}% (as of ${parsed.recordDate})`);
  return {
    status: "ok",
    itemCount: 1,
    metadata: buildMetadata({
      fallbackMode: source ? null : "fred-failed-treasury-ok",
      source: effectiveSource,
      rate: parsed.rate,
      recordDate: parsed.recordDate,
    }),
  };
}
