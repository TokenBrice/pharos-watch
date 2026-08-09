import type { ContractEventConfig } from "../../lib/blacklist-contracts";
import { batchExecute, normalizeBlacklistSyncStateKey } from "../../lib/db";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { throwIfAborted } from "../../lib/abort";

export type BlacklistCursorKind = "evm_block" | "tron_timestamp_ms";

export type BlacklistConfigOutcome =
  | "running"
  | "complete"
  | "quiet"
  | "partial"
  | "provider_error"
  | "missing_topic"
  | "incomplete"
  | "cursor_ahead"
  | "provider_skipped"
  | "budget_skipped"
  | "exception";

export interface BlacklistConfigState {
  config: ContractEventConfig;
  configKey: string;
  cursorKind: BlacklistCursorKind;
  cursorValue: number;
  attemptGeneration: number;
  lastAttemptedAt: number | null;
  lastSucceededAt: number | null;
  lastSkippedAt: number | null;
  lastFailedAt: number | null;
  consecutiveSkips: number;
  consecutiveFailures: number;
  lastOutcome: string | null;
}

export interface BlacklistConfigAttempt {
  configKey: string;
  cursorKind: BlacklistCursorKind;
  expectedCursor: number;
  generation: number;
  attemptedAt: number;
}

export function inferBlacklistCursorKind(config: ContractEventConfig): BlacklistCursorKind {
  return config.chain.type === "tron" ? "tron_timestamp_ms" : "evm_block";
}

function attemptSortValue(state: BlacklistConfigState): number {
  return state.lastAttemptedAt ?? 0;
}

function compareWithinCohort(a: BlacklistConfigState, b: BlacklistConfigState): number {
  return attemptSortValue(a) - attemptSortValue(b) || a.configKey.localeCompare(b.configKey);
}

/**
 * Merge source cohorts by the comparable attempt timestamp, never by the
 * source-specific cursor value. Ties alternate cohorts so a newly migrated
 * Tron cohort is admitted near the front of the first run.
 */
export function orderBlacklistConfigStatesFairly(states: readonly BlacklistConfigState[]): BlacklistConfigState[] {
  const evm = states.filter((state) => state.cursorKind === "evm_block").sort(compareWithinCohort);
  const tron = states.filter((state) => state.cursorKind === "tron_timestamp_ms").sort(compareWithinCohort);
  const ordered: BlacklistConfigState[] = [];
  let evmIndex = 0;
  let tronIndex = 0;
  let preferTronOnTie = true;

  while (evmIndex < evm.length || tronIndex < tron.length) {
    const evmState = evm[evmIndex];
    const tronState = tron[tronIndex];
    if (!evmState) {
      ordered.push(tronState!);
      tronIndex++;
      continue;
    }
    if (!tronState) {
      ordered.push(evmState);
      evmIndex++;
      continue;
    }

    const evmAttempt = attemptSortValue(evmState);
    const tronAttempt = attemptSortValue(tronState);
    if (evmAttempt < tronAttempt || (evmAttempt === tronAttempt && !preferTronOnTie)) {
      ordered.push(evmState);
      evmIndex++;
      if (evmAttempt === tronAttempt) preferTronOnTie = true;
    } else {
      ordered.push(tronState);
      tronIndex++;
      if (evmAttempt === tronAttempt) preferTronOnTie = false;
    }
  }

  return ordered;
}

function changedRows(result: D1Result): number {
  return typeof result.meta?.changes === "number" ? result.meta.changes : 0;
}

export async function claimBlacklistConfigAttempt(
  db: D1Database,
  state: BlacklistConfigState,
  attemptedAt: number,
  signal?: AbortSignal,
): Promise<BlacklistConfigAttempt | null> {
  const configKey = normalizeBlacklistSyncStateKey(state.configKey);
  await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `/* blacklist-state-bootstrap */
       INSERT INTO blacklist_sync_state
         (config_key, last_block, cursor_kind, cursor_value)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(config_key) DO NOTHING`,
        )
        .bind(configKey, state.cursorValue, state.cursorKind, state.cursorValue)
        .run(),
    3,
    signal,
  );

  const result = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `/* blacklist-state-claim */
       UPDATE blacklist_sync_state
       SET
         cursor_kind = ?,
         cursor_value = MAX(COALESCE(cursor_value, 0), last_block),
         last_block = MAX(last_block, COALESCE(cursor_value, 0)),
         last_attempted_at = ?,
         last_outcome = 'running',
         attempt_generation = attempt_generation + 1
       WHERE config_key = ?
         AND attempt_generation = ?
         AND MAX(last_block, COALESCE(cursor_value, 0)) = ?`,
        )
        .bind(state.cursorKind, attemptedAt, configKey, state.attemptGeneration, state.cursorValue)
        .run(),
    3,
    signal,
  );

  if (changedRows(result) !== 1) return null;
  return {
    configKey,
    cursorKind: state.cursorKind,
    expectedCursor: state.cursorValue,
    generation: state.attemptGeneration + 1,
    attemptedAt,
  };
}

function isSuccessfulOutcome(outcome: BlacklistConfigOutcome): boolean {
  return outcome === "complete" || outcome === "quiet";
}

