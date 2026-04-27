import { CONTRACT_CONFIGS } from "../../lib/blacklist-contracts";
import { excludeFrozenIds } from "../shared/exclude-frozen";
import { getLastBlock } from "../../lib/db";
import { backfillTronFromLedger } from "./amount-recovery";

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
    deleted: number;
    failed: number;
  };
};

type SyncBlacklistStatus = "ok" | "degraded" | "error";

type SyncBlacklistApiErrorConfig = {
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
    deleted: number;
    failed: number;
  };
};

export async function loadBlacklistConfigStates(
  db: D1Database,
): Promise<{ configStates: BlacklistConfigState[]; zeroCursorConfigs: string[] }> {
  const eligibleConfigs = excludeFrozenIds(CONTRACT_CONFIGS, (c) => c.stablecoinId);
  const configStates = await Promise.all(
    eligibleConfigs.map(async (config) => {
      const configKey = config.configKey;
      const lastBlock = await getLastBlock(db, configKey);
      return { config, configKey, lastBlock };
    }),
  );

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
  counters.currentBalanceCacheCounters.deleted += processed.currentBalanceCacheCounters.deleted;
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
): Promise<number> {
  try {
    const ledgerResult = await backfillTronFromLedger(db);
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

export function deriveSyncBlacklistStatus(
  apiErrors: number,
  runtimeBudgetHit: boolean,
): SyncBlacklistStatus {
  const degradedThreshold = Math.max(1, Math.ceil(CONTRACT_CONFIGS.length * 0.25));
  const errorThreshold = Math.ceil(CONTRACT_CONFIGS.length / 2);

  if (apiErrors > errorThreshold) return "error";
  if (apiErrors > degradedThreshold || runtimeBudgetHit) return "degraded";
  return "ok";
}
