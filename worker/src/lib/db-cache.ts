import { batchExecute, buildInClause } from "./db";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { throwIfAborted } from "./abort";
import type { PriceConfidence, PriceObservedAtMode } from "@shared/types/core";
import {
  getFreshnessSentinelCacheKey,
  getFreshnessSentinelProducerJob,
  type FreshnessSentinelBackedCacheKey,
} from "./freshness-sentinels";
import { toErrorMessage } from "./error-utils";
import { parseJsonStringArray } from "./json-parse";

export async function getCache(db: D1Database, key: string): Promise<{ value: string; updatedAt: number } | null> {
  const row = await runWithOverloadRetry(() =>
    db
      .prepare("SELECT value, updated_at FROM cache WHERE key = ?")
      .bind(key)
      .first<{ value: string; updated_at: number }>(),
  );
  if (!row) return null;
  return { value: row.value, updatedAt: row.updated_at };
}

export async function getCaches(
  db: D1Database,
  keys: readonly string[],
): Promise<Map<string, { value: string; updatedAt: number }>> {
  const uniqueKeys = [...new Set(keys)];
  const rowsByKey = new Map<string, { value: string; updatedAt: number }>();
  if (uniqueKeys.length === 0) return rowsByKey;

  const keyClause = buildInClause(uniqueKeys);
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(`SELECT key, value, updated_at FROM cache WHERE key IN (${keyClause.sql})`)
      .bind(...keyClause.binds)
      .all<{ key: string; value: string; updated_at: number }>(),
  );
  for (const row of rows.results ?? []) {
    rowsByKey.set(row.key, { value: row.value, updatedAt: row.updated_at });
  }
  return rowsByKey;
}

/**
 * Reads only updated_at for a cache key, avoiding the value-column transfer
 * for multi-megabyte payloads when the caller may not need the body.
 */
export async function getCacheUpdatedAt(db: D1Database, key: string): Promise<number | null> {
  const row = await runWithOverloadRetry(() =>
    db
      .prepare("SELECT updated_at FROM cache WHERE key = ?")
      .bind(key)
      .first<{ updated_at: number }>(),
  );
  return row?.updated_at ?? null;
}

export async function setCache(db: D1Database, key: string, value: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await runWithOverloadRetry(() =>
    db
      .prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(key, value, Math.floor(Date.now() / 1000))
      .run(),
    3,
    signal,
  );
  throwIfAborted(signal);
}

export interface CacheEntryWrite {
  key: string;
  value: string;
}

export async function setCacheMany(
  db: D1Database,
  entries: readonly CacheEntryWrite[],
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (entries.length === 0) return;
  const updatedAt = Math.floor(Date.now() / 1000);
  const statement = db.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
  await batchExecute(db, entries.map((entry) => statement.bind(entry.key, entry.value, updatedAt)), { signal });
  throwIfAborted(signal);
}

export async function deleteCache(db: D1Database, key: string): Promise<void> {
  await runWithOverloadRetry(() => db.prepare("DELETE FROM cache WHERE key = ?").bind(key).run());
}


export async function shouldSkipFreshCache(db: D1Database, key: string, maxAgeSec: number): Promise<boolean> {
  const cached = await getCache(db, key);
  if (!cached) return false;
  return Date.now() / 1000 - cached.updatedAt < maxAgeSec;
}

export interface CacheWriteResult {
  written: boolean;
  skippedBecauseNewer: boolean;
}

/**
 * Compare-and-swap cache write: only updates if the existing row is older than `syncStartSec`.
 * Prevents a slow cron run from overwriting a newer run's data.
 */
