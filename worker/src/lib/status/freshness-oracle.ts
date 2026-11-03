import { CRON_JOB_DEFINITIONS, type CronJobMeta } from "@shared/lib/cron-jobs";
import { runWithOverloadRetry } from "../d1-overload-retry";
import {
  CONFIRMED_CRON_OUTPUT_AT_SQL,
  confirmedCronOutputReachesSql,
  newestConfirmedCronOutputSql,
} from "../cron-output";
import { assessFreshnessTimestamp, type FreshnessTimestampReason } from "../api-freshness-age";

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
  /** Newest `started_at` of a completed (non-`not_started`) run. */
  lastLivenessAt?: number | null;
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
  timestampReason: FreshnessTimestampReason | null;
}

interface ProducerFreshnessRow {
  job: string;
  last_success_at: number | null;
  last_liveness_at: number | null;
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
  clock: { readAtSec?: number; allowedFutureSkewSec?: number } = {},
): FreshnessClassification {
  const watchAtSec = resolveThresholdSec(policy.watchAt, fact.expectedIntervalSec);
  const staleAtSec = resolveThresholdSec(policy.staleAt, fact.expectedIntervalSec);
  if (watchAtSec < 0 || staleAtSec < watchAtSec) {
    throw new Error("freshness policy thresholds must be non-negative and ordered");
  }
  const timestamp = assessFreshnessTimestamp(
    clock.readAtSec ?? nowSec, fact.lastSuccessAt, clock.allowedFutureSkewSec,
  );
  const timestampReason = Number.isFinite(nowSec) ? timestamp.reason : "invalid-timestamp";
  const ageSec = timestampReason == null ? Math.max(0, nowSec - fact.lastSuccessAt!) : null;
  const ratio = ageSec == null || fact.expectedIntervalSec <= 0
    ? null
    : ageSec / fact.expectedIntervalSec;
  const state = ageSec == null || ageSec > staleAtSec
    ? "stale"
    : ageSec > watchAtSec
      ? "watch"
      : "fresh";
  return { state, ageSec, ratio, watchAtSec, staleAtSec, timestampReason };
}

/**
 * Load the latest attempt and latest confirmed output clock for every producer in
 * one D1 statement. Missing or unproven output remains an explicit null clock.
 * Every per-job read is an index seek or a floor-pruned range: parsing each job's
 * whole retained metadata here took 3-4 s per call and overloaded D1 (2026-11-03).
 */
export async function loadProducerFreshnessFacts(
  db: D1Database,
  _nowSec: number,
  definitions: readonly CronJobMeta[] = CRON_JOB_DEFINITIONS,
): Promise<ProducerFreshnessFact[]> {
  if (definitions.length === 0) return [];
  const jobs = definitions.map((definition) => definition.job);
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `WITH requested(job) AS (SELECT value FROM json_each(?1)),
         floors AS MATERIALIZED (
           SELECT requested.job AS job, ${newestConfirmedCronOutputSql("requested.job")} AS floor_at
             FROM requested
         )
         SELECT floors.job AS job,
                (SELECT latest.started_at FROM cron_runs AS latest WHERE latest.job = floors.job
                  ORDER BY latest.started_at DESC, latest.id DESC LIMIT 1) AS last_run_at,
                (SELECT latest.status FROM cron_runs AS latest WHERE latest.job = floors.job
                  ORDER BY latest.started_at DESC, latest.id DESC LIMIT 1) AS last_status,
                (SELECT MAX(${CONFIRMED_CRON_OUTPUT_AT_SQL}) FROM cron_runs
                  WHERE cron_runs.job = floors.job
                    AND ${confirmedCronOutputReachesSql("floors.floor_at")}) AS last_success_at,
                (SELECT live.started_at FROM cron_runs AS live
                  WHERE live.job = floors.job AND live.status IN ('ok', 'degraded')
                    AND COALESCE(json_extract(
                      CASE WHEN json_valid(live.metadata) THEN live.metadata ELSE '{}' END,
                      '$.childDisposition'
                    ), '') != 'not_started'
                  ORDER BY live.started_at DESC LIMIT 1) AS last_liveness_at
           FROM floors`,
      )
      .bind(JSON.stringify(jobs))
      .all<ProducerFreshnessRow>(),
  );
  const rowByJob = new Map((rows.results ?? []).map((row) => [row.job, row]));
  return definitions.map((definition) => {
    const row = rowByJob.get(definition.job);
    return {
      job: definition.job,
      lastSuccessAt: row?.last_success_at ?? null,
      lastLivenessAt: row?.last_liveness_at ?? null,
      lastRunAt: row?.last_run_at ?? null,
      expectedIntervalSec: definition.intervalSec,
      lastStatus: row?.last_status ?? null,
    };
  });
}
