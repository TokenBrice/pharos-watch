import {
  reportStatusPersistenceIssue,
  STATUS_SCOPE,
  type StatusPersistenceIssueReporter,
} from "./status-reliability-shared";

interface StatusDiscrepancyStateRow {
  scope: string;
  consecutive_divergent: number;
  last_divergent_at: number | null;
  last_alert_at: number | null;
  consecutive_probe_failures: number;
  last_probe_failure_at: number | null;
  last_probe_alert_at: number | null;
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
  persistenceSucceeded: boolean;
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
    return {
      consecutiveDivergent: nextConsecutive,
      lastAlertAt,
      consecutiveProbeFailures: nextConsecutiveProbeFailures,
      lastProbeAlertAt,
      persistenceSucceeded: true,
    };
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_discrepancy_write_failed", "write-status-discrepancy", error);
    return {
      consecutiveDivergent: current?.consecutive_divergent ?? 0,
      lastAlertAt,
      consecutiveProbeFailures: current?.consecutive_probe_failures ?? 0,
      lastProbeAlertAt,
      persistenceSucceeded: false,
    };
  }
}

export async function markDiscrepancyAlertSent(
  db: D1Database,
  now: number,
  onIssue?: StatusPersistenceIssueReporter,
): Promise<boolean> {
  try {
    await db
      .prepare(
        `UPDATE status_discrepancy_state
         SET last_alert_at = ?, updated_at = ?
         WHERE scope = ?`,
      )
      .bind(now, now, STATUS_SCOPE)
      .run();
    return true;
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_discrepancy_alert_write_failed", "mark-discrepancy-alert", error);
    return false;
  }
}

export async function markProbeFailureAlertSent(
  db: D1Database,
  now: number,
  onIssue?: StatusPersistenceIssueReporter,
): Promise<boolean> {
  try {
    await db
      .prepare(
        `UPDATE status_discrepancy_state
         SET last_probe_alert_at = ?, updated_at = ?
         WHERE scope = ?`,
      )
      .bind(now, now, STATUS_SCOPE)
      .run();
    return true;
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_probe_alert_write_failed", "mark-probe-alert", error);
    return false;
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
