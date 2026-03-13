import { batchExecute } from "./db";

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

export async function shouldSkipFreshCache(db: D1Database, key: string, maxAgeSec: number): Promise<boolean> {
  const cached = await getCache(db, key);
  if (!cached) return false;
  return Date.now() / 1000 - cached.updatedAt < maxAgeSec;
}

/**
 * Compare-and-swap cache write: only updates if the existing row is older than `syncStartSec`.
 * Prevents a slow cron run from overwriting a newer run's data.
 */
export async function setCacheIfNewer(db: D1Database, key: string, value: string, syncStartSec: number): Promise<void> {
  const result = await db
    .prepare(
      `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE cache.updated_at <= excluded.updated_at`,
    )
    .bind(key, value, syncStartSec)
    .run();
  if (result.meta.changes === 0) {
    console.log(`[cache] Skipped write for "${key}" — existing data is newer (started_at > ${syncStartSec})`);
  }
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
    db
      .prepare("INSERT OR REPLACE INTO price_cache (asset_id, price, updated_at) VALUES (?, ?, ?)")
      .bind(e.id, e.price, now),
  );
  await batchExecute(db, stmts);
}
