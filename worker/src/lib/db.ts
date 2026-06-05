import { D1_BATCH_SIZE } from "./constants";
import { chunkArray } from "./collections";
import { runWithOverloadRetry } from "./cron-lease";

export const D1_MAX_BOUND_PARAMETERS = 100;
export { D1_SAFE_IN_CLAUSE_BIND_LIMIT, chunkArray } from "./collections";

/** Execute D1 prepared statements in chunks to stay within the batch limit */
export async function batchExecute(
  db: D1Database,
  stmts: D1PreparedStatement[],
  chunkSize = D1_BATCH_SIZE,
): Promise<number> {
  let changes = 0;
  for (let i = 0; i < stmts.length; i += chunkSize) {
    const result = await runWithOverloadRetry(() => db.batch(stmts.slice(i, i + chunkSize)));
    for (const row of result) {
      changes += Number(row?.meta?.changes ?? 0);
    }
  }
  return changes;
}

/** Build WHERE, LIMIT, and OFFSET clauses for paginated SQL queries */
export function buildPaginatedQuery(opts: { conditions: string[]; limit: number; offset: number }): {
  where: string;
  limitClause: string;
  offsetClause: string;
  paginationBindings: number[];
} {
  const where = opts.conditions.length > 0 ? ` WHERE ${opts.conditions.join(" AND ")}` : "";
  const limitClause = opts.limit > 0 ? " LIMIT ?" : opts.offset > 0 ? " LIMIT -1" : "";
  const offsetClause = opts.offset > 0 ? " OFFSET ?" : "";
  const paginationBindings: number[] = [];
  if (opts.limit > 0) paginationBindings.push(opts.limit);
  if (opts.offset > 0) paginationBindings.push(opts.offset);
  return { where, limitClause, offsetClause, paginationBindings };
}

/**
 * Build a safe SQL IN-clause with parameterized placeholders.
 * Returns the SQL fragment (e.g. "?,?,?") and the bind values.
 */
export function buildInClause(values: readonly unknown[]): { sql: string; binds: unknown[] } {
  if (values.length === 0) throw new Error("buildInClause: empty array");
  if (values.length > D1_MAX_BOUND_PARAMETERS) {
    throw new Error(
      `buildInClause: ${values.length} values exceeds D1 bound-parameter limit ${D1_MAX_BOUND_PARAMETERS}`,
    );
  }
  return {
    sql: new Array(values.length).fill("?").join(","),
    binds: [...values],
  };
}

export async function runChunkedInFilter<T>(
  values: readonly T[],
  buildSql: (inClauseSql: string) => string,
  runQuery: (whereSql: string, binds: unknown[]) => Promise<void>,
): Promise<void> {
  for (const chunk of chunkArray(values)) {
    const clause = buildInClause(chunk);
    await runQuery(buildSql(clause.sql), clause.binds);
  }
}

export async function runChunkedInRead<T, Row>(
  values: readonly T[],
  buildSql: (inClauseSql: string) => string,
  readRows: (whereSql: string, binds: unknown[]) => Promise<Row[]>,
): Promise<Row[]> {
  const rows: Row[] = [];
  await runChunkedInFilter(values, buildSql, async (whereSql, binds) => {
    rows.push(...(await readRows(whereSql, binds)));
  });
  return rows;
}

export async function insertReturningMapped<Row, Mapped>(
  db: D1Database,
  sql: string,
  binds: readonly unknown[],
  map: (row: Row) => Mapped,
  label: string,
): Promise<Mapped> {
  const row = await db
    .prepare(sql)
    .bind(...binds)
    .first<Row>();
  if (!row) throw new Error(`${label} insert could not be reloaded`);
  return map(row);
}

export function normalizeBlacklistSyncStateKey(configKey: string): string {
  if (configKey.startsWith("tron-")) return configKey;
  const separator = configKey.indexOf("-");
  if (separator === -1) return configKey;
  return `${configKey.slice(0, separator)}-${configKey.slice(separator + 1).toLowerCase()}`;
}

export async function getLastBlock(db: D1Database, configKey: string): Promise<number> {
  const normalizedKey = normalizeBlacklistSyncStateKey(configKey);
  const keyCandidates = [...new Set([configKey, normalizedKey])];
  const keyInClause = buildInClause(keyCandidates);
  const rows = await db
    .prepare(
      `SELECT config_key, last_block
       FROM blacklist_sync_state
       WHERE config_key IN (${keyInClause.sql})`,
    )
    .bind(...keyInClause.binds)
    .all<{ config_key: string; last_block: number }>();

  return Math.max(0, ...(rows.results ?? []).map((row) => row.last_block));
}

