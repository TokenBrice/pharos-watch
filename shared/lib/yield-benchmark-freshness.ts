import { YIELD_BENCHMARK_SCORE_TTL_SEC } from "./status-thresholds";
import { DAY_SECONDS } from "./time-constants";
import type { YieldBenchmarkKey, YieldBenchmarkSelectionMode } from "../types/yield";

export type YieldBenchmarkFreshness = "healthy" | "degraded" | "stale";

/**
 * Per-key bound on the age of a benchmark's own observation (`recordDate`).
 * A fetch that just succeeded says nothing about the data it carried: a frozen
 * or rewound upstream keeps returning an old CSV, and the fetch-age TTL alone
 * would stamp it as current market data forever. Bounds follow each series'
 * real publication calendar, not one size: daily/overnight series get five
 * days (a long weekend plus one failed run), keys whose calendars have
 * multi-day holiday clusters carry more (see per-key comments), and CAD is
 * the Bank of Canada's monthly announced Bank rate.
 */
export const YIELD_BENCHMARK_RECORD_MAX_AGE_SEC: Record<YieldBenchmarkKey, number> = {
  USD: 5 * DAY_SECONDS,
  USD_EFFR: 5 * DAY_SECONDS,
  EUR: 5 * DAY_SECONDS,
  // SAR3MC publishes T+1 and the Good Friday + Easter Monday cluster lands the
  // newest print exactly 5d old, tripping the daily bound every year.
  CHF: 7 * DAY_SECONDS,
  GBP: 5 * DAY_SECONDS,
  JPY: 5 * DAY_SECONDS,
  MXN: 5 * DAY_SECONDS,
  BRL: 5 * DAY_SECONDS,
  AUD: 5 * DAY_SECONDS,
  CAD: 45 * DAY_SECONDS,
  // CBR key-rate prints sit ~9-10 days old across every Jan 1-8 holiday cluster.
  RUB: 12 * DAY_SECONDS,
  // TCMB Kurban/Bayram holiday clusters can leave the newest print past 5d.
  TRY: 10 * DAY_SECONDS,
  SGD: 5 * DAY_SECONDS,
};

/**
 * Age of a benchmark's own observation at `nowSec`. `null` when the entry
 * carries no parseable observation date; a future-dated record clamps to zero,
 * mirroring the fetch-time guard (`worker/src/cron/tbill-sources/fred.ts`) that
 * rejects those rows before they are stored.
 */
export function benchmarkRecordAgeSeconds(
  recordDate: string | null | undefined,
  nowSec: number,
): number | null {
  if (!recordDate) return null;
  const recordTimestampMs = Date.parse(`${recordDate}T00:00:00Z`);
  if (!Number.isFinite(recordTimestampMs)) return null;
  return Math.max(0, nowSec - Math.floor(recordTimestampMs / 1000));
}

/**
 * Classify a registry entry from its own evidence: the hard 48h fetch-age TTL,
 * plus — when the caller supplies the key's observation bound — the age of the
 * observation the fetch carried. Both are `max`-combined; a future-dated
 * observation clamps to zero age here because the fetch-time guard
 * (`worker/src/cron/tbill-sources/fred.ts`) already rejects those rows before
 * they are stored. Shared so the API read path and the cron write path apply
 * one rule without crossing the worker api/cron import boundary.
 */
export function classifyYieldBenchmarkFreshness(meta: {
  ageSeconds: number | null;
  isFallback: boolean;
  fallbackMode: string | null;
}, options?: {
  selectionMode?: YieldBenchmarkSelectionMode | null;
  /** The benchmark's own observation date, as published on the registry entry. */
  recordDate?: string | null;
  /** Per-key bound, normally `YIELD_BENCHMARK_RECORD_MAX_AGE_SEC[key]`. */
  maxRecordAgeSec?: number | null;
}): YieldBenchmarkFreshness {
  if (
    meta.ageSeconds == null ||
    !Number.isFinite(meta.ageSeconds) ||
    meta.ageSeconds < 0 ||
    meta.ageSeconds > YIELD_BENCHMARK_SCORE_TTL_SEC
  ) {
    return "stale";
  }
  const maxRecordAgeSec = options?.maxRecordAgeSec;
  if (maxRecordAgeSec != null && Number.isFinite(maxRecordAgeSec)) {
    const recordAgeSec = benchmarkRecordAgeSeconds(options?.recordDate, Math.floor(Date.now() / 1000));
    if (recordAgeSec != null && recordAgeSec > maxRecordAgeSec) {
      return "stale";
    }
  }
  if (
    meta.isFallback ||
    meta.fallbackMode != null ||
    options?.selectionMode === "fallback-usd"
  ) {
    return "degraded";
  }
  return "healthy";
}
