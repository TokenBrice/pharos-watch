import { D1_BATCH_SIZE } from "./constants";
import { chunkArray } from "./collections";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  readCacheWithPolicy,
  writeCacheWithPolicy,
  type CachePolicy,
} from "./db-cache";

export const D1_MAX_BOUND_PARAMETERS = 100;
export { D1_SAFE_IN_CLAUSE_BIND_LIMIT, chunkArray } from "./collections";

export interface BatchExecuteOptions {
  chunkSize?: number;
  signal?: AbortSignal;
}

export interface AtomicBatchExecuteOptions {
  signal?: AbortSignal;
  returnResults?: false;
}

export interface AtomicBatchExecuteResultOptions {
  signal?: AbortSignal;
  returnResults: true;
}

function d1ErrorMessage(error: unknown): string {
  return toErrorMessage(error);
}

export function isMissingTableError(error: unknown): boolean {
  return d1ErrorMessage(error).toLowerCase().includes("no such table");
}

/** Execute D1 prepared statements in chunks to stay within the batch limit */
export async function batchExecute(
  db: D1Database,
  stmts: D1PreparedStatement[],
  optionsOrChunkSize: number | BatchExecuteOptions = D1_BATCH_SIZE,
): Promise<number> {
  const options = typeof optionsOrChunkSize === "number"
    ? { chunkSize: optionsOrChunkSize }
    : optionsOrChunkSize;
  const chunkSize = options.chunkSize ?? D1_BATCH_SIZE;
  const signal = options.signal;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError(`batchExecute requires a positive integer chunkSize (received ${chunkSize})`);
  }
  let changes = 0;
  for (let i = 0; i < stmts.length; i += chunkSize) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const result = await runWithOverloadRetry(() => db.batch(stmts.slice(i, i + chunkSize)), 3, signal);
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    for (const row of result) {
      changes += Number(row?.meta?.changes ?? 0);
    }
  }
  return changes;
}

/** Execute one bounded D1 batch so every statement commits or rolls back together. */
export function executeAtomicBatch(
  db: D1Database,
  stmts: D1PreparedStatement[],
  options: AtomicBatchExecuteResultOptions,
): Promise<D1Result[]>;
export function executeAtomicBatch(
  db: D1Database,
  stmts: D1PreparedStatement[],
  options?: AtomicBatchExecuteOptions,
): Promise<number>;
export async function executeAtomicBatch(
  db: D1Database,
  stmts: D1PreparedStatement[],
  options: AtomicBatchExecuteOptions | AtomicBatchExecuteResultOptions = {},
): Promise<number | D1Result[]> {
  if (stmts.length === 0) return options.returnResults ? [] : 0;
  if (stmts.length > D1_BATCH_SIZE) {
    throw new RangeError(
      `executeAtomicBatch supports at most ${D1_BATCH_SIZE} statements (received ${stmts.length})`,
    );
  }

  const { signal } = options;
  if (signal?.aborted) throw signal.reason ?? new Error("aborted");
  const result = await runWithOverloadRetry(() => db.batch(stmts), 3, signal);
  if (signal?.aborted) throw signal.reason ?? new Error("aborted");
  if (options.returnResults) return result;
  return result.reduce((changes, row) => changes + Number(row?.meta?.changes ?? 0), 0);
}

/**
 * Prepare bounded multi-row INSERT statements without exceeding D1's bind limit.
 * `insertSql` must contain the INSERT target/columns but not a VALUES clause.
 */
