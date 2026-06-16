import { CRON_INTERVALS, getCronStatusImpact } from "@shared/lib/cron-jobs";
import { flattenScheduledSlotPlanJobs, SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import { CronRunStatusSchema } from "@shared/types/status";
import type { CronEvent, CronInFlight, CronRun, CronStaleArtifact, CronStatus } from "@shared/types/status";
import { buildInClause } from "../db";
import { logWorkerEvent } from "../structured-log";

export interface CronHealthSnapshot {
  crons: Record<string, CronStatus>;
  unhealthyCrons: number;
  availabilityImpactingUnhealthyCrons: number;
  watchUnhealthyCrons: number;
  degradedCronRuns: number;
  cronErrorCount: number;
  availabilityImpactingCronErrors: number;
  /** Count of availability-critical crons whose most recent 2+ runs are all `error`. */
  availabilityImpactingConsecutiveCronErrors: number;
  staleCronArtifacts: number;
  expiredCronLeases: number;
  orphanedCronProgressRows: number;
  cronHistoryQueryFailed: boolean;
  cronProgressQueryFailed: boolean;
  cronLeaseQueryFailed: boolean;
}

const CRON_HISTORY_ROWS_PER_JOB = 10;
// D1's compound SELECT term limit is lower than upstream SQLite's default.
// Each per-job branch here contributes two SELECT terms because it wraps a
// latest-N subquery, so keep batches to five jobs or fewer.
const CRON_HISTORY_QUERY_JOB_BATCH_SIZE = 5;

const CRON_HISTORY_SELECT_COLUMNS = "job, started_at, duration_ms, status, error, item_count, metadata";
const STALE_SLOT_ABANDONED_EVENT_TYPE = "scheduled-slot-abandoned";

function cacheKeySegment(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9:-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || "unknown").slice(0, 96);
}

function staleSlotEventCacheKey(scheduleKey: string): string {
  return `cron:event:${cacheKeySegment(scheduleKey)}:${cacheKeySegment(STALE_SLOT_ABANDONED_EVENT_TYPE)}`;
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

function parseCronEvent(value: string | null | undefined): CronEvent | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      record.event !== "cron_event" ||
      typeof record.job !== "string" ||
      typeof record.eventType !== "string" ||
      (record.severity !== "info" && record.severity !== "warning" && record.severity !== "error") ||
      typeof record.message !== "string" ||
      typeof record.recordedAt !== "number" ||
      !Number.isFinite(record.recordedAt)
    ) {
      return null;
    }
    const metadata = record.metadata;
    return {
      event: "cron_event",
      job: record.job,
      eventType: record.eventType,
      severity: record.severity,
      message: record.message,
      ...(metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? { metadata: metadata as Record<string, unknown> }
        : {}),
      recordedAt: record.recordedAt,
    };
  } catch {
    return null;
  }
}

