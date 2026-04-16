import {
  computeBlacklistAmountUsdAtEvent,
  getBlacklistPriceAssetId,
} from "@shared/lib/blacklist";
import { fetchBlacklistAssetPriceFromCache } from "./current-balance-cache";
import { shouldSuppressAsMirrorZero } from "./shared";
import { throwIfAborted } from "../../lib/abort";
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
  decodeUint256AtSlot,
} from "../../lib/evm-logs";
import { ETHERSCAN_V2_BASE } from "../../lib/constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { fetchEvmTokenBalance } from "../blacklist/balance-providers";
import type { BlacklistRow } from "../blacklist/shared";
import type { ChainRpcConfig } from "../../lib/chain-registry";

const BACKFILL_BATCH_SIZE = 50;
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
  | "none";

function runtimeBudgetReached(deadlineMs: number): boolean {
  return Date.now() >= deadlineMs;
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
  if (message.includes("timeout")) return "provider_timeout";
  if (message.includes("http")) return "provider_http_error";
  return "provider_null";
}

export async function enrichRowBalances(
  rows: BlacklistRow[],
  config: ContractEventConfig,
  etherscanApiKey: string | null,
  drpcApiKey: string | null,
  etherscanLimiter: RateLimitedFetch,
  budget: SubrequestBudget,
  deadlineMs: number,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  assetPriceUsd?: number | null,
): Promise<{ attempted: number; succeeded: number; failed: number }> {
  const counters = { attempted: 0, succeeded: 0, failed: 0 };
  for (const row of rows) {
    throwIfAborted(signal);
    if (runtimeBudgetReached(deadlineMs)) {
      if (row.amount_native == null && row.amount_status !== "permanently_unavailable") {
        markRecoveryAttempt(row, "none", "runtime_budget");
      }
      break;
    }
    if (budgetExhausted(budget)) {
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

    const blockForBalance = Math.max(0, row.block_number - 1);

    if (config.chain.type === "tron") {
      // Tron has no historical balance API — mark blacklist/unblacklist
      // events as permanently unavailable so they don't re-enter backfill.
      if (row.event_type !== "destroy") {
        row.amount_status = "permanently_unavailable";
        row.amount_source = "unavailable";
        markRecoveryAttempt(row, "trongrid", "provider_unsupported");
      }
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
            budget,
            signal,
          );
          if (amount != null) source = "event";
        }

        if (amount == null) {
          markRecoveryAttempt(row, "drpc", null);
          amount = await fetchEvmTokenBalance(
            config,
            row.address,
            blockForBalance,
            etherscanApiKey,
            drpcApiKey,
            etherscanLimiter,
            budget,
            signal,
            chainRpcs,
          );
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
        row.amount_status = "provider_failed";
        row.amount_last_error_class = inferErrorClass(error);
        counters.failed++;
      }
    }
  }
  return counters;
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

    for (const log of json.result.logs) {
      if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
      const matchingEvent = getBlacklistEventByTopic(config, log.topics[0]);
      if (matchingEvent?.eventType !== "destroy" || !matchingEvent.hasAmount) continue;

      if (typeof matchingEvent.amountTopicIndex === "number" && log.topics.length > matchingEvent.amountTopicIndex) {
        return decodeUint256(log.topics[matchingEvent.amountTopicIndex]!, config.decimals);
      }
      if (typeof matchingEvent.amountDataIndex === "number") {
        return decodeUint256AtSlot(log.data, matchingEvent.amountDataIndex, config.decimals);
      }

      const addressIndexed = log.topics.length > 1;
      if (addressIndexed) {
        return log.data.length >= 66 ? decodeUint256(log.data, config.decimals) : null;
      }
      return log.data.length > 66 ? decodeUint256("0x" + log.data.slice(66), config.decimals) : null;
    }

    const paddedAddress = "0x000000000000000000000000"
      + (affectedAddress.startsWith("0x") ? affectedAddress.slice(2) : affectedAddress).toLowerCase();
    for (const log of json.result.logs) {
      if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
      if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
      if (log.topics.length < 3) continue;
      if (log.topics[1]?.toLowerCase() !== paddedAddress) continue;
      if (log.topics[2]?.toLowerCase() !== ZERO_ADDRESS_TOPIC) continue;
      if (log.data.length >= 66) {
        return decodeUint256(log.data, config.decimals);
      }
    }

    return null;
  } catch (error) {
    console.warn("[sync-blacklist] fetchDestroyAmountFromLog failed:", error);
    return null;
  }
}

