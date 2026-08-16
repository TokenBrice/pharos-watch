import { logWorkerEventArgs } from "../structured-log";
import { batchExecute } from "../db";
import { throwIfAborted } from "../abort";
import { collectAffectedHours, recalcAffectedHours } from "./persistence";
import { ROUNDTRIP_TOLERANCE_HAVING_SQL } from "./roundtrip-detection";
import type { MintBurnAffectedHour } from "./types";

const SWEEP_LOOKBACK_SEC = 7 * 24 * 3600; // 7 days; capped by SWEEP_LIMIT per run
const SWEEP_LIMIT = 200; // keep it lightweight per cron run

export interface RoundtripSweepResult {
  reclassified: number;
  affectedHours: Map<string, MintBurnAffectedHour>;
  saturated: boolean;
}

/**
 * Lightweight post-cron sweep for cross-run atomic roundtrips.
 * Finds (tx_hash, stablecoin_id, chain_id) groups within the recent window where
 * both directions exist but flow_type is still 'standard'. Reclassifies
 * and recalculates affected hourly buckets.
 */
export async function sweepRecentRoundtrips(
  db: D1Database,
  nowSec: number,
  lookbackSec = SWEEP_LOOKBACK_SEC,
  signal?: AbortSignal,
): Promise<RoundtripSweepResult> {
  throwIfAborted(signal);
  const cutoff = nowSec - lookbackSec;

  const { results: candidates } = await db.prepare(
    `SELECT tx_hash, stablecoin_id, chain_id, MIN(timestamp) as timestamp
     FROM mint_burn_events
     WHERE flow_type = 'standard' AND timestamp >= ?
     GROUP BY tx_hash, stablecoin_id, chain_id
     HAVING COUNT(DISTINCT direction) > 1
        AND ${ROUNDTRIP_TOLERANCE_HAVING_SQL}
     ORDER BY MIN(timestamp) ASC, stablecoin_id ASC, tx_hash ASC
     LIMIT ?`,
  ).bind(cutoff, SWEEP_LIMIT).all<{
    tx_hash: string;
    stablecoin_id: string;
    chain_id: string;
    timestamp: number;
  }>();
  throwIfAborted(signal);

  if (candidates.length === 0) {
    return { reclassified: 0, affectedHours: new Map(), saturated: false };
  }

  const saturated = candidates.length === SWEEP_LIMIT;
  if (saturated) {
    logWorkerEventArgs("lib", "warn", `[roundtrip-sweep] Hit limit (${SWEEP_LIMIT}), backlog may remain`);
  }

  const affectedHours = collectAffectedHours(candidates);

  const updateStmts = candidates.map((row) =>
    db.prepare(
     `UPDATE mint_burn_events
       SET flow_type = 'atomic_roundtrip'
       WHERE tx_hash = ? AND stablecoin_id = ? AND chain_id = ? AND flow_type = 'standard'`,
    ).bind(row.tx_hash, row.stablecoin_id, row.chain_id),
  );
  const reclassified = await batchExecute(db, updateStmts, { signal });

  if (affectedHours.size > 0) {
    await recalcAffectedHours(db, affectedHours, { signal });
  }

  return { reclassified, affectedHours, saturated };
}
