import { requireAdmin } from "../lib/auth";
import { jsonResponse } from "../lib/api-utils";
import { batchExecute } from "../lib/db";
import { recalcAffectedHours } from "../lib/mint-burn-pipeline/persistence";
import type { MintBurnAffectedHour } from "../lib/mint-burn-pipeline/types";
// The reverse-pass SQL HAVING clause below hardcodes 0.005 because SQL cannot
// interpolate TS constants. Keep it in lock-step with ROUNDTRIP_AMOUNT_TOLERANCE
// in lib/mint-burn-pipeline/roundtrip-detection.ts — this import acts as a
// compile-time reminder.
import { ROUNDTRIP_AMOUNT_TOLERANCE } from "../lib/mint-burn-pipeline/roundtrip-detection";

if (ROUNDTRIP_AMOUNT_TOLERANCE !== 0.005) {
  throw new Error(
    `ROUNDTRIP_AMOUNT_TOLERANCE (${ROUNDTRIP_AMOUNT_TOLERANCE}) drifted from reverse-pass SQL literal 0.005`,
  );
}

const BATCH_SIZE = 1000;

interface RoundtripDiscoveryRow {
  tx_hash: string;
  stablecoin_id: string;
  chain_id: string;
  min_ts: number;
}

function collectAffectedHours(
  rows: RoundtripDiscoveryRow[],
  seed?: Map<string, MintBurnAffectedHour>,
): Map<string, MintBurnAffectedHour> {
  const affectedHours = seed ?? new Map<string, MintBurnAffectedHour>();
  for (const row of rows) {
    const hourTs = Math.floor(row.min_ts / 3600) * 3600;
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
 * POST /api/reclassify-atomic-roundtrips (admin)
 * Retroactively re-tags mint_burn_events flow_type in two passes:
 *   - Forward: standard → atomic_roundtrip when the same (tx_hash, stablecoin_id, chain_id)
 *     contains both mints and burns whose totals match within tolerance.
 *   - Reverse: atomic_roundtrip → standard when legacy-tagged groups no longer
 *     satisfy the 0.5% amount-match tolerance introduced in Task 1.4.
 * Returns { done: true } when both passes land < BATCH_SIZE rows.
 */
export async function handleReclassifyAtomicRoundtrips(
  db: D1Database,
  _url: URL,
  trustedAdmin: boolean | undefined,
  request?: Request,
): Promise<Response> {
  const authErr = await requireAdmin(request, trustedAdmin);
  if (authErr) return authErr;

  // --- Forward pass: standard → atomic_roundtrip ---
  const { results: forwardTxs } = await db
    .prepare(
      `SELECT tx_hash, stablecoin_id, chain_id,
              MIN(timestamp) as min_ts,
              COUNT(*) as cnt
       FROM mint_burn_events
       WHERE flow_type = 'standard'
       GROUP BY tx_hash, stablecoin_id, chain_id
       HAVING COUNT(DISTINCT direction) > 1
       ORDER BY MIN(timestamp) ASC, stablecoin_id ASC, tx_hash ASC
       LIMIT ?`,
    )
    .bind(BATCH_SIZE)
    .all<RoundtripDiscoveryRow & { cnt: number }>();

  const affectedHours = new Map<string, MintBurnAffectedHour>();
  let toRoundtrip = 0;
  if (forwardTxs.length > 0) {
    collectAffectedHours(forwardTxs, affectedHours);
    const forwardStmts = forwardTxs.map((row) =>
      db
        .prepare(
          `UPDATE mint_burn_events
           SET flow_type = 'atomic_roundtrip'
           WHERE tx_hash = ? AND stablecoin_id = ? AND flow_type = 'standard'`,
        )
        .bind(row.tx_hash, row.stablecoin_id),
    );
    toRoundtrip = await batchExecute(db, forwardStmts);
  }

  // --- Reverse pass: atomic_roundtrip → standard for tolerance-violating groups.
  // The HAVING clause mirrors ROUNDTRIP_AMOUNT_TOLERANCE (0.5%) from
  // roundtrip-detection.ts: groups whose mint/burn totals diverge by more than
  // 0.5% of the larger side no longer qualify as atomic roundtrips.
  const { results: reverseTxs } = await db
    .prepare(
      `SELECT tx_hash, stablecoin_id, chain_id,
              MIN(timestamp) as min_ts,
              SUM(CASE WHEN direction='mint' THEN amount ELSE 0 END) AS mint_amt,
              SUM(CASE WHEN direction='burn' THEN amount ELSE 0 END) AS burn_amt
       FROM mint_burn_events
       WHERE flow_type = 'atomic_roundtrip'
       GROUP BY tx_hash, stablecoin_id, chain_id
       HAVING mint_amt > 0 AND burn_amt > 0
         AND ABS(mint_amt - burn_amt) > 0.005 * (
           CASE WHEN mint_amt >= burn_amt THEN mint_amt ELSE burn_amt END
         )
       ORDER BY MIN(timestamp) ASC, stablecoin_id ASC, tx_hash ASC
       LIMIT ?`,
    )
    .bind(BATCH_SIZE)
    .all<RoundtripDiscoveryRow & { mint_amt: number; burn_amt: number }>();

  let toStandard = 0;
  if (reverseTxs.length > 0) {
    collectAffectedHours(reverseTxs, affectedHours);
    const reverseStmts = reverseTxs.map((row) =>
      db
        .prepare(
          `UPDATE mint_burn_events
           SET flow_type = 'standard'
           WHERE tx_hash = ? AND stablecoin_id = ? AND flow_type = 'atomic_roundtrip'`,
        )
        .bind(row.tx_hash, row.stablecoin_id),
    );
    toStandard = await batchExecute(db, reverseStmts);
  }

  await recalcAffectedHours(db, affectedHours);

  return jsonResponse({
    done: forwardTxs.length < BATCH_SIZE && reverseTxs.length < BATCH_SIZE,
    // Legacy field: sum of both directions so callers can monitor any activity.
    updated: toRoundtrip + toStandard,
    toRoundtrip,
    toStandard,
    hoursRecalculated: affectedHours.size,
    batchSize: BATCH_SIZE,
  });
}
