import { CONTRACT_CONFIGS } from "../../lib/blacklist-contracts";
import { includeActiveTrackedIds } from "../shared/exclude-frozen";
import { normalizeBlacklistSyncStateKey } from "../../lib/db";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { inferBlacklistCursorKind, type BlacklistConfigState } from "./state";

type ProcessedRows = {
  insertedRows: number;
  enrichCounters: {
    attempted: number;
    succeeded: number;
    failed: number;
  };
  currentBalanceCacheCounters: {
    updated: number;
    failed: number;
    skippedDueBudget: number;
    budgetExhausted: boolean;
  };
};

type SyncBlacklistStatus = "ok" | "degraded" | "error";

type SyncBlacklistRuntimeBudgetContext = {
  contractsSkipped?: number;
  totalConfigs?: number;
  incompleteRuntimeConfigs?: number;
  subrequestBudgetHit?: boolean;
};

export type SyncBlacklistApiErrorConfig = {
  configKey: string;
  stablecoin: string;
  chainId: string;
  reason: string;
  errorMessage?: string;
  stackHead?: string;
};

type SyncBlacklistCounters = {
  totalInsertedRows: number;
  enrichCounters: {
    attempted: number;
    succeeded: number;
    failed: number;
  };
  currentBalanceCacheCounters: {
    updated: number;
    failed: number;
    skippedDueBudget: number;
    budgetExhausted: boolean;
  };
};

export async function loadBlacklistConfigStates(
  db: D1Database,
  signal?: AbortSignal,
): Promise<{ configStates: BlacklistConfigState[]; zeroCursorConfigs: string[] }> {
  const eligibleConfigs = includeActiveTrackedIds(CONTRACT_CONFIGS, (c) => c.stablecoinId);

  // Single bulk fetch instead of one getLastBlock D1 round-trip per config.
  // The per-config key-normalization that getLastBlock applies is replicated
  // in-memory below: each config's last_block is the max over rows matching
  // either its raw config_key or its normalized form, defaulting to 0.
  const rows = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `SELECT
           config_key,
           last_block,
           cursor_value,
           attempt_generation,
           last_attempted_at,
           last_succeeded_at,
           last_skipped_at,
           last_failed_at,
           consecutive_skips,
           consecutive_failures,
           last_outcome
         FROM blacklist_sync_state`,
        )
        .all<{
          config_key: string;
          last_block: number;
          cursor_value: number | null;
          attempt_generation: number | null;
          last_attempted_at: number | null;
          last_succeeded_at: number | null;
          last_skipped_at: number | null;
          last_failed_at: number | null;
          consecutive_skips: number | null;
          consecutive_failures: number | null;
          last_outcome: string | null;
        }>(),
    3,
    signal,
  );
  type LoadedStateRow = NonNullable<typeof rows.results>[number];
  const stateByKey = new Map<string, LoadedStateRow>();
  for (const row of rows.results ?? []) {
    stateByKey.set(row.config_key, row);
  }

  const configStates = eligibleConfigs.map((config) => {
    const configKey = config.configKey;
    const keyCandidates = [...new Set([configKey, normalizeBlacklistSyncStateKey(configKey)])];
    const matchingRows = keyCandidates
      .map((key) => stateByKey.get(key))
      .filter((row): row is LoadedStateRow => row != null);
    const cursorValue = Math.max(0, ...matchingRows.flatMap((row) => [row.last_block ?? 0, row.cursor_value ?? 0]));
    const newestState = matchingRows.sort((a, b) => (b.attempt_generation ?? 0) - (a.attempt_generation ?? 0))[0];
    return {
      config,
      configKey,
      cursorKind: inferBlacklistCursorKind(config),
      cursorValue,
      attemptGeneration: newestState?.attempt_generation ?? 0,
      lastAttemptedAt: newestState?.last_attempted_at ?? null,
      lastSucceededAt: newestState?.last_succeeded_at ?? null,
      lastSkippedAt: newestState?.last_skipped_at ?? null,
      lastFailedAt: newestState?.last_failed_at ?? null,
      consecutiveSkips: newestState?.consecutive_skips ?? 0,
      consecutiveFailures: newestState?.consecutive_failures ?? 0,
      lastOutcome: newestState?.last_outcome ?? null,
    } satisfies BlacklistConfigState;
  });

  return {
    configStates,
    zeroCursorConfigs: configStates.filter((state) => state.cursorValue === 0).map((state) => state.configKey),
  };
}

export function recordProcessedRows(counters: SyncBlacklistCounters, processed: ProcessedRows): void {
  counters.enrichCounters.attempted += processed.enrichCounters.attempted;
  counters.enrichCounters.succeeded += processed.enrichCounters.succeeded;
  counters.enrichCounters.failed += processed.enrichCounters.failed;
  counters.currentBalanceCacheCounters.updated += processed.currentBalanceCacheCounters.updated;
  counters.currentBalanceCacheCounters.failed += processed.currentBalanceCacheCounters.failed;
  counters.currentBalanceCacheCounters.skippedDueBudget += processed.currentBalanceCacheCounters.skippedDueBudget;
  counters.currentBalanceCacheCounters.budgetExhausted ||= processed.currentBalanceCacheCounters.budgetExhausted;
  counters.totalInsertedRows += processed.insertedRows;
}

export function recordApiErrorConfig(
  apiErrorConfigs: SyncBlacklistApiErrorConfig[],
  configKey: string,
  stablecoin: string,
  chainId: string,
  reason: string,
  error?: unknown,
): void {
  if (apiErrorConfigs.length >= 10) return;

  const entry: SyncBlacklistApiErrorConfig = { configKey, stablecoin, chainId, reason };
  if (error instanceof Error) {
    entry.errorMessage = error.message.slice(0, 200);
    if (error.stack) {
      entry.stackHead = error.stack.split("\n").slice(0, 3).join(" | ").slice(0, 240);
    }
  }
  apiErrorConfigs.push(entry);
}


export function deriveSyncBlacklistStatus(
  apiErrors: number,
  runtimeBudgetHit: boolean,
  runtimeBudgetContext: SyncBlacklistRuntimeBudgetContext = {},
): SyncBlacklistStatus {
  const errorThreshold = Math.ceil((runtimeBudgetContext.totalConfigs ?? CONTRACT_CONFIGS.length) / 2);
  if (apiErrors > errorThreshold) return "error";
  if (apiErrors > 0 || runtimeBudgetHit) return "degraded";
  return "ok";
}
