import {
  computeBlacklistAmountUsdAtEvent,
  getBlacklistPriceAssetId,
} from "@shared/lib/blacklist";
import { fetchBlacklistAssetPriceFromCache } from "./row-preparation";
import { shouldSuppressAsMirrorZero } from "./shared";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import {
  getBlacklistConfigByContract,
  getBlacklistConfigByKey,
  getBlacklistConfigsForSymbolAndChain,
  getBlacklistEventByTopic,
  type ContractEventConfig,
} from "../../lib/blacklist-contracts";
import { batchExecute } from "../../lib/db";
import {
  type EtherscanLogEntry,
  type RateLimitedFetch,
  type SubrequestBudget,
  budgetExhausted,
  decodeUint256,
  readDataWord,
} from "../../lib/evm-logs";
import { ETHERSCAN_V2_BASE } from "../../lib/constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { fetchEvmTokenBalance } from "../blacklist/balance-providers";
import type { BlacklistRow } from "../blacklist/shared";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import {
  blacklistRuntimeBudgetReached,
  blacklistSubrequestBudgetReached,
  type BlacklistRunBudget,
} from "./run-budget";

// Conservative hourly recovery cap: one D1 batch chunk and well below the
// sync-blacklist 900-subrequest run budget observed in production.
const BACKFILL_BATCH_SIZE = 100;
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_ADDRESS_TOPIC = "0x0000000000000000000000000000000000000000000000000000000000000000";

export type BlacklistRecoveryErrorClass =
  | "provider_null"
  | "provider_timeout"
  | "provider_http_error"
  | "provider_unsupported"
  | "config_missing"
  | "ambiguous_config"
  | "runtime_budget"
  | "budget_exhausted";

export type BlacklistRecoveryProvider =
  | "etherscan"
  | "drpc"
  | "chain_rpc"
  | "trongrid"
  | "event_receipt"
  | "current_balances_ledger"
  | "none";

function getHistoricalBalanceBlock(blockNumber: number): number {
  return Math.max(0, blockNumber - 1);
}

function markRecoveryAttempt(
  row: Pick<
    BlacklistRow,
    "amount_attempt_count" | "amount_last_attempted_at" | "amount_last_error_class" | "amount_last_provider"
  >,
  provider: BlacklistRecoveryProvider,
  errorClass: BlacklistRecoveryErrorClass | null,
  nowSec = Math.floor(Date.now() / 1000),
): void {
  row.amount_attempt_count = (row.amount_attempt_count ?? 0) + 1;
  row.amount_last_attempted_at = nowSec;
  row.amount_last_provider = provider;
  row.amount_last_error_class = errorClass;
}

function inferErrorClass(error: unknown): BlacklistRecoveryErrorClass {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("http")) return "provider_http_error";
  if (message.includes("timeout")) return "provider_timeout";
  return "provider_null";
}

