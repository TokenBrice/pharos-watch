import type { StatusProbeSummary } from "@shared/types/status";
import { runWithOverloadRetry } from "./cron-lease";
import {
  buildStatusProbeRunIdempotencyKey,
  reportStatusPersistenceIssue,
  type StatusLevel,
  type StatusPersistenceIssueReporter,
} from "./status-reliability-shared";

interface StatusProbeRow {
  created_at: number;
  status: StatusLevel;
  sample_count: number;
  pass_count: number;
  fail_count: number;
  p95_latency_ms: number;
}

export async function writeStatusProbeRun(
  db: D1Database,
  now: number,
  row: {
    status: StatusLevel;
    sampleCount: number;
    passCount: number;
    failCount: number;
    p95LatencyMs: number;
    details?: Record<string, unknown>;
  },
  onIssue?: StatusPersistenceIssueReporter,
): Promise<boolean> {
  const detailsJson = row.details ? JSON.stringify(row.details) : null;
  const idempotencyKey = buildStatusProbeRunIdempotencyKey({
    createdAt: now,
    status: row.status,
    sampleCount: row.sampleCount,
    passCount: row.passCount,
    failCount: row.failCount,
    p95LatencyMs: row.p95LatencyMs,
    detailsJson,
  });
  try {
    await runWithOverloadRetry(() =>
      db
        .prepare(
          `INSERT OR IGNORE INTO status_probe_runs
           (sample_count, pass_count, fail_count, p95_latency_ms, status, details_json, created_at, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.sampleCount,
          row.passCount,
          row.failCount,
          row.p95LatencyMs,
          row.status,
          detailsJson,
          now,
          idempotencyKey,
        )
        .run(),
    );
    return true;
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_probe_write_failed", "write-status-probe", error);
    return false;
  }
}

export async function getLatestStatusProbe(
  db: D1Database,
  onIssue?: StatusPersistenceIssueReporter,
): Promise<StatusProbeSummary> {
  try {
    const row = await db
      .prepare(
        `SELECT created_at, status, sample_count, pass_count, fail_count, p95_latency_ms
         FROM status_probe_runs
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .first<StatusProbeRow>();
    if (!row) {
      return {
        timestamp: null,
        status: "unknown",
        sampleCount: 0,
        passCount: 0,
        failCount: 0,
        p95LatencyMs: null,
      };
    }
    return {
      timestamp: row.created_at,
      status: row.status,
      sampleCount: row.sample_count,
      passCount: row.pass_count,
      failCount: row.fail_count,
      p95LatencyMs: row.p95_latency_ms,
    };
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_probe_read_failed", "read-status-probe", error);
    return {
      timestamp: null,
      status: "unknown",
      sampleCount: 0,
      passCount: 0,
      failCount: 0,
      p95LatencyMs: null,
    };
  }
}
