import type {
  StatusCause,
  StatusStaleness,
  StatusTransition,
} from "@shared/types/status";
import { decideNextStatus } from "./status-reliability-decision";
import {
  buildFallbackStatusState,
  buildStatusTransitionIdempotencyKey,
  clampConfidence,
  parseCauses,
  persistStatusStateAtomically,
  reportStatusPersistenceIssue,
  STATUS_HYSTERESIS,
  STATUS_SCOPE,
  STATUS_SYSTEM_FRESHNESS_SEC,
  toStateInfo,
  transitionType,
  type StatusLevel,
  type StatusPersistenceIssueReporter,
  type StatusStateRow,
  type StatusTransitionRow,
} from "./status-reliability-shared";

const STATUS_STATE_SELECT_COLUMNS =
  "scope, current_status, raw_status, last_evaluated_at, last_changed_at, consecutive_healthy, consecutive_degraded, consecutive_stale, confidence, causes_json";

export async function reconcileStatusState(
  db: D1Database,
  now: number,
  rawStatus: StatusLevel,
  confidence: number,
  causes: StatusCause[],
  onIssue?: StatusPersistenceIssueReporter,
): Promise<{
  effectiveStatus: StatusLevel;
  state: ReturnType<typeof buildFallbackStatusState>;
  transition: StatusTransition | null;
  persistenceSucceeded: boolean;
}> {
  const normalizedConfidence = clampConfidence(confidence);
  const causesJson = JSON.stringify(causes);

  let current: StatusStateRow | null = null;
  try {
    current = await db
      .prepare(
        `SELECT ${STATUS_STATE_SELECT_COLUMNS} FROM status_state WHERE scope = ?`,
      )
      .bind(STATUS_SCOPE)
      .first<StatusStateRow>();
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_state_read_failed", "load-status-state", error);
    return {
      effectiveStatus: rawStatus,
      state: buildFallbackStatusState(rawStatus, now),
      transition: null,
      persistenceSucceeded: false,
    };
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
    const transitionIdempotencyKey = buildStatusTransitionIdempotencyKey({
      scope: STATUS_SCOPE,
      previousStatus: null,
      nextStatus: seed.current_status,
      rawStatus: seed.raw_status,
      transitionType: transition.transitionType,
      reason: transition.reason,
      confidence: transition.confidence,
      causesJson,
      createdAt: now,
    });
    const persistenceSucceeded = await persistStatusStateAtomically(
      db,
      [
        db
          .prepare(
            `INSERT INTO status_state
             (scope, current_status, raw_status, last_evaluated_at, last_changed_at,
              consecutive_healthy, consecutive_degraded, consecutive_stale, confidence, causes_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(scope) DO UPDATE SET
               current_status = excluded.current_status,
               raw_status = excluded.raw_status,
               last_evaluated_at = excluded.last_evaluated_at,
               last_changed_at = excluded.last_changed_at,
               consecutive_healthy = excluded.consecutive_healthy,
               consecutive_degraded = excluded.consecutive_degraded,
               consecutive_stale = excluded.consecutive_stale,
               confidence = excluded.confidence,
               causes_json = excluded.causes_json,
               updated_at = excluded.updated_at
             WHERE status_state.updated_at <= excluded.updated_at`,
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
            `INSERT OR IGNORE INTO status_transitions
             (scope, previous_status, next_status, raw_status, transition_type, reason, confidence, causes_json, created_at, idempotency_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            transitionIdempotencyKey,
          ),
      ],
      onIssue,
      "seed_status_state",
    );

    if (!persistenceSucceeded) {
      return {
        effectiveStatus: rawStatus,
        state: buildFallbackStatusState(rawStatus, now),
        transition: null,
        persistenceSucceeded: false,
      };
    }

    return {
      effectiveStatus: seed.current_status,
      state: toStateInfo(seed),
      transition,
      persistenceSucceeded: true,
    };
  }

  const counters = {
    healthy: rawStatus === "healthy" ? current.consecutive_healthy + 1 : 0,
    degraded: rawStatus === "degraded" ? current.consecutive_degraded + 1 : 0,
    stale: rawStatus === "stale" ? current.consecutive_stale + 1 : 0,
  };
  const dwellSec = Math.max(0, now - current.last_changed_at);
  const decision = decideNextStatus(current.current_status, rawStatus, counters, dwellSec, STATUS_HYSTERESIS);
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
  const transitionIdempotencyKey = transition
    ? buildStatusTransitionIdempotencyKey({
        scope: STATUS_SCOPE,
        previousStatus: current.current_status,
        nextStatus,
        rawStatus,
        transitionType: transition.transitionType,
        reason: decision.reason,
        confidence: normalizedConfidence,
        causesJson,
        createdAt: now,
      })
    : null;

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
              `INSERT OR IGNORE INTO status_transitions
               (scope, previous_status, next_status, raw_status, transition_type, reason, confidence, causes_json, created_at, idempotency_key)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
              transitionIdempotencyKey,
            ),
        ]
      : []),
  ];

  const persistenceSucceeded = await persistStatusStateAtomically(db, statements, onIssue, "update_status_state");

  if (!persistenceSucceeded) {
    return {
      effectiveStatus: current.current_status,
      state: toStateInfo(current),
      transition: null,
      persistenceSucceeded: false,
    };
  }

  return {
    effectiveStatus: nextStatus,
    state: toStateInfo(nextRow),
    transition,
    persistenceSucceeded: true,
  };
}

export async function getStatusStateSnapshot(
  db: D1Database,
  now: number,
  onIssue?: StatusPersistenceIssueReporter,
): Promise<{ state: ReturnType<typeof buildFallbackStatusState> | null; staleness: StatusStaleness | null }> {
  try {
    const row = await db
      .prepare(
        `SELECT ${STATUS_STATE_SELECT_COLUMNS} FROM status_state WHERE scope = ?`,
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
  // Admin history fetches one sentinel row beyond its public 200-row page cap.
  const bounded = Math.max(1, Math.min(201, Math.floor(limit)));
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
      causes: parseCauses(row.causes_json, "status_transitions.causes_json", row.created_at),
      at: row.created_at,
    }));
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_transition_list_failed", "list-status-transitions", error);
    return [];
  }
}