function isSkippedOutcome(outcome: BlacklistConfigOutcome): boolean {
  return outcome === "provider_skipped" || outcome === "budget_skipped";
}

export async function finalizeBlacklistConfigAttempt(
  db: D1Database,
  attempt: BlacklistConfigAttempt,
  args: {
    outcome: Exclude<BlacklistConfigOutcome, "running" | "budget_skipped">;
    nextCursor?: number | null;
    observedSafeHead?: number | null;
    completedAt: number;
  },
  signal?: AbortSignal,
): Promise<boolean> {
  if (args.nextCursor != null && (!Number.isSafeInteger(args.nextCursor) || args.nextCursor < 0)) {
    throw new RangeError(`Invalid blacklist cursor for ${attempt.configKey}`);
  }
  const requestedCursor =
    args.nextCursor == null ? attempt.expectedCursor : Math.max(attempt.expectedCursor, Math.floor(args.nextCursor));
  const successful = isSuccessfulOutcome(args.outcome);
  const skipped = isSkippedOutcome(args.outcome);
  const failed = !successful && !skipped;
  const observedSafeHead = args.observedSafeHead == null ? null : Math.max(0, Math.floor(args.observedSafeHead));

  const result = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `/* blacklist-state-finalize */
       UPDATE blacklist_sync_state
       SET
         last_block = MAX(last_block, ?),
         cursor_value = MAX(COALESCE(cursor_value, 0), ?),
         last_succeeded_at = CASE WHEN ? = 1 THEN ? ELSE last_succeeded_at END,
         last_skipped_at = CASE WHEN ? = 1 THEN ? ELSE last_skipped_at END,
         last_failed_at = CASE WHEN ? = 1 THEN ? ELSE last_failed_at END,
         consecutive_skips = CASE WHEN ? = 1 THEN consecutive_skips + 1 ELSE 0 END,
         consecutive_failures = CASE
           WHEN ? = 1 THEN consecutive_failures + 1
           WHEN ? = 1 THEN 0
           ELSE consecutive_failures
         END,
         last_outcome = ?,
         last_observed_safe_head = CASE
           WHEN ? IS NULL THEN last_observed_safe_head
           ELSE ?
         END,
         last_safe_head_observed_at = CASE
           WHEN ? IS NULL THEN last_safe_head_observed_at
           ELSE ?
         END
       WHERE config_key = ?
         AND attempt_generation = ?
         AND MAX(last_block, COALESCE(cursor_value, 0)) = ?`,
        )
        .bind(
          requestedCursor,
          requestedCursor,
          successful ? 1 : 0,
          args.completedAt,
          skipped ? 1 : 0,
          args.completedAt,
          failed ? 1 : 0,
          args.completedAt,
          skipped ? 1 : 0,
          failed ? 1 : 0,
          successful ? 1 : 0,
          args.outcome,
          observedSafeHead,
          observedSafeHead,
          observedSafeHead,
          args.completedAt,
          attempt.configKey,
          attempt.generation,
          attempt.expectedCursor,
        )
        .run(),
    3,
    signal,
  );

  return changedRows(result) === 1;
}

export async function recordBlacklistConfigSkips(
  db: D1Database,
  states: readonly BlacklistConfigState[],
  skippedAt: number,
  signal?: AbortSignal,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const state of states) {
    throwIfAborted(signal);
    const configKey = normalizeBlacklistSyncStateKey(state.configKey);
    statements.push(
      db
        .prepare(
          `/* blacklist-state-budget-skip */
         INSERT INTO blacklist_sync_state
           (config_key, last_block, cursor_kind, cursor_value, last_skipped_at, consecutive_skips, last_outcome)
         VALUES (?, ?, ?, ?, ?, 1, 'budget_skipped')
         ON CONFLICT(config_key) DO UPDATE SET
           cursor_kind = excluded.cursor_kind,
           cursor_value = MAX(COALESCE(blacklist_sync_state.cursor_value, 0), blacklist_sync_state.last_block),
           last_block = MAX(blacklist_sync_state.last_block, COALESCE(blacklist_sync_state.cursor_value, 0)),
           last_skipped_at = excluded.last_skipped_at,
           consecutive_skips = blacklist_sync_state.consecutive_skips + 1,
           last_outcome = 'budget_skipped'
         WHERE blacklist_sync_state.attempt_generation = ?
           AND MAX(blacklist_sync_state.last_block, COALESCE(blacklist_sync_state.cursor_value, 0)) = ?`,
        )
        .bind(
          configKey,
          state.cursorValue,
          state.cursorKind,
          state.cursorValue,
          skippedAt,
          state.attemptGeneration,
          state.cursorValue,
        ),
    );
  }
  await batchExecute(db, statements, { signal });
}

export function getOldestBlacklistSuccessAt(states: readonly BlacklistConfigState[]): {
  oldestSuccessAt: number | null;
  neverSucceeded: number;
} {
  const successful = states
    .map((state) => state.lastSucceededAt)
    .filter((value): value is number => value != null && value > 0);
  return {
    oldestSuccessAt: successful.length === states.length && successful.length > 0 ? Math.min(...successful) : null,
    neverSucceeded: states.length - successful.length,
  };
}
