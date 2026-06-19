import { CONTRACT_CONFIGS } from "../../lib/blacklist-contracts";
import { excludeFrozenIds } from "../shared/exclude-frozen";
import { normalizeBlacklistSyncStateKey } from "../../lib/db";
import { backfillTronFromLedger } from "./amount-recovery";
import type { BlacklistRunBudget } from "./run-budget";

type BlacklistConfigState = {
  config: (typeof CONTRACT_CONFIGS)[number];
  configKey: string;
  lastBlock: number;
};

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
  };
};

type SyncBlacklistStatus = "ok" | "degraded" | "error";

type SyncBlacklistRuntimeBudgetContext = {
  contractsSkipped?: number;
  totalConfigs?: number;
  incompleteRuntimeConfigs?: number;
  subrequestBudgetHit?: boolean;
};

const RUNTIME_SKIPPED_OK_MAX_CONTRACTS = 10;
const RUNTIME_SKIPPED_OK_RATIO = 0.15;

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
  };
};

export async function loadBlacklistConfigStates(
  db: D1Database,
): Promise<{ configStates: BlacklistConfigState[]; zeroCursorConfigs: string[] }> {
  const eligibleConfigs = excludeFrozenIds(CONTRACT_CONFIGS, (c) => c.stablecoinId);

  // Single bulk fetch instead of one getLastBlock D1 round-trip per config.
  // The per-config key-normalization that getLastBlock applies is replicated
  // in-memory below: each config's last_block is the max over rows matching
  // either its raw config_key or its normalized form, defaulting to 0.
  const rows = await db
    .prepare(`SELECT config_key, last_block FROM blacklist_sync_state`)
    .all<{ config_key: string; last_block: number }>();
  const lastBlockByKey = new Map<string, number>();
  for (const row of rows.results ?? []) {
    lastBlockByKey.set(row.config_key, row.last_block);
  }

  const configStates = eligibleConfigs.map((config) => {
    const configKey = config.configKey;
    const keyCandidates = [...new Set([configKey, normalizeBlacklistSyncStateKey(configKey)])];
    const lastBlock = Math.max(
      0,
      ...keyCandidates.map((key) => lastBlockByKey.get(key) ?? 0),
    );
    return { config, configKey, lastBlock };
  });

  return {
    configStates,
    zeroCursorConfigs: configStates.filter((state) => state.lastBlock === 0).map((state) => state.configKey),
  };
}

export function recordProcessedRows(counters: SyncBlacklistCounters, processed: ProcessedRows): void {
  counters.enrichCounters.attempted += processed.enrichCounters.attempted;
  counters.enrichCounters.succeeded += processed.enrichCounters.succeeded;
  counters.enrichCounters.failed += processed.enrichCounters.failed;
  counters.currentBalanceCacheCounters.updated += processed.currentBalanceCacheCounters.updated;
  counters.currentBalanceCacheCounters.failed += processed.currentBalanceCacheCounters.failed;
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

export async function applyTronLedgerMirrorPass(
  db: D1Database,
  phase: "initial" | "post-sync",
  options: { runBudget?: BlacklistRunBudget; signal?: AbortSignal } = {},
): Promise<number> {
  try {
    const ledgerResult = await backfillTronFromLedger(db, options);
    if (ledgerResult.updated > 0) {
      const suffix = phase === "post-sync" ? " after current-balance sync" : "";
      console.log(`[sync-blacklist] Tron ledger mirror updated ${ledgerResult.updated} row(s)${suffix}`);
    }
    return ledgerResult.updated;
  } catch (err) {
    const prefix = phase === "post-sync" ? "Post-sync " : "";
    console.warn(`[sync-blacklist] ${prefix}Tron ledger mirror failed:`, err);
    return 0;
  }
}

export function getRuntimeBudgetSkippedOkThreshold(totalConfigs = CONTRACT_CONFIGS.length): number {
  if (totalConfigs <= 0) return 0;
  return Math.max(1, Math.min(RUNTIME_SKIPPED_OK_MAX_CONTRACTS, Math.ceil(totalConfigs * RUNTIME_SKIPPED_OK_RATIO)));
}

export function deriveSyncBlacklistStatus(
  apiErrors: number,
  runtimeBudgetHit: boolean,
  runtimeBudgetContext: SyncBlacklistRuntimeBudgetContext = {},
): SyncBlacklistStatus {
  const degradedThreshold = Math.max(1, Math.ceil(CONTRACT_CONFIGS.length * 0.25));
  const errorThreshold = Math.ceil(CONTRACT_CONFIGS.length / 2);
  const contractsSkipped = Math.max(0, runtimeBudgetContext.contractsSkipped ?? 0);
  const totalConfigs = Math.max(0, runtimeBudgetContext.totalConfigs ?? CONTRACT_CONFIGS.length);
  const incompleteRuntimeConfigs = Math.max(0, runtimeBudgetContext.incompleteRuntimeConfigs ?? 0);
  const skippedThreshold = getRuntimeBudgetSkippedOkThreshold(totalConfigs);
  const materialRuntimeBudgetHit = runtimeBudgetHit && (
    runtimeBudgetContext.subrequestBudgetHit === true ||
    incompleteRuntimeConfigs > 0 ||
    contractsSkipped > skippedThreshold
  );

  if (apiErrors > errorThreshold) return "error";
  if (apiErrors > degradedThreshold || materialRuntimeBudgetHit) return "degraded";
  return "ok";
}
