import {
  computeBlacklistAmountUsdAtEvent,
  isGoldBlacklistStablecoin,
} from "@shared/lib/blacklist";
import {
  upsertBlacklistCurrentBalance,
} from "../blacklist-current-balances";
import type { ContractEventConfig } from "../blacklist-contracts";
import { type RateLimitedFetch } from "../evm-logs";
import type { ChainRpcConfig } from "../chain-registry";
import {
  fetchEvmTokenCurrentBalance,
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
} from "./row-preparation";

export interface SyncCurrentBalanceCacheResult {
  updated: number;
  failed: number;
  skippedDueBudget: number;
  budgetExhausted: boolean;
}

type CurrentBalanceFetchContext = {
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

  return fetchEvmTokenCurrentBalance(
    config,
    address,
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
    source: "current_balance",
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
    return { updated: 0, failed: 0, skippedDueBudget: 0, budgetExhausted: false };
  }

  const latestRows = context.latestRows ?? buildCurrentBalanceSnapshotRows(rows);
  const counters: SyncCurrentBalanceCacheResult = {
    updated: 0,
    failed: 0,
    skippedDueBudget: 0,
    budgetExhausted: false,
  };
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
        amountUsd: row.amount_usd_at_event ?? computeBlacklistAmountUsdAtEvent(config.stablecoin, row.amount_native, assetPriceUsd),
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
      continue;
    }

    let amount = await fetchCurrentBalanceForAddress(config, row.address, context);

    // Gold contracts (PAXG, XAUT) override balanceOf() to return 0 for frozen
    // addresses.  When the on-chain balance is 0 but the event captured a
    // pre-freeze amount, use the event-time amount so the freeze ledger
    // reflects the actual seized value.  Only apply to gold stablecoins —
    // for others, a 0 balance means funds were genuinely moved or destroyed.
    if (isGoldBlacklistStablecoin(config.stablecoin) && (amount == null || amount === 0) && row.amount_native != null && row.amount_native > 0) {
      amount = row.amount_native;
    }

    const status = await persistCurrentBalanceResult(db, config, row.address, amount, now, assetPriceUsd);
    counters[status]++;
  }

  return counters;
}
