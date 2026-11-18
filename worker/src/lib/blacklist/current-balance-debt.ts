import { CONTRACT_CONFIGS, getBlacklistConfigByContract } from "../blacklist-contracts";
import { blacklistEventOrderSql } from "@shared/lib/blacklist-event-order";
import { computeBlacklistAmountUsdAtEvent } from "@shared/lib/blacklist";
import { BLACKLIST_POST_WIPE_CONTRACT } from "@shared/lib/blacklist-active-records";
import { BLACKLIST_POST_WIPE_BALANCE_PREFIX, BLACKLIST_POST_WIPE_MAX_AGE_SEC } from "../blacklist-cache-keys";
import { fetchEvmBlockHeader } from "../evm-rpc";
import { fetchEvmTokenBalance } from "./balance-providers";
import {
  CURRENT_BALANCE_DEBT_PREFIX,
  MAX_SCAN_PHASE_BALANCE_CAPTURES,
  syncCurrentBalanceCacheForRows,
  type CurrentBalanceFetchContext,
} from "./current-balance-cache";
import { blacklistRuntimeBudgetReached, blacklistSubrequestBudgetReached } from "./run-budget";
import { BLACKLIST_PUBLIC_EVENT_SQL, type BlacklistRow } from "./shared";
import { canonicalBlacklistAddress } from "@shared/lib/tron-address";
import { blacklistAddressSpellings } from "../tron-address";

const RESERVED_POST_WIPE_CAPTURES = 4;

async function refreshPostWipeBalances(db: D1Database, context: CurrentBalanceFetchContext, limit: number): Promise<number> {
  const config = getBlacklistConfigByContract("ethereum", BLACKLIST_POST_WIPE_CONTRACT);
  if (!config || blacklistRuntimeBudgetReached(context.runBudget) || blacklistSubrequestBudgetReached(context.runBudget)) {
    return 0;
  }
  const candidates = await db.prepare(`SELECT blacklist_events.id, blacklist_events.address,
      blacklist_events.block_number, blacklist_events.timestamp
    FROM blacklist_events
    LEFT JOIN cache AS snapshot ON snapshot.key = ? || blacklist_events.id
    WHERE blacklist_events.event_type = 'destroy'
      AND blacklist_events.stablecoin = 'USDT' AND blacklist_events.chain_id = 'ethereum'
      AND COALESCE(LOWER(blacklist_events.contract_address), '') = ?
      AND ${BLACKLIST_PUBLIC_EVENT_SQL}
      AND blacklist_events.id = (
        SELECT current_event.id FROM blacklist_events AS current_event
        WHERE current_event.stablecoin = 'USDT' AND current_event.chain_id = 'ethereum'
          AND LOWER(current_event.address) = LOWER(blacklist_events.address)
          AND COALESCE(LOWER(current_event.contract_address), '') = ?
          AND current_event.suppression_reason IS NULL
          AND current_event.event_type IN ('destroy', 'unblacklist')
        ORDER BY ${blacklistEventOrderSql("DESC")}, id ASC LIMIT 1
      )
    ORDER BY snapshot.updated_at, blacklist_events.timestamp, blacklist_events.id LIMIT ?`)
    .bind(BLACKLIST_POST_WIPE_BALANCE_PREFIX, BLACKLIST_POST_WIPE_CONTRACT, BLACKLIST_POST_WIPE_CONTRACT, limit)
    .all<Pick<BlacklistRow, "id" | "address" | "block_number" | "timestamp">>();
  if (!candidates.results.length) return 0;

  const cursor = await db.prepare(`SELECT MAX(last_block, COALESCE(cursor_value, 0)) AS committed_block
    FROM blacklist_sync_state WHERE config_key = ? AND (cursor_kind IS NULL OR cursor_kind = 'evm_block')`)
    .bind(config.configKey).first<number>("committed_block");
  if (cursor == null || !Number.isSafeInteger(cursor) || cursor <= 0) return 0;

  const { deadlineMs, subrequestBudget } = context.runBudget;
  const headerOptions = {
    chainRpcs: context.chainRpcs, signal: context.signal, deadlineMs, maxRetries: 0, excludeSupplementalRpc: true,
    minTimestampSec: Math.floor(Date.now() / 1000) - BLACKLIST_POST_WIPE_MAX_AGE_SEC,
    minBlockNumber: Math.min(...candidates.results.map((row) => row.block_number)),
    beforeRequest: () => {
      if (blacklistSubrequestBudgetReached(context.runBudget)) return false;
      subrequestBudget.count++;
      return true;
    },
  };
  const finalized = cursor >= headerOptions.minBlockNumber
    ? await fetchEvmBlockHeader(config.chain.chainId, "finalized", headerOptions) : null;
  const header = finalized && finalized.number > cursor
    ? await fetchEvmBlockHeader(config.chain.chainId, cursor, headerOptions) : finalized;
  const observedAtSec = Math.floor(Date.now() / 1000);
  const pin = finalized && header && header.number === Math.min(cursor, finalized.number) &&
    finalized.timestamp <= observedAtSec && header.timestamp <= finalized.timestamp &&
    observedAtSec - header.timestamp <= BLACKLIST_POST_WIPE_MAX_AGE_SEC ? {
    chainId: config.chain.chainId, header, finalized, observedAtSec, maxAgeSec: BLACKLIST_POST_WIPE_MAX_AGE_SEC,
  } : null;

  let attempted = 0;
  for (const row of candidates.results) {
    if (blacklistRuntimeBudgetReached(context.runBudget) || blacklistSubrequestBudgetReached(context.runBudget)) break;
    let amount: number | null = null;
    if (pin && pin.header.number >= row.block_number && pin.header.timestamp >= row.timestamp) {
      attempted++;
      amount = await fetchEvmTokenBalance(config, row.address, pin.header.number, context.etherscanApiKey,
        context.drpcApiKey, context.etherscanLimiter, subrequestBudget, context.signal, context.chainRpcs,
        { finalizedPin: pin, deadlineMs });
    }
    const attemptedAt = Math.floor(Date.now() / 1000);
    const amountUsd = amount != null && Number.isFinite(amount) && amount >= 0
      ? computeBlacklistAmountUsdAtEvent(config.stablecoin, amount) : null;
    const value = amountUsd == null || !pin ? "null" : JSON.stringify({ amountUsd,
      blockNumber: pin.header.number, blockHash: pin.header.hash, observedAt: pin.header.timestamp });
    await db.prepare(`INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = CASE
        WHEN json_extract(excluded.value, '$.blockNumber') >= COALESCE(
          json_extract(CASE WHEN json_valid(cache.value) THEN cache.value END, '$.blockNumber'), 0)
          OR json_extract(CASE WHEN json_valid(cache.value) THEN cache.value END, '$.blockNumber') > ?
        THEN excluded.value ELSE cache.value END,
        updated_at = MAX(cache.updated_at, excluded.updated_at)`)
      .bind(`${BLACKLIST_POST_WIPE_BALANCE_PREFIX}${row.id}`, value, attemptedAt, cursor).run();
  }
  return attempted;
}

