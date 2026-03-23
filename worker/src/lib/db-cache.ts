import { batchExecute } from "./db";
import type { PriceConfidence, PriceObservedAtMode } from "@shared/types";

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
  const result = await db
    .prepare("SELECT asset_id, price, updated_at FROM price_cache")
    .all<{ asset_id: string; price: number; updated_at: number }>();
  const map = new Map<string, PriceCacheEntry>();
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

  try {
    const metadataResult = await db
      .prepare(
        "SELECT asset_id, source, confidence, observed_at, observed_at_mode, synced_at, agree_sources_json, consensus_sources_json FROM price_cache",
      )
      .all<{
        asset_id: string;
        source: string | null;
        confidence: PriceConfidence | null;
        observed_at: number | null;
        observed_at_mode: PriceObservedAtMode | null;
        synced_at: number | null;
        agree_sources_json: string | null;
        consensus_sources_json: string | null;
      }>();
    for (const row of metadataResult.results ?? []) {
      const existing = map.get(row.asset_id);
      if (!existing) continue;
      existing.source = row.source ?? null;
      existing.confidence = row.confidence ?? null;
      existing.observedAt = row.observed_at ?? existing.updatedAt;
      existing.observedAtMode = row.observed_at_mode ?? null;
      existing.syncedAt = row.synced_at ?? existing.updatedAt;
      existing.agreeSources = parseJsonStringArray(row.agree_sources_json);
      existing.consensusSources = parseJsonStringArray(row.consensus_sources_json);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no such column")) {
      console.warn("[db-cache] Failed to load price_cache metadata:", msg);
    }
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
