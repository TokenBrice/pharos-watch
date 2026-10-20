import { executeAtomicBatch } from "../db";
import { throwIfAborted } from "../abort";
import { mintBurnHourlyBucketAggregatesSql } from "./persistence";
import { MINT_BURN_HOURLY_BUCKET_COLUMNS_SQL } from "../mint-burn-hourly-valuation";
import type { MintBurnAffectedHour } from "./types";

interface MaintenanceMutation {
  // Enqueue selects current source hours before its paired source update.
  // Callers using affectedHours must RETURN every key, including already-dirty
  // keys; nonreturning operator writes instead drain the persisted debt.
  enqueue: D1PreparedStatement;
  update: D1PreparedStatement;
}

export async function executeMintBurnMaintenanceMutations(
  db: D1Database,
  mutations: MaintenanceMutation[],
  options: { signal?: AbortSignal } = {},
): Promise<{ changed: number; affectedHours: Map<string, MintBurnAffectedHour> }> {
  let changed = 0;
  const affectedHours = new Map<string, MintBurnAffectedHour>();
  // 40 pairs = 80 statements, below executeAtomicBatch's 100-statement ceiling.
  for (let offset = 0; offset < mutations.length; offset += 40) {
    throwIfAborted(options.signal);
    const statements: D1PreparedStatement[] = [];
    const end = Math.min(offset + 40, mutations.length);
    for (let index = offset; index < end; index++) {
      const mutation = mutations[index];
      statements.push(mutation.enqueue, mutation.update);
    }
    const results = await executeAtomicBatch(db, statements, { signal: options.signal, returnResults: true });
    for (let index = 0; index < results.length; index += 2) {
      changed += Number(results[index + 1]?.meta?.changes ?? 0);
      for (const row of results[index].results as Array<{ stablecoin_id: string; chain_id: string; hour_ts: number }>) {
        const hour = { stablecoinId: row.stablecoin_id, chainId: row.chain_id, hourTs: row.hour_ts };
        affectedHours.set(`${hour.stablecoinId}-${hour.chainId}-${hour.hourTs}`, hour);
      }
    }
  }
  return { changed, affectedHours };
}

export async function seedMintBurnLegacyMaterializationDebt(
  db: D1Database,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<void> {
  throwIfAborted(options.signal);
  await db.prepare(`INSERT OR IGNORE INTO mint_burn_dirty_hours (stablecoin_id, chain_id, hour_ts)
    SELECT stablecoin_id, chain_id, (timestamp / 3600) * 3600 AS hour_ts
    FROM mint_burn_events e
    WHERE price_repair_status = 'pending_aggregate' AND amount_usd IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM mint_burn_dirty_hours d
        WHERE d.stablecoin_id = e.stablecoin_id AND d.chain_id = e.chain_id
          AND d.hour_ts = (e.timestamp / 3600) * 3600)
    GROUP BY stablecoin_id, chain_id, hour_ts
    ORDER BY hour_ts, stablecoin_id, chain_id
    LIMIT ?`).bind(options.limit ?? 100).run();
}

export async function drainMintBurnMaterializationDebt(
  db: D1Database,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<number> {
  await seedMintBurnLegacyMaterializationDebt(db, options);
  throwIfAborted(options.signal);
  const rows = await db.prepare(`SELECT stablecoin_id, chain_id, hour_ts
    FROM mint_burn_dirty_hours
    ORDER BY hour_ts, stablecoin_id, chain_id LIMIT ?`)
    .bind(options.limit ?? 100)
    .all<{ stablecoin_id: string; chain_id: string; hour_ts: number }>();
  const hours = new Map<string, MintBurnAffectedHour>();
  for (const row of rows.results ?? []) {
    const hour = { stablecoinId: row.stablecoin_id, chainId: row.chain_id, hourTs: row.hour_ts };
    hours.set(`${hour.stablecoinId}-${hour.chainId}-${hour.hourTs}`, hour);
  }
  await rebuildMintBurnMaterializationHours(db, hours, options);
  return hours.size;
}

export async function rebuildMintBurnMaterializationHours(
  db: D1Database,
  affectedHours: Map<string, MintBurnAffectedHour>,
  options: { signal?: AbortSignal } = {},
): Promise<MintBurnAffectedHour[]> {
  const rebuiltHours: MintBurnAffectedHour[] = [];
  const debtExistsSql = `EXISTS (SELECT 1 FROM mint_burn_dirty_hours
    WHERE stablecoin_id = ? AND chain_id = ? AND hour_ts = ?)`;
  for (const hour of affectedHours.values()) {
    throwIfAborted(options.signal);
    const { stablecoinId, chainId, hourTs } = hour;
    // Selection may be stale after another drainer settles the key and retention
    // prunes raw siblings. Gate every write on debt inside this same transaction;
    // a later maintenance mutation re-enqueues and remains eligible to rebuild.
    const results = await executeAtomicBatch(db, [
      db.prepare(`DELETE FROM mint_burn_hourly
        WHERE stablecoin_id = ? AND chain_id = ? AND hour_ts = ?
          AND ${debtExistsSql}`)
        .bind(stablecoinId, chainId, hourTs, stablecoinId, chainId, hourTs),
      db.prepare(`INSERT INTO mint_burn_hourly
        (stablecoin_id, chain_id, hour_ts, ${MINT_BURN_HOURLY_BUCKET_COLUMNS_SQL})
        SELECT stablecoin_id, chain_id, (timestamp / 3600) * 3600 AS hour_ts,
          ${mintBurnHourlyBucketAggregatesSql()}
        FROM mint_burn_events
        WHERE stablecoin_id = ? AND chain_id = ? AND timestamp >= ? AND timestamp < ?
          AND ${debtExistsSql}
        GROUP BY stablecoin_id, chain_id, hour_ts`)
        .bind(stablecoinId, chainId, hourTs, hourTs + 3600, stablecoinId, chainId, hourTs),
      db.prepare(`UPDATE mint_burn_events
        SET price_repair_status = 'recovered', price_repair_reason = NULL
        WHERE stablecoin_id = ? AND chain_id = ? AND timestamp >= ? AND timestamp < ?
          AND price_repair_status = 'pending_aggregate' AND amount_usd IS NOT NULL
          AND ${debtExistsSql}`)
        .bind(stablecoinId, chainId, hourTs, hourTs + 3600, stablecoinId, chainId, hourTs),
      db.prepare(`DELETE FROM mint_burn_dirty_hours
        WHERE stablecoin_id = ? AND chain_id = ? AND hour_ts = ?`)
        .bind(stablecoinId, chainId, hourTs),
    ], { signal: options.signal, returnResults: true });
    // The last statement consumes exactly the key that authorized this rebuild.
    if (Number(results[3].meta.changes) > 0) rebuiltHours.push(hour);
  }
  return rebuiltHours;
}
