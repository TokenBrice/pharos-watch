import { DAY_SECONDS } from "@shared/lib/time-constants";

import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { runWithOverloadRetry } from "../../lib/cron-lease";
import { toErrorMessage } from "../../lib/error-utils";

export const MINT_BURN_EVENT_RETENTION_SEC = 8 * DAY_SECONDS;
export const MINT_BURN_HOURLY_RETENTION_SEC = 95 * DAY_SECONDS;

const MINT_BURN_TAPE_CURSOR_KEY = "tape-projector:cursor:mint_burn.large_flow";
const DEFAULT_DELETE_BATCH_LIMIT = 10_000;
const DEFAULT_EVENT_DELETE_RUN_LIMIT = 50_000;
const DEFAULT_HOURLY_DELETE_RUN_LIMIT = 25_000;

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
  eventRows: MintBurnRetentionFamilyResult;
  hourlyRows: MintBurnRetentionFamilyResult;
  durationMs: number;
  error: string | null;
}

interface MintBurnRetentionOptions {
  eventBatchLimit?: number;
  eventRunLimit?: number;
  hourlyBatchLimit?: number;
  hourlyRunLimit?: number;
}

function normalizeLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return resolved;
}

async function deleteCapped(
  db: D1Database,
  sql: string,
  bindsForLimit: (limit: number) => unknown[],
  batchLimit: number,
  runLimit: number,
  signal?: AbortSignal,
): Promise<{ deletedRows: number; cappedAtLimit: boolean }> {
  let deletedRows = 0;
  while (deletedRows < runLimit) {
    throwIfAborted(signal);
    const limit = Math.min(batchLimit, runLimit - deletedRows);
    const result = await runWithOverloadRetry(
      () => db.prepare(sql).bind(...bindsForLimit(limit)).run(),
      3,
      signal,
    );
    const deleted = Number(result.meta?.changes ?? 0);
    deletedRows += deleted;
    if (deleted < limit) break;
  }
  return {
    deletedRows,
    cappedAtLimit: deletedRows >= runLimit,
  };
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
    result.deletedRows = deleted.deletedRows;
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
    result.deletedRows = deleted.deletedRows;
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
  const eventBatchLimit = normalizeLimit(
    options.eventBatchLimit,
    DEFAULT_DELETE_BATCH_LIMIT,
    "eventBatchLimit",
  );
  const eventRunLimit = normalizeLimit(
    options.eventRunLimit,
    DEFAULT_EVENT_DELETE_RUN_LIMIT,
    "eventRunLimit",
  );
  const hourlyBatchLimit = normalizeLimit(
    options.hourlyBatchLimit,
    DEFAULT_DELETE_BATCH_LIMIT,
    "hourlyBatchLimit",
  );
  const hourlyRunLimit = normalizeLimit(
    options.hourlyRunLimit,
    DEFAULT_HOURLY_DELETE_RUN_LIMIT,
    "hourlyRunLimit",
  );

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
    eventRows.error ? `eventRows: ${eventRows.error}` : null,
    hourlyRows.error ? `hourlyRows: ${hourlyRows.error}` : null,
  ].filter((error): error is string => error !== null);

  return {
    eventRows,
    hourlyRows,
    durationMs: Math.max(0, Date.now() - startedAtMs),
    error: errors.length > 0 ? errors.join("; ").slice(0, 500) : null,
  };
}
