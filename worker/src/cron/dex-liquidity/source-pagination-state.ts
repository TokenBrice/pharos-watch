import { isMissingTableError } from "../../lib/db";
import { logWorkerEvent } from "../../lib/structured-log";

export interface DexSourcePaginationState {
  cursor: string | null;
  cycleStartedAt: number | null;
  updatedAt: number | null;
  completedAt: number | null;
  pagesFetched: number;
}

function warnStateFailure(error: unknown): void {
  if (!isMissingTableError(error)) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "dex_liquidity.pagination_state_unavailable",
      job: "sync-dex-liquidity",
      message: "Durable DEX pagination cursor unavailable; using head fallback",
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
    warnStateFailure(error);
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
}): Promise<void> {
  if (!params.db) return;
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
  } catch (error) {
    warnStateFailure(error);
  }
}
