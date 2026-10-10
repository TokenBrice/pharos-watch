import { DAY_SECONDS } from "@shared/lib/time-constants";
import { toErrorMessage } from "@shared/lib/error-utils";

import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { mintBurnHourlyBucketAggregatesSql } from "../../lib/mint-burn-pipeline/persistence";
import { MINT_BURN_HOURLY_BUCKET_COLUMNS_SQL } from "../../lib/mint-burn-hourly-valuation";
import { runCappedPruneFamily } from "../shared/capped-delete";
import { tapeProjectorCursorKey } from "../../lib/tape-event-store";
import { MINT_BURN_CONFIGS, type MintBurnContractConfig } from "../../lib/mint-burn-contracts";
import { mintBurnConfigKey } from "../../lib/mint-burn-pipeline/sync-state";
import { includeActiveTrackedIds } from "../shared/exclude-frozen";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";

export const MINT_BURN_EVENT_RETENTION_SEC = 8 * DAY_SECONDS;
export const MINT_BURN_HOURLY_RETENTION_SEC = 95 * DAY_SECONDS;

const MINT_BURN_TAPE_CURSOR_KEY = tapeProjectorCursorKey("mint_burn.large_flow");
const DEFAULT_DELETE_BATCH_LIMIT = 10_000;
const DEFAULT_EVENT_DELETE_RUN_LIMIT = 50_000;
const DEFAULT_HOURLY_DELETE_RUN_LIMIT = 25_000;
const DEFAULT_REPAIR_CANDIDATE_EVENT_LIMIT = 50_000;
const DEFAULT_HOURLY_REPAIR_RUN_LIMIT = 5_000;

// Registry-owned identities only, not provider input. Use the same active,
// enabled config scope as ingestion, across both lanes.
function mintBurnConfigFrontiersSql(configs: readonly MintBurnContractConfig[]): string {
  if (configs.length === 0) {
    return "SELECT NULL AS column1, NULL AS column2, NULL AS column3 WHERE 0";
  }
  return `VALUES ${configs.map((config) =>
    `('${config.stablecoinId}', '${config.chain.chainId}', '${mintBurnConfigKey(config)}')`,
  ).join(", ")}`;
}

/**
 * Retention-eligibility predicate shared by all four retention statements
 * (repair candidates, oldest-repairable, event delete, oldest-eligible).
 * An event row may only leave `mint_burn_events` once its price is final
 * (`amount_usd` present or repair settled as recovered/irreducible), it is
 * not awaiting aggregation, and the mint-burn tape projector has consumed
 * past it. Bind order at every consumer: cutoff first, then
 * MINT_BURN_TAPE_CURSOR_KEY. A missing cursor cache row fails closed via
 * COALESCE 0 — nothing is eligible for deletion or repair.
 */
const MINT_BURN_TAPE_ELIGIBLE_EVENT_SQL = `event.timestamp < ?
  AND (
    event.amount_usd IS NOT NULL
    OR event.price_repair_status IN ('recovered', 'irreducible')
  )
  AND COALESCE(event.price_repair_status, '') <> 'pending_aggregate'
  AND event.timestamp <= COALESCE((
    SELECT CAST(value AS INTEGER)
      FROM cache
     WHERE key = ?
  ), 0)`;

/**
 * Whole-hour finality: neither valuation debt nor an uncommitted scan frontier
 * may lose a sibling needed to reconstruct the bucket. Missing sync state
 * fails closed for active enabled configs. Secondary configs conservatively
 * protect siblings until every matching enabled frontier covers them.
 */
function mintBurnFinalHourSql(frontiersSql: string): string {
  return `NOT EXISTS (
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
         OR EXISTS (
           SELECT 1
             FROM (${frontiersSql}) frontier
            WHERE frontier.column1 = sibling.stablecoin_id
              AND frontier.column2 = sibling.chain_id
              AND sibling.block_number > COALESCE((
                SELECT state.last_block FROM mint_burn_sync_state state
                 WHERE state.config_key = frontier.column3
              ), -1)
         )
       )
  )`;
}

/**
 * Repair-eligible event: retention-eligible, its hour carries no aggregate row,
 * and every sibling in that hour is final. Bind order: cutoff, tape cursor.
 */
