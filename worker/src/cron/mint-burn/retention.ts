import { DAY_SECONDS } from "@shared/lib/time-constants";

import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { toErrorMessage } from "@shared/lib/error-utils";
import { deleteCapped } from "../shared/capped-delete";

export const MINT_BURN_EVENT_RETENTION_SEC = 8 * DAY_SECONDS;
export const MINT_BURN_HOURLY_RETENTION_SEC = 95 * DAY_SECONDS;

const MINT_BURN_TAPE_CURSOR_KEY = "tape-projector:cursor:mint_burn.large_flow";
const DEFAULT_DELETE_BATCH_LIMIT = 10_000;
const DEFAULT_EVENT_DELETE_RUN_LIMIT = 50_000;
const DEFAULT_HOURLY_DELETE_RUN_LIMIT = 25_000;
const DEFAULT_REPAIR_CANDIDATE_EVENT_LIMIT = 50_000;
const DEFAULT_HOURLY_REPAIR_RUN_LIMIT = 5_000;

export interface MintBurnRetentionFamilyResult {
  cutoff: number;
  deletedRows: number;
  oldestRemainingAt: number | null;
  oldestEligibleAt: number | null;
  cappedAtLimit: boolean;
  durationMs: number;
  error: string | null;
}

export interface MintBurnRetentionResult {
  aggregationRepair: MintBurnAggregationRepairResult;
  eventRows: MintBurnRetentionFamilyResult;
  hourlyRows: MintBurnRetentionFamilyResult;
  durationMs: number;
  error: string | null;
}

export interface MintBurnAggregationRepairResult {
  cutoff: number;
  repairedRows: number;
  oldestRepairableAt: number | null;
  cappedAtLimit: boolean;
  durationMs: number;
  error: string | null;
}

/**
 * Test-only scale overrides. Production callers (`sync-mint-burn.ts`) always take the module
 * defaults; the retention suite injects small limits to exercise the batch/cap loops.
 */
interface MintBurnRetentionOptions {
  repairCandidateEventLimit?: number;
  repairRunLimit?: number;
  eventBatchLimit?: number;
  eventRunLimit?: number;
  hourlyBatchLimit?: number;
  hourlyRunLimit?: number;
}

