import { CRON_INTERVALS, getCronStatusImpact } from "@shared/lib/cron-jobs";
import type { CronInFlight, CronRun, CronStatus } from "@shared/types/status";
import { buildInClause } from "../db";

export interface CronHealthSnapshot {
  crons: Record<string, CronStatus>;
  unhealthyCrons: number;
  availabilityImpactingUnhealthyCrons: number;
  watchUnhealthyCrons: number;
  degradedCronRuns: number;
  cronErrorCount: number;
  availabilityImpactingCronErrors: number;
  cronHistoryQueryFailed: boolean;
  cronProgressQueryFailed: boolean;
}

function parseMetadataObject(value: string | null | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export async function loadCronHealth(
  db: D1Database,
  now: number,
): Promise<CronHealthSnapshot> {
  const cronJobs = Object.keys(CRON_INTERVALS);
  const cronJobInClause = buildInClause(cronJobs);
  let cronRows: { results?: Array<{
    job: string;
    started_at: number;
    duration_ms: number;
    status: string;
    error: string | null;
    item_count: number | null;
    metadata: string | null;
  }> } = { results: [] };
  let cronHistoryQueryFailed = false;

  try {
    cronRows = await db
      .prepare(
        `SELECT job, started_at, duration_ms, status, error, item_count, metadata
         FROM (
           SELECT job, started_at, duration_ms, status, error, item_count, metadata,
                  ROW_NUMBER() OVER (PARTITION BY job ORDER BY started_at DESC) AS rn
           FROM cron_runs
           WHERE job IN (${cronJobInClause.sql})
         )
         WHERE rn <= 10
         ORDER BY started_at DESC`,
      )
      .bind(...cronJobInClause.binds)
      .all<{
        job: string;
        started_at: number;
        duration_ms: number;
        status: string;
        error: string | null;
        item_count: number | null;
        metadata: string | null;
      }>();
  } catch (err) {
    cronHistoryQueryFailed = true;
    console.error("[status] Failed to query cron history:", err);
  }

  let cronProgressByJob = new Map<string, CronInFlight>();
  let cronProgressQueryFailed = false;
  let cronLeaseByJob: Map<string, { leaseOwner: string; leaseUntil: number }> | null = null;
  let cronLeaseQueryFailed = false;

  try {
    const leaseRows = await db
      .prepare(
        `SELECT job, lease_owner, lease_until
           FROM cron_leases
           WHERE job IN (${cronJobInClause.sql})`,
      )
      .bind(...cronJobInClause.binds)
      .all<{
        job: string;
        lease_owner: string;
        lease_until: number;
      }>();

    cronLeaseByJob = new Map(
      (leaseRows.results ?? []).map((row) => [row.job, {
        leaseOwner: row.lease_owner,
        leaseUntil: row.lease_until,
      }]),
    );
  } catch (err) {
    cronLeaseQueryFailed = true;
    console.warn("[status] cron_leases unavailable:", err);
  }

  try {
    const progressRows = await db
      .prepare(
        `SELECT job, started_at, updated_at, stage, items_done, items_total, message, lease_owner, metadata
           FROM cron_run_progress
           WHERE job IN (${cronJobInClause.sql})`,
      )
      .bind(...cronJobInClause.binds)
      .all<{
        job: string;
        started_at: number;
        updated_at: number;
        stage: string | null;
        items_done: number | null;
        items_total: number | null;
        message: string | null;
        lease_owner: string | null;
        metadata: string | null;
      }>();

    const filteredProgressRows = (progressRows.results ?? []).filter((row) => {
      if (cronLeaseQueryFailed || cronLeaseByJob == null || !row.lease_owner) {
        return true;
      }

      const lease = cronLeaseByJob.get(row.job);
      return lease != null && lease.leaseOwner === row.lease_owner && lease.leaseUntil >= now;
    });

    cronProgressByJob = new Map(
      filteredProgressRows.map((row) => {
        const parsedMeta = parseMetadataObject(row.metadata);

        return [row.job, {
          startedAt: row.started_at,
          updatedAt: row.updated_at,
          ...(row.stage ? { stage: row.stage } : {}),
          ...(row.items_done != null ? { itemsDone: row.items_done } : {}),
          ...(row.items_total != null ? { itemsTotal: row.items_total } : {}),
          ...(row.message ? { message: row.message } : {}),
          ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
          ...(parsedMeta ? { metadata: parsedMeta } : {}),
          stale: false,
        } satisfies CronInFlight];
      }),
    );
  } catch (err) {
    cronProgressQueryFailed = true;
    console.warn("[status] cron_run_progress unavailable:", err);
  }

  const cronByJob = new Map<string, CronRun[]>();
  for (const row of cronRows.results ?? []) {
    const runs = cronByJob.get(row.job) ?? [];
    if (runs.length < 10) {
      const parsedMeta = parseMetadataObject(row.metadata);
      runs.push({
        startedAt: row.started_at,
        durationMs: row.duration_ms,
        status: row.status,
        ...(row.error ? { error: row.error } : {}),
        ...(row.item_count != null ? { itemCount: row.item_count } : {}),
        ...(parsedMeta ? { metadata: parsedMeta } : {}),
      });
      cronByJob.set(row.job, runs);
    }
  }

  const crons: Record<string, CronStatus> = {};
  let unhealthyCrons = 0;
  let availabilityImpactingUnhealthyCrons = 0;
  let watchUnhealthyCrons = 0;
  let degradedCronRuns = 0;
  let cronErrorCount = 0;
  let availabilityImpactingCronErrors = 0;

  for (const [job, interval] of Object.entries(CRON_INTERVALS)) {
    const runs = cronByJob.get(job) ?? [];
    const lastRun = runs.length > 0 ? runs[0] : null;
    const inFlight = cronProgressByJob.get(job);
    const telemetryUnknown = cronHistoryQueryFailed;
    const inFlightFresh = inFlight != null && now - inFlight.updatedAt <= Math.max(300, interval);
    const isFresh = lastRun != null && now - lastRun.startedAt <= interval * 2;
    const hasFreshOk = runs.some((run) => run.status === "ok" && now - run.startedAt <= interval * 2);
    const availabilityHealthyFromLastRun =
      isFresh &&
      lastRun != null &&
      (lastRun.status === "ok" ||
        lastRun.status === "degraded" ||
        (lastRun.status === "skipped_locked" && hasFreshOk));
    const healthy = telemetryUnknown ? true : inFlightFresh || availabilityHealthyFromLastRun;
    const availabilityUnhealthy = !telemetryUnknown && !healthy;
    const statusImpact = getCronStatusImpact(job);

    if (availabilityUnhealthy) {
      unhealthyCrons++;
      if (statusImpact === "critical") {
        availabilityImpactingUnhealthyCrons++;
      } else {
        watchUnhealthyCrons++;
      }
    }
    if (!telemetryUnknown && lastRun?.status === "degraded" && isFresh) degradedCronRuns++;
    if (!telemetryUnknown && lastRun?.status === "error" && !inFlightFresh) {
      cronErrorCount++;
      if (statusImpact === "critical") {
        availabilityImpactingCronErrors++;
      }
    }

    crons[job] = {
      lastRun,
      recentRuns: runs,
      expectedIntervalSec: interval,
      healthy,
      telemetryUnknown,
      inFlight: (() => {
        if (!inFlight) return null;
        return {
          ...inFlight,
          stale: now - inFlight.updatedAt > Math.max(300, interval),
        };
      })(),
    };
  }

  return {
    crons,
    unhealthyCrons,
    availabilityImpactingUnhealthyCrons,
    watchUnhealthyCrons,
    degradedCronRuns,
    cronErrorCount,
    availabilityImpactingCronErrors,
    cronHistoryQueryFailed,
    cronProgressQueryFailed,
  };
}
