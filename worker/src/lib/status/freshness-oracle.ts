import { CRON_JOB_DEFINITIONS, type CronJobMeta } from "@shared/lib/cron-jobs";
import { runWithOverloadRetry } from "../d1-overload-retry";

export type FreshnessThreshold =
  | { multiplier: number }
  | { absoluteSec: number };

export interface FreshnessPolicy {
  watchAt: FreshnessThreshold;
  staleAt: FreshnessThreshold;
}

export interface ProducerFreshnessFact {
  job: string;
  lastSuccessAt: number | null;
  lastRunAt: number | null;
  expectedIntervalSec: number;
  lastStatus: string | null;
}

export interface FreshnessClassification {
  state: "fresh" | "watch" | "stale";
  ageSec: number | null;
  ratio: number | null;
  watchAtSec: number;
  staleAtSec: number;
}

interface ProducerFreshnessRow {
  job: string;
  last_success_at: number | null;
  last_run_at: number;
  last_status: string;
}

function resolveThresholdSec(
  threshold: FreshnessThreshold,
  expectedIntervalSec: number,
): number {
  return "absoluteSec" in threshold
    ? threshold.absoluteSec
    : threshold.multiplier * expectedIntervalSec;
}

/**
 * Classify producer evidence without prescribing a consumer policy. Boundary
 * values are inclusive, matching the legacy `age <= threshold` checks.
 */
export function classifyFreshness(
  fact: ProducerFreshnessFact,
  policy: FreshnessPolicy,
  nowSec: number,
): FreshnessClassification {
  const watchAtSec = resolveThresholdSec(policy.watchAt, fact.expectedIntervalSec);
  const staleAtSec = resolveThresholdSec(policy.staleAt, fact.expectedIntervalSec);
  if (watchAtSec < 0 || staleAtSec < watchAtSec) {
    throw new Error("freshness policy thresholds must be non-negative and ordered");
  }
  const ageSec = fact.lastSuccessAt == null
    || !Number.isFinite(fact.lastSuccessAt)
    || !Number.isFinite(nowSec)
    ? null
    : Math.max(0, nowSec - fact.lastSuccessAt);
  const ratio = ageSec == null || fact.expectedIntervalSec <= 0
    ? null
    : ageSec / fact.expectedIntervalSec;
  const state = ageSec == null || ageSec > staleAtSec
    ? "stale"
    : ageSec > watchAtSec
      ? "watch"
      : "fresh";
  return { state, ageSec, ratio, watchAtSec, staleAtSec };
}

/**
 * Load the latest run and latest successful/degraded run for every producer in
 * one D1 statement. Missing producers remain explicit facts with null clocks.
 */
export async function loadProducerFreshnessFacts(
  db: D1Database,
  _nowSec: number,
  definitions: readonly CronJobMeta[] = CRON_JOB_DEFINITIONS,
): Promise<ProducerFreshnessFact[]> {
  if (definitions.length === 0) return [];
  const jobs = definitions.map((definition) => definition.job);
  const placeholders = jobs.map(() => "?").join(", ");
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT job,
                started_at AS last_run_at,
                status AS last_status,
                last_success_at
           FROM (
             SELECT job,
                    started_at,
                    status,
                    MAX(CASE WHEN status IN ('ok', 'degraded') THEN started_at END)
                      OVER (PARTITION BY job) AS last_success_at,
                    ROW_NUMBER() OVER (
                      PARTITION BY job
                      ORDER BY started_at DESC, id DESC
                    ) AS row_number
               FROM cron_runs
              WHERE job IN (${placeholders})
           )
          WHERE row_number = 1`,
      )
      .bind(...jobs)
      .all<ProducerFreshnessRow>(),
  );
  const rowByJob = new Map((rows.results ?? []).map((row) => [row.job, row]));
  return definitions.map((definition) => {
    const row = rowByJob.get(definition.job);
    return {
      job: definition.job,
      lastSuccessAt: row?.last_success_at ?? null,
      lastRunAt: row?.last_run_at ?? null,
      expectedIntervalSec: definition.intervalSec,
      lastStatus: row?.last_status ?? null,
    };
  });
}
