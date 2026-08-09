import { jsonResponse, parseOptionalNonNegativeIntegerParam } from "../lib/api-utils";
import { runTrustedAdminMutation } from "../lib/route-wrappers";
import { batchExecute } from "../lib/db";
import { collectAffectedHours, recalcAffectedHours } from "../lib/mint-burn-pipeline/persistence";
import { ROUNDTRIP_TOLERANCE_HAVING_SQL } from "../lib/mint-burn-pipeline/roundtrip-detection";
import type { MintBurnAffectedHour } from "../lib/mint-burn-pipeline/types";

const BATCH_SIZE = 1000;
/**
 * Default reclassify window. The `atomic_roundtrip` partition alone has >100k
 * rows in production; scanning all of them with the tolerance HAVING clause
 * exceeds D1's per-statement CPU budget. The `idx_mbe_flow_type_ts` index on
 * `(flow_type, timestamp DESC)` lets the query prune when a timestamp cutoff
 * is present. Callers can widen via `?since=0` at their own risk.
 */
const DEFAULT_SINCE_LOOKBACK_SEC = 90 * 24 * 3600;

interface RoundtripDiscoveryRow {
  tx_hash: string;
  stablecoin_id: string;
  chain_id: string;
  timestamp: number;
}

export interface ReclassifyAtomicRoundtripsRouteContext {
  db: D1Database;
  url: URL;
}

function resolveSince(url: URL): number | Response {
  const defaultSince = Math.floor(Date.now() / 1000) - DEFAULT_SINCE_LOOKBACK_SEC;
  return parseOptionalNonNegativeIntegerParam(url.searchParams.get("since"), defaultSince, "since");
}

function resolveStablecoinId(url: URL): string | null {
  const raw = url.searchParams.get("stablecoinId");
  return raw && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * POST /api/reclassify-atomic-roundtrips (admin)
 * Retroactively re-tags mint_burn_events flow_type in two passes:
 *   - Forward: standard → atomic_roundtrip when the same (tx_hash, stablecoin_id, chain_id)
 *     contains both mints and burns whose totals match within tolerance.
 *   - Reverse: atomic_roundtrip → standard when legacy-tagged groups no longer
 *     satisfy the 0.5% amount-match tolerance introduced in Task 1.4.
 *
 * Both passes respect:
 *   - `?since=<unixSeconds>` (default: last 90 days).
 *   - `?stablecoinId=<id>` (optional): narrows both scans to one coin's rows.
 *     Strongly recommended on production when the atomic_roundtrip partition
 *     has >30k rows — per-coin queries stay within D1's per-statement CPU
 *     budget even with the tolerance HAVING clause.
 *
 * Pass `since=0` to sweep the entire table (expect D1 CPU limits without
 * the `stablecoinId` filter).
 *
 * Returns { done: true } when both passes land < BATCH_SIZE rows.
 */
export async function handleReclassifyAtomicRoundtripsTrusted({
  db,
  url,
}: ReclassifyAtomicRoundtripsRouteContext): Promise<Response> {
  return runTrustedAdminMutation(async () => {
    const since = resolveSince(url);
    if (since instanceof Response) return since;
    const stablecoinId = resolveStablecoinId(url);
    const coinFilterSql = stablecoinId ? " AND stablecoin_id = ?" : "";
    const buildBindArgs = (base: (string | number)[]): (string | number)[] =>
      stablecoinId ? [...base, stablecoinId] : base;

    // --- Forward pass: standard → atomic_roundtrip ---
    const { results: forwardTxs } = await db
      .prepare(
        `SELECT tx_hash, stablecoin_id, chain_id, MIN(timestamp) as timestamp
         FROM mint_burn_events
         WHERE flow_type = 'standard' AND timestamp >= ?${coinFilterSql}
         GROUP BY tx_hash, stablecoin_id, chain_id
         HAVING COUNT(DISTINCT direction) > 1
         ORDER BY MIN(timestamp) ASC, stablecoin_id ASC, tx_hash ASC
         LIMIT ?`,
      )
      .bind(...buildBindArgs([since]), BATCH_SIZE)
      .all<RoundtripDiscoveryRow>();

    const affectedHours = new Map<string, MintBurnAffectedHour>();
    let toRoundtrip = 0;
    if (forwardTxs.length > 0) {
      collectAffectedHours(forwardTxs, affectedHours);
      const forwardStmts = forwardTxs.map((row) =>
        db
          .prepare(
            `UPDATE mint_burn_events
             SET flow_type = 'atomic_roundtrip'
             WHERE tx_hash = ? AND stablecoin_id = ? AND chain_id = ? AND flow_type = 'standard'`,
          )
          .bind(row.tx_hash, row.stablecoin_id, row.chain_id),
      );
      toRoundtrip = await batchExecute(db, forwardStmts);
    }

    // --- Reverse pass: atomic_roundtrip → standard for tolerance-violating groups.
    // The HAVING fragment is the inverse of ROUNDTRIP_TOLERANCE_HAVING_SQL — a
    // group survives the filter only when mint and burn sides are both non-zero
    // AND the two totals diverge by more than the shared 0.5% tolerance.
    const { results: reverseTxs } = await db
      .prepare(
        `SELECT tx_hash, stablecoin_id, chain_id, MIN(timestamp) as timestamp
         FROM mint_burn_events
         WHERE flow_type = 'atomic_roundtrip' AND timestamp >= ?${coinFilterSql}
         GROUP BY tx_hash, stablecoin_id, chain_id
         HAVING SUM(CASE WHEN direction='mint' THEN amount ELSE 0 END) > 0
            AND SUM(CASE WHEN direction='burn' THEN amount ELSE 0 END) > 0
            AND NOT (${ROUNDTRIP_TOLERANCE_HAVING_SQL})
         ORDER BY MIN(timestamp) ASC, stablecoin_id ASC, tx_hash ASC
         LIMIT ?`,
      )
      .bind(...buildBindArgs([since]), BATCH_SIZE)
      .all<RoundtripDiscoveryRow>();

    let toStandard = 0;
    if (reverseTxs.length > 0) {
      collectAffectedHours(reverseTxs, affectedHours);
      const reverseStmts = reverseTxs.map((row) =>
        db
          .prepare(
            `UPDATE mint_burn_events
             SET flow_type = 'standard'
             WHERE tx_hash = ? AND stablecoin_id = ? AND chain_id = ? AND flow_type = 'atomic_roundtrip'`,
          )
          .bind(row.tx_hash, row.stablecoin_id, row.chain_id),
      );
      toStandard = await batchExecute(db, reverseStmts);
    }

    await recalcAffectedHours(db, affectedHours);

    return jsonResponse({
      done: forwardTxs.length < BATCH_SIZE && reverseTxs.length < BATCH_SIZE,
      since,
      stablecoinId,
      // Legacy field: sum of both directions so callers can monitor any activity.
      updated: toRoundtrip + toStandard,
      toRoundtrip,
      toStandard,
      hoursRecalculated: affectedHours.size,
      batchSize: BATCH_SIZE,
    });
  });
}
