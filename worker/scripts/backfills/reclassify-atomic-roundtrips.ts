import { jsonResponse } from "../../src/lib/api-response";
import { parseOptionalNonNegativeIntegerParam } from "../../src/lib/api-params";
import { runTrustedAdminMutation } from "../../src/lib/route-wrappers";
import {
  drainMintBurnMaterializationDebt,
  executeMintBurnMaintenanceMutations,
} from "../../src/lib/mint-burn-pipeline/materialization-debt";
import { ROUNDTRIP_TOLERANCE_HAVING_SQL } from "../../src/lib/mint-burn-pipeline/roundtrip-detection";

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

async function reclassify(
  db: D1Database,
  rows: RoundtripDiscoveryRow[],
  from: "standard" | "atomic_roundtrip",
  to: "standard" | "atomic_roundtrip",
): Promise<number> {
  const { changed } = await executeMintBurnMaintenanceMutations(db, rows.map((row) => ({
    // Nonreturning writes preserve the operator adapter's atomic-import receipts.
    // Read every matching source hour, not only the discovery group's MIN(timestamp).
    enqueue: db.prepare(`INSERT OR IGNORE INTO mint_burn_dirty_hours (stablecoin_id, chain_id, hour_ts)
      SELECT DISTINCT stablecoin_id, chain_id, (timestamp / 3600) * 3600
      FROM mint_burn_events
      WHERE tx_hash = ? AND stablecoin_id = ? AND chain_id = ? AND flow_type = ?`)
      .bind(row.tx_hash, row.stablecoin_id, row.chain_id, from),
    update: db.prepare(`UPDATE mint_burn_events SET flow_type = ?
      WHERE tx_hash = ? AND stablecoin_id = ? AND chain_id = ? AND flow_type = ?`)
      .bind(to, row.tx_hash, row.stablecoin_id, row.chain_id, from),
  })));
  return changed;
}

async function drainDebt(db: D1Database): Promise<number> {
  let total = 0;
  let drained: number;
  do {
    drained = await drainMintBurnMaterializationDebt(db, { limit: BATCH_SIZE });
    total += drained;
  } while (drained === BATCH_SIZE);
  return total;
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
 * Operator CLI job: reclassify-atomic-roundtrips (no HTTP route).
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
 * Returns { done: true } when both passes land < BATCH_SIZE rows and no debt remains.
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

    // Retry repair is independent of discovery: interrupted tags may no longer match.
    let hoursRecalculated = await drainDebt(db);

    // --- Forward pass: standard → atomic_roundtrip ---
    const { results: forwardTxs } = await db
      .prepare(
        `SELECT tx_hash, stablecoin_id, chain_id, MIN(timestamp) as timestamp
         FROM mint_burn_events
         WHERE flow_type = 'standard' AND timestamp >= ?${coinFilterSql}
         GROUP BY tx_hash, stablecoin_id, chain_id
         HAVING COUNT(DISTINCT direction) > 1
            AND (${ROUNDTRIP_TOLERANCE_HAVING_SQL})
         ORDER BY MIN(timestamp) ASC, stablecoin_id ASC, tx_hash ASC
         LIMIT ?`,
      )
      .bind(...buildBindArgs([since]), BATCH_SIZE)
      .all<RoundtripDiscoveryRow>();

    const toRoundtrip = await reclassify(db, forwardTxs, "standard", "atomic_roundtrip");

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

    const toStandard = await reclassify(db, reverseTxs, "atomic_roundtrip", "standard");

    hoursRecalculated += await drainDebt(db);
    const pendingDebt = await db.prepare("SELECT 1 FROM mint_burn_dirty_hours LIMIT 1").first();

    return jsonResponse({
      done: forwardTxs.length < BATCH_SIZE && reverseTxs.length < BATCH_SIZE && pendingDebt === null,
      since,
      stablecoinId,
      // Legacy field: sum of both directions so callers can monitor any activity.
      updated: toRoundtrip + toStandard,
      toRoundtrip,
      toStandard,
      hoursRecalculated,
      batchSize: BATCH_SIZE,
    });
  });
}
