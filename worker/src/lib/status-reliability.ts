import type {
  StatusCause,
  StatusDiscrepancy,
  StatusProbeSummary,
  StatusSectionError,
  StatusStateInfo,
  StatusStaleness,
  StatusTransition,
} from "@shared/types/status";
import { clamp } from "@shared/lib/math";

export type StatusLevel = "healthy" | "degraded" | "stale";

const STATUS_SCOPE = "global" as const;

export const STATUS_HYSTERESIS = {
  escalateToDegraded: 2,
  escalateToStale: 1,
  recoverToDegraded: 2,
  recoverToHealthy: 3,
  minDwellSec: 120,
  staleMinDwellSec: 180,
} as const;

export const STATUS_SYSTEM_FRESHNESS_SEC = 1800;
export const STATUS_DISCREPANCY_ALERT_STREAK = 2;
export const STATUS_DISCREPANCY_ALERT_COOLDOWN_SEC = 1800;
const LOGGED_STATUS_PERSISTENCE_FAILURES = new Set<string>();

export interface StatusPersistenceIssue {
  code: string;
  operation: string;
  message: string;
}

export type StatusPersistenceIssueReporter = (issue: StatusPersistenceIssue) => void;

interface StatusStateRow {
  scope: string;
  current_status: StatusLevel;
  raw_status: StatusLevel;
  last_evaluated_at: number;
  last_changed_at: number;
  consecutive_healthy: number;
  consecutive_degraded: number;
  consecutive_stale: number;
  confidence: number;
  causes_json: string | null;
}

interface StatusDiscrepancyStateRow {
  scope: string;
  consecutive_divergent: number;
  last_divergent_at: number | null;
  last_alert_at: number | null;
  consecutive_probe_failures: number;
  last_probe_failure_at: number | null;
  last_probe_alert_at: number | null;
}

interface StatusTransitionRow {
  id: number;
  scope: string;
  previous_status: StatusLevel | null;
  next_status: StatusLevel;
  raw_status: StatusLevel;
  transition_type: "degrade" | "recover" | "init";
  reason: string;
  confidence: number;
  causes_json: string | null;
  created_at: number;
}

interface StatusProbeRow {
  created_at: number;
  status: StatusLevel;
  sample_count: number;
  pass_count: number;
  fail_count: number;
  p95_latency_ms: number;
}

const SEVERITY: Record<StatusLevel, number> = { healthy: 0, degraded: 1, stale: 2 };

export function clampConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0.1;
  return clamp(confidence, 0.1, 1);
}

function parseCauses(json: string | null | undefined): StatusCause[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as StatusCause[]) : [];
  } catch {
    return [];
  }
}

