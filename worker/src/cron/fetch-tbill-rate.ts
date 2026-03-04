import { fetchWithRetry } from "../lib/fetch-retry";
import { setCache } from "../lib/db";
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

export async function fetchTbillRate(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  if (!await shouldAttemptFetch(db, CIRCUIT_SOURCE.TREASURY_RATES)) {
    console.log("[fetch-tbill-rate] Circuit open, using fallback");
    await setCache(db, "risk_free_rate", String(RISK_FREE_RATE_FALLBACK));
    return {
      status: "degraded",
      metadata: buildMetadata({
        fallbackMode: "circuit-open",
        wroteRate: RISK_FREE_RATE_FALLBACK,
      }),
    };
  }

  try {
    const res = await fetchWithRetry(FRED_TBILL_CSV_URL, {
      headers: { "User-Agent": USER_AGENT },
      signal,
    }, FRED_FETCH_MAX_RETRIES, { timeoutMs: FRED_FETCH_TIMEOUT_MS });

    if (!res?.ok) {
      await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
      await setCache(db, "risk_free_rate", String(RISK_FREE_RATE_FALLBACK));
      return {
        status: "degraded",
        metadata: buildMetadata({
          fallbackMode: "fred-api-error",
          apiStatus: res?.status ?? null,
          wroteRate: RISK_FREE_RATE_FALLBACK,
        }),
      };
    }

    const csv = await res.text();
    const parsed = parseFredLatest(csv);
    if (!parsed) {
      await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
      await setCache(db, "risk_free_rate", String(RISK_FREE_RATE_FALLBACK));
      return {
        status: "degraded",
        metadata: buildMetadata({
          fallbackMode: "fred-invalid-data",
          wroteRate: RISK_FREE_RATE_FALLBACK,
        }),
      };
    }

    await setCache(db, "risk_free_rate", String(parsed.rate));
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
    await setCache(db, "risk_free_rate", String(RISK_FREE_RATE_FALLBACK));
    return {
      status: "degraded",
      metadata: buildMetadata({
        fallbackMode: "fred-exception",
        error: String(err).slice(0, 240),
        wroteRate: RISK_FREE_RATE_FALLBACK,
      }),
    };
  }
}
