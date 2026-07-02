import { CRON_INTERVALS, getCronStatusImpact } from "@shared/lib/cron-jobs";
import { flattenScheduledSlotPlanJobs, SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import { CronRunStatusSchema } from "@shared/types/status";
import type { CronEvent, CronInFlight, CronRun, CronStaleArtifact, CronStatus } from "@shared/types/status";
import { staleSlotEventCacheKey } from "../cron-lease";
import { buildInClause } from "../db";
import { loadWorkerJobAttemptHealth } from "../job-ledger";
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
  activeJobAttempts: number;
  staleJobAttempts: number;
  cronHistoryQueryFailed: boolean;
  cronProgressQueryFailed: boolean;
  cronLeaseQueryFailed: boolean;
  jobAttemptQueryFailed: boolean;
  scheduledSlots: ScheduledSlotHealthSummary;
}

export interface ScheduledSlotHealthSummary {
  runningSlots: number;
  staleCandidateSlots: number;
  oldestRunningAgeSec: number | null;
  oldestStaleAgeSec: number | null;
  queryFailed: boolean;
}

const CRON_HISTORY_ROWS_PER_JOB = 10;
// D1's compound SELECT term limit is lower than upstream SQLite's default.
// Each per-job branch here contributes two SELECT terms because it wraps a
// latest-N subquery, so keep batches to five jobs or fewer.
const CRON_HISTORY_QUERY_JOB_BATCH_SIZE = 5;

const CRON_HISTORY_SELECT_COLUMNS = "job, started_at, duration_ms, status, error, item_count, metadata";

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

function isFreshCronRun(run: CronRun | null | undefined, now: number, interval: number): run is CronRun {
  return run != null && now - run.startedAt <= interval * 2;
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

interface CronHistoryRow {
  job: string;
  started_at: number;
  duration_ms: number;
  status: string;
  error: string | null;
  item_count: number | null;
  metadata: string | null;
}

interface CronLeaseRow {
  job: string;
  lease_owner: string;
  lease_until: number;
}

interface CronProgressRow {
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
}

interface CronSlotEventRow {
  key: string;
  value: string | null;
  updated_at: number;
}

interface RunningCronSlotRow {
  slot_key: string;
  slot_started_at: number;
  execution_owner: string;
  started_at: number;
  updated_at: number;
}

const STATUS_RUNNING_SLOT_STALE_CANDIDATE_SEC = 35 * 60;

async function fetchCronHistoryRows(
  db: D1Database,
  cronJobs: string[],
): Promise<{ rows: CronHistoryRow[]; failed: boolean }> {
  try {
    // Each batch is an independent SELECT, so fire all batches concurrently
    // rather than awaiting them in sequence; D1's HTTP/2 connection is
    // multiplexed and this avoids serialising N batch round-trips.
    const batches = chunkCronJobs(cronJobs);
    const batchResults = await Promise.all(
      batches.map(async (jobBatch) => {
        const batchJobSet = new Set(jobBatch);
        const batchRows = await db
          .prepare(buildCronHistoryQuery(jobBatch.length))
          .bind(...jobBatch)
          .all<CronHistoryRow>();
        return (batchRows.results ?? []).filter((row) => batchJobSet.has(row.job));
      }),
    );
    const rows = batchResults.flat();
    rows.sort((a, b) => b.started_at - a.started_at);
    return { rows, failed: false };
  } catch (err) {
    logWorkerEvent({
      scope: "status",
      level: "error",
      event: "cron_history_query_failed",
      route: "status",
      source: "cron_runs",
      message: "Failed to query cron history",
      error: err,
    });
    return { rows: [], failed: true };
  }
}

async function fetchCronLeaseRows(
  db: D1Database,
  cronJobInClause: { sql: string; binds: unknown[] },
): Promise<{ rows: CronLeaseRow[]; failed: boolean }> {
  try {
    const leaseRows = await db
      .prepare(
        `SELECT job, lease_owner, lease_until
           FROM cron_leases
           WHERE job IN (${cronJobInClause.sql})`,
      )
      .bind(...cronJobInClause.binds)
      .all<CronLeaseRow>();
    return { rows: leaseRows.results ?? [], failed: false };
  } catch (err) {
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "cron_leases_unavailable",
      route: "status",
      source: "cron_leases",
      message: "Cron leases unavailable",
      error: err,
    });
    return { rows: [], failed: true };
  }
}