function transitionType(from: StatusLevel | null, to: StatusLevel): "degrade" | "recover" | "init" {
  if (!from) return "init";
  return SEVERITY[to] > SEVERITY[from] ? "degrade" : "recover";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportStatusPersistenceIssue(
  report: StatusPersistenceIssueReporter | undefined,
  code: string,
  operation: string,
  error: unknown,
): void {
  const message = getErrorMessage(error);
  const logKey = `${code}:${operation}`;
  if (!LOGGED_STATUS_PERSISTENCE_FAILURES.has(logKey)) {
    LOGGED_STATUS_PERSISTENCE_FAILURES.add(logKey);
    console.error(`[status-reliability] ${operation} failed: ${message}`);
  }
  report?.({
    code,
    operation,
    message,
  });
}

async function persistStatusStateAtomically(
  db: D1Database,
  statements: D1PreparedStatement[],
  onIssue: StatusPersistenceIssueReporter | undefined,
  operation: string,
): Promise<void> {
  try {
    await db.batch(statements);
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_state_persistence_failed", operation, error);
  }
}

export function summarizeStatusPersistenceIssues(
  issues: StatusPersistenceIssue[],
): StatusSectionError | undefined {
  if (issues.length === 0) return undefined;
  const distinctOperations = [...new Set(issues.map((issue) => issue.operation))];
  if (issues.length === 1) {
    return {
      code: issues[0]!.code,
      message: `Status persistence degraded during ${issues[0]!.operation}: ${issues[0]!.message}`,
    };
  }
  return {
    code: "status_persistence_degraded",
    message: `Status persistence degraded across ${distinctOperations.join(", ")}. First issue: ${issues[0]!.message}`,
  };
}

function toStateInfo(row: StatusStateRow): StatusStateInfo {
  return {
    scope: "global",
    currentStatus: row.current_status,
    rawStatus: row.raw_status,
    lastEvaluatedAt: row.last_evaluated_at,
    lastChangedAt: row.last_changed_at,
    minDwellSec: STATUS_HYSTERESIS.minDwellSec,
    staleMinDwellSec: STATUS_HYSTERESIS.staleMinDwellSec,
    consecutiveRaw: {
      healthy: row.consecutive_healthy,
      degraded: row.consecutive_degraded,
      stale: row.consecutive_stale,
    },
    thresholds: {
      escalateToDegraded: STATUS_HYSTERESIS.escalateToDegraded,
      escalateToStale: STATUS_HYSTERESIS.escalateToStale,
      recoverToDegraded: STATUS_HYSTERESIS.recoverToDegraded,
      recoverToHealthy: STATUS_HYSTERESIS.recoverToHealthy,
    },
  };
}

export function buildFallbackStatusState(rawStatus: StatusLevel, now: number): StatusStateInfo {
  return {
    scope: "global",
    currentStatus: rawStatus,
    rawStatus,
    lastEvaluatedAt: now,
    lastChangedAt: now,
    minDwellSec: STATUS_HYSTERESIS.minDwellSec,
    staleMinDwellSec: STATUS_HYSTERESIS.staleMinDwellSec,
    consecutiveRaw: {
      healthy: rawStatus === "healthy" ? 1 : 0,
      degraded: rawStatus === "degraded" ? 1 : 0,
      stale: rawStatus === "stale" ? 1 : 0,
    },
    thresholds: {
      escalateToDegraded: STATUS_HYSTERESIS.escalateToDegraded,
      escalateToStale: STATUS_HYSTERESIS.escalateToStale,
      recoverToDegraded: STATUS_HYSTERESIS.recoverToDegraded,
      recoverToHealthy: STATUS_HYSTERESIS.recoverToHealthy,
    },
  };
}

function decideNextStatus(
  current: StatusLevel,
  raw: StatusLevel,
  counters: { healthy: number; degraded: number; stale: number },
  dwellSec: number,
): { next: StatusLevel; changed: boolean; reason: string } {
  // Escalations (fast path)
  if (current === "healthy" && raw === "stale" && counters.stale >= STATUS_HYSTERESIS.escalateToStale) {
    return { next: "stale", changed: true, reason: "raw-stale-immediate-escalation" };
  }
  if (current === "healthy" && raw === "degraded" && counters.degraded >= STATUS_HYSTERESIS.escalateToDegraded) {
    return { next: "degraded", changed: true, reason: "raw-degraded-consecutive-threshold" };
  }
  if (current === "degraded" && raw === "stale" && counters.stale >= 2) {
    return { next: "stale", changed: true, reason: "raw-stale-consecutive-threshold" };
  }

  // Recoveries (require sustained healthy signals + dwell)
  if (
    current === "degraded" &&
    raw === "healthy" &&
    counters.healthy >= STATUS_HYSTERESIS.recoverToHealthy &&
    dwellSec >= STATUS_HYSTERESIS.minDwellSec
  ) {
    return { next: "healthy", changed: true, reason: "raw-healthy-recovery-threshold" };
  }
  if (
    current === "stale" &&
    raw === "degraded" &&
    counters.degraded >= STATUS_HYSTERESIS.recoverToDegraded &&
    dwellSec >= STATUS_HYSTERESIS.staleMinDwellSec
  ) {
    return { next: "degraded", changed: true, reason: "raw-degraded-recovery-from-stale" };
  }
  if (
    current === "stale" &&
    raw === "healthy" &&
    counters.healthy >= STATUS_HYSTERESIS.recoverToHealthy &&
    dwellSec >= STATUS_HYSTERESIS.staleMinDwellSec
  ) {
    return { next: "healthy", changed: true, reason: "raw-healthy-recovery-from-stale" };
  }

  return { next: current, changed: false, reason: "hysteresis-hold" };
}

export async function reconcileStatusState(
  db: D1Database,
  now: number,
  rawStatus: StatusLevel,
  confidence: number,
  causes: StatusCause[],
  onIssue?: StatusPersistenceIssueReporter,
): Promise<{
  effectiveStatus: StatusLevel;
  state: StatusStateInfo;
  transition: StatusTransition | null;
}> {
  const normalizedConfidence = clampConfidence(confidence);
  const causesJson = JSON.stringify(causes);

  let current: StatusStateRow | null = null;
  try {
    current = await db
      .prepare(
        `SELECT scope, current_status, raw_status, last_evaluated_at, last_changed_at,
                consecutive_healthy, consecutive_degraded, consecutive_stale, confidence, causes_json
         FROM status_state
         WHERE scope = ?`,
      )
      .bind(STATUS_SCOPE)
      .first<StatusStateRow>();
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_state_read_failed", "load-status-state", error);
  }

  if (!current) {
    const seed: StatusStateRow = {
      scope: STATUS_SCOPE,
      current_status: rawStatus,
      raw_status: rawStatus,
      last_evaluated_at: now,
      last_changed_at: now,
      consecutive_healthy: rawStatus === "healthy" ? 1 : 0,
      consecutive_degraded: rawStatus === "degraded" ? 1 : 0,
      consecutive_stale: rawStatus === "stale" ? 1 : 0,
      confidence: normalizedConfidence,
      causes_json: causesJson,
    };

    const transition: StatusTransition = {
      id: 0,
      scope: "global",
      from: null,
      to: seed.current_status,
      rawStatus: seed.raw_status,
      transitionType: "init",
      reason: "status-state-initialized",
      confidence: normalizedConfidence,
      causes,
      at: now,
    };
    await persistStatusStateAtomically(
      db,
      [
        db
          .prepare(
            `INSERT INTO status_state
             (scope, current_status, raw_status, last_evaluated_at, last_changed_at,
              consecutive_healthy, consecutive_degraded, consecutive_stale, confidence, causes_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            seed.scope,
            seed.current_status,
            seed.raw_status,
            seed.last_evaluated_at,
            seed.last_changed_at,
            seed.consecutive_healthy,
            seed.consecutive_degraded,
            seed.consecutive_stale,
            seed.confidence,
            seed.causes_json,
            now,
          ),
        db
          .prepare(
            `INSERT INTO status_transitions
             (scope, previous_status, next_status, raw_status, transition_type, reason, confidence, causes_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            STATUS_SCOPE,
            null,
            seed.current_status,
            seed.raw_status,
            transition.transitionType,
            transition.reason,
            transition.confidence,
            causesJson,
            now,
          ),
      ],
      onIssue,
      "seed_status_state",
    );

    return {
      effectiveStatus: seed.current_status,
      state: toStateInfo(seed),
      transition,
    };
  }

  const counters = {
    healthy: rawStatus === "healthy" ? current.consecutive_healthy + 1 : 0,
    degraded: rawStatus === "degraded" ? current.consecutive_degraded + 1 : 0,
    stale: rawStatus === "stale" ? current.consecutive_stale + 1 : 0,
  };
  const dwellSec = Math.max(0, now - current.last_changed_at);
  const decision = decideNextStatus(current.current_status, rawStatus, counters, dwellSec);
  const nextStatus = decision.next;
  const changed = decision.changed;
  const nextChangedAt = changed ? now : current.last_changed_at;

  const nextRow: StatusStateRow = {
    scope: STATUS_SCOPE,
    current_status: nextStatus,
    raw_status: rawStatus,
    last_evaluated_at: now,
    last_changed_at: nextChangedAt,
    consecutive_healthy: counters.healthy,
    consecutive_degraded: counters.degraded,
    consecutive_stale: counters.stale,
    confidence: normalizedConfidence,
    causes_json: causesJson,
  };

  let transition: StatusTransition | null = null;
  if (changed) {
    const tType = transitionType(current.current_status, nextStatus);
    transition = {
      id: 0,
      scope: "global",
      from: current.current_status,
      to: nextStatus,
      rawStatus,
      transitionType: tType,
      reason: decision.reason,
      confidence: normalizedConfidence,
      causes,
      at: now,
    };
  }

  const statements = [
    db
      .prepare(
        `UPDATE status_state
         SET current_status = ?, raw_status = ?, last_evaluated_at = ?, last_changed_at = ?,
             consecutive_healthy = ?, consecutive_degraded = ?, consecutive_stale = ?,
             confidence = ?, causes_json = ?, updated_at = ?
         WHERE scope = ?`,
      )
      .bind(
        nextRow.current_status,
        nextRow.raw_status,
        nextRow.last_evaluated_at,
        nextRow.last_changed_at,
        nextRow.consecutive_healthy,
        nextRow.consecutive_degraded,
        nextRow.consecutive_stale,
        nextRow.confidence,
        nextRow.causes_json,
        now,
        STATUS_SCOPE,
      ),
    ...(changed && transition
      ? [
          db
            .prepare(
              `INSERT INTO status_transitions
               (scope, previous_status, next_status, raw_status, transition_type, reason, confidence, causes_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              STATUS_SCOPE,
              current.current_status,
              nextStatus,
              rawStatus,
              transition.transitionType,
              decision.reason,
              normalizedConfidence,
              causesJson,
              now,
            ),
        ]
      : []),
  ];

  await persistStatusStateAtomically(db, statements, onIssue, "update_status_state");

  return {
    effectiveStatus: nextStatus,
    state: toStateInfo(nextRow),
    transition,
  };
}

export async function getStatusStateSnapshot(
  db: D1Database,
  now: number,
  onIssue?: StatusPersistenceIssueReporter,
): Promise<{ state: StatusStateInfo | null; staleness: StatusStaleness | null }> {
  try {
    const row = await db
      .prepare(
        `SELECT scope, current_status, raw_status, last_evaluated_at, last_changed_at,
                consecutive_healthy, consecutive_degraded, consecutive_stale, confidence, causes_json
         FROM status_state
         WHERE scope = ?`,
      )
      .bind(STATUS_SCOPE)
      .first<StatusStateRow>();
    if (!row) return { state: null, staleness: null };
    const ageSeconds = Math.max(0, now - row.last_evaluated_at);
    return {
      state: toStateInfo(row),
      staleness: {
        ageSeconds,
        maxAgeSec: STATUS_SYSTEM_FRESHNESS_SEC,
        isStale: ageSeconds > STATUS_SYSTEM_FRESHNESS_SEC,
      },
    };
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_state_snapshot_failed", "read-status-snapshot", error);
    return { state: null, staleness: null };
  }
}

export async function listRecentStatusTransitions(
  db: D1Database,
  limit = 30,
  range?: { from?: number | null; to?: number | null },
  onIssue?: StatusPersistenceIssueReporter,
): Promise<StatusTransition[]> {
  const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
  try {
    let sql = `SELECT id, scope, previous_status, next_status, raw_status, transition_type, reason, confidence, causes_json, created_at
         FROM status_transitions
         WHERE scope = ?`;
    const binds: unknown[] = [STATUS_SCOPE];
    if (range?.from != null) {
      sql += " AND created_at >= ?";
      binds.push(range.from);
    }
    if (range?.to != null) {
      sql += " AND created_at <= ?";
      binds.push(range.to);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    binds.push(bounded);

    const rows = await db
      .prepare(sql)
      .bind(...binds)
      .all<StatusTransitionRow>();
    return (rows.results ?? []).map((row) => ({
      id: row.id,
      scope: "global",
      from: row.previous_status,
      to: row.next_status,
      rawStatus: row.raw_status,
      transitionType: row.transition_type,
      reason: row.reason,
      confidence: row.confidence,
      causes: parseCauses(row.causes_json),
      at: row.created_at,
    }));
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_transition_list_failed", "list-status-transitions", error);
    return [];
  }
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
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO status_probe_runs
         (sample_count, pass_count, fail_count, p95_latency_ms, status, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.sampleCount,
        row.passCount,
        row.failCount,
        row.p95LatencyMs,
        row.status,
        row.details ? JSON.stringify(row.details) : null,
        now,
      )
      .run();
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_probe_write_failed", "write-status-probe", error);
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

export async function updateDiscrepancyObservation(
  db: D1Database,
  now: number,
  hasDivergence: boolean,
  hasProbeFailure = false,
  onIssue?: StatusPersistenceIssueReporter,
): Promise<{
  consecutiveDivergent: number;
  lastAlertAt: number | null;
  consecutiveProbeFailures: number;
  lastProbeAlertAt: number | null;
}> {
  let current: StatusDiscrepancyStateRow | null = null;
  try {
    current = await db
      .prepare(
        `SELECT scope,
                consecutive_divergent,
                last_divergent_at,
                last_alert_at,
                consecutive_probe_failures,
                last_probe_failure_at,
                last_probe_alert_at
         FROM status_discrepancy_state
         WHERE scope = ?`,
      )
      .bind(STATUS_SCOPE)
      .first<StatusDiscrepancyStateRow>();
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_discrepancy_read_failed", "load-status-discrepancy", error);
  }

  const nextConsecutive = hasDivergence ? (current?.consecutive_divergent ?? 0) + 1 : 0;
  const nextLastDivergentAt = hasDivergence ? now : (current?.last_divergent_at ?? null);
  const lastAlertAt = current?.last_alert_at ?? null;
  const nextConsecutiveProbeFailures = hasProbeFailure ? (current?.consecutive_probe_failures ?? 0) + 1 : 0;
  const nextLastProbeFailureAt = hasProbeFailure ? now : (current?.last_probe_failure_at ?? null);
  const lastProbeAlertAt = current?.last_probe_alert_at ?? null;

  try {
    await db
      .prepare(
        `INSERT INTO status_discrepancy_state
         (
           scope,
           consecutive_divergent,
           last_divergent_at,
           last_alert_at,
           consecutive_probe_failures,
           last_probe_failure_at,
           last_probe_alert_at,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET
           consecutive_divergent = excluded.consecutive_divergent,
           last_divergent_at = excluded.last_divergent_at,
           consecutive_probe_failures = excluded.consecutive_probe_failures,
           last_probe_failure_at = excluded.last_probe_failure_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        STATUS_SCOPE,
        nextConsecutive,
        nextLastDivergentAt,
        lastAlertAt,
        nextConsecutiveProbeFailures,
        nextLastProbeFailureAt,
        lastProbeAlertAt,
        now,
      )
      .run();
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_discrepancy_write_failed", "write-status-discrepancy", error);
  }

  return {
    consecutiveDivergent: nextConsecutive,
    lastAlertAt,
    consecutiveProbeFailures: nextConsecutiveProbeFailures,
    lastProbeAlertAt,
  };
}

export async function markDiscrepancyAlertSent(
  db: D1Database,
  now: number,
  onIssue?: StatusPersistenceIssueReporter,
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE status_discrepancy_state
         SET last_alert_at = ?, updated_at = ?
         WHERE scope = ?`,
      )
      .bind(now, now, STATUS_SCOPE)
      .run();
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_discrepancy_alert_write_failed", "mark-discrepancy-alert", error);
  }
}

export async function markProbeFailureAlertSent(
  db: D1Database,
  now: number,
  onIssue?: StatusPersistenceIssueReporter,
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE status_discrepancy_state
         SET last_probe_alert_at = ?, updated_at = ?
         WHERE scope = ?`,
      )
      .bind(now, now, STATUS_SCOPE)
      .run();
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_probe_alert_write_failed", "mark-probe-alert", error);
  }
}

export async function getDiscrepancyStreak(
  db: D1Database,
  onIssue?: StatusPersistenceIssueReporter,
): Promise<number> {
  try {
    const row = await db
      .prepare("SELECT consecutive_divergent FROM status_discrepancy_state WHERE scope = ?")
      .bind(STATUS_SCOPE)
      .first<{ consecutive_divergent: number }>();
    return row?.consecutive_divergent ?? 0;
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_discrepancy_streak_failed", "read-discrepancy-streak", error);
    return 0;
  }
}

export function buildDiscrepancy(
  overallStatus: StatusLevel,
  probe: StatusProbeSummary,
  now: number,
  consecutiveDivergent: number,
): StatusDiscrepancy {
  if (probe.status === "unknown" || probe.timestamp == null) {
    return {
      hasDivergence: false,
      severityDelta: 0,
      statusSeverity: SEVERITY[overallStatus],
      probeSeverity: -1,
      details: null,
      probeAgeSeconds: null,
      consecutiveDivergent,
    };
  }

  const probeAgeSeconds = Math.max(0, now - probe.timestamp);
  const statusSeverity = SEVERITY[overallStatus];
  const probeSeverity = SEVERITY[probe.status];
  const severityDelta = statusSeverity - probeSeverity;
  const freshProbe = probeAgeSeconds <= STATUS_SYSTEM_FRESHNESS_SEC;
  const hasDivergence = freshProbe && Math.abs(severityDelta) >= 1;

  return {
    hasDivergence,
    severityDelta,
    statusSeverity,
    probeSeverity,
    details: hasDivergence ? `status=${overallStatus}, probe=${probe.status}, probeAge=${probeAgeSeconds}s` : null,
    probeAgeSeconds,
    consecutiveDivergent,
  };
}