function mintBurnRepairableEventSql(frontiersSql: string): string {
  return `${MINT_BURN_TAPE_ELIGIBLE_EVENT_SQL}
  AND ${mintBurnFinalHourSql(frontiersSql)}
  AND NOT EXISTS (
    SELECT 1
      FROM mint_burn_hourly hourly
     WHERE hourly.stablecoin_id = event.stablecoin_id
       AND hourly.chain_id = event.chain_id
       AND hourly.hour_ts = (event.timestamp / 3600) * 3600
  )`;
}

/**
 * Deletable event: retention-eligible and its hour is already aggregated. Bind
 * order: cutoff, MINT_BURN_TAPE_CURSOR_KEY. Shared by the delete and the
 * oldest-eligible backlog probe.
 */
function mintBurnAggregatedEventSql(frontiersSql: string): string {
  return `${MINT_BURN_TAPE_ELIGIBLE_EVENT_SQL}
  AND ${mintBurnFinalHourSql(frontiersSql)}
  AND EXISTS (
    SELECT 1
      FROM mint_burn_hourly hourly
     WHERE hourly.stablecoin_id = event.stablecoin_id
       AND hourly.chain_id = event.chain_id
       AND hourly.hour_ts = (event.timestamp / 3600) * 3600
  )`;
}

/**
 * Deletable hourly row: past its own retention window with no surviving source
 * event in the hour. Bind order: cutoff. Shared by the delete and the
 * oldest-eligible backlog probe.
 */
const MINT_BURN_DRAINED_HOURLY_SQL = `hourly.hour_ts < ?
  AND NOT EXISTS (
    SELECT 1
      FROM mint_burn_events event
     WHERE event.stablecoin_id = hourly.stablecoin_id
       AND event.chain_id = hourly.chain_id
       AND event.timestamp >= hourly.hour_ts
       AND event.timestamp < hourly.hour_ts + 3600
  )`;

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
  frontierProtection: MintBurnFrontierProtectionResult;
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

export interface MintBurnFrontierProtectionResult {
  configs: Array<{
    configKey: string;
    stablecoinId: string;
    chainId: string;
    lastBlock: number | null;
    highestProtectedBlock: number;
    lagBlocks: number | null;
    oldestProtectedHour: number;
    oldestProtectedAgeSeconds: number;
  }> | null;
  error: string | null;
}

/**
 * Production supplies its all-lane enabled registry scope. Tests can also
 * override scale limits to exercise bounded repair and deletion loops.
 */
interface MintBurnRetentionOptions {
  enabledConfigs?: readonly MintBurnContractConfig[];
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
  frontiersSql: string,
  candidateEventLimit: number,
  runLimit: number,
  signal?: AbortSignal,
): Promise<MintBurnAggregationRepairResult> {
  const cutoff = nowSec - MINT_BURN_EVENT_RETENTION_SEC;
  const family = await runCappedPruneFamily({
    db,
    signal,
    statements: {
      repair: {
        sql: `/* pharos:mint-burn:aggregation-evidence-repair */
           WITH oldest_candidates AS MATERIALIZED (
             SELECT
               event.stablecoin_id,
               event.chain_id,
               (event.timestamp / 3600) * 3600 AS hour_ts,
               event.timestamp
             FROM mint_burn_events event INDEXED BY idx_mbe2_ts
             WHERE ${mintBurnRepairableEventSql(frontiersSql)}
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
             (stablecoin_id, chain_id, hour_ts, ${MINT_BURN_HOURLY_BUCKET_COLUMNS_SQL})
           SELECT
             event.stablecoin_id,
             event.chain_id,
             candidate.hour_ts,
             ${mintBurnHourlyBucketAggregatesSql("event.")}
             FROM candidate_hours candidate
             JOIN mint_burn_events event
               ON event.stablecoin_id = candidate.stablecoin_id
              AND event.chain_id = candidate.chain_id
              AND event.timestamp >= candidate.hour_ts
              AND event.timestamp < candidate.hour_ts + 3600
            GROUP BY event.stablecoin_id, event.chain_id, candidate.hour_ts`,
        bindsForLimit: (limit) => [cutoff, MINT_BURN_TAPE_CURSOR_KEY, candidateEventLimit, limit],
        batchLimit: runLimit,
        runLimit,
      },
    },
    probes: {
      oldestRepairable: {
        sql: `/* pharos:mint-burn:aggregation-evidence-oldest-repairable */
           SELECT event.timestamp AS oldest_repairable_at
             FROM mint_burn_events event INDEXED BY idx_mbe2_ts
            WHERE ${mintBurnRepairableEventSql(frontiersSql)}
            ORDER BY event.timestamp ASC
            LIMIT 1`,
        binds: [cutoff, MINT_BURN_TAPE_CURSOR_KEY],
      },
    },
  });
  const oldestRepairableAt = family.probes.oldestRepairable.oldest_repairable_at ?? null;
  return {
    cutoff,
    repairedRows: family.changedRows,
    oldestRepairableAt,
    // A remaining repairable event means this run stopped at its own budget.
    cappedAtLimit: oldestRepairableAt !== null,
    durationMs: family.durationMs,
    error: family.error,
  };
}

