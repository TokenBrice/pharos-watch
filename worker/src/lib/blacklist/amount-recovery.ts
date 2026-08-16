import { logWorkerEventArgs } from "../structured-log";
import {
  buildBlacklistAddressCountKey,
  buildBlacklistContractBalanceKey,
  computeBlacklistAmountUsdAtEvent,
  getBlacklistPriceAssetId,
} from "@shared/lib/blacklist";
import type { BlacklistAmountStatus, BlacklistStablecoin } from "@shared/types/market";
import { fetchBlacklistAssetPriceFromCache } from "./row-preparation";
import { rethrowIfAborted, throwIfAborted } from "../abort";
import {
  getBlacklistConfigByContract,
  getBlacklistConfigByKey,
  getBlacklistConfigsForSymbolAndChain,
  getBlacklistEventByTopic,
  type ContractEventConfig,
} from "../blacklist-contracts";
import { batchExecute, buildInClause, chunkArray } from "../db";
import {
  type EtherscanLogEntry,
  type RateLimitedFetch,
  type SubrequestBudget,
  budgetExhausted,
  decodeAddressWord,
  decodeUint256Word,
  readDataWord,
} from "../evm-logs";
import { ETHERSCAN_V2_BASE } from "../constants";
import { toErrorMessage } from "../error-utils";
import { fetchJsonWithRetry } from "../fetch-retry";
import { fetchEvmTokenBalance } from "./balance-providers";
import type { BlacklistRow } from "./shared";
import type { ChainRpcConfig } from "../chain-registry";
import { blacklistRuntimeBudgetReached, blacklistSubrequestBudgetReached, type BlacklistRunBudget } from "./run-budget";
import { buildBlacklistAmountRepairQueueUpdate, refreshBlacklistAmountRepairQueue } from "./amount-repair-queue";
import { buildRecoveredBlacklistAmountPersistence } from "./amount-persistence";

// Conservative scheduled recovery cap: one D1 batch chunk and well below the
// sync-blacklist 900-subrequest run budget observed in production.
const BACKFILL_BATCH_SIZE = 100;
const MAX_DERIVED_RECOVERY_ATTEMPTS = 3;
// Independent cap that happens to share the same value as BACKFILL_BATCH_SIZE;
// keep separate so either can be tuned without affecting the other.
const TRON_LEDGER_BACKFILL_BATCH_SIZE = 100;
const TRON_LEDGER_LOOKUP_CHUNK_SIZE = 90;
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
  "etherscan" | "drpc" | "chain_rpc" | "trongrid" | "event_receipt" | "current_balances_ledger" | "none";

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
  const message = toErrorMessage(error).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out")) return "provider_timeout";
  if (/\b[45]\d{2}\b/.test(message)) return "provider_http_error";
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
  const { rows, config, etherscanApiKey, drpcApiKey, etherscanLimiter, runBudget, signal, chainRpcs, assetPriceUsd } =
    opts;
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
      row.amount_usd_at_event ??= computeBlacklistAmountUsdAtEvent(config.stablecoin, row.amount_native, assetPriceUsd);
      continue;
    }
    if (row.amount_status === "permanently_unavailable") continue;
    if (row.event_type !== "blacklist" && row.event_type !== "unblacklist" && row.event_type !== "destroy") continue;
    if (config.chain.type === "tron") {
      // Tron blacklist/unblacklist rows are resolved by backfillTronFromLedger
      // (pure-SQL mirror from blacklist_current_balances). Destroy events keep
      // their native amount from the event payload.
      continue;
    } else if (config.chain.evmChainId != null) {
      counters.attempted++;
      try {
        const { amount, amountSource } = await recoverEvmAmountFromEventOrHistory({
          row,
          config,
          etherscanApiKey,
          drpcApiKey,
          etherscanLimiter,
          runBudget,
          unresolvedAmountSource: "historical_balance",
          signal,
          chainRpcs,
          onProviderAttempt: (provider) => markRecoveryAttempt(row, provider, null),
        });

        row.amount_native = amount;
        row.amount_usd_at_event = computeBlacklistAmountUsdAtEvent(config.stablecoin, amount, assetPriceUsd);
        row.amount_source = amountSource;
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
      address: decodeAddressWord(readDataWord(log.data, matchingEvent.addressDataIndex)),
      addressFromTopic: false,
    };
  }

  const topicIdx = matchingEvent.addressTopicIndex ?? 1;
  const topicAddress = decodeAddressWord(readTopicWord(log.topics, topicIdx));
  if (topicAddress) {
    return { address: topicAddress, addressFromTopic: true };
  }

  return {
    address: decodeAddressWord(readDataWord(log.data, 0)),
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
    return decodeUint256Word(readTopicWord(log.topics, matchingEvent.amountTopicIndex), decimals);
  }
  if (typeof matchingEvent.amountDataIndex === "number") {
    return decodeUint256Word(readDataWord(log.data, matchingEvent.amountDataIndex), decimals);
  }

  return decodeUint256Word(readDataWord(log.data, addressFromTopic ? 0 : 1), decimals);
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
    const amount = decodeUint256Word(readDataWord(log.data, 0), config.decimals);
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
      const result = await fetchJsonWithRetry<{ result?: { logs?: EtherscanLogEntry[] } }>(
        `${ETHERSCAN_V2_BASE}?${params}`,
        signal ? { signal } : undefined,
      );
      if (!result?.response.ok) return null;
      return result.body;
    });

    if (!json?.result?.logs) return null;
    return extractDestroyAmountFromReceiptLogs(config, json.result.logs, affectedAddress);
  } catch (error) {
    rethrowIfAborted(error, signal);
    logWorkerEventArgs("lib", "warn", "[sync-blacklist] fetchDestroyAmountFromLog failed:", error);
    return null;
  }
}