export async function setLastBlock(db: D1Database, configKey: string, block: number): Promise<void> {
  const normalizedKey = normalizeBlacklistSyncStateKey(configKey);
  await db
    .prepare("INSERT OR REPLACE INTO blacklist_sync_state (config_key, last_block) VALUES (?, ?)")
    .bind(normalizedKey, block)
    .run();
}

// --- Coin first-seen dates (for peg score tracking window) ---

const FIRST_SEEN_CACHE_KEY = "supply-history:first-seen-dates";
const FIRST_SEEN_CACHE_MAX_AGE_SEC = 24 * 60 * 60;

interface FirstSeenCachePayload {
  version: 1;
  firstSeenById: Record<string, number>;
}

export interface FirstSeenObservation {
  id: string;
  observedAtSec: number | null | undefined;
}

interface FirstSeenCacheRead {
  map: Map<string, number>;
  fresh: boolean;
}

function parseFirstSeenCache(value: string): Map<string, number> | null {
  try {
    const payload = JSON.parse(value) as Partial<FirstSeenCachePayload>;
    if (payload.version !== 1 || !payload.firstSeenById || typeof payload.firstSeenById !== "object") {
      return null;
    }
    const map = new Map<string, number>();
    for (const [id, firstSeen] of Object.entries(payload.firstSeenById)) {
      if (typeof id !== "string" || typeof firstSeen !== "number" || !Number.isFinite(firstSeen)) {
        return null;
      }
      map.set(id, firstSeen);
    }
    return map;
  } catch {
    return null;
  }
}

async function readFirstSeenCache(db: D1Database, nowSec: number): Promise<FirstSeenCacheRead | null> {
  const row = await db
    .prepare("SELECT value, updated_at FROM cache WHERE key = ?")
    .bind(FIRST_SEEN_CACHE_KEY)
    .first<{ value: string; updated_at: number }>();
  if (!row) return null;
  const parsed = parseFirstSeenCache(row.value);
  if (!parsed) return null;
  return {
    map: parsed,
    fresh: nowSec - row.updated_at <= FIRST_SEEN_CACHE_MAX_AGE_SEC,
  };
}

async function writeFirstSeenCache(db: D1Database, firstSeen: Map<string, number>, nowSec: number): Promise<void> {
  const firstSeenById = Object.fromEntries(firstSeen);
  const payload: FirstSeenCachePayload = { version: 1, firstSeenById };
  await db
    .prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(FIRST_SEEN_CACHE_KEY, JSON.stringify(payload), nowSec)
    .run();
}

function mergeFirstSeen(map: Map<string, number>, id: string, firstSeenSec: number): boolean {
  if (!id || !Number.isFinite(firstSeenSec) || firstSeenSec <= 0) return false;
  const current = map.get(id);
  if (current != null && current <= firstSeenSec) return false;
  map.set(id, Math.floor(firstSeenSec));
  return true;
}

function mergeObservedFirstSeen(
  map: Map<string, number>,
  observations: readonly FirstSeenObservation[],
  nowSec: number,
): boolean {
  let changed = false;
  for (const observation of observations) {
    const observedAtSec = observation.observedAtSec;
    if (typeof observedAtSec !== "number" || !Number.isFinite(observedAtSec) || observedAtSec <= 0) continue;
    // Provider timestamps can occasionally skew forward; do not let them create a future tracking anchor.
    const boundedObservedAt = Math.min(Math.floor(observedAtSec), nowSec);
    changed = mergeFirstSeen(map, observation.id, boundedObservedAt) || changed;
  }
  return changed;
}

/** Earliest tracking anchor per coin — used so young coins aren't scored over a phantom 4-year window. */
export async function getFirstSeenDates(
  db: D1Database,
  observations: readonly FirstSeenObservation[] = [],
): Promise<Map<string, number>> {
  const nowSec = Math.floor(Date.now() / 1000);
  const cached = await readFirstSeenCache(db, nowSec);
  if (cached?.fresh && observations.length === 0) return cached.map;

  const map = cached?.fresh ? new Map(cached.map) : new Map<string, number>();

  if (!cached?.fresh) {
    for (const [id, firstSeen] of cached?.map ?? []) {
      mergeFirstSeen(map, id, firstSeen);
    }

    const result = await db
      .prepare("SELECT stablecoin_id, MIN(snapshot_date) as first_seen FROM supply_history GROUP BY stablecoin_id")
      .all<{ stablecoin_id: string; first_seen: number }>();
    for (const row of result.results ?? []) {
      mergeFirstSeen(map, row.stablecoin_id, row.first_seen);
    }
  }

  const changed = mergeObservedFirstSeen(map, observations, nowSec);
  if (!cached?.fresh || changed) {
    await writeFirstSeenCache(db, map, nowSec);
  }

  return map;
}
