import { computeBlacklistAmountUsdAtEvent, isGoldBlacklistStablecoin } from "@shared/lib/blacklist";
import {
  upsertBlacklistCurrentBalance,
} from "../../lib/blacklist-current-balances";
import type { ContractEventConfig } from "../../lib/blacklist-contracts";
import { budgetExhausted, type RateLimitedFetch, type SubrequestBudget } from "../../lib/evm-logs";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import {
  fetchEvmTokenCurrentBalance,
  fetchTronTokenCurrentBalance,
} from "./balance-providers";
import type { BlacklistRow } from "./shared";

function runtimeBudgetReached(deadlineMs: number): boolean {
  return Date.now() >= deadlineMs;
}

export interface SyncCurrentBalanceCacheResult {
  updated: number;
  deleted: number;
  failed: number;
}

type CurrentBalanceFetchContext = {
  etherscanApiKey: string | null;
  drpcApiKey: string | null;
  trongridApiKey: string | null;
  etherscanLimiter: RateLimitedFetch;
  tronLimiter: RateLimitedFetch;
  budget: SubrequestBudget;
  deadlineMs: number;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
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
      context.budget,
      context.signal,
    );
  }

  return fetchEvmTokenCurrentBalance(
    config,
    address,
    context.etherscanApiKey,
    context.etherscanLimiter,
    context.budget,
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
  goldPriceUsd: number | null,
): Promise<"updated" | "failed"> {
  if (amount == null) {
    await upsertBlacklistCurrentBalance(db, {
      stablecoin: config.stablecoin,
      chainId: config.chain.chainId,
      address,
      amountNative: null,
      amountUsd: null,
      source: "current_balance",
      status: "provider_failed",
      observedAt: now,
      attemptCount: 1,
      lastAttemptedAt: now,
      lastErrorClass: "provider_null",
    });
    return "failed";
  }

  await upsertBlacklistCurrentBalance(db, {
    stablecoin: config.stablecoin,
    chainId: config.chain.chainId,
    address,
    amountNative: amount,
    amountUsd: computeBlacklistAmountUsdAtEvent(config.stablecoin, amount, goldPriceUsd),
    source: "current_balance",
    status: "resolved",
    observedAt: now,
    attemptCount: 1,
    lastAttemptedAt: now,
    lastErrorClass: null,
  });
  return "updated";
}

/** Map gold-pegged stablecoins to their price_cache asset_id. */
const GOLD_PRICE_ASSET_IDS: Record<string, string> = {
  PAXG: "paxg-paxos",
  XAUT: "xaut-tether",
};

/**
 * Fetch the gold spot price from price_cache for a specific stablecoin.
 * Returns the coin-specific price entry so PAXG and XAUT use their own
 * market premium rather than sharing a single gold spot price.
 */
export async function fetchGoldPriceFromCache(
  db: D1Database,
  stablecoin?: string,
): Promise<number | null> {
  const assetId = (stablecoin && GOLD_PRICE_ASSET_IDS[stablecoin]) ?? "paxg-paxos";
  const row = await db
    .prepare("SELECT price FROM price_cache WHERE asset_id = ? LIMIT 1")
    .bind(assetId)
    .first<{ price: number }>();
  return row?.price ?? null;
}

export async function syncCurrentBalanceCacheForRows(
  db: D1Database,
  config: ContractEventConfig,
  rows: BlacklistRow[],
  context: CurrentBalanceFetchContext,
): Promise<SyncCurrentBalanceCacheResult> {
  if (rows.length === 0) {
    return { updated: 0, deleted: 0, failed: 0 };
  }

  const latestByAddress = new Map<string, BlacklistRow>();
  const ordered = [...rows].sort((a, b) => (a.timestamp === b.timestamp ? a.id.localeCompare(b.id) : a.timestamp - b.timestamp));
  for (const row of ordered) {
    latestByAddress.set(row.address.toLowerCase(), row);
  }

  const counters: SyncCurrentBalanceCacheResult = { updated: 0, deleted: 0, failed: 0 };
  const now = Math.floor(Date.now() / 1000);

  // Resolve gold price once if this config is a gold-pegged stablecoin
  const goldPriceUsd = isGoldBlacklistStablecoin(config.stablecoin)
    ? await fetchGoldPriceFromCache(db, config.stablecoin)
    : null;

  for (const row of latestByAddress.values()) {
    if (runtimeBudgetReached(context.deadlineMs) || budgetExhausted(context.budget)) break;

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
        amountNative: row.amount_native,
        amountUsd: row.amount_usd_at_event ?? computeBlacklistAmountUsdAtEvent(config.stablecoin, row.amount_native, goldPriceUsd),
        source: "destroy_event",
        status: "resolved",
        observedAt: now,
        attemptCount: 1,
        lastAttemptedAt: now,
        lastErrorClass: null,
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

    const status = await persistCurrentBalanceResult(db, config, row.address, amount, now, goldPriceUsd);
    counters[status]++;
  }

  return counters;
}