export async function enrichRowBalances(opts: {
  rows: BlacklistRow[];
  config: ContractEventConfig;
  etherscanApiKey: string | null;
  drpcApiKey: string | null;
  etherscanLimiter: RateLimitedFetch;
  runBudget: BlacklistRunBudget;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  assetPriceUsd?: number | null;
}): Promise<{ attempted: number; succeeded: number; failed: number }> {
  const {
    rows,
    config,
    etherscanApiKey,
    drpcApiKey,
    etherscanLimiter,
    runBudget,
    signal,
    chainRpcs,
    assetPriceUsd,
  } = opts;
  const counters = { attempted: 0, succeeded: 0, failed: 0 };
  for (const row of rows) {
    throwIfAborted(signal);
    if (blacklistRuntimeBudgetReached(runBudget)) {
      if (row.amount_native == null && row.amount_status !== "permanently_unavailable") {
        markRecoveryAttempt(row, "none", "runtime_budget");
      }
      break;
    }
    if (blacklistSubrequestBudgetReached(runBudget)) {
      if (row.amount_native == null && row.amount_status !== "permanently_unavailable") {
        markRecoveryAttempt(row, "none", "budget_exhausted");
      }
      break;
    }
    if (row.amount_native != null) {
      row.amount_usd_at_event ??= computeBlacklistAmountUsdAtEvent(
        config.stablecoin,
        row.amount_native,
        assetPriceUsd,
      );
      continue;
    }
    if (row.amount_status === "permanently_unavailable") continue;
    if (row.event_type !== "blacklist" && row.event_type !== "unblacklist" && row.event_type !== "destroy") continue;

    const blockForBalance = getHistoricalBalanceBlock(row.block_number);

    if (config.chain.type === "tron") {
      // Tron blacklist/unblacklist rows are resolved by backfillTronFromLedger
      // (pure-SQL mirror from blacklist_current_balances). Destroy events keep
      // their native amount from the event payload.
      continue;
    } else if (config.chain.evmChainId != null) {
      counters.attempted++;
      try {
        let amount: number | null = null;
        let source: "event" | "historical_balance" = "historical_balance";

        if (row.event_type === "destroy") {
          markRecoveryAttempt(row, "event_receipt", null);
          amount = await fetchDestroyAmountFromLog(
            config.chain.evmChainId,
            config.contractAddress,
            row.tx_hash,
            row.address,
            config,
            etherscanApiKey,
            etherscanLimiter,
            runBudget.subrequestBudget,
            signal,
          );
          throwIfAborted(signal);
          if (amount != null) source = "event";
        }

        if (amount == null) {
          markRecoveryAttempt(row, inferHistoricalBalanceProvider(drpcApiKey, etherscanApiKey, chainRpcs), null);
          amount = await fetchEvmTokenBalance(
            config,
            row.address,
            blockForBalance,
            etherscanApiKey,
            drpcApiKey,
            etherscanLimiter,
            runBudget.subrequestBudget,
            signal,
            chainRpcs,
          );
          throwIfAborted(signal);
        }

        row.amount_native = amount;
        row.amount_usd_at_event = computeBlacklistAmountUsdAtEvent(config.stablecoin, amount, assetPriceUsd);
        row.amount_source = source;
        row.amount_status = amount != null ? "resolved" : "provider_failed";
        row.amount_last_error_class = amount != null ? null : "provider_null";
        if (amount != null) {
          counters.succeeded++;
        } else {
          counters.failed++;
        }
      } catch (error) {
        rethrowIfAborted(error, signal);
        row.amount_status = "provider_failed";
        row.amount_last_error_class = inferErrorClass(error);
        counters.failed++;
      }
    }
  }
  return counters;
}

function normalizeEvmAddress(address: string): string | null {
  const value = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(value)) return null;
  return value;
}

function decodeAddressWordStrict(word: string | null | undefined): string | null {
  if (typeof word !== "string") return null;
  const cleaned = word.startsWith("0x") ? word.slice(2) : word;
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) return null;
  return normalizeEvmAddress("0x" + cleaned.slice(24));
}

function decodeUint256WordStrict(word: string | null | undefined, decimals: number): number | null {
  if (typeof word !== "string") return null;
  const cleaned = word.startsWith("0x") ? word.slice(2) : word;
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) return null;
  return decodeUint256("0x" + cleaned, decimals);
}

function readTopicWord(topics: readonly string[], index: number): string | null {
  const topic = topics[index];
  if (typeof topic !== "string") return null;
  return /^0x[0-9a-fA-F]{64}$/.test(topic) ? topic : null;
}

