import { batchExecute } from "../db";
import { throwIfAborted } from "../abort";
import { detectAtomicRoundtrips } from "./roundtrip-detection";
import { applyReviewedProtocolInternalFlows } from "./reviewed-protocol-flows";
import type { MintBurnAffectedHour, MintBurnRow } from "./types";
import { MINT_BURN_HOURLY_BUCKET_COLUMNS_SQL } from "../mint-burn-hourly-valuation";

const MINT_BURN_EVENT_INSERT_BATCH_SIZE = 50;

export interface MintBurnPersistenceOptions {
  signal?: AbortSignal;
}

export async function insertMintBurnRows(
  db: D1Database,
  rows: MintBurnRow[],
  options: MintBurnPersistenceOptions = {},
): Promise<{ inserted: number; ignored: number }> {
  if (rows.length === 0) return { inserted: 0, ignored: 0 };
  throwIfAborted(options.signal);

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
  const inserted = await batchExecute(db, insertStmts, {
    chunkSize: MINT_BURN_EVENT_INSERT_BATCH_SIZE,
    signal: options.signal,
  });
  const ignored = Math.max(0, rows.length - inserted);
  return { inserted, ignored };
}

export interface ClassificationUpdateCounters {
  flowTypeChanges: number;
  burnTypeChanges: number;
  rowsUpdated: number;
}

export async function updateEventClassifications(
  db: D1Database,
  rows: MintBurnRow[],
  options: MintBurnPersistenceOptions = {},
): Promise<ClassificationUpdateCounters> {
  // Any burn row gets its classification written unconditionally; mint rows
  // only participate when the classifier produced a non-standard flow_type.
  const needsUpdate = rows.filter(
    (row) => row.direction === "burn" || row.flow_type !== "standard",
  );
  if (needsUpdate.length === 0) {
    return { flowTypeChanges: 0, burnTypeChanges: 0, rowsUpdated: 0 };
  }
  throwIfAborted(options.signal);

  const stmts = needsUpdate.map((row) =>
    db.prepare(
      `UPDATE mint_burn_events
       SET burn_type = ?, burn_review_reason = ?, flow_type = ?
       WHERE id = ?`,
    ).bind(row.burn_type, row.burn_review_reason, row.flow_type, row.id),
  );
  const rowsUpdated = await batchExecute(db, stmts, { signal: options.signal });

  // Per-column counters derived from classifier output rather than D1
  // meta.changes so a row that changed both columns counts once per column
  // without double-counting in the union (`rowsUpdated`).
  const burnTypeChanges = needsUpdate.filter((r) => r.direction === "burn").length;
  const flowTypeChanges = needsUpdate.filter((r) => r.flow_type !== "standard").length;
  return { flowTypeChanges, burnTypeChanges, rowsUpdated };
}

interface AffectedHourCandidate {
  stablecoin_id: string;
  chain_id: string;
  timestamp: number;
}

