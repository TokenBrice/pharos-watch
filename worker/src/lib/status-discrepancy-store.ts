import {
  reportStatusPersistenceIssue,
  STATUS_SCOPE,
  type StatusPersistenceIssueReporter,
} from "./status-reliability-shared";
import { isRecord } from "@shared/lib/type-guards";
import { STATUS_PROBE_THRESHOLDS } from "@shared/lib/status-thresholds";
interface StatusDiscrepancyStateRow {
  scope: string;
  consecutive_divergent: number;
  last_divergent_at: number | null;
  consecutive_probe_failures: number;
  last_probe_failure_at: number | null;
}

export type StatusProbePlane = "internal" | "external";

export interface StatusProbePathObservation {
  plane: StatusProbePlane;
  lane: string;
  origin: string;
  path: string;
  failed: boolean;
}

export interface StatusProbePathFailure {
  plane: StatusProbePlane;
  lane: string;
  origin: string;
  path: string;
  failStreak: number;
  lastProbedAt: number;
}

interface StatusProbePathFailureState {
  version: 1;
  paths: Record<string, StatusProbePathFailure>;
}

/** Stable identity for one probed endpoint; a bare path would merge internal and external planes. */
export function getProbePathIdentity(
  probe: Pick<StatusProbePathObservation, "plane" | "lane" | "origin" | "path">,
): string {
  return `${probe.plane}|${probe.lane}|${probe.origin}|${probe.path}`;
}

function parseProbePathFailureState(value: string | null): StatusProbePathFailureState | null {
  if (value == null) return { version: 1, paths: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.paths)) return null;
  const paths: Record<string, StatusProbePathFailure> = {};
  for (const [key, entry] of Object.entries(parsed.paths)) {
    if (!isRecord(entry)) return null;
    const { plane, lane, origin, path, failStreak, lastProbedAt } = entry;
    if (
      (plane !== "internal" && plane !== "external")
      || typeof lane !== "string"
      || typeof origin !== "string"
      || typeof path !== "string"
      || typeof failStreak !== "number"
      || !Number.isFinite(failStreak)
      || failStreak < 0
      || typeof lastProbedAt !== "number"
      || !Number.isFinite(lastProbedAt)
    ) {
      return null;
    }
    paths[key] = { plane, lane, origin, path, failStreak, lastProbedAt };
  }
  return { version: 1, paths };
}