export async function backfillAmounts(
  db: D1Database,
  etherscanApiKey: string | null,
  drpcApiKey: string | null,
  etherscanLimiter: RateLimitedFetch,
  budget: SubrequestBudget,
  deadlineMs: number,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<{ runtimeBudgetReached: boolean }> {
  if (runtimeBudgetReached(deadlineMs)) {
    return { runtimeBudgetReached: true };
  }

  const result = await db
    .prepare(
      `SELECT id, chain_id, event_type, address, block_number, stablecoin, tx_hash, config_key, contract_address,
              amount_attempt_count, amount_last_attempted_at, amount_last_error_class, amount_last_provider
      FROM blacklist_events
       WHERE event_type IN ('blacklist', 'unblacklist', 'destroy')
         AND amount_status IN ('recoverable_pending', 'provider_failed', 'ambiguous')
       ORDER BY timestamp DESC
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
    }>();

  if (!result.results?.length) return { runtimeBudgetReached: false };

  const stmts: D1PreparedStatement[] = [];
  let runtimeBudgetHit = false;

  for (const row of result.results) {
    throwIfAborted(signal);
    if (runtimeBudgetReached(deadlineMs)) {
      runtimeBudgetHit = true;
      break;
    }
    if (budgetExhausted(budget)) break;

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
    let lastProvider: BlacklistRecoveryProvider = "drpc";
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
        budget,
        signal,
      );
      if (amount != null) {
        amountSource = "event";
        lastErrorClass = null;
      }
      if (amount == null) {
        lastProvider = "drpc";
        amount = await fetchEvmTokenBalance(
          config,
          row.address,
          row.block_number - 1,
          etherscanApiKey,
          drpcApiKey,
          etherscanLimiter,
          budget,
          signal,
          chainRpcs,
        );
        if (amount != null) {
          amountSource = "historical_balance";
          lastErrorClass = null;
        }
      }
    } else if (config.chain.type === "tron") {
      stmts.push(
        db.prepare(
          `UPDATE blacklist_events
           SET amount_status = 'permanently_unavailable',
               amount_source = 'unavailable',
               amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
               amount_last_attempted_at = ?,
               amount_last_error_class = 'provider_unsupported',
               amount_last_provider = 'trongrid'
           WHERE id = ?`,
        ).bind(attemptAt, row.id),
      );
      continue;
    } else if (config.chain.evmChainId != null) {
      lastProvider = "drpc";
      amount = await fetchEvmTokenBalance(
        config,
        row.address,
        row.block_number - 1,
        etherscanApiKey,
        drpcApiKey,
        etherscanLimiter,
        budget,
        signal,
        chainRpcs,
      );
      if (amount != null) {
        amountSource = "historical_balance";
        lastErrorClass = null;
      }
    }

    amountStatus = amount != null ? "resolved" : "provider_failed";
    if (amount != null) {
      const shouldSuppress = shouldSuppressAsMirrorZero(config.stablecoin, row.event_type, amount);
      stmts.push(
        db.prepare(
          `UPDATE blacklist_events
           SET amount = ?,
               amount_native = ?,
               amount_usd_at_event = ?,
               amount_source = ?,
               amount_status = ?,
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
          amountStatus,
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
      stmts.push(
        db.prepare(
          `UPDATE blacklist_events
           SET amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
               amount_last_attempted_at = ?,
               amount_last_error_class = ?,
               amount_last_provider = ?,
               amount_status = ?
           WHERE id = ?`,
        ).bind(
          attemptAt,
          lastErrorClass,
          lastProvider,
          amountStatus,
          row.id,
        ),
      );
    }
  }

  if (stmts.length > 0) {
    await batchExecute(db, stmts);
    console.log(`[sync-blacklist] Backfilled amounts for ${stmts.length} events`);
  }

  return { runtimeBudgetReached: runtimeBudgetHit };
}
