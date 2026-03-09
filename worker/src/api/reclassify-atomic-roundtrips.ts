import { requireAdmin } from "../lib/auth";
import { withErrorHandler, jsonResponse } from "../lib/api-utils";
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
    adminKey: string | undefined,
    request?: Request,
  ): Promise<Response> => {
    const authErr = await requireAdmin(request, adminKey);
    if (authErr) return authErr;

    const { results: roundtripTxs } = await db.prepare(
      `SELECT tx_hash, stablecoin_id
       FROM mint_burn_events
       WHERE flow_type = 'standard'
       GROUP BY tx_hash, stablecoin_id
       HAVING COUNT(DISTINCT direction) > 1
       LIMIT ?`,
    ).bind(BATCH_SIZE).all<{ tx_hash: string; stablecoin_id: string }>();

    if (roundtripTxs.length === 0) {
      return jsonResponse({ done: true, updated: 0 });
    }

    const affectedHours = new Map<string, MintBurnAffectedHour>();
    let updated = 0;

    for (const { tx_hash, stablecoin_id } of roundtripTxs) {
      const { results: events } = await db.prepare(
        `SELECT chain_id, timestamp FROM mint_burn_events
         WHERE tx_hash = ? AND stablecoin_id = ? AND flow_type = 'standard'`,
      ).bind(tx_hash, stablecoin_id).all<{ chain_id: string; timestamp: number }>();

      for (const event of events) {
        const hourTs = Math.floor(event.timestamp / 3600) * 3600;
        const key = `${stablecoin_id}-${event.chain_id}-${hourTs}`;
        affectedHours.set(key, {
          stablecoinId: stablecoin_id,
          chainId: event.chain_id,
          hourTs,
        });
      }

      const result = await db.prepare(
        `UPDATE mint_burn_events
         SET flow_type = 'atomic_roundtrip'
         WHERE tx_hash = ? AND stablecoin_id = ? AND flow_type = 'standard'`,
      ).bind(tx_hash, stablecoin_id).run();
      updated += result.meta.changes ?? 0;
    }

    await recalcAffectedHours(db, affectedHours);

    return jsonResponse({
      done: roundtripTxs.length < BATCH_SIZE,
      updated,
      hoursRecalculated: affectedHours.size,
      batchSize: BATCH_SIZE,
    });
  },
);