export async function updateDiscrepancyObservation(
  db: D1Database,
  now: number,
  hasDivergence: boolean,
  hasProbeFailure = false,
  onIssue?: StatusPersistenceIssueReporter,
): Promise<{
  consecutiveDivergent: number | null;
  consecutiveProbeFailures: number | null;
  persistenceSucceeded: boolean;
}> {
  let current: StatusDiscrepancyStateRow | null = null;
  try {
    current = await db
      .prepare(
        `SELECT scope,
                consecutive_divergent,
                last_divergent_at,
                consecutive_probe_failures,
                last_probe_failure_at
         FROM status_discrepancy_state
         WHERE scope = ?`,
      )
      .bind(STATUS_SCOPE)
      .first<StatusDiscrepancyStateRow>();
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_discrepancy_read_failed", "load-status-discrepancy", error);
    return {
      consecutiveDivergent: null,
      consecutiveProbeFailures: null,
      persistenceSucceeded: false,
    };
  }

  const nextConsecutive = hasDivergence ? (current?.consecutive_divergent ?? 0) + 1 : 0;
  const nextLastDivergentAt = hasDivergence ? now : (current?.last_divergent_at ?? null);
  const nextConsecutiveProbeFailures = hasProbeFailure ? (current?.consecutive_probe_failures ?? 0) + 1 : 0;
  const nextLastProbeFailureAt = hasProbeFailure ? now : (current?.last_probe_failure_at ?? null);

  try {
    await db
      .prepare(
        `INSERT INTO status_discrepancy_state
         (
           scope,
           consecutive_divergent,
           last_divergent_at,
           consecutive_probe_failures,
           last_probe_failure_at,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?)
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
        nextConsecutiveProbeFailures,
        nextLastProbeFailureAt,
        now,
      )
      .run();
    return {
      consecutiveDivergent: nextConsecutive,
      consecutiveProbeFailures: nextConsecutiveProbeFailures,
      persistenceSucceeded: true,
    };
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_discrepancy_write_failed", "write-status-discrepancy", error);
    return {
      consecutiveDivergent: current?.consecutive_divergent ?? 0,
      consecutiveProbeFailures: current?.consecutive_probe_failures ?? 0,
      persistenceSucceeded: false,
    };
  }
}

/**
 * Advances one fail streak per probed endpoint and returns the paths at or past
 * `STATUS_PROBE_THRESHOLDS.persistentFailSweeps`. One probe of a rotating deep
 * path happens per turn of its bucket, so the streak counts that path's own
 * consecutive sweeps, not runs. A pass resets it; unobserved paths carry their
 * streak until their next turn. `knownIdentities` prunes paths removed from the
 * probe registry. Unreadable or unpersisted state returns null, never zero.
 */
export async function updateProbePathFailureStreaks(
  db: D1Database,
  now: number,
  observations: readonly StatusProbePathObservation[],
  knownIdentities: readonly string[] = [],
  onIssue?: StatusPersistenceIssueReporter,
): Promise<{
  persistentFailures: StatusProbePathFailure[] | null;
  persistenceSucceeded: boolean;
}> {
  let current: StatusProbePathFailureState | null;
  try {
    const row = await db
      .prepare("SELECT probe_path_failure_streaks_json FROM status_discrepancy_state WHERE scope = ?")
      .bind(STATUS_SCOPE)
      .first<{ probe_path_failure_streaks_json: string | null }>();
    current = parseProbePathFailureState(row?.probe_path_failure_streaks_json ?? null);
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_probe_path_streak_read_failed", "load-probe-path-streaks", error);
    return { persistentFailures: null, persistenceSucceeded: false };
  }
  if (!current) {
    reportStatusPersistenceIssue(
      onIssue,
      "status_probe_path_streak_invalid",
      "load-probe-path-streaks",
      new Error("Invalid probe path failure streak state"),
    );
    return { persistentFailures: null, persistenceSucceeded: false };
  }

  const observed = new Map<string, StatusProbePathObservation>();
  for (const observation of observations) {
    const key = getProbePathIdentity(observation);
    const previous = observed.get(key);
    observed.set(key, previous ? { ...previous, failed: previous.failed || observation.failed } : observation);
  }

  const nextPaths: Record<string, StatusProbePathFailure> = { ...current.paths };
  for (const [key, observation] of observed) {
    nextPaths[key] = {
      plane: observation.plane,
      lane: observation.lane,
      origin: observation.origin,
      path: observation.path,
      failStreak: observation.failed ? (nextPaths[key]?.failStreak ?? 0) + 1 : 0,
      lastProbedAt: now,
    };
  }
  if (knownIdentities.length > 0) {
    const known = new Set(knownIdentities);
    const observedKeys = new Set(observed.keys());
    for (const key of Object.keys(nextPaths)) {
      if (!known.has(key) && !observedKeys.has(key)) delete nextPaths[key];
    }
  }

  const state: StatusProbePathFailureState = { version: 1, paths: nextPaths };
  try {
    await db
      .prepare(
        `INSERT INTO status_discrepancy_state
         (
           scope,
           consecutive_divergent,
           last_divergent_at,
           consecutive_probe_failures,
           last_probe_failure_at,
           probe_path_failure_streaks_json,
           updated_at
         )
         VALUES (?, 0, NULL, 0, NULL, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET
           probe_path_failure_streaks_json = excluded.probe_path_failure_streaks_json,
           updated_at = excluded.updated_at`,
      )
      .bind(STATUS_SCOPE, JSON.stringify(state), now)
      .run();
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_probe_path_streak_write_failed", "write-probe-path-streaks", error);
    return { persistentFailures: null, persistenceSucceeded: false };
  }

  return {
    persistentFailures: Object.values(nextPaths)
      .filter((entry) => entry.failStreak >= STATUS_PROBE_THRESHOLDS.persistentFailSweeps),
    persistenceSucceeded: true,
  };
}

export async function getDiscrepancyStreak(db: D1Database, onIssue?: StatusPersistenceIssueReporter): Promise<number | null> {
  try {
    const row = await db
      .prepare("SELECT consecutive_divergent FROM status_discrepancy_state WHERE scope = ?")
      .bind(STATUS_SCOPE)
      .first<{ consecutive_divergent: number }>();
    return row?.consecutive_divergent ?? 0;
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_discrepancy_streak_failed", "read-discrepancy-streak", error);
    return null;
  }
}
