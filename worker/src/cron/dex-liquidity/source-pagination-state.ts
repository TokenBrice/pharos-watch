import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { isMissingTableError } from "../../lib/db";
import { logWorkerEvent } from "../../lib/structured-log";
import type {
  DexApiFetchResult,
  DexPaginationPersistenceErrorClass,
  DexPaginationPersistenceSummary,
} from "../../lib/dex-api-common";

export interface DexSourcePaginationState {
  cursor: string | null;
  cycleStartedAt: number | null;
  updatedAt: number | null;
  completedAt: number | null;
  pagesFetched: number;
  /** Exact persisted revision; undefined means the read failed or had no database. */
  revision?: { updatedAt: number | null; diagnosticsJson: string | null };
}

export type DexSourcePaginationWriteOutcome =
  | { written: true; errorClass: null }
  | { written: false; errorClass: DexPaginationPersistenceErrorClass };

export interface DexSourcePaginationWriteAttempt {
  sourceKey: string;
  outcome: DexSourcePaginationWriteOutcome;
}

export interface PendingDexSourcePaginationUpdate {
  sourceKey: string;
  cursor: string | null;
  cycleStartedAt: number;
  nowSec: number;
  completed: boolean;
  pagesFetched: number;
  diagnostics: readonly string[];
  expectedRevision: NonNullable<DexSourcePaginationState["revision"]>;
  generation: string;
}

export interface PaginatedDexApiFetchResult extends DexApiFetchResult {
  pendingPaginationUpdates?: PendingDexSourcePaginationUpdate[];
  censusScope?: "exhaustive" | "bounded-sample";
}

/** Called only after registry writeback and the complete scoring stage are durable. */
export async function acknowledgeDexSourcePagination(
  db: D1Database,
  updates: readonly PendingDexSourcePaginationUpdate[],
): Promise<DexPaginationPersistenceSummary> {
  const attempts: DexSourcePaginationWriteAttempt[] = [];
  for (const update of updates) {
    const outcome = await writeDexSourcePaginationState({ db, ...update });
    attempts.push({ sourceKey: update.sourceKey, outcome });
  }
  return summarizeDexSourcePaginationWrites(attempts);
}

function summarizeDexSourcePaginationWrites(
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

function warnStateFailure(error: unknown, operation: "read" | "write", job = "sync-dex-liquidity"): void {
  logWorkerEvent({
    scope: "lib",
    level: "warn",
    event: "dex_liquidity.pagination_state_unavailable",
    job,
    message: operation === "read"
      ? "Durable DEX pagination cursor unavailable; using head fallback"
      : "Durable DEX pagination cursor write failed; stored cursor remains retryable",
    metadata: { operation },
    error,
  });
}

export async function readDexSourcePaginationState(
  db: D1Database | undefined,
  sourceKey: string,
  job = "sync-dex-liquidity",
): Promise<DexSourcePaginationState> {
  if (!db) {
    return { cursor: null, cycleStartedAt: null, updatedAt: null, completedAt: null, pagesFetched: 0 };
  }
  try {
    // Idempotent read: transient D1 overload previously fell through to the
    // head fallback and silently restarted cursor rotation.
    const row = await runWithOverloadRetry(
      () =>
        db.prepare(
          `SELECT cursor, cycle_started_at, updated_at, completed_at, pages_fetched, diagnostics_json
         FROM dex_source_pagination_state
        WHERE source_key = ?`,
        ).bind(sourceKey).first<{
          cursor: string | null;
          cycle_started_at: number | null;
          updated_at: number | null;
          completed_at: number | null;
          pages_fetched: number | null;
          diagnostics_json: string | null;
        }>(),
      3,
    );
    return {
      cursor: row?.cursor ?? null,
      cycleStartedAt: row?.cycle_started_at ?? null,
      updatedAt: row?.updated_at ?? null,
      completedAt: row?.completed_at ?? null,
      pagesFetched: row?.pages_fetched ?? 0,
      revision: { updatedAt: row?.updated_at ?? null, diagnosticsJson: row?.diagnostics_json ?? null },
    };
  } catch (error) {
    if (isMissingTableError(error)) throw error;
    warnStateFailure(error, "read", job);
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
  job?: string;
  expectedRevision?: NonNullable<DexSourcePaginationState["revision"]>;
  generation?: string;
}): Promise<DexSourcePaginationWriteOutcome> {
  if (!params.db) return { written: false, errorClass: "not-configured" };
  const diagnostics = (params.diagnostics ?? []).slice(0, 12).map((value) => value.slice(0, 240));
  // A per-attempt token prevents same-second and cursor-cycle ABA overwrites.
  if (params.generation) diagnostics.push(`cursor-generation:${params.generation}`);
  const diagnosticsJson = JSON.stringify(diagnostics);
  try {
    // Idempotent upsert: retry transient D1 overload so a brief contention
    // window does not fail the whole shadow collection after its quotes
    // already persisted.
    const result = await runWithOverloadRetry(
      () =>
        params.db!.prepare(
          `INSERT INTO dex_source_pagination_state
         (source_key, cursor, cycle_started_at, updated_at, completed_at, pages_fetched, diagnostics_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_key) DO UPDATE SET
         cursor = excluded.cursor,
         cycle_started_at = excluded.cycle_started_at,
         updated_at = excluded.updated_at,
         completed_at = excluded.completed_at,
         pages_fetched = excluded.pages_fetched,
         diagnostics_json = excluded.diagnostics_json
       WHERE dex_source_pagination_state.updated_at <= excluded.updated_at
         AND (? = 0 OR (
           dex_source_pagination_state.updated_at IS ?
           AND dex_source_pagination_state.diagnostics_json IS ?
         ) OR dex_source_pagination_state.diagnostics_json = excluded.diagnostics_json)`,
        ).bind(
          params.sourceKey,
          params.cursor,
          params.cycleStartedAt,
          params.nowSec,
          params.completed ? params.nowSec : null,
          params.pagesFetched,
          diagnosticsJson,
          params.expectedRevision ? 1 : 0,
          params.expectedRevision?.updatedAt ?? null,
          params.expectedRevision?.diagnosticsJson ?? null,
        ).run(),
      3,
    );
    if (Number(result.meta?.changes ?? 0) !== 1) {
      return { written: false, errorClass: "write-failed" };
    }
    return { written: true, errorClass: null };
  } catch (error) {
    warnStateFailure(error, "write", params.job);
    return {
      written: false,
      errorClass: "write-failed",
    };
  }
}
