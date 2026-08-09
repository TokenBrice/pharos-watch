import type {
  StatusProbeComparison,
  StatusProbePlaneSummary,
  StatusProbeSummary,
} from "@shared/types/status";
import { isRecord, numberValue as readNumber } from "@shared/lib/type-guards";
import { runWithOverloadRetry } from "./d1-overload-retry";
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
  details_json: string | null;
}

const STATUS_LEVELS = new Set(["healthy", "degraded", "stale", "unknown"]);
const PROBE_COMPARISON_REASONS = new Set([
  "in-sync",
  "internal-missing",
  "external-missing",
  "external-worse",
  "internal-worse",
]);

function readStatus(value: unknown): StatusProbePlaneSummary["status"] | null {
  return typeof value === "string" && STATUS_LEVELS.has(value) ? value as StatusProbePlaneSummary["status"] : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseDetails(detailsJson: string | null): Record<string, unknown> | null {
  if (!detailsJson) return null;
  try {
    const parsed = JSON.parse(detailsJson) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseProbePlaneSummary(value: unknown): StatusProbePlaneSummary | null {
  if (!isRecord(value)) return null;
  const status = readStatus(value.status);
  const sampleCount = readNumber(value.sampleCount);
  const passCount = readNumber(value.passCount);
  const failCount = readNumber(value.failCount);
  if (!status || sampleCount == null || passCount == null || failCount == null) return null;
  const rawP95LatencyMs = value.p95LatencyMs;
  const p95LatencyMs = rawP95LatencyMs == null ? null : readNumber(rawP95LatencyMs);
  return {
    status,
    sampleCount,
    passCount,
    failCount,
    p95LatencyMs,
    origins: readStringArray(value.origins),
  };
}

function parseProbeComparison(value: unknown): StatusProbeComparison | null {
  if (!isRecord(value)) return null;
  const internalStatus = readStatus(value.internalStatus);
  const externalStatus = readStatus(value.externalStatus);
  const severityDelta = readNumber(value.severityDelta);
  const reason =
    typeof value.reason === "string" && PROBE_COMPARISON_REASONS.has(value.reason)
      ? (value.reason as StatusProbeComparison["reason"])
      : null;
  if (!internalStatus || !externalStatus || severityDelta == null || !reason) return null;
  return {
    hasDivergence: value.hasDivergence === true,
    severityDelta,
    internalStatus,
    externalStatus,
    reason,
    details: typeof value.details === "string" ? value.details : null,
  };
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
        `SELECT created_at, status, sample_count, pass_count, fail_count, p95_latency_ms, details_json
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
    const details = parseDetails(row.details_json);
    const planes = isRecord(details?.planes) ? details.planes : null;
    const internal = parseProbePlaneSummary(planes?.internal);
    const external = parseProbePlaneSummary(planes?.external);
    const internalExternalDiscrepancy = parseProbeComparison(details?.internalExternalDiscrepancy);
    return {
      timestamp: row.created_at,
      status: row.status,
      sampleCount: row.sample_count,
      passCount: row.pass_count,
      failCount: row.fail_count,
      p95LatencyMs: row.p95_latency_ms,
      ...(internal ? { internal } : {}),
      ...(external ? { external } : {}),
      ...(internalExternalDiscrepancy ? { internalExternalDiscrepancy } : {}),
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