async function pruneEventRows(
  db: D1Database,
  nowSec: number,
  frontiersSql: string,
  batchLimit: number,
  runLimit: number,
  signal?: AbortSignal,
): Promise<MintBurnRetentionFamilyResult> {
  const cutoff = nowSec - MINT_BURN_EVENT_RETENTION_SEC;
  const family = await runCappedPruneFamily({
    db,
    signal,
    statements: {
      events: {
        sql: `/* pharos:mint-burn:event-retention-delete */
       DELETE FROM mint_burn_events
        WHERE id IN (
          SELECT event.id
            FROM mint_burn_events event
           WHERE ${mintBurnAggregatedEventSql(frontiersSql)}
           ORDER BY event.timestamp ASC
           LIMIT ?
        )`,
        bindsForLimit: (limit) => [cutoff, MINT_BURN_TAPE_CURSOR_KEY, limit],
        batchLimit,
        runLimit,
      },
    },
    probes: {
      oldestRemaining: { sql: "SELECT MIN(timestamp) AS oldest_remaining_at FROM mint_burn_events" },
      oldestEligible: {
        sql: `/* pharos:mint-burn:event-retention-oldest-eligible */
           SELECT event.timestamp AS oldest_eligible_at
             FROM mint_burn_events event
            WHERE ${mintBurnAggregatedEventSql(frontiersSql)}
            ORDER BY event.timestamp ASC
            LIMIT 1`,
        binds: [cutoff, MINT_BURN_TAPE_CURSOR_KEY],
      },
    },
  });
  return {
    cutoff,
    deletedRows: family.changedRows,
    oldestRemainingAt: family.probes.oldestRemaining.oldest_remaining_at ?? null,
    oldestEligibleAt: family.probes.oldestEligible.oldest_eligible_at ?? null,
    cappedAtLimit: family.cappedAtLimit,
    durationMs: family.durationMs,
    error: family.error,
  };
}

async function pruneHourlyRows(
  db: D1Database,
  nowSec: number,
  batchLimit: number,
  runLimit: number,
  signal?: AbortSignal,
): Promise<MintBurnRetentionFamilyResult> {
  const cutoff = nowSec - MINT_BURN_HOURLY_RETENTION_SEC;
  const family = await runCappedPruneFamily({
    db,
    signal,
    statements: {
      hourly: {
        sql: `/* pharos:mint-burn:hourly-retention-delete */
       DELETE FROM mint_burn_hourly
        WHERE rowid IN (
          SELECT hourly.rowid
            FROM mint_burn_hourly hourly
           WHERE ${MINT_BURN_DRAINED_HOURLY_SQL}
           ORDER BY hourly.hour_ts ASC
           LIMIT ?
        )`,
        bindsForLimit: (limit) => [cutoff, limit],
        batchLimit,
        runLimit,
      },
    },
    probes: {
      oldestRemaining: { sql: "SELECT MIN(hour_ts) AS oldest_remaining_at FROM mint_burn_hourly" },
      oldestEligible: {
        sql: `SELECT hourly.hour_ts AS oldest_eligible_at
             FROM mint_burn_hourly hourly
            WHERE ${MINT_BURN_DRAINED_HOURLY_SQL}
            ORDER BY hourly.hour_ts ASC
            LIMIT 1`,
        binds: [cutoff],
      },
    },
  });
  return {
    cutoff,
    deletedRows: family.changedRows,
    oldestRemainingAt: family.probes.oldestRemaining.oldest_remaining_at ?? null,
    oldestEligibleAt: family.probes.oldestEligible.oldest_eligible_at ?? null,
    cappedAtLimit: family.cappedAtLimit,
    durationMs: family.durationMs,
    error: family.error,
  };
}