async function fetchCronProgressRows(
  db: D1Database,
  cronJobInClause: { sql: string; binds: unknown[] },
): Promise<{ rows: CronProgressRow[]; failed: boolean }> {
  try {
    const progressRows = await db
      .prepare(
        `SELECT job, started_at, updated_at, stage, items_done, items_total, message, lease_owner, metadata, slot_started_at
           FROM cron_run_progress
           WHERE job IN (${cronJobInClause.sql})`,
      )
      .bind(...cronJobInClause.binds)
      .all<CronProgressRow>();
    return { rows: progressRows.results ?? [], failed: false };
  } catch (err) {
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "cron_run_progress_unavailable",
      route: "status",
      source: "cron_run_progress",
      message: "Cron run progress unavailable",
      error: err,
    });
    return { rows: [], failed: true };
  }
}

async function fetchCronSlotEventRows(
  db: D1Database,
  eventKeyInClause: { sql: string; binds: unknown[] },
): Promise<{ rows: CronSlotEventRow[]; failed: boolean }> {
  try {
    const eventRows = await db
      .prepare(
        `SELECT key, value, updated_at
           FROM cache
           WHERE key IN (${eventKeyInClause.sql})`,
      )
      .bind(...eventKeyInClause.binds)
      .all<CronSlotEventRow>();
    return { rows: eventRows.results ?? [], failed: false };
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
    return { rows: [], failed: true };
  }
}

async function fetchRunningCronSlotRows(db: D1Database): Promise<{ rows: RunningCronSlotRow[]; failed: boolean }> {
  try {
    const runningRows = await db
      .prepare(
        `SELECT slot_key, slot_started_at, execution_owner, started_at, updated_at
           FROM cron_slot_executions
           WHERE state = 'running'
           ORDER BY updated_at ASC
           LIMIT 25`,
      )
      .all<RunningCronSlotRow>();
    return { rows: runningRows.results ?? [], failed: false };
  } catch (err) {
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "cron_slot_running_unavailable",
      route: "status",
      source: "cron_slot_executions",
      message: "Running scheduled slot rows unavailable",
      error: err,
    });
    return { rows: [], failed: true };
  }
}

function summarizeRunningCronSlots(
  rows: readonly RunningCronSlotRow[],
  now: number,
  queryFailed: boolean,
): ScheduledSlotHealthSummary {
  let oldestRunningAgeSec: number | null = null;
  let oldestStaleAgeSec: number | null = null;
  let staleCandidateSlots = 0;
  for (const row of rows) {
    const ageSec = Math.max(0, now - row.updated_at);
    oldestRunningAgeSec = Math.max(oldestRunningAgeSec ?? 0, ageSec);
    if (ageSec >= STATUS_RUNNING_SLOT_STALE_CANDIDATE_SEC) {
      staleCandidateSlots++;
      oldestStaleAgeSec = Math.max(oldestStaleAgeSec ?? 0, ageSec);
    }
  }
  return {
    runningSlots: rows.length,
    staleCandidateSlots,
    oldestRunningAgeSec,
    oldestStaleAgeSec,
    queryFailed,
  };
}

