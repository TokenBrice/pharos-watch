import { D1_BATCH_SIZE } from "./constants";

/** Execute D1 prepared statements in chunks to stay within the batch limit */
export async function batchExecute(db: D1Database, stmts: D1PreparedStatement[], chunkSize = D1_BATCH_SIZE): Promise<void> {
  for (let i = 0; i < stmts.length; i += chunkSize) {
    await db.batch(stmts.slice(i, i + chunkSize));
  }
}

/** Build WHERE, LIMIT, and OFFSET clauses for paginated SQL queries */
export function buildPaginatedQuery(opts: {
  conditions: string[];
  bindings: (string | number)[];
  limit: number;
  offset: number;
}): { where: string; limitClause: string; offsetClause: string; paginationBindings: number[] } {
  const where = opts.conditions.length > 0 ? ` WHERE ${opts.conditions.join(" AND ")}` : "";
  const limitClause = opts.limit > 0 ? " LIMIT ?" : opts.offset > 0 ? " LIMIT -1" : "";
  const offsetClause = opts.offset > 0 ? " OFFSET ?" : "";
  const paginationBindings: number[] = [];
  if (opts.limit > 0) paginationBindings.push(opts.limit);
  if (opts.offset > 0) paginationBindings.push(opts.offset);
  return { where, limitClause, offsetClause, paginationBindings };
}

export async function getCache(db: D1Database, key: string): Promise<{ value: string; updatedAt: number } | null> {
  const row = await db
    .prepare("SELECT value, updated_at FROM cache WHERE key = ?")
    .bind(key)
    .first<{ value: string; updated_at: number }>();
  if (!row) return null;
  return { value: row.value, updatedAt: row.updated_at };
}

export async function setCache(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(key, value, Math.floor(Date.now() / 1000))
    .run();
}

/**
 * Compare-and-swap cache write: only updates if the existing row is older than `syncStartSec`.
 * Prevents a slow cron run from overwriting a newer run's data.
 */
export async function setCacheIfNewer(db: D1Database, key: string, value: string, syncStartSec: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  // Try UPDATE first (only if existing row is older)
  const result = await db
    .prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ? AND updated_at <= ?")
    .bind(value, now, key, syncStartSec)
    .run();
  // If no row was updated (either no row exists or existing is newer), INSERT if missing
  if (result.meta.changes === 0) {
    await db
      .prepare("INSERT OR IGNORE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(key, value, now)
      .run();
  }
}

export async function getLastBlock(db: D1Database, configKey: string): Promise<number> {
  const row = await db
    .prepare("SELECT last_block FROM blacklist_sync_state WHERE config_key = ?")
    .bind(configKey)
    .first<{ last_block: number }>();
  return row?.last_block ?? 0;
}

export async function setLastBlock(db: D1Database, configKey: string, block: number): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO blacklist_sync_state (config_key, last_block) VALUES (?, ?)")
    .bind(configKey, block)
    .run();
}

export async function getPriceCache(db: D1Database): Promise<Map<string, { price: number; updatedAt: number }>> {
  const result = await db
    .prepare("SELECT asset_id, price, updated_at FROM price_cache")
    .all<{ asset_id: string; price: number; updated_at: number }>();
  const map = new Map<string, { price: number; updatedAt: number }>();
  for (const row of result.results ?? []) {
    map.set(row.asset_id, { price: row.price, updatedAt: row.updated_at });
  }
  return map;
}

export async function savePriceCache(db: D1Database, entries: { id: string; price: number }[]): Promise<void> {
  if (entries.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const stmts = entries.map((e) =>
    db.prepare("INSERT OR REPLACE INTO price_cache (asset_id, price, updated_at) VALUES (?, ?, ?)").bind(e.id, e.price, now)
  );
  await db.batch(stmts);
}
