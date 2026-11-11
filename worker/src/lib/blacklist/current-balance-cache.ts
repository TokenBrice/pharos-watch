import {
  computeBlacklistAmountUsdAtEvent,
  isGoldBlacklistStablecoin,
} from "@shared/lib/blacklist";
import {
  upsertBlacklistCurrentBalance,
} from "./blacklist-current-balances";
import type { ContractEventConfig } from "./blacklist-contracts";
import { type RateLimitedFetch } from "../evm-logs";
import type { ChainRpcConfig } from "../chain-registry";
import {
  fetchEvmTokenBalance,
  fetchTronTokenCurrentBalance,
} from "./balance-providers";
import type { BlacklistRow } from "./shared";
import {
  blacklistRuntimeBudgetReached,
  blacklistSubrequestBudgetReached,
  type BlacklistRunBudget,
} from "./run-budget";
import {
  buildCurrentBalanceSnapshotRows,
  fetchBlacklistAssetPriceFromCache,
  unambiguousRows,
} from "./row-preparation";
import { batchExecute } from "../db";

export const CURRENT_BALANCE_DEBT_PREFIX = "blacklist:current-balance-debt:";

async function enqueueCurrentBalanceDebt(db: D1Database, rows: readonly BlacklistRow[]): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await batchExecute(db, rows.filter((row) => row.suppression_reason == null).map((row) => db.prepare(
    "INSERT OR IGNORE INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
  ).bind(`${CURRENT_BALANCE_DEBT_PREFIX}${row.id}`, row.id, now)));
}

async function clearCurrentBalanceDebt(db: D1Database, eventId: string): Promise<void> {
  await db.prepare("DELETE FROM cache WHERE key = ?").bind(`${CURRENT_BALANCE_DEBT_PREFIX}${eventId}`).run();
}

export interface SyncCurrentBalanceCacheResult {
  updated: number;
  failed: number;
  skippedDueBudget: number;
  budgetExhausted: boolean;
  /** Rows this call deferred without a live capture so they stay durable debt. */
  deferredToDebt: number;
}

/**
 * Live per-address captures admitted per scan-phase call. A mass freeze on one
 * config must not consume the shared scan budget (one serial provider fetch
 * plus ledger writes per address), so scans admit the same row count the
 * maintenance debt lane digests per run and leave the remainder as durable
 * `blacklist:current-balance-debt:` rows. Uncapped callers (debt lane,
 * operator backfills) keep their own bounds.
 */
export const MAX_SCAN_PHASE_BALANCE_CAPTURES = 24;

export type CurrentBalanceFetchContext = {
  etherscanApiKey: string | null;
  drpcApiKey: string | null;
  trongridApiKey: string | null;
  etherscanLimiter: RateLimitedFetch;
  tronLimiter: RateLimitedFetch;
  runBudget: BlacklistRunBudget;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  assetPriceUsd?: number | null;
  latestRows?: readonly BlacklistRow[];
  /** Maximum live captures this call may attempt; absent means uncapped. */
  captureLimit?: number;
};

async function fetchCurrentBalanceForAddress(
  config: ContractEventConfig,
  address: string,
  context: CurrentBalanceFetchContext,
): Promise<number | null> {
  if (config.chain.type === "tron") {
    return fetchTronTokenCurrentBalance(
      config,
      address,
      context.trongridApiKey,
      context.tronLimiter,
      context.runBudget.subrequestBudget,
      context.signal,
    );
  }

  return fetchEvmTokenBalance(
    config,
    address,
    "latest",
    context.etherscanApiKey,
    context.drpcApiKey,
    context.etherscanLimiter,
    context.runBudget.subrequestBudget,
    context.signal,
    context.chainRpcs,
  );
}

async function persistCurrentBalanceResult(
  db: D1Database,
  config: ContractEventConfig,
  address: string,
  amount: number | null,
  now: number,
  assetPriceUsd: number | null,
  source = "current_balance",
): Promise<"updated" | "failed"> {
  if (amount == null) {
    await upsertBlacklistCurrentBalance(db, {
      stablecoin: config.stablecoin,
      chainId: config.chain.chainId,
      address,
      configKey: config.configKey,
      contractAddress: config.contractAddress,
      amountNative: null,
      amountUsd: null,
      source: "current_balance",
      status: "provider_failed",
      observedAt: now,
      lastSuccessfulObservedAt: null,
      attemptCount: 1,
      lastAttemptedAt: now,
      lastErrorClass: "provider_null",
      consecutiveFailures: 1,
    });
    return "failed";
  }

  await upsertBlacklistCurrentBalance(db, {
    stablecoin: config.stablecoin,
    chainId: config.chain.chainId,
    address,
    configKey: config.configKey,
    contractAddress: config.contractAddress,
    amountNative: amount,
    amountUsd: computeBlacklistAmountUsdAtEvent(config.stablecoin, amount, assetPriceUsd),
    source,
    status: "resolved",
    observedAt: now,
    lastSuccessfulObservedAt: now,
    attemptCount: 1,
    lastAttemptedAt: now,
    lastErrorClass: null,
    consecutiveFailures: 0,
  });
  return "updated";
}