async function repairMissingHourlyRows(
  db: D1Database,
  nowSec: number,
  candidateEventLimit: number,
  runLimit: number,
  signal?: AbortSignal,
): Promise<MintBurnAggregationRepairResult> {
  const startedAtMs = Date.now();
  const cutoff = nowSec - MINT_BURN_EVENT_RETENTION_SEC;
  const result: MintBurnAggregationRepairResult = {
    cutoff,
    repairedRows: 0,
    oldestRepairableAt: null,
    cappedAtLimit: false,
    durationMs: 0,
    error: null,
  };

  try {
    throwIfAborted(signal);
    const repaired = await runWithOverloadRetry(
      () => db
        .prepare(
          `/* pharos:mint-burn:aggregation-evidence-repair */
           WITH oldest_candidates AS MATERIALIZED (
             SELECT
               event.stablecoin_id,
               event.chain_id,
               (event.timestamp / 3600) * 3600 AS hour_ts,
               event.timestamp
             FROM mint_burn_events event INDEXED BY idx_mbe2_ts
             WHERE event.timestamp < ?
               AND (
                 event.amount_usd IS NOT NULL
                 OR event.price_repair_status IN ('recovered', 'irreducible')
               )
               AND COALESCE(event.price_repair_status, '') <> 'pending_aggregate'
               AND event.timestamp <= COALESCE((
                 SELECT CAST(value AS INTEGER)
                   FROM cache
                  WHERE key = ?
               ), 0)
               AND NOT EXISTS (
                 SELECT 1
                   FROM mint_burn_hourly hourly
                  WHERE hourly.stablecoin_id = event.stablecoin_id
                    AND hourly.chain_id = event.chain_id
                    AND hourly.hour_ts = (event.timestamp / 3600) * 3600
               )
               AND NOT EXISTS (
                 SELECT 1
                   FROM mint_burn_events sibling
                  WHERE sibling.stablecoin_id = event.stablecoin_id
                    AND sibling.chain_id = event.chain_id
                    AND sibling.timestamp >= (event.timestamp / 3600) * 3600
                    AND sibling.timestamp < ((event.timestamp / 3600) * 3600) + 3600
                    AND (
                      (
                        sibling.amount_usd IS NULL
                        AND COALESCE(sibling.price_repair_status, '') NOT IN ('recovered', 'irreducible')
                      )
                      OR sibling.price_repair_status = 'pending_aggregate'
                    )
               )
             ORDER BY event.timestamp ASC
             LIMIT ?
           ), candidate_hours AS MATERIALIZED (
             SELECT stablecoin_id, chain_id, hour_ts, MIN(timestamp) AS oldest_at
               FROM oldest_candidates
              GROUP BY stablecoin_id, chain_id, hour_ts
              ORDER BY oldest_at ASC
              LIMIT ?
           )
           INSERT OR IGNORE INTO mint_burn_hourly
             (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
              mint_volume_usd, burn_volume_usd, net_flow_usd)
           SELECT
             event.stablecoin_id,
             event.chain_id,
             candidate.hour_ts,
             SUM(CASE WHEN event.direction = 'mint' AND event.flow_type = 'standard' THEN 1 ELSE 0 END),
             SUM(CASE WHEN event.direction = 'burn' AND event.burn_type = 'effective_burn' AND event.flow_type = 'standard' THEN 1 ELSE 0 END),
             COALESCE(SUM(CASE WHEN event.direction = 'mint' AND event.flow_type = 'standard' THEN event.amount_usd ELSE 0 END), 0),
             COALESCE(SUM(CASE WHEN event.direction = 'burn' AND event.burn_type = 'effective_burn' AND event.flow_type = 'standard' THEN event.amount_usd ELSE 0 END), 0),
             COALESCE(SUM(CASE
               WHEN event.direction = 'mint' AND event.flow_type = 'standard' THEN event.amount_usd
               WHEN event.direction = 'burn' AND event.burn_type = 'effective_burn' AND event.flow_type = 'standard' THEN -event.amount_usd
               ELSE 0
             END), 0)
             FROM candidate_hours candidate
             JOIN mint_burn_events event
               ON event.stablecoin_id = candidate.stablecoin_id
              AND event.chain_id = candidate.chain_id
              AND event.timestamp >= candidate.hour_ts
              AND event.timestamp < candidate.hour_ts + 3600
            GROUP BY event.stablecoin_id, event.chain_id, candidate.hour_ts`,
        )
        .bind(cutoff, MINT_BURN_TAPE_CURSOR_KEY, candidateEventLimit, runLimit)
        .run(),
      3,
      signal,
    );
    result.repairedRows = Number(repaired.meta?.changes ?? 0);

    const oldestRepairable = await runWithOverloadRetry(
      () => db
        .prepare(
          `/* pharos:mint-burn:aggregation-evidence-oldest-repairable */
           SELECT event.timestamp AS oldest_repairable_at
             FROM mint_burn_events event INDEXED BY idx_mbe2_ts
            WHERE event.timestamp < ?
              AND (
                event.amount_usd IS NOT NULL
                OR event.price_repair_status IN ('recovered', 'irreducible')
              )
              AND COALESCE(event.price_repair_status, '') <> 'pending_aggregate'
              AND event.timestamp <= COALESCE((
                SELECT CAST(value AS INTEGER)
                  FROM cache
                 WHERE key = ?
              ), 0)
              AND NOT EXISTS (
                SELECT 1
                  FROM mint_burn_hourly hourly
                 WHERE hourly.stablecoin_id = event.stablecoin_id
                   AND hourly.chain_id = event.chain_id
                   AND hourly.hour_ts = (event.timestamp / 3600) * 3600
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM mint_burn_events sibling
                 WHERE sibling.stablecoin_id = event.stablecoin_id
                   AND sibling.chain_id = event.chain_id
                   AND sibling.timestamp >= (event.timestamp / 3600) * 3600
                   AND sibling.timestamp < ((event.timestamp / 3600) * 3600) + 3600
                   AND (
                     (
                       sibling.amount_usd IS NULL
                       AND COALESCE(sibling.price_repair_status, '') NOT IN ('recovered', 'irreducible')
                     )
                     OR sibling.price_repair_status = 'pending_aggregate'
                   )
              )
            ORDER BY event.timestamp ASC
            LIMIT 1`,
        )
        .bind(cutoff, MINT_BURN_TAPE_CURSOR_KEY)
        .first<{ oldest_repairable_at: number | null }>(),
      3,
      signal,
    );
    result.oldestRepairableAt = oldestRepairable?.oldest_repairable_at ?? null;
    result.cappedAtLimit = result.oldestRepairableAt !== null;
  } catch (error) {
    rethrowIfAborted(error, signal);
    result.error = toErrorMessage(error).slice(0, 500);
  }

  result.durationMs = Math.max(0, Date.now() - startedAtMs);
  return result;
}

