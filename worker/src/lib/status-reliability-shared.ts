import { getStatusSeverity, STATUS_SYSTEM_FRESHNESS_SEC } from "@shared/lib/public-health";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { CRON_TIMEOUT_MS } from "./cron-timeouts";
import { logWorkerEventArgs } from "./structured-log";
import { toErrorMessage } from "@shared/lib/error-utils";
import type {  StatusCause,
  StatusSectionError,
  StatusStateInfo,
} from "@shared/types/status";
import type { StatusHealthValue } from "@shared/types/status/core";
import { clamp } from "@shared/lib/math";
import { decodeJsonString } from "./cache-json";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { logMalformedJsonPath } from "./json-decode-observability";

export const STATUS_SCOPE = "global" as const;

export const STATUS_HYSTERESIS = {
  escalateToDegraded: 2,
  // One stale reading is one sample: three single failed D1 reads turned a
  // healthy state stale at once on 2026-11-05/10. Stale needs two, from any state.
  escalateToStale: 2,
  recoverToDegraded: 2,
  recoverToHealthy: 3,
  minDwellSec: 120,
  staleMinDwellSec: 180,
} as const;

export { STATUS_SYSTEM_FRESHNESS_SEC };

const STATUS_SELF_CHECK_TIMEOUT_SEC = Math.ceil(CRON_TIMEOUT_MS["status-self-check"] / 1000);

/** A served public snapshot older than one cadence plus the job's timeout missed a publication. */
export const STATUS_SNAPSHOT_OVERDUE_SEC = CRON_INTERVALS["status-self-check"] + STATUS_SELF_CHECK_TIMEOUT_SEC;

/**
 * Two readable samples confirm a change when at most one unevaluated or
 * unpersisted self-check lies between them: twice the cadence plus the job's
 * timeout. A longer gap restarts a streak or pending change (ADR-42).
 */
export const STATUS_SELF_CHECK_CONTINUITY_SEC = 2 * CRON_INTERVALS["status-self-check"] + STATUS_SELF_CHECK_TIMEOUT_SEC;

/**
 * Isolate-scoped dedup set: suppresses repeat `code:operation` error logs within
 * a single Worker isolate (it resets on isolate recycle, so the same error logs
 * again after a restart — this is log-noise reduction, not durable dedup).
 * Capped to avoid unbounded growth in a high-cardinality error scenario.
 */
const LOGGED_STATUS_PERSISTENCE_FAILURES = new Set<string>();
const MAX_LOGGED_STATUS_PERSISTENCE_FAILURES = 200;

export interface StatusPersistenceIssue {
  code: string;
  operation: string;
  message: string;
}

export type StatusPersistenceIssueReporter = (issue: StatusPersistenceIssue) => void;

export interface StatusStateRow {
  scope: string;
  current_status: StatusHealthValue;
  raw_status: StatusHealthValue;
  last_evaluated_at: number;
  last_changed_at: number;
  consecutive_healthy: number;
  consecutive_degraded: number;
  consecutive_stale: number;
  confidence: number;
  causes_json: string | null;
  /** Last write; selected for streak continuity, absent on rows built in memory. */
  updated_at?: number | null;
}

export interface StatusTransitionRow {
  id: number;
  scope: string;
  previous_status: StatusHealthValue | null;
  next_status: StatusHealthValue;
  raw_status: StatusHealthValue;
  transition_type: "degrade" | "recover" | "init";
  reason: string;
  confidence: number;
  causes_json: string | null;
  created_at: number;
}

export const SEVERITY: Record<StatusHealthValue, number> = { healthy: getStatusSeverity("healthy"), degraded: getStatusSeverity("degraded"), stale: getStatusSeverity("stale") };

export function maxStatus(a: StatusHealthValue, b: StatusHealthValue): StatusHealthValue {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

export function clampConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0.1;
  return clamp(confidence, 0.1, 1);
}

export function parseCauses(
  json: string | null | undefined,
  context: string,
  updatedAt?: number | null,
): StatusCause[] {
  const decoded = decodeJsonString<StatusCause[], "missing" | "json-parse-failed" | "invalid-shape">(
    json,
    {
      updatedAt: updatedAt ?? null,
      missingReason: "missing",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => {
        if (!Array.isArray(parsed)) {
          return { ok: false, reason: "invalid-shape" };
        }
        return { ok: true, payload: parsed as StatusCause[] };
      },
    },
  );
  if (!decoded.ok) {
    if (decoded.reason !== "missing") {
      logMalformedJsonPath({
        scope: "lib",
        owner: "status-reliability",
        context,
        reason: decoded.reason,
        source: "status_transitions",
        updatedAt: updatedAt ?? null,
      });
    }
    return [];
  }
  return decoded.payload;
}

export function transitionType(from: StatusHealthValue | null, to: StatusHealthValue): "degrade" | "recover" | "init" {
  if (!from) return "init";
  return SEVERITY[to] > SEVERITY[from] ? "degrade" : "recover";
}

export function buildStatusTransitionIdempotencyKey(input: {
  scope: string;
  previousStatus: StatusHealthValue | null;
  nextStatus: StatusHealthValue;
  rawStatus: StatusHealthValue;
  transitionType: "degrade" | "recover" | "init";
  reason: string;
  confidence: number;
  causesJson: string | null;
  createdAt: number;
}): string {
  return JSON.stringify(input);
}

export function buildStatusProbeRunIdempotencyKey(input: {
  createdAt: number;
  status: StatusHealthValue;
  sampleCount: number;
  passCount: number;
  failCount: number;
  p95LatencyMs: number;
  detailsJson: string | null;
}): string {
  return JSON.stringify(input);
}

export function reportStatusPersistenceIssue(
  report: StatusPersistenceIssueReporter | undefined,
  code: string,
  operation: string,
  error: unknown,
): void {
  const message = toErrorMessage(error);
  const logKey = `${code}:${operation}`;
  if (!LOGGED_STATUS_PERSISTENCE_FAILURES.has(logKey)) {
    if (LOGGED_STATUS_PERSISTENCE_FAILURES.size < MAX_LOGGED_STATUS_PERSISTENCE_FAILURES) {
      LOGGED_STATUS_PERSISTENCE_FAILURES.add(logKey);
    }
    logWorkerEventArgs("lib", "error", `[status-reliability] ${operation} failed: ${message}`);
  }
  report?.({
    code,
    operation,
    message,
  });
}

export async function persistStatusStateAtomically(
  db: D1Database,
  statements: D1PreparedStatement[],
  onIssue: StatusPersistenceIssueReporter | undefined,
  operation: string,
): Promise<D1Result[] | null> {
  try {
    return await runWithOverloadRetry(() => db.batch(statements));
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_state_persistence_failed", operation, error);
    return null;
  }
}

export function summarizeStatusPersistenceIssues(
  issues: StatusPersistenceIssue[],
): StatusSectionError | undefined {
  if (issues.length === 0) return undefined;
  return {
    code: issues.length === 1 ? issues[0]!.code : "status_persistence_degraded",
    message: "Status persistence degraded.",
  };
}

export function toStateInfo(row: StatusStateRow): StatusStateInfo {
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

export function buildFallbackStatusState(rawStatus: StatusHealthValue, now: number): StatusStateInfo {
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
