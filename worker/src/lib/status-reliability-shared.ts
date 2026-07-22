import { toErrorMessage } from "./error-utils";
import type {  StatusCause,
  StatusSectionError,
  StatusStateInfo,
} from "@shared/types/status";
import { clamp } from "@shared/lib/math";
import { decodeJsonString } from "./cache-json";
import { runWithOverloadRetry } from "./cron-lease";
import { logMalformedJsonPath } from "./json-decode-observability";

export type StatusLevel = "healthy" | "degraded" | "stale";

export const STATUS_SCOPE = "global" as const;

export const STATUS_HYSTERESIS = {
  escalateToDegraded: 2,
  escalateToStale: 1,
  recoverToDegraded: 2,
  recoverToHealthy: 3,
  minDwellSec: 120,
  staleMinDwellSec: 180,
} as const;

export const STATUS_SYSTEM_FRESHNESS_SEC = 1800;

/**
 * Consecutive-stale readings required to transition degraded → stale.
 * Intentionally stricter than `STATUS_HYSTERESIS.escalateToStale` (the
 * healthy → stale path). Rationale: once the system has already acknowledged
 * degradation, we want two consecutive stale samples before escalating,
 * preventing flap-through from a single noisy probe.
 */
export const STATUS_DEGRADED_TO_STALE_THRESHOLD = 2 as const;

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

export interface StatusTransitionRow {
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

export const SEVERITY: Record<StatusLevel, number> = { healthy: 0, degraded: 1, stale: 2 };

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
      mode: "best-effort",
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

export function transitionType(from: StatusLevel | null, to: StatusLevel): "degrade" | "recover" | "init" {
  if (!from) return "init";
  return SEVERITY[to] > SEVERITY[from] ? "degrade" : "recover";
}

export function buildStatusTransitionIdempotencyKey(input: {
  scope: string;
  previousStatus: StatusLevel | null;
  nextStatus: StatusLevel;
  rawStatus: StatusLevel;
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
  status: StatusLevel;
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
    console.error(`[status-reliability] ${operation} failed: ${message}`);
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
): Promise<boolean> {
  try {
    await runWithOverloadRetry(() => db.batch(statements));
    return true;
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "status_state_persistence_failed", operation, error);
    return false;
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
