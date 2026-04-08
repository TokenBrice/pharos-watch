import { batchExecute } from "../db";
import { detectAtomicRoundtrips } from "./roundtrip-detection";
import type { MintBurnAffectedHour, MintBurnRow } from "./types";

const MINT_BURN_EVENT_INSERT_BATCH_SIZE = 50;

export async function insertMintBurnRows(
  db: D1Database,
  rows: MintBurnRow[],
): Promise<{ inserted: number; ignored: number }> {
  if (rows.length === 0) return { inserted: 0, ignored: 0 };

  const insertStmts = rows.map((row) =>
    db.prepare(
      `INSERT OR IGNORE INTO mint_burn_events
       (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, price_used, price_timestamp, price_source,
        burn_type, burn_review_reason, counterparty, tx_hash, block_number, timestamp, explorer_tx_url, flow_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.id,
      row.stablecoin_id,
      row.symbol,
      row.chain_id,
      row.direction,
      row.amount,
      row.amount_usd,
      row.price_used,
      row.price_timestamp,
      row.price_source,
      row.burn_type,
      row.burn_review_reason,
      row.counterparty,
      row.tx_hash,
      row.block_number,
      row.timestamp,
      row.explorer_tx_url,
      row.flow_type,
    ),
  );

  // Each insert binds 18 values; keep D1 batch writes well below the bind-variable ceiling.
  const inserted = await batchExecute(db, insertStmts, MINT_BURN_EVENT_INSERT_BATCH_SIZE);
  const ignored = Math.max(0, rows.length - inserted);
  return { inserted, ignored };
}

export async function updateEventClassifications(
  db: D1Database,
  rows: MintBurnRow[],
): Promise<number> {
  const rowsNeedingUpdate = rows.filter((row) =>
    row.direction === "burn" || row.flow_type !== "standard",
  );
  if (rowsNeedingUpdate.length === 0) return 0;

  const updateClassificationStmts = rowsNeedingUpdate.map((row) =>
    db.prepare(
      `UPDATE mint_burn_events
       SET burn_type = ?, burn_review_reason = ?, flow_type = ?
       WHERE id = ?`,
    ).bind(
      row.burn_type,
      row.burn_review_reason,
      row.flow_type,
      row.id,
    ),
  );
  return batchExecute(db, updateClassificationStmts);
}

export function collectAffectedHours(
  rows: MintBurnRow[],
  seed?: Map<string, MintBurnAffectedHour>,
): Map<string, MintBurnAffectedHour> {
  const affectedHours = seed ?? new Map<string, MintBurnAffectedHour>();
  for (const row of rows) {
    const hourTs = Math.floor(row.timestamp / 3600) * 3600;
    const key = `${row.stablecoin_id}-${row.chain_id}-${hourTs}`;
    affectedHours.set(key, {
      stablecoinId: row.stablecoin_id,
      chainId: row.chain_id,
      hourTs,
    });
  }
  return affectedHours;
}

export async function recalcAffectedHours(
  db: D1Database,
  affectedHours: Map<string, MintBurnAffectedHour>,
): Promise<void> {
  if (affectedHours.size === 0) return;

  const deleteStmt = db.prepare(
    `DELETE FROM mint_burn_hourly
     WHERE stablecoin_id = ? AND chain_id = ? AND hour_ts = ?`,
  );
  const deleteStmts = [...affectedHours.values()].map((hour) =>
    deleteStmt.bind(hour.stablecoinId, hour.chainId, hour.hourTs),
  );
  await batchExecute(db, deleteStmts);

  const aggStmt = db.prepare(
    `INSERT OR REPLACE INTO mint_burn_hourly
      (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
       mint_volume_usd, burn_volume_usd, net_flow_usd)
     SELECT
      stablecoin_id,
      chain_id,
      (timestamp / 3600) * 3600 AS hour_ts,
      SUM(CASE WHEN direction = 'mint' AND flow_type = 'standard' THEN 1 ELSE 0 END),
      SUM(CASE WHEN direction = 'burn' AND burn_type = 'effective_burn' AND flow_type = 'standard' THEN 1 ELSE 0 END),
      COALESCE(SUM(CASE WHEN direction = 'mint' AND flow_type = 'standard' THEN amount_usd ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN direction = 'burn' AND burn_type = 'effective_burn' AND flow_type = 'standard' THEN amount_usd ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN direction = 'mint' AND flow_type = 'standard' THEN amount_usd WHEN direction = 'burn' AND burn_type = 'effective_burn' AND flow_type = 'standard' THEN -amount_usd ELSE 0 END), 0)
     FROM mint_burn_events
     WHERE stablecoin_id = ? AND chain_id = ?
       AND timestamp >= ? AND timestamp < ?
     GROUP BY stablecoin_id, chain_id, hour_ts`,
  );

  const aggStmts = [...affectedHours.values()].map((hour) =>
    aggStmt.bind(hour.stablecoinId, hour.chainId, hour.hourTs, hour.hourTs + 3600),
  );
  await batchExecute(db, aggStmts);
}

export async function rebuildHourlyForStablecoinIds(
  db: D1Database,
  stablecoinIds: Iterable<string>,
): Promise<void> {
  const ids = [...new Set(stablecoinIds)].sort();
  if (ids.length === 0) return;

  const deleteStmt = db.prepare("DELETE FROM mint_burn_hourly WHERE stablecoin_id = ?");
  await batchExecute(
    db,
    ids.map((id) => deleteStmt.bind(id)),
  );

  const rebuildStmt = db.prepare(
    `INSERT OR REPLACE INTO mint_burn_hourly
      (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
       mint_volume_usd, burn_volume_usd, net_flow_usd)
     SELECT
      stablecoin_id,
      chain_id,
      (timestamp / 3600) * 3600 AS hour_ts,
      SUM(CASE WHEN direction = 'mint' AND flow_type = 'standard' THEN 1 ELSE 0 END),
      SUM(CASE WHEN direction = 'burn' AND burn_type = 'effective_burn' AND flow_type = 'standard' THEN 1 ELSE 0 END),
      COALESCE(SUM(CASE WHEN direction = 'mint' AND flow_type = 'standard' THEN amount_usd ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN direction = 'burn' AND burn_type = 'effective_burn' AND flow_type = 'standard' THEN amount_usd ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN direction = 'mint' AND flow_type = 'standard' THEN amount_usd WHEN direction = 'burn' AND burn_type = 'effective_burn' AND flow_type = 'standard' THEN -amount_usd ELSE 0 END), 0)
     FROM mint_burn_events
     WHERE stablecoin_id = ?
     GROUP BY stablecoin_id, chain_id, hour_ts`,
  );
  await batchExecute(
    db,
    ids.map((id) => rebuildStmt.bind(id)),
  );
}

export async function persistMintBurnRows(
  db: D1Database,
  rows: MintBurnRow[],
  affectedHours?: Map<string, MintBurnAffectedHour>,
): Promise<{
  inserted: number;
  ignored: number;
  classificationRowsUpdated: number;
  roundtripsDetected: number;
}> {
  const roundtripsDetected = detectAtomicRoundtrips(rows);
  if (affectedHours) {
    collectAffectedHours(rows, affectedHours);
  }
  if (rows.length === 0) {
    return {
      inserted: 0,
      ignored: 0,
      classificationRowsUpdated: 0,
      roundtripsDetected,
    };
  }

  const insertResult = await insertMintBurnRows(db, rows);
  const classificationRowsUpdated = await updateEventClassifications(db, rows);
  return {
    inserted: insertResult.inserted,
    ignored: insertResult.ignored,
    classificationRowsUpdated,
    roundtripsDetected,
  };
}