export function collectAffectedHours<T extends AffectedHourCandidate>(
  rows: T[],
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

/**
 * Event aggregates for one hourly bucket, shared by every materializer (sync
 * recalc, retention evidence repair, heal verification) so counts, unpriced
 * counts and known subtotals are always rebuilt together. Counted flow is
 * standard mints and standard effective burns. Volumes/net are known-valuation
 * subtotals: an event without `amount_usd` adds to its side's unpriced count,
 * never to a dollar amount, so a subtotal is exact only when that count is 0.
 * `eventAlias` is a trusted literal table alias prefix such as `"event."`.
 */
export function mintBurnHourlyBucketAggregatesSql(eventAlias = ""): string {
  const e = eventAlias;
  const mint = `${e}direction = 'mint' AND ${e}flow_type = 'standard'`;
  const burn = `${e}direction = 'burn' AND ${e}burn_type = 'effective_burn' AND ${e}flow_type = 'standard'`;
  // SAFETY: only the fixed predicates above and a caller-supplied literal alias are interpolated.
  return `SUM(CASE WHEN ${mint} THEN 1 ELSE 0 END) AS mint_count,
      SUM(CASE WHEN ${burn} THEN 1 ELSE 0 END) AS burn_count,
      SUM(CASE WHEN ${mint} AND ${e}amount_usd IS NULL THEN 1 ELSE 0 END) AS mint_unpriced_event_count,
      SUM(CASE WHEN ${burn} AND ${e}amount_usd IS NULL THEN 1 ELSE 0 END) AS burn_unpriced_event_count,
      COALESCE(SUM(CASE WHEN ${mint} THEN ${e}amount_usd ELSE 0 END), 0) AS mint_volume_usd,
      COALESCE(SUM(CASE WHEN ${burn} THEN ${e}amount_usd ELSE 0 END), 0) AS burn_volume_usd,
      COALESCE(SUM(CASE WHEN ${mint} THEN ${e}amount_usd WHEN ${burn} THEN -${e}amount_usd ELSE 0 END), 0) AS net_flow_usd`;
}

function hourlyAggSql(whereClause: string): string {
  // SAFETY: whereClause is a fixed parameterized predicate from recalcAffectedHours.
  return `INSERT OR REPLACE INTO mint_burn_hourly
      (stablecoin_id, chain_id, hour_ts, ${MINT_BURN_HOURLY_BUCKET_COLUMNS_SQL})
     SELECT
      stablecoin_id,
      chain_id,
      (timestamp / 3600) * 3600 AS hour_ts,
      ${mintBurnHourlyBucketAggregatesSql()}
     FROM mint_burn_events
     WHERE ${whereClause}
     GROUP BY stablecoin_id, chain_id, hour_ts`;
}

export async function recalcAffectedHours(
  db: D1Database,
  affectedHours: Map<string, MintBurnAffectedHour>,
  options: MintBurnPersistenceOptions = {},
): Promise<void> {
  if (affectedHours.size === 0) return;
  throwIfAborted(options.signal);

  const deleteStmt = db.prepare(
    `DELETE FROM mint_burn_hourly
     WHERE stablecoin_id = ? AND chain_id = ? AND hour_ts = ?`,
  );
  const aggStmt = db.prepare(
    hourlyAggSql("stablecoin_id = ? AND chain_id = ? AND timestamp >= ? AND timestamp < ?"),
  );

  // Interleave delete+insert per hour so each pair lands in the same db.batch()
  // call, keeping hourly recalc atomic within each chunk. D1_BATCH_SIZE (100) is
  // even, so pairs are never split across chunk boundaries.
  const interleaved: D1PreparedStatement[] = [];
  for (const hour of affectedHours.values()) {
    throwIfAborted(options.signal);
    interleaved.push(deleteStmt.bind(hour.stablecoinId, hour.chainId, hour.hourTs));
    interleaved.push(aggStmt.bind(hour.stablecoinId, hour.chainId, hour.hourTs, hour.hourTs + 3600));
  }
  await batchExecute(db, interleaved, { signal: options.signal });
}


export async function persistMintBurnRows(
  db: D1Database,
  rows: MintBurnRow[],
  affectedHours?: Map<string, MintBurnAffectedHour>,
  options: MintBurnPersistenceOptions = {},
): Promise<{
  inserted: number;
  ignored: number;
  flowTypeChanges: number;
  burnTypeChanges: number;
  rowsUpdated: number;
  roundtripsDetected: number;
  reviewedProtocolInternal: number;
}> {
  const roundtripsDetected = detectAtomicRoundtrips(rows);
  // Reviewed issuer-internal events win over heuristic tagging.
  const reviewedProtocolInternal = applyReviewedProtocolInternalFlows(rows);
  if (rows.length === 0) {
    return {
      inserted: 0,
      ignored: 0,
      flowTypeChanges: 0,
      burnTypeChanges: 0,
      rowsUpdated: 0,
      roundtripsDetected,
      reviewedProtocolInternal,
    };
  }
  throwIfAborted(options.signal);

  const insertResult = await insertMintBurnRows(db, rows, options);
  const { flowTypeChanges, burnTypeChanges, rowsUpdated } = await updateEventClassifications(db, rows, options);
  // A held cursor replays already-persisted rows after a failed hourly rebuild.
  // Their buckets still need materialization even when every insert is ignored.
  if (affectedHours) {
    throwIfAborted(options.signal);
    collectAffectedHours(rows, affectedHours);
  }
  return {
    inserted: insertResult.inserted,
    ignored: insertResult.ignored,
    flowTypeChanges,
    burnTypeChanges,
    rowsUpdated,
    roundtripsDetected,
    reviewedProtocolInternal,
  };
}
