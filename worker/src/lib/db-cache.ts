import { batchExecute } from "./db";
import type { PriceConfidence, PriceObservedAtMode } from "@shared/types/core";
import {
  getFreshnessSentinelCacheKey,
  getFreshnessSentinelProducerJob,
  type FreshnessSentinelBackedCacheKey,
} from "./freshness-sentinels";

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

export async function deleteCache(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM cache WHERE key = ?").bind(key).run();
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
): Promise<CacheWriteResult> {
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
    return { written: false, skippedBecauseNewer: true };
  }
  return { written: true, skippedBecauseNewer: false };
}

export async function writeFreshnessSentinel(
  db: D1Database,
  key: FreshnessSentinelBackedCacheKey,
  syncStartSec: number,
): Promise<void> {
  await setCacheIfNewer(
    db,
    getFreshnessSentinelCacheKey(key),
    JSON.stringify({
      updatedAt: syncStartSec,
      source: getFreshnessSentinelProducerJob(key),
      publishStatus: "ok",
    }),
    syncStartSec,
  );
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

function parseJsonStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export async function getPriceCache(db: D1Database): Promise<Map<string, PriceCacheEntry>> {
  const map = new Map<string, PriceCacheEntry>();

  // Try full-column query first (preferred — single D1 read).
  try {
    const result = await db
      .prepare(
        "SELECT asset_id, price, updated_at, source, confidence, observed_at, observed_at_mode, synced_at, agree_sources_json, consensus_sources_json FROM price_cache",
      )
      .all<{
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
      }>();
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no such column")) {
      console.warn("[db-cache] Full-column price_cache query failed, trying core-only fallback:", msg);
    }
  }

  // Fallback: core columns only (schema may be missing metadata columns,
  // or the full-column query hit a transient D1 error).
  try {
    const result = await db
      .prepare("SELECT asset_id, price, updated_at FROM price_cache")
      .all<{ asset_id: string; price: number; updated_at: number }>();
    for (const row of result.results ?? []) {
      map.set(row.asset_id, {
        price: row.price,
        updatedAt: row.updated_at,
        source: null,
        confidence: null,
        observedAt: row.updated_at,
        observedAtMode: null,
        syncedAt: row.updated_at,
        agreeSources: [],
        consensusSources: [],
      });
    }
  } catch (err) {
    console.warn("[db-cache] Failed to load price_cache:", err instanceof Error ? err.message : String(err));
  }
  return map;
}

export async function savePriceCache(db: D1Database, entries: Array<{
  id: string;
  price: number;
  source?: string | null;
  confidence?: PriceConfidence | null;
  observedAt?: number | null;
  observedAtMode?: PriceObservedAtMode | null;
  syncedAt?: number | null;
  agreeSources?: string[];
  consensusSources?: string[];
}>): Promise<void> {
  if (entries.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const stmts = entries.map((e) =>
    db
      .prepare(
        "INSERT OR REPLACE INTO price_cache (asset_id, price, updated_at, source, confidence, observed_at, observed_at_mode, synced_at, agree_sources_json, consensus_sources_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        e.id,
        e.price,
        e.observedAt ?? e.syncedAt ?? now,
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