function resolveDestroyLogAddress(
  matchingEvent: ReturnType<typeof getBlacklistEventByTopic>,
  log: Pick<EtherscanLogEntry, "topics" | "data">,
): { address: string | null; addressFromTopic: boolean } {
  if (!matchingEvent) return { address: null, addressFromTopic: false };

  if (typeof matchingEvent.addressDataIndex === "number") {
    return {
      address: decodeAddressWordStrict(readDataWord(log.data, matchingEvent.addressDataIndex)),
      addressFromTopic: false,
    };
  }

  const topicIdx = matchingEvent.addressTopicIndex ?? 1;
  const topicAddress = decodeAddressWordStrict(readTopicWord(log.topics, topicIdx));
  if (topicAddress) {
    return { address: topicAddress, addressFromTopic: true };
  }

  return {
    address: decodeAddressWordStrict(readDataWord(log.data, 0)),
    addressFromTopic: false,
  };
}

function resolveDestroyLogAmount(
  matchingEvent: NonNullable<ReturnType<typeof getBlacklistEventByTopic>>,
  log: Pick<EtherscanLogEntry, "topics" | "data">,
  decimals: number,
  addressFromTopic: boolean,
): number | null {
  if (typeof matchingEvent.amountTopicIndex === "number") {
    return decodeUint256WordStrict(readTopicWord(log.topics, matchingEvent.amountTopicIndex), decimals);
  }
  if (typeof matchingEvent.amountDataIndex === "number") {
    return decodeUint256WordStrict(readDataWord(log.data, matchingEvent.amountDataIndex), decimals);
  }

  return decodeUint256WordStrict(
    readDataWord(log.data, addressFromTopic ? 0 : 1),
    decimals,
  );
}

export function extractDestroyAmountFromReceiptLogs(
  config: ContractEventConfig,
  logs: readonly EtherscanLogEntry[],
  affectedAddress: string,
): number | null {
  const normalizedAffectedAddress = normalizeEvmAddress(affectedAddress);
  if (!normalizedAffectedAddress) return null;

  for (const log of logs) {
    if (log.address.toLowerCase() !== config.contractAddress.toLowerCase()) continue;
    const matchingEvent = getBlacklistEventByTopic(config, log.topics[0]);
    if (matchingEvent?.eventType !== "destroy" || !matchingEvent.hasAmount) continue;

    const { address, addressFromTopic } = resolveDestroyLogAddress(matchingEvent, log);
    if (address !== normalizedAffectedAddress) continue;

    const amount = resolveDestroyLogAmount(matchingEvent, log, config.decimals, addressFromTopic);
    if (amount != null) return amount;
  }

  const paddedAddress = "0x000000000000000000000000" + normalizedAffectedAddress.slice(2);
  for (const log of logs) {
    if (log.address.toLowerCase() !== config.contractAddress.toLowerCase()) continue;
    if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    if (log.topics.length < 3) continue;
    if (log.topics[1]?.toLowerCase() !== paddedAddress) continue;
    if (log.topics[2]?.toLowerCase() !== ZERO_ADDRESS_TOPIC) continue;
    const amount = decodeUint256WordStrict(readDataWord(log.data, 0), config.decimals);
    if (amount != null) return amount;
  }

  return null;
}

