import { logWorkerEventArgs } from "../structured-log";
import { isMissingTableError } from "../db";
import { CACHED_VAULT_RATE_MAX_AGE_SEC, type CachedVaultRate } from "./helpers";

const PRUNE_AFTER_SEC = 7 * 24 * 60 * 60;

interface VaultRateRow {
  stablecoin_id: string;
  rate: number;
  observed_at: number;
}

function tolerateRateTableError(error: unknown): void {
  if (!isMissingTableError(error)) {
    logWorkerEventArgs("lib", "warn", "[authoritative-price-sources] vault rate cache unavailable; continuing without it:", error);
  }
}

export async function readVaultRateCache(db: D1Database, nowSec: number): Promise<Map<string, CachedVaultRate>> {
  try {
    const rows = await db.prepare(
      `SELECT stablecoin_id, rate, observed_at
         FROM authoritative_vault_rates
        WHERE observed_at > ?`,
    ).bind(nowSec - CACHED_VAULT_RATE_MAX_AGE_SEC).all<VaultRateRow>();
    const cache = new Map<string, CachedVaultRate>();
    for (const row of rows.results ?? []) {
      if (typeof row.stablecoin_id !== "string" || row.stablecoin_id.length === 0) continue;
      if (typeof row.rate !== "number" || !Number.isFinite(row.rate) || row.rate <= 0) continue;
      if (typeof row.observed_at !== "number" || !Number.isFinite(row.observed_at) || row.observed_at <= 0) continue;
      cache.set(row.stablecoin_id, { rate: row.rate, observedAt: Math.floor(row.observed_at) });
    }
    return cache;
  } catch (error) {
    tolerateRateTableError(error);
    return new Map();
  }
}

export async function writeVaultRateCache(
  db: D1Database,
  writes: ReadonlyMap<string, CachedVaultRate>,
  nowSec: number,
): Promise<void> {
  if (writes.size === 0) return;
  try {
    const upsert = db.prepare(
      `INSERT INTO authoritative_vault_rates (stablecoin_id, rate, observed_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(stablecoin_id) DO UPDATE SET
         rate = excluded.rate,
         observed_at = excluded.observed_at,
         updated_at = excluded.updated_at`,
    );
    await db.batch([
      ...[...writes].map(([stablecoinId, entry]) =>
        upsert.bind(stablecoinId, entry.rate, Math.floor(entry.observedAt), nowSec),
      ),
      db.prepare("DELETE FROM authoritative_vault_rates WHERE observed_at <= ?").bind(nowSec - PRUNE_AFTER_SEC),
    ]);
  } catch (error) {
    tolerateRateTableError(error);
  }
}
