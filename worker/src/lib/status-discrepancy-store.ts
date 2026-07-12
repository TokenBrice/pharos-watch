import {
  reportStatusPersistenceIssue,
  STATUS_SCOPE,
  type StatusPersistenceIssueReporter,
} from "./status-reliability-shared";
import { getCache, setCache } from "./db-cache";
import { parseJsonObject } from "./json-parse";

export const STATUS_DISCREPANCY_DIRECT_ALERT_CACHE_KEY = "status:discrepancy-alert:direct:v1";
export const STATUS_PROBE_FAILURE_DIRECT_ALERT_CACHE_KEY = "status:probe-failure-alert:direct:v1";

interface StatusDiscrepancyStateRow {
  scope: string;
  consecutive_divergent: number;
  last_divergent_at: number | null;
  last_alert_at: number | null;
  consecutive_probe_failures: number;
  last_probe_failure_at: number | null;
  last_probe_alert_at: number | null;
}

function parseDirectAlertTimestamp(value: string | null | undefined): number | null {
  const parsed = parseJsonObject(value, { onFailure: () => undefined });
  return typeof parsed?.lastAlertedAt === "number" && Number.isFinite(parsed.lastAlertedAt)
    ? parsed.lastAlertedAt
    : null;
}

async function readDirectAlertTimestamp(
  db: D1Database,
  key: string,
  issueCode: string,
  action: string,
  onIssue?: StatusPersistenceIssueReporter,
): Promise<{ value: number | null; succeeded: boolean }> {
  try {
    return {
      value: parseDirectAlertTimestamp((await getCache(db, key))?.value),
      succeeded: true,
    };
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, issueCode, action, error);
    return { value: null, succeeded: false };
  }
}

async function markDirectAlertSent(
  db: D1Database,
  now: number,
  key: string,
  issueCode: string,
  action: string,
  onIssue?: StatusPersistenceIssueReporter,
): Promise<boolean> {
  try {
    await setCache(db, key, JSON.stringify({ lastAlertedAt: now }));
    return true;
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, issueCode, action, error);
    return false;
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

  const directDiscrepancyAlert = await readDirectAlertTimestamp(
    db,
    STATUS_DISCREPANCY_DIRECT_ALERT_CACHE_KEY,
    "status_discrepancy_alert_read_failed",
    "read-discrepancy-alert",
    onIssue,
  );
  const directProbeFailureAlert = await readDirectAlertTimestamp(
    db,
    STATUS_PROBE_FAILURE_DIRECT_ALERT_CACHE_KEY,
    "status_probe_alert_read_failed",
    "read-probe-alert",
    onIssue,
  );
  const directAlertMarkersRead = directDiscrepancyAlert.succeeded && directProbeFailureAlert.succeeded;

  const nextConsecutive = hasDivergence ? (current?.consecutive_divergent ?? 0) + 1 : 0;
  const nextLastDivergentAt = hasDivergence ? now : (current?.last_divergent_at ?? null);
  const legacyLastAlertAt = current?.last_alert_at ?? null;
  const nextConsecutiveProbeFailures = hasProbeFailure ? (current?.consecutive_probe_failures ?? 0) + 1 : 0;
  const nextLastProbeFailureAt = hasProbeFailure ? now : (current?.last_probe_failure_at ?? null);
  const legacyLastProbeAlertAt = current?.last_probe_alert_at ?? null;

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
        legacyLastAlertAt,
        nextConsecutiveProbeFailures,
        nextLastProbeFailureAt,
        legacyLastProbeAlertAt,
        now,
      )
      .run();
    return {
      consecutiveDivergent: nextConsecutive,
      lastAlertAt: directDiscrepancyAlert.value,
      consecutiveProbeFailures: nextConsecutiveProbeFailures,
      lastProbeAlertAt: directProbeFailureAlert.value,
      persistenceSucceeded: directAlertMarkersRead,
    };
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_discrepancy_write_failed", "write-status-discrepancy", error);
    return {
      consecutiveDivergent: current?.consecutive_divergent ?? 0,
      lastAlertAt: directDiscrepancyAlert.value,
      consecutiveProbeFailures: current?.consecutive_probe_failures ?? 0,
      lastProbeAlertAt: directProbeFailureAlert.value,
      persistenceSucceeded: false,
    };
  }
}

export async function markDiscrepancyAlertSent(
  db: D1Database,
  now: number,
  onIssue?: StatusPersistenceIssueReporter,
): Promise<boolean> {
  return markDirectAlertSent(
    db,
    now,
    STATUS_DISCREPANCY_DIRECT_ALERT_CACHE_KEY,
    "status_discrepancy_alert_write_failed",
    "mark-discrepancy-alert",
    onIssue,
  );
}

export async function markProbeFailureAlertSent(
  db: D1Database,
  now: number,
  onIssue?: StatusPersistenceIssueReporter,
): Promise<boolean> {
  return markDirectAlertSent(
    db,
    now,
    STATUS_PROBE_FAILURE_DIRECT_ALERT_CACHE_KEY,
    "status_probe_alert_write_failed",
    "mark-probe-alert",
    onIssue,
  );
}

export async function getDiscrepancyStreak(db: D1Database, onIssue?: StatusPersistenceIssueReporter): Promise<number> {
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
