import { batchExecute } from "../db";
import { recalcAffectedHours } from "./persistence";
import type { MintBurnAffectedHour } from "./types";

const SWEEP_LOOKBACK_SEC = 7 * 24 * 3600; // 7 days; capped by SWEEP_LIMIT per run
const SWEEP_LIMIT = 200; // keep it lightweight per cron run

export interface RoundtripSweepResult {
  reclassified: number;
  affectedHours: Map<string, MintBurnAffectedHour>;
}

/**
 * Lightweight post-cron sweep for cross-run atomic roundtrips.
 * Finds (tx_hash, stablecoin_id) groups within the recent window where
 * both directions exist but flow_type is still 'standard'. Reclassifies
 * and recalculates affected hourly buckets.
 */
export async function sweepRecentRoundtrips(
  db: D1Database,
  nowSec: number,
  lookbackSec = SWEEP_LOOKBACK_SEC,
): Promise<RoundtripSweepResult> {
  const cutoff = nowSec - lookbackSec;

  // The 0.005 literal below mirrors ROUNDTRIP_AMOUNT_TOLERANCE in
  // roundtrip-detection.ts — that file is the source of truth. CASE...END is
  // used instead of a two-arg MAX() to avoid SQLite scalar-variadic subtleties
  // inside an aggregate HAVING context.
  const { results: candidates } = await db.prepare(
    `SELECT tx_hash, stablecoin_id, chain_id, MIN(timestamp) as min_ts
     FROM mint_burn_events
     WHERE flow_type = 'standard' AND timestamp >= ?
     GROUP BY tx_hash, stablecoin_id, chain_id
     HAVING COUNT(DISTINCT direction) > 1
        AND ABS(SUM(CASE WHEN direction='mint' THEN amount ELSE 0 END)
              - SUM(CASE WHEN direction='burn' THEN amount ELSE 0 END))
            <= 0.005 * (
                 CASE
                   WHEN SUM(CASE WHEN direction='mint' THEN amount ELSE 0 END)
                      >= SUM(CASE WHEN direction='burn' THEN amount ELSE 0 END)
                   THEN SUM(CASE WHEN direction='mint' THEN amount ELSE 0 END)
                   ELSE SUM(CASE WHEN direction='burn' THEN amount ELSE 0 END)
                 END
               )
     ORDER BY MIN(timestamp) ASC, stablecoin_id ASC, tx_hash ASC
     LIMIT ?`,
  ).bind(cutoff, SWEEP_LIMIT).all<{
    tx_hash: string;
    stablecoin_id: string;
    chain_id: string;
    min_ts: number;
  }>();

  if (candidates.length === 0) {
    return { reclassified: 0, affectedHours: new Map() };
  }

  if (candidates.length === SWEEP_LIMIT) {
    console.warn(`[roundtrip-sweep] Hit limit (${SWEEP_LIMIT}), backlog may remain`);
  }

  const affectedHours = new Map<string, MintBurnAffectedHour>();
  for (const row of candidates) {
    const hourTs = Math.floor(row.min_ts / 3600) * 3600;
    const key = `${row.stablecoin_id}-${row.chain_id}-${hourTs}`;
    affectedHours.set(key, {
      stablecoinId: row.stablecoin_id,
      chainId: row.chain_id,
      hourTs,
    });
  }

  const updateStmts = candidates.map((row) =>
    db.prepare(
      `UPDATE mint_burn_events
       SET flow_type = 'atomic_roundtrip'
       WHERE tx_hash = ? AND stablecoin_id = ? AND flow_type = 'standard'`,
    ).bind(row.tx_hash, row.stablecoin_id),
  );
  const reclassified = await batchExecute(db, updateStmts);

  if (affectedHours.size > 0) {
    await recalcAffectedHours(db, affectedHours);
  }

  return { reclassified, affectedHours };
}
