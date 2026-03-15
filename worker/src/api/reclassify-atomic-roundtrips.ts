import { requireAdmin } from "../lib/auth";
import { withErrorHandler, jsonResponse } from "../lib/api-utils";
import { batchExecute } from "../lib/db";
import { recalcAffectedHours } from "../lib/mint-burn-pipeline/persistence";
import type { MintBurnAffectedHour } from "../lib/mint-burn-pipeline/types";

const BATCH_SIZE = 1000;

/**
 * POST /api/reclassify-atomic-roundtrips (admin)
 * Retroactively classifies existing events where the same tx_hash contains
 * both mints and burns for the same stablecoin. Processes BATCH_SIZE tx groups
 * per call. Returns { done: true } when no more roundtrips remain.
 */
export const handleReclassifyAtomicRoundtrips = withErrorHandler(
  "reclassify-atomic-roundtrips",
  async (
    db: D1Database,
    _url: URL,
    trustedAdmin: boolean | undefined,
    request?: Request,
  ): Promise<Response> => {
    const authErr = await requireAdmin(request, trustedAdmin);
    if (authErr) return authErr;

    // Single discovery query that also returns chain_id + timestamp for affected hours.
    // This replaces the old per-group SELECT loop.
    const { results: roundtripTxs } = await db.prepare(
      `SELECT tx_hash, stablecoin_id, chain_id,
              MIN(timestamp) as min_ts,
              COUNT(*) as cnt
       FROM mint_burn_events
       WHERE flow_type = 'standard'
       GROUP BY tx_hash, stablecoin_id, chain_id
       HAVING COUNT(DISTINCT direction) > 1
       LIMIT ?`,
    ).bind(BATCH_SIZE).all<{
      tx_hash: string;
      stablecoin_id: string;
      chain_id: string;
      min_ts: number;
      cnt: number;
    }>();

    if (roundtripTxs.length === 0) {
      return jsonResponse({ done: true, updated: 0 });
    }

    // Collect affected hours from discovery results (no per-tx query needed).
    const affectedHours = new Map<string, MintBurnAffectedHour>();
    for (const row of roundtripTxs) {
      const hourTs = Math.floor(row.min_ts / 3600) * 3600;
      const key = `${row.stablecoin_id}-${row.chain_id}-${hourTs}`;
      affectedHours.set(key, {
        stablecoinId: row.stablecoin_id,
        chainId: row.chain_id,
        hourTs,
      });
    }

    // Batch UPDATE all matched rows in one batchExecute call.
    const updateStmts = roundtripTxs.map((row) =>
      db.prepare(
        `UPDATE mint_burn_events
         SET flow_type = 'atomic_roundtrip'
         WHERE tx_hash = ? AND stablecoin_id = ? AND flow_type = 'standard'`,
      ).bind(row.tx_hash, row.stablecoin_id),
    );
    const updated = await batchExecute(db, updateStmts);

    await recalcAffectedHours(db, affectedHours);

    return jsonResponse({
      done: roundtripTxs.length < BATCH_SIZE,
      updated,
      hoursRecalculated: affectedHours.size,
      batchSize: BATCH_SIZE,
    });
  },
);