export async function syncCurrentBalanceCacheForRows(
  db: D1Database,
  config: ContractEventConfig,
  rows: BlacklistRow[],
  context: CurrentBalanceFetchContext,
): Promise<SyncCurrentBalanceCacheResult> {
  if (rows.length === 0) {
    return { updated: 0, failed: 0, skippedDueBudget: 0, budgetExhausted: false, deferredToDebt: 0 };
  }

  await enqueueCurrentBalanceDebt(db, rows);
  const latestRows = context.latestRows ?? buildCurrentBalanceSnapshotRows(rows);
  const counters: SyncCurrentBalanceCacheResult = {
    updated: 0,
    failed: 0,
    skippedDueBudget: 0,
    budgetExhausted: false,
    deferredToDebt: 0,
  };
  const deferredRowIds = new Set<string>();
  let liveCaptures = 0;
  const now = Math.floor(Date.now() / 1000);

  const assetPriceUsd = context.assetPriceUsd ?? await fetchBlacklistAssetPriceFromCache(db, config.stablecoin);

  for (let index = 0; index < latestRows.length; index++) {
    const row = latestRows[index]!;
    if (
      blacklistRuntimeBudgetReached(context.runBudget)
      || blacklistSubrequestBudgetReached(context.runBudget)
    ) {
      counters.budgetExhausted = true;
      counters.skippedDueBudget = latestRows.length - index;
      break;
    }

    if (row.event_type === "unblacklist") {
      // Preserve the freeze-ledger snapshot after releases so historical seized/frozen
      // totals do not disappear when the live blacklist status changes later.
      await clearCurrentBalanceDebt(db, row.id);
      continue;
    }

    if (row.event_type === "destroy") {
      if (row.amount_native == null) continue;
      await upsertBlacklistCurrentBalance(db, {
        stablecoin: config.stablecoin,
        chainId: config.chain.chainId,
        address: row.address,
        configKey: config.configKey,
        contractAddress: config.contractAddress,
        amountNative: row.amount_native,
        amountUsd: row.amount_usd_at_event,
        source: "destroy_event",
        status: "resolved",
        observedAt: row.timestamp,
        lastSuccessfulObservedAt: row.timestamp,
        attemptCount: 1,
        lastAttemptedAt: now,
        lastErrorClass: null,
        consecutiveFailures: 0,
      });
      counters.updated++;
      await clearCurrentBalanceDebt(db, row.id);
      continue;
    }

    if (context.captureLimit != null && liveCaptures >= context.captureLimit) {
      // Admission deferral, not a budget stop: budget telemetry stays untouched
      // and the row keeps its durable current-balance debt for the maintenance lane.
      counters.deferredToDebt++;
      deferredRowIds.add(row.id);
      continue;
    }
    liveCaptures++;

    let amount = await fetchCurrentBalanceForAddress(config, row.address, context);
    let source = "current_balance";

    // Gold contracts (PAXG, XAUT) override balanceOf() to return 0 for frozen
    // addresses.  When the on-chain balance is 0 but the event captured a
    // pre-freeze amount, use the event-time amount so the freeze ledger
    // reflects the actual seized value.  Only apply to gold stablecoins —
    // for others, a 0 balance means funds were genuinely moved or destroyed.
    if (isGoldBlacklistStablecoin(config.stablecoin) && amount === 0 && row.amount_native != null && row.amount_native > 0) {
      amount = row.amount_native;
      source = "gold_event_zero_balance";
    }

    const status = await persistCurrentBalanceResult(db, config, row.address, amount, now, assetPriceUsd, source);
    if (status === "updated") await clearCurrentBalanceDebt(db, row.id);
    counters[status]++;
  }
  if (!counters.budgetExhausted && counters.failed === 0 && latestRows.length > 0
    && !latestRows.some((row) => row.event_type === "destroy" && row.amount_native == null)) {
    for (const row of unambiguousRows(rows)) {
      // Never clear durable debt for work this call deferred.
      if (deferredRowIds.has(row.id)) continue;
      await clearCurrentBalanceDebt(db, row.id);
    }
  }

  return counters;
}
