import {
  CONTRACT_CONFIGS,
  getBlacklistConfigByContract,
  getBlacklistConfigByKey,
  getBlacklistConfigsForSymbolAndChain,
  getBlacklistEventByTopic,
  type ContractEventConfig,
} from "../lib/blacklist-contracts";
import { ETHERSCAN_V2_BASE, CIRCUIT_SOURCE } from "../lib/constants";
import { shouldAttemptFetch, recordOutcomeSafe } from "../lib/circuit-breaker";
import { getLastBlock, setLastBlock, batchExecute } from "../lib/db";
import {
  type SubrequestBudget,
  type RateLimitedFetch,
  type EtherscanLogEntry,
  createBudget,
  budgetExhausted,
  createRateLimiter,
  decodeUint256,
  getEvmBlockNumber,
} from "../lib/evm-logs";
import { type ChainRpcConfig } from "../lib/chain-registry";
import { fetchEvmTokenBalance } from "./blacklist/balance-providers";
import { computeBlacklistAmountUsdAtEvent } from "@shared/lib/blacklist";
import { fetchWithRetry } from "../lib/fetch-retry";
import { throwIfAborted } from "../lib/abort";
import type { CronProgressReporter } from "../lib/cron-logger";
import { reportCronProgress, withBudgetMetadata } from "../lib/cron-progress";
import { fetchEvmEventsIncremental } from "./blacklist/evm-source";
import { fetchTronEventsIncremental } from "./blacklist/tron-source";
import { type BlacklistRow } from "./blacklist/shared";
import {
  syncCurrentBalanceCacheForRows,
} from "./blacklist/current-balance-cache";

const EVM_SCANNED_TO_LATEST = 99999999;
const BACKFILL_BATCH_SIZE = 50;
const SYNC_BLACKLIST_RUNTIME_BUDGET_MS = 7 * 60_000;
const SYNC_BLACKLIST_MIN_CONFIG_WINDOW_MS = 60_000;

type BlacklistRecoveryErrorClass =
  | "provider_null"
  | "provider_timeout"
  | "provider_http_error"
  | "provider_unsupported"
  | "config_missing"
  | "ambiguous_config"
  | "runtime_budget"
  | "budget_exhausted";

type BlacklistRecoveryProvider =
  | "etherscan"
  | "drpc"
  | "chain_rpc"
  | "trongrid"
  | "event_receipt"
  | "none";

type SyncBlacklistResult = {
  itemCount: number;
  metadata: string;
  status: "ok" | "degraded" | "error";
};

// Safety margin when advancing sync state to chain head (prevents permanent event loss
// if block explorer indexing lags behind chain tip). 15 minutes in seconds/ms.
const INDEXING_SAFETY_SEC = 900;
const TRON_SAFETY_MS = INDEXING_SAFETY_SEC * 1000;

// Approximate block times (seconds) per EVM chain — used to compute safety margin in blocks.
const EVM_BLOCK_TIME: Record<number, number> = {
  1: 12, // Ethereum
  42161: 0.25, // Arbitrum
  8453: 2, // Base
  10: 2, // Optimism
  137: 2, // Polygon
  43114: 2, // Avalanche
  56: 3, // BSC
};

function evmSafetyMarginBlocks(evmChainId: number): number {
  const blockTime = EVM_BLOCK_TIME[evmChainId] ?? 2;
  return Math.ceil(INDEXING_SAFETY_SEC / blockTime);
}

function runtimeBudgetReached(deadlineMs: number): boolean {
  return Date.now() >= deadlineMs;
}

