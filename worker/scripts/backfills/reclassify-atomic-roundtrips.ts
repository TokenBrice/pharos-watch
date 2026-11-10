import { jsonResponse } from "../../src/lib/api-response";
import { parseOptionalNonNegativeIntegerParam } from "../../src/lib/api-params";
import { runTrustedAdminMutation } from "../../src/lib/route-wrappers";
import { drainMintBurnMaterializationDebt } from "../../src/lib/mint-burn-pipeline/materialization-debt";
import {
  discoverRoundtripGroups,
  parseRoundtripCursor,
  reconcileAtomicRoundtripGroups,
} from "../../src/lib/mint-burn-pipeline/roundtrip-detection";

const BATCH_SIZE = 1000;
const DEFAULT_SINCE_LOOKBACK_SEC = 90 * 24 * 3600;

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

/**
 * Operator CLI job (no HTTP route): reconcile complete transaction populations
 * with the same resolved-leg/raw-BigInt rule as ingestion and the cron sweep.
 * Continue with the returned nextCursor; unchanged unequal groups advance too.
 */
export async function handleReclassifyAtomicRoundtripsTrusted({
  db,
  url,
}: ReclassifyAtomicRoundtripsRouteContext): Promise<Response> {
  return runTrustedAdminMutation(async () => {
    const defaultSince = Math.floor(Date.now() / 1000) - DEFAULT_SINCE_LOOKBACK_SEC;
    const since = parseOptionalNonNegativeIntegerParam(url.searchParams.get("since"), defaultSince, "since");
    if (since instanceof Response) return since;
    const stablecoinId = url.searchParams.get("stablecoinId")?.trim() || null;
    const rawCursor = url.searchParams.get("cursor");
    const cursor = rawCursor == null ? null : parseRoundtripCursor(rawCursor);
    if (rawCursor != null && !cursor) return jsonResponse({ error: "Invalid cursor" }, { status: 400 });

    // Retry repair is independent of discovery and of the operator's scan scope.
    let hoursRecalculated = await drainDebt(db);
    const groups = await discoverRoundtripGroups(db, since, BATCH_SIZE, { cursor, stablecoinId });
    const result = await reconcileAtomicRoundtripGroups(db, groups, { returnAffectedHours: false });
    hoursRecalculated += await drainDebt(db);
    const pendingDebt = await db.prepare("SELECT 1 FROM mint_burn_dirty_hours LIMIT 1").first();
    const nextCursor = groups.length === BATCH_SIZE ? JSON.stringify(groups[groups.length - 1]) : null;
    return jsonResponse({
      done: nextCursor === null && pendingDebt === null,
      since,
      stablecoinId,
      nextCursor,
      updated: result.changed,
      toRoundtrip: result.toRoundtrip,
      toStandard: result.toStandard,
      hoursRecalculated,
      batchSize: BATCH_SIZE,
    });
  });
}