export async function setCacheIfNewer(
  db: D1Database,
  key: string,
  value: string,
  syncStartSec: number,
  signal?: AbortSignal,
): Promise<CacheWriteResult> {
  throwIfAborted(signal);
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
         WHERE cache.updated_at <= excluded.updated_at`,
      )
      .bind(key, value, syncStartSec)
      .run(),
    3,
    signal,
  );
  throwIfAborted(signal);
  if (result.meta.changes === 0) {
    console.log(`[cache] Skipped write for "${key}" — existing data is newer (started_at > ${syncStartSec})`);
    return { written: false, skippedBecauseNewer: true };
  }
  return { written: true, skippedBecauseNewer: false };
}

export async function writeFreshnessSentinel(
  db: D1Database,
  key: FreshnessSentinelBackedCacheKey,
  syncStartSec: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await setCacheIfNewer(
    db,
    getFreshnessSentinelCacheKey(key),
    JSON.stringify({
      updatedAt: syncStartSec,
      source: getFreshnessSentinelProducerJob(key),
      publishStatus: "ok",
    }),
    syncStartSec,
    signal,
  );
  throwIfAborted(signal);
}

export interface PriceCacheEntry {
  price: number;
  updatedAt: number;
  source?: string | null;
  confidence?: PriceConfidence | null;
  observedAt?: number | null;
  observedAtMode?: PriceObservedAtMode | null;
  syncedAt?: number | null;
  agreeSources?: string[];
  consensusSources?: string[];
}

export async function getPriceCache(db: D1Database): Promise<Map<string, PriceCacheEntry>> {
  const map = new Map<string, PriceCacheEntry>();

  type PriceCacheRow = {
    asset_id: string;
    price: number;
    updated_at: number;
    source: string | null;
    confidence: PriceConfidence | null;
    observed_at: number | null;
    observed_at_mode: PriceObservedAtMode | null;
    synced_at: number | null;
    agree_sources_json: string | null;
    consensus_sources_json: string | null;
  };
  let result: D1Result<PriceCacheRow>;
  try {
    result = await db
      .prepare(
        "SELECT asset_id, price, updated_at, source, confidence, observed_at, observed_at_mode, synced_at, agree_sources_json, consensus_sources_json FROM price_cache",
      )
      .all<PriceCacheRow>();
  } catch (err) {
    console.warn("[db-cache] Full-column price_cache query failed:", toErrorMessage(err));
    throw err;
  }
  for (const row of result.results ?? []) {
    map.set(row.asset_id, {
      price: row.price,
      updatedAt: row.updated_at,
      source: row.source ?? null,
      confidence: row.confidence ?? null,
      observedAt: row.observed_at ?? row.updated_at,
      observedAtMode: row.observed_at_mode ?? null,
      syncedAt: row.synced_at ?? row.updated_at,
      agreeSources: parseJsonStringArray(row.agree_sources_json),
      consensusSources: parseJsonStringArray(row.consensus_sources_json),
    });
  }
  return map;
}

export interface PriceCacheWriteEntry {
  id: string;
  price: number;
  source?: string | null;
  confidence?: PriceConfidence | null;
  observedAt?: number | null;
  observedAtMode?: PriceObservedAtMode | null;
  syncedAt?: number | null;
  agreeSources?: string[];
  consensusSources?: string[];
}

function resolvePriceCacheUpdatedAt(e: PriceCacheWriteEntry, now: number): number {
  const syncedAt = e.syncedAt ?? now;
  if (e.observedAt == null) return syncedAt;
  return e.observedAt <= syncedAt ? e.observedAt : syncedAt;
}

export async function savePriceCache(db: D1Database, entries: PriceCacheWriteEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const stmts = entries.map((e) =>
    db
      .prepare(
        `INSERT INTO price_cache (asset_id, price, updated_at, source, confidence, observed_at, observed_at_mode, synced_at, agree_sources_json, consensus_sources_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET
           price = excluded.price,
           updated_at = excluded.updated_at,
           source = excluded.source,
           confidence = excluded.confidence,
           observed_at = excluded.observed_at,
           observed_at_mode = excluded.observed_at_mode,
           synced_at = excluded.synced_at,
           agree_sources_json = excluded.agree_sources_json,
           consensus_sources_json = excluded.consensus_sources_json
         WHERE COALESCE(excluded.synced_at, 0) >= COALESCE(price_cache.synced_at, 0)`,
      )
      .bind(
        e.id,
        e.price,
        resolvePriceCacheUpdatedAt(e, now),
        e.source ?? null,
        e.confidence ?? null,
        e.observedAt ?? null,
        e.observedAtMode ?? null,
        e.syncedAt ?? now,
        JSON.stringify(e.agreeSources ?? []),
        JSON.stringify(e.consensusSources ?? []),
      ),
  );
  await batchExecute(db, stmts);
}
