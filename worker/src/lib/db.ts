import { D1_BATCH_SIZE } from "./constants";
import { runWithOverloadRetry } from "./cron-lease";

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
  return {
    sql: new Array(values.length).fill("?").join(","),
    binds: [...values],
  };
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

async function readFirstSeenCache(db: D1Database, nowSec: number): Promise<Map<string, number> | null> {
  const row = await db
    .prepare("SELECT value, updated_at FROM cache WHERE key = ?")
    .bind(FIRST_SEEN_CACHE_KEY)
    .first<{ value: string; updated_at: number }>();
  if (!row || nowSec - row.updated_at > FIRST_SEEN_CACHE_MAX_AGE_SEC) return null;
  return parseFirstSeenCache(row.value);
}

async function writeFirstSeenCache(db: D1Database, firstSeen: Map<string, number>, nowSec: number): Promise<void> {
  const firstSeenById = Object.fromEntries(firstSeen);
  const payload: FirstSeenCachePayload = { version: 1, firstSeenById };
  await db
    .prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(FIRST_SEEN_CACHE_KEY, JSON.stringify(payload), nowSec)
    .run();
}

/** Earliest supply_history snapshot per coin — used so young coins aren't scored over a phantom 4-year window. */
export async function getFirstSeenDates(db: D1Database): Promise<Map<string, number>> {
  const nowSec = Math.floor(Date.now() / 1000);
  const cached = await readFirstSeenCache(db, nowSec);
  if (cached) return cached;

  const result = await db
    .prepare("SELECT stablecoin_id, MIN(snapshot_date) as first_seen FROM supply_history GROUP BY stablecoin_id")
    .all<{ stablecoin_id: string; first_seen: number }>();
  const map = new Map<string, number>();
  for (const row of result.results ?? []) {
    map.set(row.stablecoin_id, row.first_seen);
  }
  await writeFirstSeenCache(db, map, nowSec);
  return map;
}