type RecoverableAmountRow = {
  event_type: string;
  address: string;
  block_number: number;
  tx_hash: string;
};

type TronLedgerCandidateRow = {
  id: string;
  stablecoin: BlacklistStablecoin;
  chain_id: string;
  address: string;
  config_key: string | null;
  contract_address: string | null;
};

type TronLedgerBalanceRow = {
  id: string;
  amount_native: number | null;
  amount_usd: number | null;
};

type TronLedgerLookup = {
  eventId: string;
  balanceId: string;
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

export interface BlacklistAmountBackfillResult {
  runtimeBudgetReached: boolean;
  attempted: number;
  resolved: number;
  retried: number;
  unrecoverable: number;
}

export interface BlacklistAmountBackfillOptions {
  maxRows?: number;
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

type EvmAmountRecoveryResult = {
  amount: number | null;
  amountSource: "event" | "historical_balance" | "unavailable";
  lastErrorClass: BlacklistRecoveryErrorClass | null;
  lastProvider: BlacklistRecoveryProvider;
};

async function recoverEvmAmountFromEventOrHistory(opts: {
  row: RecoverableAmountRow;
  config: ContractEventConfig;
  etherscanApiKey: string | null;
  drpcApiKey: string | null;
  etherscanLimiter: RateLimitedFetch;
  runBudget: BlacklistRunBudget;
  unresolvedAmountSource: EvmAmountRecoveryResult["amountSource"];
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  onProviderAttempt?: (provider: BlacklistRecoveryProvider) => void;
}): Promise<EvmAmountRecoveryResult> {
  const {
    row,
    config,
    etherscanApiKey,
    drpcApiKey,
    etherscanLimiter,
    runBudget,
    unresolvedAmountSource,
    signal,
    chainRpcs,
    onProviderAttempt,
  } = opts;
  let amount: number | null = null;
  let amountSource = unresolvedAmountSource;
  let lastErrorClass: BlacklistRecoveryErrorClass | null = "provider_null";
  let lastProvider: BlacklistRecoveryProvider;

  if (row.event_type === "destroy") {
    lastProvider = "event_receipt";
    onProviderAttempt?.(lastProvider);
    amount = await fetchDestroyAmountFromLog(
      config.chain.evmChainId!,
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
      return {
        amount,
        amountSource: "event",
        lastErrorClass: null,
        lastProvider,
      };
    }
  }

  lastProvider = inferHistoricalBalanceProvider(drpcApiKey, etherscanApiKey, chainRpcs);
  onProviderAttempt?.(lastProvider);
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

  return {
    amount,
    amountSource,
    lastErrorClass,
    lastProvider,
  };
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

  const { amount, amountSource, lastErrorClass, lastProvider } = await recoverEvmAmountFromEventOrHistory({
    row,
    config,
    etherscanApiKey: options.etherscanApiKey,
    drpcApiKey: options.drpcApiKey,
    etherscanLimiter: options.etherscanLimiter,
    runBudget: options.runBudget,
    unresolvedAmountSource: "unavailable",
    signal: options.signal,
    chainRpcs: options.chainRpcs,
  });

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
  options: BlacklistAmountBackfillOptions = {},
): Promise<BlacklistAmountBackfillResult> {
  const maxRows = Math.max(
    1,
    Math.min(BACKFILL_BATCH_SIZE, Math.floor(options.maxRows ?? BACKFILL_BATCH_SIZE)),
  );
  if (blacklistRuntimeBudgetReached(runBudget)) {
    return { runtimeBudgetReached: true, attempted: 0, resolved: 0, retried: 0, unrecoverable: 0 };
  }

  await refreshBlacklistAmountRepairQueue(db, Math.floor(Date.now() / 1000));

  const buildAttemptUpdate = (
    eventId: string,
    attemptAtSec: number,
    errorClass: BlacklistRecoveryErrorClass | null,
    provider: BlacklistRecoveryProvider,
    status?: BlacklistAmountStatus,
  ): D1PreparedStatement => {
    const statusClause = status !== undefined ? `,\n               amount_status = ?` : "";
    const stmt = db.prepare(
      `UPDATE blacklist_events
           SET amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
               amount_last_attempted_at = ?,
               amount_last_error_class = ?,
               amount_last_provider = ?${statusClause}
           WHERE id = ?`,
    );
    return status !== undefined
      ? stmt.bind(attemptAtSec, errorClass, provider, status, eventId)
      : stmt.bind(attemptAtSec, errorClass, provider, eventId);
  };

  const result = await db
    .prepare(
      `/* blacklist-amount-recovery-evm-candidates */
       SELECT events.id, events.chain_id, events.event_type, events.address, events.block_number,
              events.stablecoin, events.tx_hash, events.config_key, events.contract_address,
              events.amount_attempt_count, events.amount_last_attempted_at,
              events.amount_last_error_class, events.amount_last_provider, events.amount_source,
              COALESCE(queue.attempt_count, 0) AS queue_attempt_count
       FROM blacklist_events AS events
       LEFT JOIN blacklist_amount_repair_queue AS queue ON queue.event_id = events.id
       WHERE events.event_type IN ('blacklist', 'unblacklist', 'destroy')
         AND chain_id != 'tron'
         AND (
               events.amount_status IN ('recoverable_pending', 'provider_failed', 'ambiguous')
               OR (
                 events.amount_source = 'derived'
                 AND events.amount_native = 0
                 AND events.amount_status = 'resolved'
                 AND COALESCE(events.amount_attempt_count, 0) < ?
               )
             )
         AND COALESCE(queue.status, 'pending') IN ('pending', 'retry')
         AND COALESCE(queue.available_at, 0) <= unixepoch()
       ORDER BY
         COALESCE(queue.priority, 100) ASC,
         CASE WHEN events.amount_status IN ('recoverable_pending', 'provider_failed', 'ambiguous') THEN 0 ELSE 1 END ASC,
         events.timestamp DESC
       LIMIT ?`,
    )
    .bind(MAX_DERIVED_RECOVERY_ATTEMPTS, maxRows)
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
      queue_attempt_count: number;
    }>();

  if (!result.results?.length) {
    return { runtimeBudgetReached: false, attempted: 0, resolved: 0, retried: 0, unrecoverable: 0 };
  }

  const stmts: D1PreparedStatement[] = [];
  let processedRepairRows = 0;
  let resolvedRepairRows = 0;
  let retriedRepairRows = 0;
  let unrecoverableRepairRows = 0;
  const assetPriceCache = new Map<BlacklistStablecoin, number | null>();
  let runtimeBudgetHit = false;
  const getAssetPriceUsd = async (stablecoin: BlacklistStablecoin): Promise<number | null> => {
    if (!getBlacklistPriceAssetId(stablecoin)) return null;
    if (assetPriceCache.has(stablecoin)) return assetPriceCache.get(stablecoin) ?? null;
    const assetPriceUsd = await fetchBlacklistAssetPriceFromCache(db, stablecoin);
    assetPriceCache.set(stablecoin, assetPriceUsd);
    return assetPriceUsd;
  };

  for (const row of result.results) {
    throwIfAborted(signal);
    if (blacklistRuntimeBudgetReached(runBudget)) {
      runtimeBudgetHit = true;
      break;
    }
    if (blacklistSubrequestBudgetReached(runBudget)) break;

    const attemptAt = Math.floor(Date.now() / 1000);
    processedRepairRows++;
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
      const wasLegacyDerived = row.amount_source === "derived";
      const derivedRetryExhausted =
        wasLegacyDerived && (row.amount_attempt_count ?? 0) + 1 >= MAX_DERIVED_RECOVERY_ATTEMPTS;
      stmts.push(
        buildAttemptUpdate(
          row.id,
          attemptAt,
          row.contract_address == null && row.config_key == null ? "config_missing" : "ambiguous_config",
          "none",
          derivedRetryExhausted ? "permanently_unavailable" : undefined,
        ),
      );
      stmts.push(
        buildBlacklistAmountRepairQueueUpdate(db, {
          eventId: row.id,
          outcome: derivedRetryExhausted ? "unrecoverable" : "retry",
          attemptedAt: attemptAt,
          priorAttempts: row.queue_attempt_count ?? 0,
          errorClass: row.contract_address == null && row.config_key == null ? "config_missing" : "ambiguous_config",
        }),
      );
      if (derivedRetryExhausted) {
        unrecoverableRepairRows++;
      } else {
        retriedRepairRows++;
      }
      continue;
    }

    const assetPriceUsd = await getAssetPriceUsd(config.stablecoin);

    let amount: number | null = null;
    let amountSource: "event" | "historical_balance" | "derived" | "unavailable" = "unavailable";
    let amountStatus: BlacklistAmountStatus = "provider_failed";
    let lastErrorClass: BlacklistRecoveryErrorClass | null = "provider_null";
    let lastProvider: BlacklistRecoveryProvider = inferHistoricalBalanceProvider(
      drpcApiKey,
      etherscanApiKey,
      chainRpcs,
    );

    // Tron rows are resolved by backfillTronFromLedger; SQL filters chain_id != 'tron'.
    if (config.chain.evmChainId != null) {
      const recovered = await recoverEvmAmountFromEventOrHistory({
        row,
        config,
        etherscanApiKey,
        drpcApiKey,
        etherscanLimiter,
        runBudget,
        unresolvedAmountSource: "unavailable",
        signal,
        chainRpcs,
      });
      amount = recovered.amount;
      amountSource = recovered.amountSource;
      lastErrorClass = recovered.lastErrorClass;
      lastProvider = recovered.lastProvider;
    }

    amountStatus = amount != null ? "resolved" : "provider_failed";
    if (amount != null) {
      const persistence = buildRecoveredBlacklistAmountPersistence(db, {
        eventId: row.id,
        eventType: row.event_type,
        config,
        amount,
        amountUsd: computeBlacklistAmountUsdAtEvent(config.stablecoin, amount, assetPriceUsd),
        amountSource,
        amountStatus,
        attemptedAt: attemptAt,
        lastErrorClass,
        lastProvider,
      });
      const { targetStatus } = persistence;
      stmts.push(persistence.statement);
      stmts.push(
        buildBlacklistAmountRepairQueueUpdate(db, {
          eventId: row.id,
          outcome: targetStatus === "permanently_unavailable" ? "unrecoverable" : "resolved",
          attemptedAt: attemptAt,
          priorAttempts: row.queue_attempt_count ?? 0,
          errorClass: lastErrorClass,
        }),
      );
      if (targetStatus === "permanently_unavailable") {
        unrecoverableRepairRows++;
      } else {
        resolvedRepairRows++;
      }
    } else {
      const wasLegacyDerived = row.amount_source === "derived";
      const derivedRetryExhausted =
        wasLegacyDerived && (row.amount_attempt_count ?? 0) + 1 >= MAX_DERIVED_RECOVERY_ATTEMPTS;
      if (wasLegacyDerived) {
        stmts.push(
          buildAttemptUpdate(
            row.id,
            attemptAt,
            lastErrorClass,
            lastProvider,
            derivedRetryExhausted ? "permanently_unavailable" : undefined,
          ),
        );
      } else {
        stmts.push(buildAttemptUpdate(row.id, attemptAt, lastErrorClass, lastProvider, amountStatus));
      }
      stmts.push(
        buildBlacklistAmountRepairQueueUpdate(db, {
          eventId: row.id,
          outcome: derivedRetryExhausted ? "unrecoverable" : "retry",
          attemptedAt: attemptAt,
          priorAttempts: row.queue_attempt_count ?? 0,
          errorClass: lastErrorClass,
        }),
      );
      if (derivedRetryExhausted) {
        unrecoverableRepairRows++;
      } else {
        retriedRepairRows++;
      }
    }
  }

  if (stmts.length > 0) {
    await batchExecute(db, stmts, { signal });
    logWorkerEventArgs("lib", "info", `[sync-blacklist] Backfilled amounts for ${processedRepairRows} events`);
  }

  return {
    runtimeBudgetReached: runtimeBudgetHit,
    attempted: processedRepairRows,
    resolved: resolvedRepairRows,
    retried: retriedRepairRows,
    unrecoverable: unrecoverableRepairRows,
  };
}