export async function loadCronHealth(
  db: D1Database,
  now: number,
): Promise<CronHealthSnapshot> {
  const cronJobs = Object.keys(CRON_INTERVALS);
  const cronJobInClause = buildInClause(cronJobs);
  const scheduleKeys = Object.keys(SCHEDULED_SLOT_PLANS) as Array<keyof typeof SCHEDULED_SLOT_PLANS>;
  const eventKeys = scheduleKeys.map(staleSlotEventCacheKey);
  const eventKeyInClause = buildInClause(eventKeys);
  const scheduleKeyByEventKey = new Map(eventKeys.map((key, index) => [key, scheduleKeys[index]]));

  // Fire independent query groups concurrently. The lease→progress
  // dependency is purely an in-memory post-fetch step, so only the raw fetches
  // run in parallel; the dependent processing below preserves the original
  // ordering. This collapses ~13 sequential D1 awaits into one parallel wave.
  const [historyResult, leaseResult, progressResult, slotEventResult, runningSlotResult, jobAttemptHealth] = await Promise.all([
    fetchCronHistoryRows(db, cronJobs),
    fetchCronLeaseRows(db, cronJobInClause),
    fetchCronProgressRows(db, cronJobInClause),
    fetchCronSlotEventRows(db, eventKeyInClause),
    fetchRunningCronSlotRows(db),
    loadWorkerJobAttemptHealth(db, cronJobs, now),
  ]);
  const scheduledSlots = summarizeRunningCronSlots(runningSlotResult.rows, now, runningSlotResult.failed);

  const cronRows: { results?: CronHistoryRow[] } = { results: historyResult.rows };
  const cronHistoryQueryFailed = historyResult.failed;

  const cronLeaseQueryFailed = leaseResult.failed;
  const cronLeaseRows = leaseResult.rows;
  const cronLeaseByJob: Map<string, { leaseOwner: string; leaseUntil: number }> | null =
    cronLeaseQueryFailed
      ? null
      : new Map(
          cronLeaseRows.map((row) => [row.job, {
            leaseOwner: row.lease_owner,
            leaseUntil: row.lease_until,
          }]),
        );

  let cronProgressByJob = new Map<string, CronInFlight>();
  const cronProgressQueryFailed = progressResult.failed;
  const staleArtifactsByJob = new Map<string, CronStaleArtifact[]>();
  const latestEventByJob = new Map<string, CronEvent>();

  if (!cronProgressQueryFailed) {
    const progressArtifacts: CronStaleArtifact[] = [];
    const filteredProgressRows = progressResult.rows.filter((row) => {
      if (cronLeaseQueryFailed || cronLeaseByJob == null) {
        return true;
      }
      if (!row.lease_owner) {
        progressArtifacts.push({
          kind: "orphaned-progress",
          job: row.job,
          progressUpdatedAt: row.updated_at,
          ...(row.stage ? { progressStage: row.stage } : {}),
          slotStartedAt: row.slot_started_at,
        });
        return false;
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

  for (const row of slotEventResult.rows) {
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
    const isFresh = isFreshCronRun(lastRun, now, interval);
    const requiredRuns = runs.filter((run) => run.status !== "skipped_neutral");
    const latestRequiredRun = requiredRuns[0] ?? null;
    const latestRequiredRunFresh = isFreshCronRun(latestRequiredRun, now, interval);
    const hasFreshOk = runs.some((run) => run.status === "ok" && now - run.startedAt <= interval * 2);
    const hasFreshRequiredOk = latestRequiredRunFresh && latestRequiredRun.status === "ok";
    const availabilityHealthyFromLastRun =
      isFresh &&
      lastRun != null &&
      (lastRun.status === "ok" ||
        lastRun.status === "degraded" ||
        (lastRun.status === "skipped_neutral" && hasFreshRequiredOk) ||
        (lastRun.status === "skipped_locked" && hasFreshOk));
    const statusImpact = getCronStatusImpact(job);
    const latestAttempt = jobAttemptHealth.latestByJob.get(job);
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
    if (
      !telemetryUnknown
      && (((lastRun?.status === "degraded" && isFresh)
        || (lastRun?.status === "skipped_neutral" && latestRequiredRun?.status === "degraded" && latestRequiredRunFresh))
        || metadataDegraded)
    ) {
      degradedCronRuns++;
    }
    const latestErrorRunFresh =
      (lastRun?.status === "error" && isFresh)
      || (lastRun?.status === "skipped_neutral" && latestRequiredRun?.status === "error" && latestRequiredRunFresh);
    if (!telemetryUnknown && latestErrorRunFresh && !inFlightFresh) {
      cronErrorCount++;
      if (statusImpact === "critical") {
        availabilityImpactingCronErrors++;
      }
      // Consecutive-error streak: only counts if the two most-recent runs are
      // both in-error. Neutral skips do not reset the streak because they are
      // not required attempts. A single transient error surfaces as `degraded`
      // in deriveAvailabilityStatus; only 2+ consecutive escalate to `stale`.
      if (
        statusImpact === "critical"
        && requiredRuns.length >= 2
        && requiredRuns[0]?.status === "error"
        && requiredRuns[1]?.status === "error"
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
      ...(latestAttempt ? { latestAttempt } : {}),
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
    activeJobAttempts: jobAttemptHealth.activeAttempts,
    staleJobAttempts: jobAttemptHealth.staleAttempts,
    cronHistoryQueryFailed,
    cronProgressQueryFailed,
    cronLeaseQueryFailed,
    jobAttemptQueryFailed: jobAttemptHealth.queryFailed,
    scheduledSlots,
  };
}
