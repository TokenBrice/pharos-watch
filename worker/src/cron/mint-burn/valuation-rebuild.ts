import { throwIfAborted } from "../../lib/abort";
import { collectAffectedHours, recalcAffectedHours } from "../../lib/mint-burn-pipeline/persistence";
import { MINT_BURN_EVENT_RETENTION_SEC } from "./retention";

/** Legacy buckets rebuilt per completed run; the finite backlog drains newest-first, so 24h windows recover first. */
const LEGACY_VALUATION_REBUILD_HOUR_LIMIT = 500;
/**
 * Retention prunes only events older than MINT_BURN_EVENT_RETENTION_SEC, so an
 * hour starting this far inside the window has never lost a raw event: its
 * rebuild re-derives the exact bucket, now with recorded valuation coverage.
 */
const RETENTION_WINDOW_MARGIN_SEC = 3600;

/**
 * Re-aggregate hourly buckets written before valuation completeness was
 * recorded (NULL unpriced counts: pre-migration rows, or rows a prior Worker
 * rewrote during rollout) whose raw events are all still retained. Older legacy
 * buckets cannot be reconstructed and stay `unknown` until hourly retention
 * prunes them. Uses the same atomic per-hour delete+insert as every other
 * hourly recalculation. Returns the number of buckets rebuilt.
 */
export async function rebuildRetainedLegacyValuationHours(
  db: D1Database,
  nowSec: number,
  options: { signal?: AbortSignal; limit?: number } = {},
): Promise<number> {
  throwIfAborted(options.signal);
  const rows = await db
    .prepare(
      `SELECT /* pharos:mint-burn:legacy-valuation-rebuild */
              stablecoin_id, chain_id, hour_ts AS timestamp
         FROM mint_burn_hourly INDEXED BY idx_mbh_valuation_unrecorded
        WHERE hour_ts >= ?
          AND (mint_unpriced_event_count IS NULL OR burn_unpriced_event_count IS NULL)
        ORDER BY hour_ts DESC
        LIMIT ?`,
    )
    .bind(
      nowSec - MINT_BURN_EVENT_RETENTION_SEC + RETENTION_WINDOW_MARGIN_SEC,
      options.limit ?? LEGACY_VALUATION_REBUILD_HOUR_LIMIT,
    )
    .all<{ stablecoin_id: string; chain_id: string; timestamp: number }>();
  const affectedHours = collectAffectedHours(rows.results ?? []);
  if (affectedHours.size > 0) await recalcAffectedHours(db, affectedHours, { signal: options.signal });
  return affectedHours.size;
}
