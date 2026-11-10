import { batchExecute, executeAtomicBatch } from "../db";
import { throwIfAborted } from "../abort";
import { reconcileAtomicRoundtripGroups } from "./roundtrip-detection";
import { applyReviewedProtocolInternalFlows, applySupplyExcludedProtocolInternalFlows } from "./reviewed-protocol-flows";
import type { MintBurnAffectedHour, MintBurnRow } from "./types";
import { MINT_BURN_HOURLY_BUCKET_COLUMNS_SQL } from "../mint-burn-hourly-valuation";
import { mintBurnHourlyBucketAggregatesSql } from "./hourly-aggregates";

const MINT_BURN_EVENT_INSERT_BATCH_SIZE = 50;

export interface MintBurnPersistenceOptions {
  signal?: AbortSignal;
  /** Only supplied for a complete, decoded and classified current-config scan. */
  knownCompleteConfigKey?: string;
}

export async function insertMintBurnRows(
  db: D1Database,
  rows: MintBurnRow[],
  options: MintBurnPersistenceOptions = {},
): Promise<{ inserted: number; ignored: number }> {
  if (rows.length === 0) return { inserted: 0, ignored: 0 };
  throwIfAborted(options.signal);

  const mutations = rows.map((row) => [
    db.prepare(`INSERT OR REPLACE INTO mint_burn_dirty_hours (stablecoin_id, chain_id, hour_ts)
      SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM mint_burn_events WHERE id = ?)`)
      .bind(row.stablecoin_id, row.chain_id, Math.floor(row.timestamp / 3600) * 3600, row.id),
    db.prepare(
      `INSERT OR IGNORE INTO mint_burn_events
       (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, price_used, price_timestamp, price_source,
        burn_type, burn_review_reason, counterparty, tx_hash, block_number, timestamp, explorer_tx_url, flow_type, amount_raw,
        below_display_threshold, supply_proof_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.amount_raw,
      row.below_display_threshold,
      row.supply_proof_id ?? null,
    ),
  ]);

  // Enqueue before inserting: only new rows invalidate their hour, including an
  // admitted replay interrupted before the in-memory affected-hour registration.
  let inserted = 0;
  for (let offset = 0; offset < mutations.length; offset += MINT_BURN_EVENT_INSERT_BATCH_SIZE) {
    const results = await executeAtomicBatch(db, mutations.slice(offset, offset + MINT_BURN_EVENT_INSERT_BATCH_SIZE).flat(), {
      signal: options.signal, returnResults: true,
    });
    for (let index = 1; index < results.length; index += 2) inserted += Number(results[index]?.meta?.changes ?? 0);
  }
  const ignored = Math.max(0, rows.length - inserted);
  return { inserted, ignored };
}

export interface ClassificationUpdateCounters {
  flowTypeChanges: number;
  burnTypeChanges: number;
  /** D1 `meta.changes` total: rows whose stored classification actually changed. */
  rowsUpdated: number;
}

export async function updateEventClassifications(
  db: D1Database,
  rows: MintBurnRow[],
  options: MintBurnPersistenceOptions = {},
): Promise<ClassificationUpdateCounters> {
  // Standard mint replays also revoke stale bridge/internal exclusions.
  const needsUpdate = rows;
  if (needsUpdate.length === 0) {
    return { flowTypeChanges: 0, burnTypeChanges: 0, rowsUpdated: 0 };
  }
  throwIfAborted(options.signal);

  const mutations = needsUpdate.map((row) => {
    // `atomic_roundtrip` is a transaction-group classification: a replay that
    // observes only one side cannot revoke it, because the peer may be absent
    // from this batch. Only a group-wide sweep or the operator reverse pass may
    // change it. Identical replay rows neither rewrite source nor enqueue debt.
    const accepted = `EXISTS (SELECT 1 FROM mint_burn_supply_proofs proof
      WHERE proof.proof_id = mint_burn_events.supply_proof_id
        AND proof.status = 'proven' AND proof.lifecycle = 'accepted')`;
    const keepSupply = `? IS NULL AND ${accepted}`;
    const proofId = row.supply_proof_id ?? null;
    const supplyReview = `? = 'review_required' AND ? IN ('unproven-supply-destruction', 'supply-proof-context-unavailable')`;
    const supplyReviewBinds = [row.burn_type, row.burn_review_reason];
    const assignments = [
      { column: "burn_type", sql: `CASE WHEN ${keepSupply} AND ${supplyReview}
          THEN CASE WHEN direction = 'mint' THEN NULL WHEN flow_type = 'bridge_transfer' THEN 'bridge_burn'
            ELSE 'effective_burn' END ELSE ? END`,
        binds: [proofId, ...supplyReviewBinds, row.burn_type] },
      { column: "burn_review_reason", sql: `CASE WHEN ${keepSupply} AND ${supplyReview}
          THEN 'range-supply-destruction' ELSE ? END`, binds: [proofId, ...supplyReviewBinds, row.burn_review_reason] },
      { column: "flow_type", sql: `CASE WHEN ? = 'standard' AND (flow_type = 'atomic_roundtrip'
          OR (${keepSupply} AND ${supplyReview} AND flow_type IN ('bridge_transfer', 'protocol_internal')))
          THEN flow_type ELSE ? END`,
        binds: [row.flow_type, proofId, ...supplyReviewBinds, row.flow_type] },
      { column: "supply_proof_id", sql: `CASE WHEN ${keepSupply} THEN supply_proof_id ELSE ? END`, binds: [proofId, proofId] },
      { column: "amount_raw", sql: `CASE WHEN ${keepSupply} THEN amount_raw ELSE COALESCE(amount_raw, ?) END`,
        binds: [proofId, row.amount_raw ?? null] },
    ];
    const changedSql = `(${assignments.map(({ column, sql }) => `${column} IS NOT (${sql})`).join(" OR ")})`;
    const changedBinds = assignments.flatMap(({ binds }) => binds);
    return [
      db.prepare(`INSERT OR REPLACE INTO mint_burn_dirty_hours (stablecoin_id, chain_id, hour_ts)
        SELECT stablecoin_id, chain_id, (timestamp / 3600) * 3600
        FROM mint_burn_events WHERE id = ? AND ${changedSql}`)
        .bind(row.id, ...changedBinds),
      db.prepare(`UPDATE mint_burn_events
       SET ${assignments.map(({ column, sql }) => `${column} = ${sql}`).join(", ")}
       WHERE id = ? AND ${changedSql}`)
        .bind(...changedBinds, row.id, ...changedBinds),
    ];
  });
  let rowsUpdated = 0;
  // Every classification revision carries debt in the same atomic batch.
  // Forty pairs stay below D1's 100-statement batch ceiling.
  for (let offset = 0; offset < mutations.length; offset += 40) {
    const results = await executeAtomicBatch(db, mutations.slice(offset, offset + 40).flat(), {
      signal: options.signal, returnResults: true,
    });
    for (let index = 1; index < results.length; index += 2) {
      rowsUpdated += Number(results[index]?.meta?.changes ?? 0);
    }
  }

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
  const settleStmt = db.prepare(`DELETE FROM mint_burn_dirty_hours
    WHERE stablecoin_id = ? AND chain_id = ? AND hour_ts = ?`);

  // Keep each delete+insert+debt settlement in one batch, including chunk edges.
  const interleaved: D1PreparedStatement[] = [];
  for (const hour of affectedHours.values()) {
    throwIfAborted(options.signal);
    interleaved.push(deleteStmt.bind(hour.stablecoinId, hour.chainId, hour.hourTs));
    interleaved.push(aggStmt.bind(hour.stablecoinId, hour.chainId, hour.hourTs, hour.hourTs + 3600));
    interleaved.push(settleStmt.bind(hour.stablecoinId, hour.chainId, hour.hourTs));
  }
  await batchExecute(db, interleaved, { chunkSize: 99, signal: options.signal });
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
  // Excluded legs cannot establish the neutrality of a standard-flow group.
  applySupplyExcludedProtocolInternalFlows(rows);
  const reviewedProtocolInternal = applyReviewedProtocolInternalFlows(rows);
  if (rows.length === 0) {
    return {
      inserted: 0,
      ignored: 0,
      flowTypeChanges: 0,
      burnTypeChanges: 0,
      rowsUpdated: 0,
      roundtripsDetected: 0,
      reviewedProtocolInternal,
    };
  }
  throwIfAborted(options.signal);

  const insertResult = await insertMintBurnRows(db, rows, options);
  const { flowTypeChanges, burnTypeChanges, rowsUpdated } = await updateEventClassifications(db, rows, options);
  const roundtrips = await reconcileAtomicRoundtripGroups(db, rows, options);
  // A held cursor replays already-persisted rows after a failed hourly rebuild.
  // Their buckets still need materialization even when every insert is ignored.
  if (affectedHours) {
    throwIfAborted(options.signal);
    collectAffectedHours(rows, affectedHours);
    for (const [key, hour] of roundtrips.affectedHours) affectedHours.set(key, hour);
  }
  return {
    inserted: insertResult.inserted,
    ignored: insertResult.ignored,
    flowTypeChanges: flowTypeChanges + roundtrips.changed,
    burnTypeChanges,
    rowsUpdated: rowsUpdated + roundtrips.changed,
    roundtripsDetected: roundtrips.toRoundtrip,
    reviewedProtocolInternal,
  };
}
