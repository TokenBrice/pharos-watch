import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { getPsiDailySampleBudget } from "@shared/lib/psi-policy";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { throwIfAborted, rethrowIfAborted } from "../lib/abort";
import { runWithOverloadRetry } from "../lib/d1-overload-retry";
import { parseJson } from "../lib/json-parse";

/**
 * Coverage evidence for the daily PSI aggregate. The daily writer publishes a
 * valid average over whatever samples exist; this observation turns a partial
 * day into a named operator condition instead of trusting the row's presence.
 */
export type PsiDailyCoverageStatus =
  | "ok"
  | "shortfall"
  | "not-due"
  | "missing"
  | "legacy"
  | "read-failed";

export interface PsiDailyCoverageObservation {
  status: PsiDailyCoverageStatus;
  /** Midnight-keyed day the aggregate covers; null before the first due slot. */
  computedAt: number | null;
  sampleCount: number | null;
  expectedSampleCount: number;
  minimumSampleCount: number;
  reason: string | null;
}

interface DailyPsiRow {
  computed_at: number;
  input_snapshot: string | null;
}

export async function loadPsiDailyCoverage(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
): Promise<PsiDailyCoverageObservation> {
  const budget = getPsiDailySampleBudget(CRON_INTERVALS["stability-index"]);
  const todayMidnight = bucketUnixSecondsToUtcDay(nowSec);
  const dueAt = todayMidnight + CRON_SCHEDULE_CADENCES.daily0800Utc.offsetSec;
  const expectedComputedAt = todayMidnight - DAY_SECONDS;
  if (nowSec < dueAt) {
    return {
      status: "not-due",
      computedAt: null,
      sampleCount: null,
      ...budget,
      reason: "before-daily-slot",
    };
  }

  let row: DailyPsiRow | null;
  try {
    row = await runWithOverloadRetry(
      () => db
        .prepare("SELECT computed_at, input_snapshot FROM stability_index WHERE computed_at = ? LIMIT 1")
        .bind(expectedComputedAt)
        .first<DailyPsiRow>(),
      3,
      signal,
    );
  } catch (error) {
    rethrowIfAborted(error, signal);
    return {
      status: "read-failed",
      computedAt: expectedComputedAt,
      sampleCount: null,
      ...budget,
      reason: "stability-index-read-failed",
    };
  }
  throwIfAborted(signal);
  if (!row) {
    // Absence belongs to the producer-staleness lane, not a coverage finding;
    // the caller retains prior coverage state rather than claiming recovery.
    return {
      status: "missing",
      computedAt: expectedComputedAt,
      sampleCount: null,
      ...budget,
      reason: "daily-row-missing",
    };
  }

  const parsed = parseJson(row.input_snapshot);
  const sampleCount = parsed.ok && parsed.value != null && typeof parsed.value === "object"
    && "sampleCount" in parsed.value
    ? Number((parsed.value as { sampleCount?: unknown }).sampleCount)
    : Number.NaN;
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 0) {
    return {
      status: "legacy",
      computedAt: row.computed_at,
      sampleCount: null,
      ...budget,
      reason: "sample-count-unavailable",
    };
  }
  return {
    status: sampleCount < budget.minimumSampleCount ? "shortfall" : "ok",
    computedAt: row.computed_at,
    sampleCount,
    ...budget,
    reason: sampleCount < budget.minimumSampleCount ? "sample-count-below-floor" : null,
  };
}