async function fetchDestroyAmountFromLog(
  evmChainId: number,
  contractAddress: string,
  txHash: string,
  affectedAddress: string,
  config: ContractEventConfig,
  apiKey: string | null,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<number | null> {
  if (budgetExhausted(budget)) return null;
  if (config.contractAddress.toLowerCase() !== contractAddress.toLowerCase()) return null;

  const params = new URLSearchParams({
    chainid: evmChainId.toString(),
    module: "proxy",
    action: "eth_getTransactionReceipt",
    txhash: txHash,
  });
  if (apiKey) params.set("apikey", apiKey);

  try {
    budget.count++;
    const json = await rateLimit(async () => {
      const res = await fetchWithRetry(`${ETHERSCAN_V2_BASE}?${params}`, signal ? { signal } : undefined);
      if (!res) return null;
      return res.json() as Promise<{ result?: { logs?: EtherscanLogEntry[] } }>;
    });

    if (!json?.result?.logs) return null;
    return extractDestroyAmountFromReceiptLogs(config, json.result.logs, affectedAddress);
  } catch (error) {
    rethrowIfAborted(error, signal);
    console.warn("[sync-blacklist] fetchDestroyAmountFromLog failed:", error);
    return null;
  }
}

type RecoverableAmountRow = {
  event_type: string;
  address: string;
  block_number: number;
  tx_hash: string;
};

export interface RecoverBlacklistAmountForRowOptions {
  etherscanApiKey: string | null;
  drpcApiKey: string | null;
  etherscanLimiter: RateLimitedFetch;
  runBudget: BlacklistRunBudget;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  assetPriceUsd?: number | null;
}

export interface RecoverBlacklistAmountForRowResult {
  amount: number | null;
  amountUsd: number | null;
  amountSource: "event" | "historical_balance" | "unavailable";
  amountStatus: "resolved" | "provider_failed";
  lastErrorClass: BlacklistRecoveryErrorClass | null;
  lastProvider: BlacklistRecoveryProvider;
}

function inferHistoricalBalanceProvider(
  drpcApiKey: string | null,
  etherscanApiKey: string | null,
  chainRpcs?: Map<string, ChainRpcConfig>,
): BlacklistRecoveryProvider {
  if (drpcApiKey) return "drpc";
  if (chainRpcs) return "chain_rpc";
  if (etherscanApiKey) return "etherscan";
  return "chain_rpc";
}

export async function recoverBlacklistAmountForRow(
  row: RecoverableAmountRow,
  config: ContractEventConfig,
  options: RecoverBlacklistAmountForRowOptions,
): Promise<RecoverBlacklistAmountForRowResult> {
  if (config.chain.type !== "evm" || config.chain.evmChainId == null) {
    return {
      amount: null,
      amountUsd: null,
      amountSource: "unavailable",
      amountStatus: "provider_failed",
      lastErrorClass: "provider_unsupported",
      lastProvider: "none",
    };
  }

  let amount: number | null = null;
  let amountSource: RecoverBlacklistAmountForRowResult["amountSource"] = "unavailable";
  let lastErrorClass: BlacklistRecoveryErrorClass | null = "provider_null";
  let lastProvider: BlacklistRecoveryProvider = inferHistoricalBalanceProvider(
    options.drpcApiKey,
    options.etherscanApiKey,
    options.chainRpcs,
  );

  if (row.event_type === "destroy") {
    lastProvider = "event_receipt";
    amount = await fetchDestroyAmountFromLog(
      config.chain.evmChainId,
      config.contractAddress,
      row.tx_hash,
      row.address,
      config,
      options.etherscanApiKey,
      options.etherscanLimiter,
      options.runBudget.subrequestBudget,
      options.signal,
    );
    throwIfAborted(options.signal);
    if (amount != null) {
      amountSource = "event";
      lastErrorClass = null;
    }
  }

  if (amount == null) {
    lastProvider = inferHistoricalBalanceProvider(
      options.drpcApiKey,
      options.etherscanApiKey,
      options.chainRpcs,
    );
    amount = await fetchEvmTokenBalance(
      config,
      row.address,
      getHistoricalBalanceBlock(row.block_number),
      options.etherscanApiKey,
      options.drpcApiKey,
      options.etherscanLimiter,
      options.runBudget.subrequestBudget,
      options.signal,
      options.chainRpcs,
    );
    throwIfAborted(options.signal);
    if (amount != null) {
      amountSource = "historical_balance";
      lastErrorClass = null;
    }
  }

  return {
    amount,
    amountUsd: computeBlacklistAmountUsdAtEvent(config.stablecoin, amount, options.assetPriceUsd),
    amountSource,
    amountStatus: amount != null ? "resolved" : "provider_failed",
    lastErrorClass,
    lastProvider,
  };
}

export async function backfillAmounts(
  db: D1Database,
  etherscanApiKey: string | null,
  drpcApiKey: string | null,
  etherscanLimiter: RateLimitedFetch,
  runBudget: BlacklistRunBudget,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<{ runtimeBudgetReached: boolean }> {
  if (blacklistRuntimeBudgetReached(runBudget)) {
    return { runtimeBudgetReached: true };
  }

  const result = await db
    .prepare(
      `SELECT id, chain_id, event_type, address, block_number, stablecoin, tx_hash, config_key, contract_address,
              amount_attempt_count, amount_last_attempted_at, amount_last_error_class, amount_last_provider,
              amount_source
      FROM blacklist_events
       WHERE event_type IN ('blacklist', 'unblacklist', 'destroy')
         AND chain_id != 'tron'
         AND (
               amount_status IN ('recoverable_pending', 'provider_failed', 'ambiguous')
               OR (
                 amount_source = 'derived'
                 AND amount_native = 0
                 AND amount_status = 'resolved'
               )
             )
       ORDER BY
         CASE WHEN amount_status IN ('recoverable_pending', 'provider_failed', 'ambiguous') THEN 0 ELSE 1 END ASC,
         timestamp DESC
       LIMIT ?`,
    )
    .bind(BACKFILL_BATCH_SIZE)
    .all<{
      id: string;
      chain_id: string;
      event_type: string;
      address: string;
      block_number: number;
      stablecoin: string;
      tx_hash: string;
      config_key: string | null;
      contract_address: string | null;
      amount_attempt_count: number | null;
      amount_last_attempted_at: number | null;
      amount_last_error_class: string | null;
      amount_last_provider: string | null;
      amount_source: string;
    }>();

  if (!result.results?.length) return { runtimeBudgetReached: false };

  const stmts: D1PreparedStatement[] = [];
  let runtimeBudgetHit = false;

  for (const row of result.results) {
    throwIfAborted(signal);
    if (blacklistRuntimeBudgetReached(runBudget)) {
      runtimeBudgetHit = true;
      break;
    }
    if (blacklistSubrequestBudgetReached(runBudget)) break;

    const symbol = row.stablecoin as ContractEventConfig["stablecoin"];
    const config = row.config_key
      ? getBlacklistConfigByKey(row.config_key)
      : row.contract_address
        ? getBlacklistConfigByContract(row.chain_id, row.contract_address)
        : (() => {
            const matches = getBlacklistConfigsForSymbolAndChain(symbol, row.chain_id);
            return matches.length === 1 ? matches[0] : undefined;
          })();
    if (!config) {
      stmts.push(
        db.prepare(
          `UPDATE blacklist_events
           SET amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
               amount_last_attempted_at = ?,
               amount_last_error_class = ?,
               amount_last_provider = ?
           WHERE id = ?`,
        ).bind(
          Math.floor(Date.now() / 1000),
          row.contract_address == null && row.config_key == null ? "config_missing" : "ambiguous_config",
          "none",
          row.id,
        ),
      );
      continue;
    }

    const assetPriceUsd = getBlacklistPriceAssetId(config.stablecoin)
      ? await fetchBlacklistAssetPriceFromCache(db, config.stablecoin)
      : null;

    let amount: number | null = null;
    let amountSource: "event" | "historical_balance" | "derived" | "unavailable" = "unavailable";
    let amountStatus: "resolved" | "provider_failed" | "recoverable_pending" | "ambiguous" = "provider_failed";
    let lastErrorClass: BlacklistRecoveryErrorClass | null = "provider_null";
    let lastProvider: BlacklistRecoveryProvider = inferHistoricalBalanceProvider(drpcApiKey, etherscanApiKey, chainRpcs);
    const attemptAt = Math.floor(Date.now() / 1000);

    if (row.event_type === "destroy" && config.chain.type === "evm" && config.chain.evmChainId != null) {
      lastProvider = "event_receipt";
      amount = await fetchDestroyAmountFromLog(
        config.chain.evmChainId,
        config.contractAddress,
        row.tx_hash,
        row.address,
        config,
        etherscanApiKey,
        etherscanLimiter,
        runBudget.subrequestBudget,
        signal,
      );
      throwIfAborted(signal);
      if (amount != null) {
        amountSource = "event";
        lastErrorClass = null;
      }
      if (amount == null) {
        lastProvider = inferHistoricalBalanceProvider(drpcApiKey, etherscanApiKey, chainRpcs);
        amount = await fetchEvmTokenBalance(
          config,
          row.address,
          getHistoricalBalanceBlock(row.block_number),
          etherscanApiKey,
          drpcApiKey,
          etherscanLimiter,
          runBudget.subrequestBudget,
          signal,
          chainRpcs,
        );
        throwIfAborted(signal);
        if (amount != null) {
          amountSource = "historical_balance";
          lastErrorClass = null;
        }
      }
    } else if (config.chain.type === "tron") {
      // Tron rows are resolved by backfillTronFromLedger; skip in per-row backfill.
      continue;
    } else if (config.chain.evmChainId != null) {
      lastProvider = inferHistoricalBalanceProvider(drpcApiKey, etherscanApiKey, chainRpcs);
      amount = await fetchEvmTokenBalance(
        config,
        row.address,
        getHistoricalBalanceBlock(row.block_number),
        etherscanApiKey,
        drpcApiKey,
        etherscanLimiter,
        runBudget.subrequestBudget,
        signal,
        chainRpcs,
      );
      throwIfAborted(signal);
      if (amount != null) {
        amountSource = "historical_balance";
        lastErrorClass = null;
      }
    }

    amountStatus = amount != null ? "resolved" : "provider_failed";
    if (amount != null) {
      const shouldSuppress = shouldSuppressAsMirrorZero(config.stablecoin, row.event_type, amount);
      // The SQL CASE-WHEN guard below ensures a row already marked
      // `permanently_unavailable` is never downgraded by a later recovery pass.
      const targetStatus = shouldSuppress ? "permanently_unavailable" : amountStatus;
      stmts.push(
        db.prepare(
          `UPDATE blacklist_events
           SET amount = ?,
               amount_native = ?,
               amount_usd_at_event = ?,
               amount_source = ?,
               amount_status = CASE WHEN amount_status = 'permanently_unavailable' THEN amount_status ELSE ? END,
               suppression_reason = COALESCE(suppression_reason, ?),
               contract_address = COALESCE(contract_address, ?),
               config_key = COALESCE(config_key, ?),
               amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
               amount_last_attempted_at = ?,
               amount_last_error_class = ?,
               amount_last_provider = ?
           WHERE id = ?`,
        ).bind(
          amount,
          amount,
          computeBlacklistAmountUsdAtEvent(config.stablecoin, amount, assetPriceUsd),
          amountSource,
          targetStatus,
          shouldSuppress ? "circle_mirror_zero_balance" : null,
          config.contractAddress,
          config.configKey,
          attemptAt,
          lastErrorClass,
          lastProvider,
          row.id,
        ),
      );
    } else {
      const wasLegacyDerived = row.amount_source === "derived";
      if (wasLegacyDerived) {
        stmts.push(
          db.prepare(
            `UPDATE blacklist_events
             SET amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
                 amount_last_attempted_at = ?,
                 amount_last_error_class = ?,
                 amount_last_provider = ?
             WHERE id = ?`,
          ).bind(attemptAt, lastErrorClass, lastProvider, row.id),
        );
      } else {
        stmts.push(
          db.prepare(
            `UPDATE blacklist_events
             SET amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
                 amount_last_attempted_at = ?,
                 amount_last_error_class = ?,
                 amount_last_provider = ?,
                 amount_status = ?
             WHERE id = ?`,
          ).bind(attemptAt, lastErrorClass, lastProvider, amountStatus, row.id),
        );
      }
    }
  }

  if (stmts.length > 0) {
    await batchExecute(db, stmts);
    console.log(`[sync-blacklist] Backfilled amounts for ${stmts.length} events`);
  }

  return { runtimeBudgetReached: runtimeBudgetHit };
}

export async function backfillTronFromLedger(
  db: D1Database,
): Promise<{ updated: number }> {
  const result = await db
    .prepare(
      `UPDATE blacklist_events
       SET amount_native = (
             SELECT bcb.amount_native
             FROM blacklist_current_balances bcb
             WHERE bcb.stablecoin = blacklist_events.stablecoin
               AND bcb.chain_id = blacklist_events.chain_id
               AND LOWER(bcb.address) = LOWER(blacklist_events.address)
               AND (
                 (blacklist_events.config_key IS NOT NULL AND bcb.config_key = blacklist_events.config_key)
                 OR (
                   blacklist_events.config_key IS NULL
                   AND blacklist_events.contract_address IS NOT NULL
                   AND LOWER(bcb.contract_address) = LOWER(blacklist_events.contract_address)
                 )
                 OR (
                   blacklist_events.config_key IS NULL
                   AND blacklist_events.contract_address IS NULL
                   AND bcb.config_key IS NULL
                   AND bcb.contract_address IS NULL
                 )
               )
               AND bcb.amount_native IS NOT NULL
             LIMIT 1
           ),
           amount_usd_at_event = (
             SELECT bcb.amount_usd
             FROM blacklist_current_balances bcb
             WHERE bcb.stablecoin = blacklist_events.stablecoin
               AND bcb.chain_id = blacklist_events.chain_id
               AND LOWER(bcb.address) = LOWER(blacklist_events.address)
               AND (
                 (blacklist_events.config_key IS NOT NULL AND bcb.config_key = blacklist_events.config_key)
                 OR (
                   blacklist_events.config_key IS NULL
                   AND blacklist_events.contract_address IS NOT NULL
                   AND LOWER(bcb.contract_address) = LOWER(blacklist_events.contract_address)
                 )
                 OR (
                   blacklist_events.config_key IS NULL
                   AND blacklist_events.contract_address IS NULL
                   AND bcb.config_key IS NULL
                   AND bcb.contract_address IS NULL
                 )
               )
               AND bcb.amount_native IS NOT NULL
             LIMIT 1
           ),
           amount_source = 'current_balance_snapshot',
           amount_status = 'resolved',
           amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
           amount_last_attempted_at = ?,
           amount_last_error_class = NULL,
           amount_last_provider = 'current_balances_ledger'
       WHERE chain_id = 'tron'
         AND amount_native IS NULL
         AND suppression_reason IS NULL
         AND event_type IN ('blacklist', 'unblacklist')
         AND EXISTS (
           SELECT 1
           FROM blacklist_current_balances bcb
           WHERE bcb.stablecoin = blacklist_events.stablecoin
             AND bcb.chain_id = blacklist_events.chain_id
             AND LOWER(bcb.address) = LOWER(blacklist_events.address)
             AND (
               (blacklist_events.config_key IS NOT NULL AND bcb.config_key = blacklist_events.config_key)
               OR (
                 blacklist_events.config_key IS NULL
                 AND blacklist_events.contract_address IS NOT NULL
                 AND LOWER(bcb.contract_address) = LOWER(blacklist_events.contract_address)
               )
               OR (
                 blacklist_events.config_key IS NULL
                 AND blacklist_events.contract_address IS NULL
                 AND bcb.config_key IS NULL
                 AND bcb.contract_address IS NULL
               )
             )
             AND bcb.amount_native IS NOT NULL
         )`,
    )
    .bind(Math.floor(Date.now() / 1000))
    .run();

  return { updated: result.meta.changes ?? 0 };
}
