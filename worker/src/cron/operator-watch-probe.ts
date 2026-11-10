import {
  STATUS_PROBE_OPERATOR_MAX_EVIDENCE_AGE_SEC,
  STATUS_PROBE_THRESHOLDS,
} from "@shared/lib/status-thresholds";
import type { OperatorWatchEvidenceCondition } from "./operator-watch-types";
import { isStatusLevelOnlyProbePath } from "./status-probe-contracts";

export interface ProbeOperatorWatchEvidence {
  conditions: OperatorWatchEvidenceCondition[];
  /** No fresh, readable persistent-failure evidence this run: keep prior state. */
  unknown: boolean;
}

interface ProbeRunRow {
  created_at: number;
  details_json: string | null;
}

interface PersistentProbeFailureRow {
  lane?: unknown;
  path?: unknown;
  failStreak?: unknown;
  lastProbedAt?: unknown;
}

/**
 * The self-check floors the probe plane only after
 * `STATUS_PROBE_THRESHOLDS.persistentFailSweeps` consecutive failed samples of
 * the same path. Reuse that persisted evidence so a stuck deep endpoint reaches
 * the operator transition machine. A missing, stale or unreadable row is
 * unknown, never a healthy reading.
 */
export async function loadProbeOperatorWatch(
  db: D1Database,
  now: number,
): Promise<ProbeOperatorWatchEvidence> {
  try {
    const row = await db
      .prepare("SELECT created_at, details_json FROM status_probe_runs ORDER BY created_at DESC LIMIT 1")
      .bind()
      .first<ProbeRunRow>();
    if (!row || !Number.isFinite(row.created_at) || row.created_at > now
      || now - row.created_at > STATUS_PROBE_OPERATOR_MAX_EVIDENCE_AGE_SEC
      || typeof row.details_json !== "string") {
      return { conditions: [], unknown: true };
    }
    const details = JSON.parse(row.details_json) as { persistentProbeFailures?: unknown };
    // null means the per-path streak store was unreadable in that run.
    if (!Array.isArray(details.persistentProbeFailures)) return { conditions: [], unknown: true };
    const conditions: OperatorWatchEvidenceCondition[] = [];
    for (const failure of details.persistentProbeFailures as PersistentProbeFailureRow[]) {
      if (typeof failure.lane !== "string" || typeof failure.path !== "string"
        || typeof failure.failStreak !== "number" || failure.failStreak < STATUS_PROBE_THRESHOLDS.persistentFailSweeps) {
        continue;
      }
      // Reserve, live-reserve and redemption findings are status-level only
      // (ADR-42): their probes still floor `/status`, but a persistent failure
      // must never create an operator Telegram condition.
      if (isStatusLevelOnlyProbePath(failure.path)) continue;
      conditions.push({
        id: `${failure.lane}:${failure.path}`,
        label: `${failure.lane}:${failure.path} (${failure.failStreak} failed sweeps >= ${STATUS_PROBE_THRESHOLDS.persistentFailSweeps}; observed ${row.created_at})`,
        active: true,
      });
    }
    return { conditions, unknown: false };
  } catch {
    return { conditions: [], unknown: true };
  }
}
