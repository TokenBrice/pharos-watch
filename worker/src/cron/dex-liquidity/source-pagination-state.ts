import { isMissingTableError } from "../../lib/db";
import { logWorkerEvent } from "../../lib/structured-log";
import type {
  DexPaginationPersistenceErrorClass,
  DexPaginationPersistenceSummary,
} from "../../lib/dex-api-common";

export interface DexSourcePaginationState {
  cursor: string | null;
  cycleStartedAt: number | null;
  updatedAt: number | null;
  completedAt: number | null;
  pagesFetched: number;
}

export type DexSourcePaginationWriteOutcome =
  | { written: true; errorClass: null }
  | { written: false; errorClass: DexPaginationPersistenceErrorClass };

export interface DexSourcePaginationWriteAttempt {
  sourceKey: string;
  outcome: DexSourcePaginationWriteOutcome;
}

export function summarizeDexSourcePaginationWrites(
  attempts: readonly DexSourcePaginationWriteAttempt[],
): DexPaginationPersistenceSummary {
  return {
    attempts: attempts.length,
    written: attempts.filter((attempt) => attempt.outcome.written).length,
    failures: attempts
      .filter((attempt): attempt is DexSourcePaginationWriteAttempt & {
        outcome: Extract<DexSourcePaginationWriteOutcome, { written: false }>;
      } => !attempt.outcome.written)
      .slice(0, 12)
      .map((attempt) => ({
        sourceKey: attempt.sourceKey,
        errorClass: attempt.outcome.errorClass,
      })),
  };
}

export function isDegradingDexPaginationWriteFailure(
  outcome: DexSourcePaginationWriteOutcome,
): boolean {
  return !outcome.written && outcome.errorClass === "write-failed";
}

export function describeDexPaginationWriteFailure(
  label: string,
  outcome: DexSourcePaginationWriteOutcome,
): string | null {
  if (outcome.written || outcome.errorClass === "not-configured") return null;
  if (outcome.errorClass === "missing-table") {
    return `${label}: pagination cursor persistence unavailable (missing-table rollout compatibility)`;
  }
  return `${label}: pagination cursor persistence failed (write-failed); stored cursor remains retryable`;
}

function warnStateFailure(error: unknown, operation: "read" | "write"): void {
  if (!isMissingTableError(error)) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "dex_liquidity.pagination_state_unavailable",
      job: "sync-dex-liquidity",
      message: operation === "read"
        ? "Durable DEX pagination cursor unavailable; using head fallback"
        : "Durable DEX pagination cursor write failed; stored cursor remains retryable",
      metadata: { operation },
      error,
    });
  }
}

export async function readDexSourcePaginationState(
  db: D1Database | undefined,
  sourceKey: string,
): Promise<DexSourcePaginationState> {
  if (!db) {
    return { cursor: null, cycleStartedAt: null, updatedAt: null, completedAt: null, pagesFetched: 0 };
  }
  try {
    const row = await db.prepare(
      `SELECT cursor, cycle_started_at, updated_at, completed_at, pages_fetched
         FROM dex_source_pagination_state
        WHERE source_key = ?`,
    ).bind(sourceKey).first<{
      cursor: string | null;
      cycle_started_at: number | null;
      updated_at: number | null;
      completed_at: number | null;
      pages_fetched: number | null;
    }>();
    return {
      cursor: row?.cursor ?? null,
      cycleStartedAt: row?.cycle_started_at ?? null,
      updatedAt: row?.updated_at ?? null,
      completedAt: row?.completed_at ?? null,
      pagesFetched: row?.pages_fetched ?? 0,
    };
  } catch (error) {
    warnStateFailure(error, "read");
    return { cursor: null, cycleStartedAt: null, updatedAt: null, completedAt: null, pagesFetched: 0 };
  }
}

export async function writeDexSourcePaginationState(params: {
  db?: D1Database;
  sourceKey: string;
  cursor: string | null;
  cycleStartedAt: number;
  nowSec: number;
  completed: boolean;
  pagesFetched: number;
  diagnostics?: readonly string[];
}): Promise<DexSourcePaginationWriteOutcome> {
  if (!params.db) return { written: false, errorClass: "not-configured" };
  const diagnostics = (params.diagnostics ?? []).slice(0, 12).map((value) => value.slice(0, 240));
  try {
    await params.db.prepare(
      `INSERT INTO dex_source_pagination_state
         (source_key, cursor, cycle_started_at, updated_at, completed_at, pages_fetched, diagnostics_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_key) DO UPDATE SET
         cursor = excluded.cursor,
         cycle_started_at = excluded.cycle_started_at,
         updated_at = excluded.updated_at,
         completed_at = excluded.completed_at,
         pages_fetched = excluded.pages_fetched,
         diagnostics_json = excluded.diagnostics_json`,
    ).bind(
      params.sourceKey,
      params.cursor,
      params.cycleStartedAt,
      params.nowSec,
      params.completed ? params.nowSec : null,
      params.pagesFetched,
      JSON.stringify(diagnostics),
    ).run();
    return { written: true, errorClass: null };
  } catch (error) {
    warnStateFailure(error, "write");
    return {
      written: false,
      errorClass: isMissingTableError(error) ? "missing-table" : "write-failed",
    };
  }
}