export async function reconcileCurrentBalanceDebt(
  db: D1Database,
  context: CurrentBalanceFetchContext,
  circuits: { etherscanAllowed: boolean; tronGridAllowed: boolean },
): Promise<void> {
  const eligibleConfigKeys = CONTRACT_CONFIGS
    .filter((config) => config.chain.type === "tron" ? circuits.tronGridAllowed : circuits.etherscanAllowed)
    .map((config) => config.configKey);
  if (eligibleConfigKeys.length === 0) return;
  // Apply provider gates before the limit so blocked debt cannot starve eligible work.
  // One JSON bind avoids D1's parameter cap as the registry grows.
  const candidates = await db.prepare(`SELECT events.* FROM cache AS debt
    JOIN blacklist_events AS events ON events.id = debt.value
    WHERE debt.key GLOB '${CURRENT_BALANCE_DEBT_PREFIX}*'
      AND events.config_key IN (SELECT value FROM json_each(?))
    ORDER BY debt.updated_at, debt.key LIMIT ?`)
    .bind(JSON.stringify(eligibleConfigKeys), MAX_SCAN_PHASE_BALANCE_CAPTURES).all<BlacklistRow>();
  // Share the existing serial cap with new capture debt and use its spare slots.
  const debt = candidates.results ?? [];
  const postWipeLimit = Math.max(RESERVED_POST_WIPE_CAPTURES, MAX_SCAN_PHASE_BALANCE_CAPTURES - debt.length);
  const postWipeAttempts = circuits.etherscanAllowed ? await refreshPostWipeBalances(db, context, postWipeLimit) : 0;
  const seen = new Set<string>();
  for (const row of debt.slice(0, MAX_SCAN_PHASE_BALANCE_CAPTURES - postWipeAttempts)) {
    if (blacklistRuntimeBudgetReached(context.runBudget) || blacklistSubrequestBudgetReached(context.runBudget)) break;
    const identity = `${row.config_key}:${canonicalBlacklistAddress(row.chain_id, row.address)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const config = CONTRACT_CONFIGS.find((candidate) => candidate.configKey === row.config_key);
    if (!config) continue;
    const history = await db.prepare(`SELECT * FROM blacklist_events
      WHERE config_key = ? AND (LOWER(address) IN (?, ?) OR address = ?) AND suppression_reason IS NULL
      ORDER BY ${blacklistEventOrderSql("ASC")}`)
      .bind(config.configKey, ...await blacklistAddressSpellings(row.chain_id, row.address)).all<BlacklistRow>();
    await syncCurrentBalanceCacheForRows(db, config, history.results ?? [], context);
    // Rotate unresolved/provider-failed work behind untouched debt. No TTL.
    await db.prepare(`UPDATE cache SET updated_at = ? WHERE key = ?`)
      .bind(Math.floor(Date.now() / 1000), `${CURRENT_BALANCE_DEBT_PREFIX}${row.id}`).run();
  }
}