async function pruneEventRows(
  db: D1Database,
  nowSec: number,
  batchLimit: number,
  runLimit: number,
  signal?: AbortSignal,
): Promise<MintBurnRetentionFamilyResult> {
  const startedAtMs = Date.now();
  const cutoff = nowSec - MINT_BURN_EVENT_RETENTION_SEC;
  const result: MintBurnRetentionFamilyResult = {
    cutoff,
    deletedRows: 0,
    oldestRemainingAt: null,
    oldestEligibleAt: null,
    cappedAtLimit: false,
    durationMs: 0,
    error: null,
  };

  try {
    const deleted = await deleteCapped(
      db,
      `/* pharos:mint-burn:event-retention-delete */
       DELETE FROM mint_burn_events
        WHERE id IN (
          SELECT event.id
            FROM mint_burn_events event
           WHERE event.timestamp < ?
             AND (
               event.amount_usd IS NOT NULL
               OR event.price_repair_status IN ('recovered', 'irreducible')
             )
             AND COALESCE(event.price_repair_status, '') <> 'pending_aggregate'
             AND event.timestamp <= COALESCE((
               SELECT CAST(value AS INTEGER)
                 FROM cache
                WHERE key = ?
             ), 0)
             AND EXISTS (
               SELECT 1
                 FROM mint_burn_hourly hourly
                WHERE hourly.stablecoin_id = event.stablecoin_id
                  AND hourly.chain_id = event.chain_id
                  AND hourly.hour_ts = (event.timestamp / 3600) * 3600
             )
           ORDER BY event.timestamp ASC
           LIMIT ?
        )`,
      (limit) => [cutoff, MINT_BURN_TAPE_CURSOR_KEY, limit],
      batchLimit,
      runLimit,
      signal,
    );
    result.deletedRows = deleted.pruned;
    result.cappedAtLimit = deleted.cappedAtLimit;

    const oldest = await runWithOverloadRetry(
      () => db
        .prepare("SELECT MIN(timestamp) AS oldest_remaining_at FROM mint_burn_events")
        .first<{ oldest_remaining_at: number | null }>(),
      3,
      signal,
    );
    result.oldestRemainingAt = oldest?.oldest_remaining_at ?? null;

    const oldestEligible = await runWithOverloadRetry(
      () => db
        .prepare(
          `/* pharos:mint-burn:event-retention-oldest-eligible */
           SELECT event.timestamp AS oldest_eligible_at
             FROM mint_burn_events event
            WHERE event.timestamp < ?
              AND (
                event.amount_usd IS NOT NULL
                OR event.price_repair_status IN ('recovered', 'irreducible')
              )
              AND COALESCE(event.price_repair_status, '') <> 'pending_aggregate'
              AND event.timestamp <= COALESCE((
                SELECT CAST(value AS INTEGER)
                  FROM cache
                 WHERE key = ?
              ), 0)
              AND EXISTS (
                SELECT 1
                  FROM mint_burn_hourly hourly
                 WHERE hourly.stablecoin_id = event.stablecoin_id
                   AND hourly.chain_id = event.chain_id
                   AND hourly.hour_ts = (event.timestamp / 3600) * 3600
              )
            ORDER BY event.timestamp ASC
            LIMIT 1`,
        )
        .bind(cutoff, MINT_BURN_TAPE_CURSOR_KEY)
        .first<{ oldest_eligible_at: number | null }>(),
      3,
      signal,
    );
    result.oldestEligibleAt = oldestEligible?.oldest_eligible_at ?? null;
  } catch (error) {
    rethrowIfAborted(error, signal);
    result.error = toErrorMessage(error).slice(0, 500);
  }

  result.durationMs = Math.max(0, Date.now() - startedAtMs);
  return result;
}