function numberFromMetadata(metadata: Record<string, unknown> | undefined, key: string): number {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function booleanFromMetadata(metadata: Record<string, unknown> | undefined, key: string): boolean {
  return metadata?.[key] === true;
}

function hasBlacklistMaintenanceDegradation(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  return (
    numberFromMetadata(metadata, "currentBalanceCacheFailed") > 0
    || numberFromMetadata(metadata, "enrichFailed") > 0
    || numberFromMetadata(metadata, "contractsSkipped") > 0
    || booleanFromMetadata(metadata, "runtimeBudgetReached")
    || booleanFromMetadata(metadata, "subrequestBudgetReached")
  );
}

function parseCronRunStatus(status: string): CronRun["status"] {
  const parsed = CronRunStatusSchema.safeParse(status);
  return parsed.success ? parsed.data : "error";
}

function buildCronHistoryQuery(jobCount: number): string {
  if (jobCount <= 0) {
    throw new Error("buildCronHistoryQuery: jobCount must be positive");
  }
  const perJobQueries = Array.from({ length: jobCount }, () => (
    `SELECT ${CRON_HISTORY_SELECT_COLUMNS}
       FROM (
         SELECT ${CRON_HISTORY_SELECT_COLUMNS}
           FROM cron_runs
          WHERE job = ?
          ORDER BY started_at DESC
          LIMIT ${CRON_HISTORY_ROWS_PER_JOB}
       )`
  ));

  return `SELECT ${CRON_HISTORY_SELECT_COLUMNS}
          FROM (
            ${perJobQueries.join("\n            UNION ALL\n            ")}
          )
          ORDER BY started_at DESC`;
}

function chunkCronJobs(jobs: string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < jobs.length; i += CRON_HISTORY_QUERY_JOB_BATCH_SIZE) {
    chunks.push(jobs.slice(i, i + CRON_HISTORY_QUERY_JOB_BATCH_SIZE));
  }
  return chunks;
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
    const results: NonNullable<typeof cronRows.results> = [];
    for (const jobBatch of chunkCronJobs(cronJobs)) {
      const batchJobSet = new Set(jobBatch);
      const batchRows = await db
        .prepare(buildCronHistoryQuery(jobBatch.length))
        .bind(...jobBatch)
        .all<{
          job: string;
          started_at: number;
          duration_ms: number;
          status: string;
          error: string | null;
          item_count: number | null;
          metadata: string | null;
        }>();
      results.push(...(batchRows.results ?? []).filter((row) => batchJobSet.has(row.job)));
    }
    results.sort((a, b) => b.started_at - a.started_at);
    cronRows = { results };
  } catch (err) {
    cronHistoryQueryFailed = true;
    logWorkerEvent({
      scope: "status",
      level: "error",
      event: "cron_history_query_failed",
      route: "status",
      source: "cron_runs",
      message: "Failed to query cron history",
      error: err,
    });
  }

  let cronProgressByJob = new Map<string, CronInFlight>();
  let cronProgressQueryFailed = false;
  let cronLeaseByJob: Map<string, { leaseOwner: string; leaseUntil: number }> | null = null;
  let cronLeaseRows: Array<{ job: string; lease_owner: string; lease_until: number }> = [];
  let cronLeaseQueryFailed = false;
  const staleArtifactsByJob = new Map<string, CronStaleArtifact[]>();
  const latestEventByJob = new Map<string, CronEvent>();

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

    cronLeaseRows = leaseRows.results ?? [];
    cronLeaseByJob = new Map(
      cronLeaseRows.map((row) => [row.job, {
        leaseOwner: row.lease_owner,
        leaseUntil: row.lease_until,
      }]),
    );
  } catch (err) {
    cronLeaseQueryFailed = true;
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "cron_leases_unavailable",
      route: "status",
      source: "cron_leases",
      message: "Cron leases unavailable",
      error: err,
    });
  }

  try {
    const progressRows = await db
      .prepare(
        `SELECT job, started_at, updated_at, stage, items_done, items_total, message, lease_owner, metadata, slot_started_at
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
        slot_started_at: number | null;
      }>();

    const progressArtifacts: CronStaleArtifact[] = [];
    const filteredProgressRows = (progressRows.results ?? []).filter((row) => {
      if (cronLeaseQueryFailed || cronLeaseByJob == null || !row.lease_owner) {
        return true;
      }

      const lease = cronLeaseByJob.get(row.job);
      const active = lease != null && lease.leaseOwner === row.lease_owner && lease.leaseUntil >= now;
      if (!active) {
        progressArtifacts.push({
          kind: "orphaned-progress",
          job: row.job,
          leaseOwner: row.lease_owner,
          ...(lease?.leaseUntil != null ? { leaseUntil: lease.leaseUntil } : {}),
          progressUpdatedAt: row.updated_at,
          ...(row.stage ? { progressStage: row.stage } : {}),
          slotStartedAt: row.slot_started_at,
        });
      }
      return active;
    });

    if (progressArtifacts.length > 0) {
      for (const artifact of progressArtifacts) {
        const artifacts = staleArtifactsByJob.get(artifact.job) ?? [];
        artifacts.push(artifact);
        staleArtifactsByJob.set(artifact.job, artifacts);
      }
    }

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
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "cron_run_progress_unavailable",
      route: "status",
      source: "cron_run_progress",
      message: "Cron run progress unavailable",
      error: err,
    });
  }

  if (!cronLeaseQueryFailed) {
    for (const lease of cronLeaseRows) {
      if (lease.lease_until >= now) continue;
      const artifacts = staleArtifactsByJob.get(lease.job) ?? [];
      artifacts.push({
        kind: "expired-lease",
        job: lease.job,
        leaseOwner: lease.lease_owner,
        leaseUntil: lease.lease_until,
      });
      staleArtifactsByJob.set(lease.job, artifacts);
    }
  }

  try {
    const scheduleKeys = Object.keys(SCHEDULED_SLOT_PLANS) as Array<keyof typeof SCHEDULED_SLOT_PLANS>;
    const eventKeys = scheduleKeys.map(staleSlotEventCacheKey);
    const eventKeyInClause = buildInClause(eventKeys);
    const scheduleKeyByEventKey = new Map(eventKeys.map((key, index) => [key, scheduleKeys[index]]));
    const eventRows = await db
      .prepare(
        `SELECT key, value, updated_at
           FROM cache
           WHERE key IN (${eventKeyInClause.sql})`,
      )
      .bind(...eventKeyInClause.binds)
      .all<{
        key: string;
        value: string | null;
        updated_at: number;
      }>();

    for (const row of eventRows.results ?? []) {
      const scheduleKey = scheduleKeyByEventKey.get(row.key);
      if (!scheduleKey) continue;
      const event = parseCronEvent(row.value);
      if (!event) continue;
      for (const job of flattenScheduledSlotPlanJobs(SCHEDULED_SLOT_PLANS[scheduleKey])) {
        const previous = latestEventByJob.get(job);
        if (!previous || previous.recordedAt < event.recordedAt) {
          latestEventByJob.set(job, event);
        }
      }
    }
  } catch (err) {
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "cron_slot_events_unavailable",
      route: "status",
      source: "cache",
      message: "Cron slot event markers unavailable",
      error: err,
    });
  }

  const cronByJob = new Map<string, CronRun[]>();
  for (const row of cronRows.results ?? []) {
    const runs = cronByJob.get(row.job) ?? [];
    if (runs.length < 10) {
      const parsedMeta = parseMetadataObject(row.metadata);
      const parsedStatus = parseCronRunStatus(row.status);
      runs.push({
        startedAt: row.started_at,
        durationMs: row.duration_ms,
        status: parsedStatus,
        ...(row.error ? { error: row.error } : {}),
        ...(row.item_count != null ? { itemCount: row.item_count } : {}),
        ...(parsedMeta || parsedStatus !== row.status
          ? { metadata: { ...(parsedMeta ?? {}), ...(parsedStatus !== row.status ? { rawStatus: row.status } : {}) } }
          : {}),
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
  let availabilityImpactingConsecutiveCronErrors = 0;
  let staleCronArtifacts = 0;
  let expiredCronLeases = 0;
  let orphanedCronProgressRows = 0;

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
    const statusImpact = getCronStatusImpact(job);
    const metadataDegraded =
      job === "sync-blacklist"
      && lastRun != null
      && isFresh
      && hasBlacklistMaintenanceDegradation(lastRun.metadata);
    // Bootstrap = never ran at all. For watch-tier crons (especially monthly
    // ones), a fresh install or a just-registered trigger legitimately has no
    // history yet; treating it as unhealthy produces a permanent false
    // positive. Critical-tier crons with no runs still count as unhealthy
    // because the system cannot credibly claim healthy operation without
    // them. Mirrors the reserveComposition.bootstrap pattern.
    const watchBootstrap = runs.length === 0 && statusImpact === "watch";
    const healthy = telemetryUnknown
      ? true
      : inFlightFresh || availabilityHealthyFromLastRun || watchBootstrap;
    const availabilityUnhealthy = !telemetryUnknown && !healthy;

    if (availabilityUnhealthy) {
      unhealthyCrons++;
      if (statusImpact === "critical") {
        availabilityImpactingUnhealthyCrons++;
      } else {
        watchUnhealthyCrons++;
      }
    }
    if (!telemetryUnknown && ((lastRun?.status === "degraded" && isFresh) || metadataDegraded)) {
      degradedCronRuns++;
    }
    if (!telemetryUnknown && lastRun?.status === "error" && !inFlightFresh) {
      cronErrorCount++;
      if (statusImpact === "critical") {
        availabilityImpactingCronErrors++;
      }
      // Consecutive-error streak: only counts if the two most-recent runs are
      // both in-error. Uses the already-loaded `runs` array (DESC by started_at,
      // capped at 10 per job). A single transient error surfaces as `degraded`
      // in deriveAvailabilityStatus; only 2+ consecutive escalate to `stale`.
      if (
        statusImpact === "critical"
        && runs.length >= 2
        && runs[0]?.status === "error"
        && runs[1]?.status === "error"
      ) {
        availabilityImpactingConsecutiveCronErrors++;
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
      ...(staleArtifactsByJob.has(job) ? { staleArtifacts: staleArtifactsByJob.get(job) } : {}),
      ...(latestEventByJob.has(job) ? { latestEvent: latestEventByJob.get(job) } : {}),
      ...(watchBootstrap ? { bootstrap: true } : {}),
    };

    for (const artifact of staleArtifactsByJob.get(job) ?? []) {
      staleCronArtifacts++;
      if (artifact.kind === "expired-lease") {
        expiredCronLeases++;
      } else {
        orphanedCronProgressRows++;
      }
    }
  }

  return {
    crons,
    unhealthyCrons,
    availabilityImpactingUnhealthyCrons,
    watchUnhealthyCrons,
    degradedCronRuns,
    cronErrorCount,
    availabilityImpactingCronErrors,
    availabilityImpactingConsecutiveCronErrors,
    staleCronArtifacts,
    expiredCronLeases,
    orphanedCronProgressRows,
    cronHistoryQueryFailed,
    cronProgressQueryFailed,
    cronLeaseQueryFailed,
  };
}
