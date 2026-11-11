import { batchExecute } from "./d1-primitives";
import type { PriceConfidence, PriceObservedAtMode } from "@shared/types/price";
import { parseJsonStringArray } from "./json-parse";
import { logWorkerEvent } from "./structured-log";

export interface PriceCacheEntry {
  price: number;
  updatedAt: number;
  source?: string | null;
  confidence?: PriceConfidence | null;
  observedAt?: number | null;
  observedAtMode?: PriceObservedAtMode | null;
  syncedAt?: number | null;
  hasExplicitClocks?: boolean;
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
    logWorkerEvent({ scope: "lib", level: "warn", event: "price_cache_full_column_query_failed", message: "Full-column price cache query failed", error: err });
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
      hasExplicitClocks: row.observed_at != null && row.synced_at != null,
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