async function pruneHourlyRows(
  db: D1Database,
  nowSec: number,
  batchLimit: number,
  runLimit: number,
  signal?: AbortSignal,
): Promise<MintBurnRetentionFamilyResult> {
  const startedAtMs = Date.now();
  const cutoff = nowSec - MINT_BURN_HOURLY_RETENTION_SEC;
  const result: MintBurnRetentionFamilyResult = {
    cutoff,
    deletedRows: 0,
    oldestRemainingAt: null,
    oldestEligibleAt: null,
    cappedAtLimit: false,
    durationMs: 0,
    error: null,
  };

  try {
    const deleted = await deleteCapped(
      db,
      `/* pharos:mint-burn:hourly-retention-delete */
       DELETE FROM mint_burn_hourly
        WHERE rowid IN (
          SELECT hourly.rowid
            FROM mint_burn_hourly hourly
           WHERE hourly.hour_ts < ?
             AND NOT EXISTS (
               SELECT 1
                 FROM mint_burn_events event
                WHERE event.stablecoin_id = hourly.stablecoin_id
                  AND event.chain_id = hourly.chain_id
                  AND event.timestamp >= hourly.hour_ts
                  AND event.timestamp < hourly.hour_ts + 3600
             )
           ORDER BY hourly.hour_ts ASC
           LIMIT ?
        )`,
      (limit) => [cutoff, limit],
      batchLimit,
      runLimit,
      signal,
    );
    result.deletedRows = deleted.pruned;
    result.cappedAtLimit = deleted.cappedAtLimit;

    const oldest = await runWithOverloadRetry(
      () => db
        .prepare("SELECT MIN(hour_ts) AS oldest_remaining_at FROM mint_burn_hourly")
        .first<{ oldest_remaining_at: number | null }>(),
      3,
      signal,
    );
    result.oldestRemainingAt = oldest?.oldest_remaining_at ?? null;

    const oldestEligible = await runWithOverloadRetry(
      () => db
        .prepare(
          `SELECT hourly.hour_ts AS oldest_eligible_at
             FROM mint_burn_hourly hourly
            WHERE hourly.hour_ts < ?
              AND NOT EXISTS (
                SELECT 1
                  FROM mint_burn_events event
                 WHERE event.stablecoin_id = hourly.stablecoin_id
                   AND event.chain_id = hourly.chain_id
                   AND event.timestamp >= hourly.hour_ts
                   AND event.timestamp < hourly.hour_ts + 3600
              )
            ORDER BY hourly.hour_ts ASC
            LIMIT 1`,
        )
        .bind(cutoff)
        .first<{ oldest_eligible_at: number | null }>(),
      3,
      signal,
    );
    result.oldestEligibleAt = oldestEligible?.oldest_eligible_at ?? null;
  } catch (error) {
    rethrowIfAborted(error, signal);
    result.error = toErrorMessage(error).slice(0, 500);
  }

  result.durationMs = Math.max(0, Date.now() - startedAtMs);
  return result;
}

/** @internal Exported for focused retention tests. */
export async function pruneMintBurnRetention(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
  options: MintBurnRetentionOptions = {},
): Promise<MintBurnRetentionResult> {
  throwIfAborted(signal);
  const startedAtMs = Date.now();
  const repairCandidateEventLimit = options.repairCandidateEventLimit ?? DEFAULT_REPAIR_CANDIDATE_EVENT_LIMIT;
  const repairRunLimit = options.repairRunLimit ?? DEFAULT_HOURLY_REPAIR_RUN_LIMIT;
  const eventBatchLimit = options.eventBatchLimit ?? DEFAULT_DELETE_BATCH_LIMIT;
  const eventRunLimit = options.eventRunLimit ?? DEFAULT_EVENT_DELETE_RUN_LIMIT;
  const hourlyBatchLimit = options.hourlyBatchLimit ?? DEFAULT_DELETE_BATCH_LIMIT;
  const hourlyRunLimit = options.hourlyRunLimit ?? DEFAULT_HOURLY_DELETE_RUN_LIMIT;

  const aggregationRepair = await repairMissingHourlyRows(
    db,
    nowSec,
    repairCandidateEventLimit,
    repairRunLimit,
    signal,
  );
  throwIfAborted(signal);
  const eventRows = await pruneEventRows(
    db,
    nowSec,
    Math.min(eventBatchLimit, eventRunLimit),
    eventRunLimit,
    signal,
  );
  throwIfAborted(signal);
  const hourlyRows = await pruneHourlyRows(
    db,
    nowSec,
    Math.min(hourlyBatchLimit, hourlyRunLimit),
    hourlyRunLimit,
    signal,
  );

  const errors = [
    aggregationRepair.error ? `aggregationRepair: ${aggregationRepair.error}` : null,
    eventRows.error ? `eventRows: ${eventRows.error}` : null,
    hourlyRows.error ? `hourlyRows: ${hourlyRows.error}` : null,
  ].filter((error): error is string => error !== null);

  return {
    aggregationRepair,
    eventRows,
    hourlyRows,
    durationMs: Math.max(0, Date.now() - startedAtMs),
    error: errors.length > 0 ? errors.join("; ").slice(0, 500) : null,
  };
}
