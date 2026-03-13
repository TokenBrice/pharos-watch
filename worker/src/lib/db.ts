import { D1_BATCH_SIZE } from "./constants";

/** Execute D1 prepared statements in chunks to stay within the batch limit */
export async function batchExecute(
  db: D1Database,
  stmts: D1PreparedStatement[],
  chunkSize = D1_BATCH_SIZE,
): Promise<number> {
  let changes = 0;
  for (let i = 0; i < stmts.length; i += chunkSize) {
    const result = await db.batch(stmts.slice(i, i + chunkSize));
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

/** Earliest supply_history snapshot per coin — used so young coins aren't scored over a phantom 4-year window. */
export async function getFirstSeenDates(db: D1Database): Promise<Map<string, number>> {
  const result = await db
    .prepare("SELECT stablecoin_id, MIN(snapshot_date) as first_seen FROM supply_history GROUP BY stablecoin_id")
    .all<{ stablecoin_id: string; first_seen: number }>();
  const map = new Map<string, number>();
  for (const row of result.results ?? []) {
    map.set(row.stablecoin_id, row.first_seen);
  }
  return map;
}