async function loadFrontierProtection(
  db: D1Database,
  nowSec: number,
  frontiersSql: string,
  signal?: AbortSignal,
): Promise<MintBurnFrontierProtectionResult> {
  const cutoff = nowSec - MINT_BURN_EVENT_RETENTION_SEC;
  try {
    throwIfAborted(signal);
    const result = await runWithOverloadRetry(
      () => db.prepare(`/* pharos:mint-burn:retention-frontier-protection */
        SELECT frontier.column3 AS configKey,
               frontier.column1 AS stablecoinId,
               frontier.column2 AS chainId,
               state.last_block AS lastBlock,
               MAX(sibling.block_number) AS highestProtectedBlock,
               MAX(sibling.block_number) - state.last_block AS lagBlocks,
               MIN((sibling.timestamp / 3600) * 3600) AS oldestProtectedHour,
               ? - MIN((sibling.timestamp / 3600) * 3600) AS oldestProtectedAgeSeconds
          FROM (${frontiersSql}) frontier
          LEFT JOIN mint_burn_sync_state state ON state.config_key = frontier.column3
          JOIN mint_burn_events sibling
            ON sibling.stablecoin_id = frontier.column1
           AND sibling.chain_id = frontier.column2
           AND sibling.block_number > COALESCE(state.last_block, -1)
         WHERE sibling.timestamp < ?
           AND EXISTS (
             SELECT 1 FROM mint_burn_events event
              WHERE event.stablecoin_id = sibling.stablecoin_id
                AND event.chain_id = sibling.chain_id
                AND event.timestamp >= (sibling.timestamp / 3600) * 3600
                AND event.timestamp < ((sibling.timestamp / 3600) * 3600) + 3600
                AND event.timestamp < ?
           )
         GROUP BY frontier.column3, frontier.column1, frontier.column2, state.last_block
         ORDER BY frontier.column3`)
        .bind(nowSec, (Math.floor(cutoff / 3600) + 1) * 3600, cutoff)
        .all<NonNullable<MintBurnFrontierProtectionResult["configs"]>[number]>(),
      3,
      signal,
    );
    return { configs: result.results, error: null };
  } catch (caught) {
    rethrowIfAborted(caught, signal);
    return { configs: null, error: toErrorMessage(caught).slice(0, 500) };
  }
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
  const enabledConfigs = includeActiveTrackedIds(
    (options.enabledConfigs ?? MINT_BURN_CONFIGS).filter((config) => config.enabled !== false),
    (config) => config.stablecoinId,
  );
  const frontiersSql = mintBurnConfigFrontiersSql(enabledConfigs);

  const aggregationRepair = await repairMissingHourlyRows(
    db,
    nowSec,
    frontiersSql,
    repairCandidateEventLimit,
    repairRunLimit,
    signal,
  );
  throwIfAborted(signal);
  const eventRows = await pruneEventRows(
    db,
    nowSec,
    frontiersSql,
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
  throwIfAborted(signal);
  const frontierProtection = await loadFrontierProtection(db, nowSec, frontiersSql, signal);

  const errors = [
    aggregationRepair.error ? `aggregationRepair: ${aggregationRepair.error}` : null,
    eventRows.error ? `eventRows: ${eventRows.error}` : null,
    hourlyRows.error ? `hourlyRows: ${hourlyRows.error}` : null,
    frontierProtection.error ? `frontierProtection: ${frontierProtection.error}` : null,
  ].filter((error): error is string => error !== null);

  return {
    aggregationRepair,
    eventRows,
    hourlyRows,
    frontierProtection,
    durationMs: Math.max(0, Date.now() - startedAtMs),
    error: errors.length > 0 ? errors.join("; ").slice(0, 500) : null,
  };
}