export async function backfillTronFromLedger(
  db: D1Database,
  options: { runBudget?: BlacklistRunBudget; signal?: AbortSignal } = {},
): Promise<{ updated: number }> {
  throwIfAborted(options.signal);
  const budgetReached = () => options.runBudget != null && blacklistRuntimeBudgetReached(options.runBudget);
  if (budgetReached()) {
    return { updated: 0 };
  }

  const candidates = await db
    .prepare(
      `/* blacklist-tron-ledger-backfill-candidates */
       SELECT id, stablecoin, chain_id, address, config_key, contract_address
       FROM blacklist_events
       WHERE chain_id = 'tron'
         AND amount_native IS NULL
         AND suppression_reason IS NULL
         AND event_type IN ('blacklist', 'unblacklist')
       ORDER BY timestamp DESC, id DESC
       LIMIT ?`,
    )
    .bind(TRON_LEDGER_BACKFILL_BATCH_SIZE)
    .all<TronLedgerCandidateRow>();

  const lookups: TronLedgerLookup[] = [];
  for (const row of candidates.results ?? []) {
    throwIfAborted(options.signal);
    if (budgetReached()) {
      break;
    }
    const scopedBalanceId = buildBlacklistContractBalanceKey(
      row.stablecoin,
      row.chain_id,
      row.address,
      row.config_key,
      row.contract_address,
    );
    const legacyBalanceId = buildBlacklistAddressCountKey(row.stablecoin, row.chain_id, row.address);
    for (const balanceId of [...new Set([scopedBalanceId, legacyBalanceId])]) {
      lookups.push({ eventId: row.id, balanceId });
    }
  }

  if (lookups.length === 0) return { updated: 0 };

  const balanceById = new Map<string, TronLedgerBalanceRow>();
  const uniqueBalanceIds = [...new Set(lookups.map((lookup) => lookup.balanceId))];
  for (const chunk of chunkArray(uniqueBalanceIds, TRON_LEDGER_LOOKUP_CHUNK_SIZE)) {
    throwIfAborted(options.signal);
    if (budgetReached()) {
      break;
    }
    const { sql, binds } = buildInClause(chunk);
    const balances = await db
      .prepare(
        `/* blacklist-tron-ledger-balance-lookup */
         SELECT id, amount_native, amount_usd
         FROM blacklist_current_balances
         WHERE id IN (${sql})
           AND amount_native IS NOT NULL`,
      )
      .bind(...binds)
      .all<TronLedgerBalanceRow>();

    for (const balance of balances.results ?? []) {
      balanceById.set(balance.id, balance);
    }
  }

  const matchedByEventId = new Map<string, TronLedgerBalanceRow>();
  for (const lookup of lookups) {
    if (matchedByEventId.has(lookup.eventId)) continue;
    const balance = balanceById.get(lookup.balanceId);
    if (balance) matchedByEventId.set(lookup.eventId, balance);
  }

  if (matchedByEventId.size === 0) return { updated: 0 };
  throwIfAborted(options.signal);

  const attemptedAt = Math.floor(Date.now() / 1000);
  const stmts = [...matchedByEventId.entries()].map(([eventId, balance]) =>
    db
      .prepare(
        `/* blacklist-tron-ledger-backfill-update */
         UPDATE blacklist_events
         SET amount_native = ?,
             amount_usd_at_event = ?,
             amount_source = 'current_balance_snapshot',
             amount_status = 'resolved',
             amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
             amount_last_attempted_at = ?,
             amount_last_error_class = NULL,
             amount_last_provider = 'current_balances_ledger'
         WHERE id = ?`,
      )
      .bind(balance.amount_native, balance.amount_usd, attemptedAt, eventId),
  );

  const updated = await batchExecute(db, stmts, { signal: options.signal });

  return { updated };
}