export function prepareMultiRowInsertStatements(
  db: D1Database,
  insertSql: string,
  rows: readonly (readonly unknown[])[],
): D1PreparedStatement[] {
  if (rows.length === 0) return [];
  const columnCount = rows[0]?.length ?? 0;
  if (columnCount <= 0 || columnCount > D1_MAX_BOUND_PARAMETERS) {
    throw new RangeError(
      `prepareMultiRowInsertStatements requires 1-${D1_MAX_BOUND_PARAMETERS} columns (received ${columnCount})`,
    );
  }
  if (rows.some((row) => row.length !== columnCount)) {
    throw new RangeError("prepareMultiRowInsertStatements requires rows with a consistent column count");
  }

  const rowsPerStatement = Math.floor(D1_MAX_BOUND_PARAMETERS / columnCount);
  return chunkArray(rows, rowsPerStatement).map((chunk) => {
    const rowPlaceholders = `(${new Array(columnCount).fill("?").join(", ")})`;
    const valuesSql = new Array(chunk.length).fill(rowPlaceholders).join(", ");
    return db.prepare(`${insertSql} VALUES ${valuesSql}`).bind(...chunk.flat());
  });
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

export async function getLastBlock(db: D1Database, configKey: string, signal?: AbortSignal): Promise<number> {
  const normalizedKey = normalizeBlacklistSyncStateKey(configKey);
  const keyCandidates = [...new Set([configKey, normalizedKey])];
  const keyInClause = buildInClause(keyCandidates);
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT config_key, last_block
         FROM blacklist_sync_state
         WHERE config_key IN (${keyInClause.sql})`,
      )
      .bind(...keyInClause.binds)
      .all<{ config_key: string; last_block: number }>(),
    3,
    signal,
  );

  return Math.max(0, ...(rows.results ?? []).map((row) => row.last_block));
}

export async function setLastBlock(
  db: D1Database,
  configKey: string,
  block: number,
  signal?: AbortSignal,
): Promise<void> {
  const normalizedKey = normalizeBlacklistSyncStateKey(configKey);
  await runWithOverloadRetry(() =>
    db
      .prepare("INSERT OR REPLACE INTO blacklist_sync_state (config_key, last_block) VALUES (?, ?)")
      .bind(normalizedKey, block)
      .run(),
    3,
    signal,
  );
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

const FIRST_SEEN_CACHE_POLICY: CachePolicy<Map<string, number>> = {
  key: FIRST_SEEN_CACHE_KEY,
  storage: "d1-kv",
  schemaId: "supply-history:first-seen:v1",
  ttlSec: FIRST_SEEN_CACHE_MAX_AGE_SEC,
  maxEntries: 1,
  stale: "fallback-only",
  invalid: "retain",
  decode: parseFirstSeenCache,
  encode: (value) => JSON.stringify({
    version: 1,
    firstSeenById: Object.fromEntries(value),
  } satisfies FirstSeenCachePayload),
};

async function readFirstSeenCache(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
): Promise<FirstSeenCacheRead | null> {
  const cached = await readCacheWithPolicy(db, FIRST_SEEN_CACHE_POLICY, nowSec, signal);
  if (cached.state === "missing" || cached.state === "invalid" || cached.value == null) return null;
  return {
    map: cached.value,
    fresh: cached.state === "fresh",
  };
}

async function writeFirstSeenCache(
  db: D1Database,
  firstSeen: Map<string, number>,
  nowSec: number,
  signal?: AbortSignal,
): Promise<void> {
  await writeCacheWithPolicy(db, FIRST_SEEN_CACHE_POLICY, firstSeen, nowSec, signal);
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
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const nowSec = Math.floor(Date.now() / 1000);
  const cached = await readFirstSeenCache(db, nowSec, signal);
  if (cached?.fresh && observations.length === 0) return cached.map;

  const map = cached?.fresh ? new Map(cached.map) : new Map<string, number>();

  if (!cached?.fresh) {
    for (const [id, firstSeen] of cached?.map ?? []) {
      mergeFirstSeen(map, id, firstSeen);
    }

    const result = await runWithOverloadRetry(() =>
      db
        .prepare("SELECT stablecoin_id, MIN(snapshot_date) as first_seen FROM supply_history GROUP BY stablecoin_id")
        .all<{ stablecoin_id: string; first_seen: number }>(),
      3,
      signal,
    );
    for (const row of result.results ?? []) {
      mergeFirstSeen(map, row.stablecoin_id, row.first_seen);
    }
  }

  const changed = mergeObservedFirstSeen(map, observations, nowSec);
  if (!cached?.fresh || changed) {
    await writeFirstSeenCache(db, map, nowSec, signal);
  }

  return map;
}