function shouldStopBeforeNextConfig(deadlineMs: number): boolean {
  return Date.now() + SYNC_BLACKLIST_MIN_CONFIG_WINDOW_MS >= deadlineMs;
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

// --- Enrichment: fetch balances for blacklist/unblacklist events ---

async function enrichRowBalances(
  rows: BlacklistRow[],
  config: ContractEventConfig,
  etherscanApiKey: string | null,
  drpcApiKey: string | null,
  etherscanLimiter: RateLimitedFetch,
  budget: SubrequestBudget,
  deadlineMs: number,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
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
    if (row.amount_native != null || row.amount_status === "permanently_unavailable") continue;
    if (row.event_type !== "blacklist" && row.event_type !== "unblacklist" && row.event_type !== "destroy") continue;

    // Fetch balance at previous block: for destroy events this captures pre-wipe balance,
    // and for blacklist/unblacklist it avoids same-block edge cases where the balance
    // might appear different due to other transactions in the same block.
    const blockForBalance = row.block_number - 1;

    if (config.chain.type === "tron") {
      // TronGrid account balance endpoint returns current state, not event-time state.
      // To avoid false precision, keep Tron blacklist/unblacklist amounts null unless
      // the amount is emitted natively in the event payload (e.g. destroy).
      continue;
    } else if (config.chain.evmChainId != null) {
      counters.attempted++;
      try {
        let amount: number | null = null;
        let source: "event" | "historical_balance" = "historical_balance";

        // For destroy events, try extracting the amount from the tx receipt first.
        // This is more reliable than balanceOf for contracts like PAXG that override
        // balanceOf to return 0 for frozen addresses.
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

        // Fall back to balanceOf at block-1
        if (amount == null) {
          markRecoveryAttempt(row, "chain_rpc", null);
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
        row.amount_usd_at_event = computeBlacklistAmountUsdAtEvent(config.stablecoin, amount);
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

// --- Backfill: update existing events that have null amounts ---

// Re-fetch event log from Etherscan to extract the amount from event data.
// Used for destroy events where balanceOf is unreliable (especially on L2s).
// ERC-20 Transfer(address indexed from, address indexed to, uint256 value)
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_ADDRESS_TOPIC = "0x0000000000000000000000000000000000000000000000000000000000000000";

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

  // Fetch the transaction receipt to get logs
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

    // Strategy 1: Find a destroy event log that carries an amount natively
    for (const log of json.result.logs) {
      if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
      const matchingEvent = getBlacklistEventByTopic(config, log.topics[0]);
      if (matchingEvent?.eventType !== "destroy" || !matchingEvent.hasAmount) continue;

      // Parse amount from the log data
      const addressIndexed = log.topics.length > 1;
      if (addressIndexed) {
        return log.data.length >= 66 ? decodeUint256(log.data, config.decimals) : null;
      } else {
        return log.data.length > 66 ? decodeUint256("0x" + log.data.slice(66), config.decimals) : null;
      }
    }

    // Strategy 2: For destroy events without an amount field (e.g. PAXG/pyUSD
    // FrozenAddressWiped), look for a co-emitted ERC-20 Transfer burn event
    // in the same receipt: Transfer(from=affectedAddress, to=0x0, amount).
    // Some contracts (PAXG) override balanceOf to return 0 for frozen addresses,
    // making balance lookups unreliable — the Transfer burn is authoritative.
    const paddedAddress = "0x000000000000000000000000" + (affectedAddress.startsWith("0x") ? affectedAddress.slice(2) : affectedAddress).toLowerCase();
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
  } catch (e) {
    console.warn("[sync-blacklist] fetchDestroyAmountFromLog failed:", e);
    return null;
  }
}

async function backfillAmounts(
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

    let amount: number | null = null;
    let amountSource: "event" | "historical_balance" | "derived" | "unavailable" = "unavailable";
    let amountStatus: "resolved" | "provider_failed" | "recoverable_pending" | "ambiguous" = "provider_failed";
    let lastErrorClass: BlacklistRecoveryErrorClass | null = "provider_null";
    let lastProvider: BlacklistRecoveryProvider = "chain_rpc";
    const attemptAt = Math.floor(Date.now() / 1000);

    if (row.event_type === "destroy" && config.chain.type === "evm" && config.chain.evmChainId != null) {
      // For destroy events, re-fetch the event log to get the amount from event data.
      // This is more reliable than balanceOf, especially on L2s without archive state.
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
      // Fall back to balanceOf at block-1 only if log parsing failed
      if (amount == null) {
        lastProvider = "chain_rpc";
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
      // Skip Tron amount backfill for non-event-native amounts. Current-balance based
      // reconstruction is not event-time accurate.
      continue;
    } else if (config.chain.evmChainId != null) {
      lastProvider = "chain_rpc";
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
      stmts.push(
        db.prepare(
          `UPDATE blacklist_events
           SET amount = ?,
               amount_native = ?,
               amount_usd_at_event = ?,
               amount_source = ?,
               amount_status = ?,
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
          computeBlacklistAmountUsdAtEvent(config.stablecoin, amount),
          amountSource,
          amountStatus,
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

// --- Orchestrator ---

async function insertRows(db: D1Database, rows: BlacklistRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  const stmts = rows.map((row) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO blacklist_events
         (id, stablecoin, chain_id, chain_name, event_type, address, amount, amount_native, amount_usd_at_event, amount_source, amount_status, tx_hash, block_number, timestamp, methodology_version, contract_address, config_key, event_signature, event_topic0, amount_attempt_count, amount_last_attempted_at, amount_last_error_class, amount_last_provider, explorer_tx_url, explorer_address_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.stablecoin,
        row.chain_id,
        row.chain_name,
        row.event_type,
        row.address,
        row.amount_native,
        row.amount_native,
        row.amount_usd_at_event,
        row.amount_source,
        row.amount_status,
        row.tx_hash,
        row.block_number,
        row.timestamp,
        row.methodology_version,
        row.contract_address,
        row.config_key,
        row.event_signature,
        row.event_topic0,
        row.amount_attempt_count,
        row.amount_last_attempted_at,
        row.amount_last_error_class,
        row.amount_last_provider,
        row.explorer_tx_url,
        row.explorer_address_url,
      ),
  );
  return batchExecute(db, stmts);
}

export interface SyncBlacklistOptions {
  db: D1Database;
  etherscanApiKey: string | null;
  trongridApiKey: string | null;
  drpcApiKey: string | null;
  externalEtherscanRL?: RateLimitedFetch;
  signal?: AbortSignal;
  onProgress?: CronProgressReporter;
  chainRpcs?: Map<string, ChainRpcConfig>;
}

export async function syncBlacklist(opts: SyncBlacklistOptions): Promise<SyncBlacklistResult> {
  const { db, etherscanApiKey, trongridApiKey, drpcApiKey, externalEtherscanRL, signal, onProgress, chainRpcs } = opts;
  const etherscanLimiter = externalEtherscanRL ?? createRateLimiter(4);
  const tronLimiter = createRateLimiter(3);
  const budget = createBudget(900);
  const deadlineMs = Date.now() + SYNC_BLACKLIST_RUNTIME_BUDGET_MS;
  let totalFetchedEvents = 0;
  let totalInsertedRows = 0;
  let contractsSkipped = 0;
  let apiErrors = 0;
  let rpcLogConfigs = 0;
  let runtimeBudgetHit = false;
  const enrichCounters = { attempted: 0, succeeded: 0, failed: 0 };
  const currentBalanceCacheCounters = { updated: 0, deleted: 0, failed: 0 };
  const apiErrorClasses: Record<string, number> = {};
  const apiErrorConfigs: Array<{
    configKey: string;
    stablecoin: string;
    chainId: string;
    reason: string;
  }> = [];
  const chainTimestampCaches = new Map<string, Map<number, number>>();
  const getChainTimestampCache = (chainId: string): Map<number, number> => {
    let cache = chainTimestampCaches.get(chainId);
    if (!cache) {
      cache = new Map<number, number>();
      chainTimestampCaches.set(chainId, cache);
    }
    return cache;
  };

  const configStates = await Promise.all(
    CONTRACT_CONFIGS.map(async (config) => {
      const configKey = config.configKey;
      const lastBlock = await getLastBlock(db, configKey);
      return { config, configKey, lastBlock };
    }),
  );
  const zeroCursorConfigs = configStates.filter((state) => state.lastBlock === 0).map((state) => state.configKey);
  const recordApiErrorConfig = (configKey: string, stablecoin: string, chainId: string, reason: string): void => {
    if (apiErrorConfigs.length >= 10) return;
    apiErrorConfigs.push({ configKey, stablecoin, chainId, reason });
  };

  // Backfill NULL amounts first — this has priority over new event scanning
  // because the worker may time out before completing the full config loop.
  try {
    const backfill = await backfillAmounts(
      db,
      etherscanApiKey,
      drpcApiKey,
      etherscanLimiter,
      budget,
      deadlineMs,
      signal,
      chainRpcs,
    );
    runtimeBudgetHit ||= backfill.runtimeBudgetReached;
  } catch (err) {
    console.warn("[sync-blacklist] Backfill failed:", err);
  }
  console.log(`[sync-blacklist] Backfill done, budget: ${budget.count}/${budget.limit}`);
  await reportCronProgress(onProgress, {
    stage: "backfill-amounts",
    itemsDone: 0,
    itemsTotal: configStates.length,
    message: `Backfill pass complete; scanning ${configStates.length} blacklist config(s)`,
  }, budget);

  // Sort by lastBlock ascending so least-synced configs go first
  configStates.sort((a, b) => a.lastBlock - b.lastBlock);

  // Cache current block per EVM chain to avoid redundant API calls
  const chainHeadCache = new Map<number, number>();

  for (let ci = 0; ci < configStates.length; ci++) {
    throwIfAborted(signal);
    if (shouldStopBeforeNextConfig(deadlineMs)) {
      runtimeBudgetHit = true;
      contractsSkipped = configStates.length - ci;
      console.warn(`[sync-blacklist] Runtime budget reached, skipping ${contractsSkipped} remaining contracts`);
      break;
    }
    const { config, configKey, lastBlock } = configStates[ci];
    await reportCronProgress(onProgress, {
      stage: "scan-config",
      itemsDone: ci,
      itemsTotal: configStates.length,
      message: `Scanning ${config.stablecoin} on ${config.chain.chainName}`,
      metadata: {
        configKey,
        stablecoin: config.stablecoin,
        chainId: config.chain.chainId,
      },
    }, budget);
    if (budgetExhausted(budget)) {
      contractsSkipped = configStates.length - ci;
      console.log(
        `[sync-blacklist] Budget exhausted (${budget.count}/${budget.limit}), skipping ${contractsSkipped} remaining contracts`,
      );
      break;
    }

    // Circuit breaker checks for provider-specific sources
    if (config.chain.type === "tron" && !(await shouldAttemptFetch(db, CIRCUIT_SOURCE.TRONGRID))) {
      console.log(`[sync-blacklist] TronGrid circuit open, skipping ${configKey}`);
      contractsSkipped++;
      continue;
    }

    try {
      let result: {
        rows: BlacklistRow[];
        maxBlock: number;
        apiError?: boolean;
        chainHead?: number | null;
        usedRpcLogs?: boolean;
        scannedToBlock?: number | null;
        incomplete?: boolean;
      };

      if (config.chain.type === "tron") {
        result = await fetchTronEventsIncremental(
          config,
          trongridApiKey,
          lastBlock,
          deadlineMs,
          tronLimiter,
          budget,
          signal,
        );
        await recordOutcomeSafe(db, CIRCUIT_SOURCE.TRONGRID, !result.apiError);

        const tronEnrichCounters = await enrichRowBalances(
          result.rows,
          config,
          etherscanApiKey,
          drpcApiKey,
          etherscanLimiter,
          budget,
          deadlineMs,
          signal,
          chainRpcs,
        );
        enrichCounters.attempted += tronEnrichCounters.attempted;
        enrichCounters.succeeded += tronEnrichCounters.succeeded;
        enrichCounters.failed += tronEnrichCounters.failed;
        console.log(
          `[sync-blacklist] enrichRowBalances (tron): attempted=${tronEnrichCounters.attempted} succeeded=${tronEnrichCounters.succeeded} failed=${tronEnrichCounters.failed}`,
        );
        totalInsertedRows += await insertRows(db, result.rows);
        const tronCurrentBalanceCache = await syncCurrentBalanceCacheForRows(
          db,
          config,
          result.rows,
          {
            etherscanApiKey,
            drpcApiKey,
            trongridApiKey,
            etherscanLimiter,
            tronLimiter,
            budget,
            deadlineMs,
            signal,
            chainRpcs,
          },
        );
        currentBalanceCacheCounters.updated += tronCurrentBalanceCache.updated;
        currentBalanceCacheCounters.deleted += tronCurrentBalanceCache.deleted;
        currentBalanceCacheCounters.failed += tronCurrentBalanceCache.failed;

        if (result.incomplete) {
          runtimeBudgetHit = true;
          console.warn(
            `[sync-blacklist] Runtime budget reached while scanning ${config.stablecoin} on ${config.chain.chainName}, keeping sync at ts ${lastBlock}`,
          );
        } else {
          // When no events found, advance toward current time but leave a safety margin
          // to avoid permanently skipping events the explorer hasn't indexed yet.
          const newBlock = result.rows.length > 0 ? result.maxBlock : Math.max(Date.now() - TRON_SAFETY_MS, lastBlock);
          if (newBlock > lastBlock) {
            await setLastBlock(db, configKey, newBlock);
          }
        }
      } else {
        const evmChainId = config.chain.evmChainId!;
        // If lastBlock hit the sentinel (99999999), reset to 0 to re-scan.
        const wasReset = lastBlock >= EVM_SCANNED_TO_LATEST;
        const configuredStartBlock =
          typeof config.startBlock === "number" && Number.isFinite(config.startBlock) && config.startBlock > 0
            ? Math.floor(config.startBlock)
            : 0;
        const fromBlock = wasReset
          ? configuredStartBlock
          : lastBlock > 0
            ? lastBlock + 1
            : configuredStartBlock;
        result = await fetchEvmEventsIncremental(
          db,
          config,
          etherscanApiKey,
          fromBlock,
          getChainTimestampCache(config.chain.chainId),
          deadlineMs,
          etherscanLimiter,
          budget,
          signal,
          chainRpcs,
        );
        if (result.usedRpcLogs) {
          rpcLogConfigs++;
        }

        const evmEnrichCounters = await enrichRowBalances(
          result.rows,
          config,
          etherscanApiKey,
          drpcApiKey,
          etherscanLimiter,
          budget,
          deadlineMs,
          signal,
          chainRpcs,
        );
        enrichCounters.attempted += evmEnrichCounters.attempted;
        enrichCounters.succeeded += evmEnrichCounters.succeeded;
        enrichCounters.failed += evmEnrichCounters.failed;
        console.log(
          `[sync-blacklist] enrichRowBalances (evm): attempted=${evmEnrichCounters.attempted} succeeded=${evmEnrichCounters.succeeded} failed=${evmEnrichCounters.failed}`,
        );
        totalInsertedRows += await insertRows(db, result.rows);
        const evmCurrentBalanceCache = await syncCurrentBalanceCacheForRows(
          db,
          config,
          result.rows,
          {
            etherscanApiKey,
            drpcApiKey,
            trongridApiKey,
            etherscanLimiter,
            tronLimiter,
            budget,
            deadlineMs,
            signal,
            chainRpcs,
          },
        );
        currentBalanceCacheCounters.updated += evmCurrentBalanceCache.updated;
        currentBalanceCacheCounters.deleted += evmCurrentBalanceCache.deleted;
        currentBalanceCacheCounters.failed += evmCurrentBalanceCache.failed;

        let newBlock: number;
        if (result.incomplete) {
          runtimeBudgetHit = true;
          newBlock = lastBlock;
          console.warn(
            `[sync-blacklist] Runtime budget reached while scanning ${config.stablecoin} on ${config.chain.chainName}, keeping sync at block ${lastBlock}`,
          );
        } else if (result.apiError) {
          const partialAdvance = result.scannedToBlock;
          apiErrors++;
          recordApiErrorConfig(
            configKey,
            config.stablecoin,
            config.chain.chainId,
            partialAdvance != null && partialAdvance > lastBlock ? "partial-coverage" : "no-coverage",
          );
          if (partialAdvance != null && partialAdvance > lastBlock) {
            newBlock = partialAdvance;
            console.warn(
              `[sync-blacklist] Partial coverage scanning ${config.stablecoin} on ${config.chain.chainName}, advancing sync from ${lastBlock} to ${newBlock}`,
            );
          } else {
            console.warn(
              `[sync-blacklist] API error scanning ${config.stablecoin} on ${config.chain.chainName}, keeping sync at block ${lastBlock}`,
            );
            newBlock = lastBlock;
          }
        } else if (result.rows.length > 0) {
          newBlock = result.maxBlock;
        } else {
          // Genuine no events — advance sync state toward chain head, but leave a safety
          // margin to avoid permanently skipping events that the explorer hasn't indexed yet.
          if (!chainHeadCache.has(evmChainId)) {
            const head =
              result.chainHead ??
              (await getEvmBlockNumber(evmChainId, etherscanApiKey, etherscanLimiter, budget, signal));
            if (head) chainHeadCache.set(evmChainId, head);
          }
          const head = chainHeadCache.get(evmChainId);
          const margin = evmSafetyMarginBlocks(evmChainId);
          if (
            result.usedRpcLogs &&
            result.scannedToBlock != null &&
            head != null &&
            result.scannedToBlock < head
          ) {
            newBlock = Math.max(result.scannedToBlock, lastBlock);
          } else {
            // Fall back: if sentinel was reset, use the configured start block rather than staying stuck at sentinel.
            newBlock = head
              ? Math.max(head - margin, lastBlock)
              : wasReset
                ? configuredStartBlock
                : lastBlock;
          }
        }

        if (newBlock !== lastBlock) {
          await setLastBlock(db, configKey, newBlock);
        }
      }

      totalFetchedEvents += result.rows.length;
      const syncLabel = config.chain.type === "tron" ? "ts" : "block";
      console.log(
        `[sync-blacklist] ${config.stablecoin} on ${config.chain.chainName}: ${result.rows.length} new events, ${syncLabel} ${result.maxBlock}`,
      );
    } catch (err) {
      apiErrors++;
      const errorClass = err instanceof Error ? err.name : "UnknownError";
      apiErrorClasses[errorClass] = (apiErrorClasses[errorClass] ?? 0) + 1;
      recordApiErrorConfig(configKey, config.stablecoin, config.chain.chainId, `exception:${errorClass}`);
      console.warn(`[sync-blacklist] Failed ${config.stablecoin} on ${config.chain.chainName}:`, err);
    }
  }

  console.log(`[sync-blacklist] Completed with ${budget.count}/${budget.limit} subrequests`);
  await reportCronProgress(onProgress, {
    stage: "complete",
    itemsDone: configStates.length,
    itemsTotal: configStates.length,
    message: "Completed blacklist sync",
    metadata: {
      rowsWritten: totalInsertedRows,
      eventsFetched: totalFetchedEvents,
      contractsSkipped,
      apiErrors,
    },
  }, budget);
  // Tolerate up to 25% of configs failing (transient upstream timeouts) before
  // marking the run degraded.  More than 50% is a full error.
  const degradedThreshold = Math.max(1, Math.ceil(CONTRACT_CONFIGS.length * 0.25));
  const errorThreshold = Math.ceil(CONTRACT_CONFIGS.length / 2);
  const status: SyncBlacklistResult["status"] =
    apiErrors > errorThreshold
      ? "error"
      : apiErrors > degradedThreshold
        ? "degraded"
        : runtimeBudgetHit
          ? "degraded"
          : "ok";
  return {
    status,
    itemCount: totalInsertedRows,
    metadata: JSON.stringify(withBudgetMetadata(budget, {
      rowsWritten: totalInsertedRows,
      eventsFetched: totalFetchedEvents,
      contractsSkipped,
      apiErrors,
      apiErrorConfigs,
      zeroCursorConfigCount: zeroCursorConfigs.length,
      zeroCursorConfigs: zeroCursorConfigs.slice(0, 10),
      rpcLogConfigs,
      apiErrorClasses,
      runtimeBudgetReached: runtimeBudgetHit,
      runtimeBudgetMs: SYNC_BLACKLIST_RUNTIME_BUDGET_MS,
      enrichAttempted: enrichCounters.attempted,
      enrichSucceeded: enrichCounters.succeeded,
      enrichFailed: enrichCounters.failed,
      currentBalanceCacheUpdated: currentBalanceCacheCounters.updated,
      currentBalanceCacheDeleted: currentBalanceCacheCounters.deleted,
      currentBalanceCacheFailed: currentBalanceCacheCounters.failed,
    })),
  };
}
