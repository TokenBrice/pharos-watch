import { logWorkerEventArgs } from "../structured-log";
import { computeBlacklistAmountUsdAtEvent } from "@shared/lib/blacklist";
import type { BlacklistAmountStatus } from "@shared/types/market";
import { rethrowIfAborted, throwIfAborted } from "../abort";
import {
  getBlacklistConfigByContract,
  getBlacklistConfigByKey,
  getBlacklistConfigsForSymbolAndChain,
  getBlacklistEventByTopic,
  type ContractEventConfig,
} from "../blacklist-contracts";
import { executeAtomicBatch } from "../db";
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
import { toErrorMessage } from "@shared/lib/error-utils";
import { fetchJsonWithRetry } from "../fetch-retry";
import type { BlacklistRow } from "./shared";
import { blacklistRuntimeBudgetReached, blacklistSubrequestBudgetReached, type BlacklistRunBudget } from "./run-budget";
import { buildBlacklistAmountRepairQueueUpdate, refreshBlacklistAmountRepairQueue } from "./amount-repair-queue";
import {
  buildBlacklistAmountAttemptUpdate, buildRecoveredBlacklistAmountPersistence,
  type BlacklistAmountSelectedState,
} from "./amount-persistence";

// Conservative scheduled recovery cap: one D1 batch chunk and well below the
// sync-blacklist 900-subrequest run budget observed in production.
const BACKFILL_BATCH_SIZE = 100;
const MAX_DERIVED_RECOVERY_ATTEMPTS = 3;

export type BlacklistRecoveryErrorClass =
  | "provider_null"
  | "provider_timeout"
  | "provider_http_error"
  | "provider_unsupported"
  | "config_missing"
  | "ambiguous_config"
  | "ambiguous"
  | "evidence_mismatch"
  | "event_time_unproven"
  | "history_over_cap"
  | "state_raced"
  | "runtime_budget"
  | "budget_exhausted";

export type BlacklistRecoveryProvider =
  "etherscan" | "drpc" | "chain_rpc" | "event_receipt" | "trongrid" | "none";


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

function recoveryAmountStatus(
  amount: number | null, eventType: string, errorClass: BlacklistRecoveryErrorClass | null,
): RecoverBlacklistAmountForRowResult["amountStatus"] {
  if (amount != null) return "resolved";
  return eventType !== "destroy" && errorClass === "event_time_unproven"
    ? "permanently_unavailable" : "provider_failed";
}

export async function enrichRowBalances(opts: {
  rows: BlacklistRow[];
  config: ContractEventConfig;
  etherscanApiKey: string | null;
  etherscanLimiter: RateLimitedFetch;
  runBudget: BlacklistRunBudget;
  signal?: AbortSignal;
}): Promise<{ attempted: number; succeeded: number; failed: number }> {
  const { rows, config, etherscanApiKey, etherscanLimiter, runBudget, signal } =
    opts;
  const counters = { attempted: 0, succeeded: 0, failed: 0 };
  for (const row of rows) {
    throwIfAborted(signal);
    if (blacklistRuntimeBudgetReached(runBudget)) break;
    if (blacklistSubrequestBudgetReached(runBudget)) break;
    if (row.amount_native != null) {
      // No historically attributed non-USD quote is available in this lane.
      row.amount_usd_at_event ??= computeBlacklistAmountUsdAtEvent(config.stablecoin, row.amount_native);
      continue;
    }
    if (row.amount_status === "permanently_unavailable") continue;
    if (row.event_type !== "blacklist" && row.event_type !== "unblacklist" && row.event_type !== "destroy") continue;
    if (config.chain.type === "tron") {
      // Tron blacklist/unblacklist events do not contain event-time balances.
      // Keep them unresolved rather than substituting a current balance.
      continue;
    } else if (config.chain.evmChainId != null) {
      counters.attempted++;
      try {
        const { amount, amountSource, lastErrorClass, lastProvider } = await recoverEvmEventAmount({
          row,
          config,
          etherscanApiKey,
          etherscanLimiter,
          runBudget,
          signal,
          onProviderAttempt: (provider) => markRecoveryAttempt(row, provider, null),
        });

        row.amount_native = amount;
        row.amount_usd_at_event = computeBlacklistAmountUsdAtEvent(config.stablecoin, amount);
        row.amount_source = amountSource;
        row.amount_status = recoveryAmountStatus(amount, row.event_type, lastErrorClass);
        row.amount_last_error_class = lastErrorClass;
        row.amount_last_provider = lastProvider;
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
  let recovered: number | null = null;
  let matches = 0;

  for (const log of logs) {
    if (log.address.toLowerCase() !== config.contractAddress.toLowerCase()) continue;
    const matchingEvent = getBlacklistEventByTopic(config, log.topics[0]);
    if (matchingEvent?.eventType !== "destroy") continue;

    const { address, addressFromTopic } = resolveDestroyLogAddress(matchingEvent, log);
    if (address !== normalizedAffectedAddress) continue;

    // A receipt can contain several wipes of the same account. Without an
    // exact target log identity, neither another wipe nor a burn-shaped Transfer
    // proves this event's quantity.
    matches++;
    if (matches > 1 || !matchingEvent.hasAmount) return null;
    recovered = resolveDestroyLogAmount(matchingEvent, log, config.decimals, addressFromTopic);
  }

  return recovered;
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


export interface RecoverBlacklistAmountForRowOptions {
  etherscanApiKey: string | null;
  etherscanLimiter: RateLimitedFetch;
  runBudget: BlacklistRunBudget;
  signal?: AbortSignal;
}

export interface RecoverBlacklistAmountForRowResult {
  amount: number | null;
  amountUsd: number | null;
  amountSource: "event" | "unavailable";
  amountStatus: "resolved" | "provider_failed" | "permanently_unavailable";
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


type EvmAmountRecoveryResult = {
  amount: number | null;
  amountSource: "event" | "unavailable";
  lastErrorClass: BlacklistRecoveryErrorClass | null;
  lastProvider: BlacklistRecoveryProvider;
};

async function recoverEvmEventAmount(opts: {
  row: RecoverableAmountRow;
  config: ContractEventConfig;
  etherscanApiKey: string | null;
  etherscanLimiter: RateLimitedFetch;
  runBudget: BlacklistRunBudget;
  signal?: AbortSignal;
  onProviderAttempt?: (provider: BlacklistRecoveryProvider) => void;
}): Promise<EvmAmountRecoveryResult> {
  const {
    row,
    config,
    etherscanApiKey,
    etherscanLimiter,
    runBudget,
    signal,
    onProviderAttempt,
  } = opts;
  throwIfAborted(signal);
  let amount: number | null = null;
  let lastProvider: BlacklistRecoveryProvider = "none";

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

  // balanceOf(block - 1) is end-of-previous-block state, not the balance at
  // this log position. Incoming/outgoing transfers or an earlier wipe in the
  // same block can change it, including turning an apparent zero into a funded
  // EURC freeze. Until ordered balance effects are proved, keep it unavailable.
  if (row.event_type !== "destroy") onProviderAttempt?.("none");
  return {
    amount: null,
    amountSource: "unavailable",
    lastErrorClass: "event_time_unproven",
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

  const { amount, amountSource, lastErrorClass, lastProvider } = await recoverEvmEventAmount({
    row,
    config,
    etherscanApiKey: options.etherscanApiKey,
    etherscanLimiter: options.etherscanLimiter,
    runBudget: options.runBudget,
    signal: options.signal,
  });

  return {
    amount,
    amountUsd: computeBlacklistAmountUsdAtEvent(config.stablecoin, amount),
    amountSource,
    amountStatus: recoveryAmountStatus(amount, row.event_type, lastErrorClass),
    lastErrorClass,
    lastProvider,
  };
}

export async function backfillAmounts(
  db: D1Database,
  etherscanApiKey: string | null,
  etherscanLimiter: RateLimitedFetch,
  runBudget: BlacklistRunBudget,
  signal?: AbortSignal,
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
    row: BlacklistAmountSelectedState & { id: string },
    attemptAtSec: number,
    errorClass: BlacklistRecoveryErrorClass | null,
    provider: BlacklistRecoveryProvider,
    status?: BlacklistAmountStatus,
  ): D1PreparedStatement =>
    buildBlacklistAmountAttemptUpdate(db, {
      eventId: row.id,
      attemptedAt: attemptAtSec,
      errorClass,
      lastProvider: provider,
      amountStatus: status,
    }, { selectedState: row });

  const result = await db
    .prepare(
      `/* blacklist-amount-recovery-evm-candidates */
       SELECT events.id, events.chain_id, events.event_type, events.address, events.block_number,
              events.stablecoin, events.tx_hash, events.config_key, events.contract_address,
              events.amount_attempt_count, events.amount_last_attempted_at,
              events.amount_last_error_class, events.amount_last_provider, events.amount_source,
              events.amount_native, events.amount_usd_at_event, events.amount_status,
              events.provenance_source, events.provenance_observed_at,
              COALESCE(queue.attempt_count, 0) AS queue_attempt_count
       FROM blacklist_events AS events
       LEFT JOIN blacklist_amount_repair_queue AS queue ON queue.event_id = events.id
       WHERE events.event_type IN ('blacklist', 'unblacklist', 'destroy')
         AND chain_id != 'tron'
         AND events.suppression_reason IS NULL
         AND (
               events.amount_status IN ('recoverable_pending', 'provider_failed', 'ambiguous')
               OR (
                 events.amount_source = 'derived'
                 AND events.amount_native = 0
                 AND events.amount_status = 'resolved'
                 AND (
                   COALESCE(events.amount_attempt_count, 0) < ?
                   OR events.amount_last_error_class IN ('runtime_budget', 'budget_exhausted')
                 )
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
      amount_native: number | null;
      amount_usd_at_event: number | null;
      amount_status: string;
      provenance_source: string | null;
      provenance_observed_at: number | null;
      queue_attempt_count: number;
    }>();

  if (!result.results?.length) {
    return { runtimeBudgetReached: false, attempted: 0, resolved: 0, retried: 0, unrecoverable: 0 };
  }

  const stmts: D1PreparedStatement[] = [];
  const outcomes: Array<"resolved" | "retry" | "unrecoverable"> = [];
  let processedRepairRows = 0;
  let resolvedRepairRows = 0;
  let retriedRepairRows = 0;
  let unrecoverableRepairRows = 0;
  let runtimeBudgetHit = false;

  for (const row of result.results) {
    throwIfAborted(signal);
    if (blacklistRuntimeBudgetReached(runBudget)) {
      runtimeBudgetHit = true;
      break;
    }
    if (blacklistSubrequestBudgetReached(runBudget)) break;

    const attemptAt = Math.floor(Date.now() / 1000);
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
        wasLegacyDerived &&
        row.amount_last_error_class !== "runtime_budget" &&
        row.amount_last_error_class !== "budget_exhausted" &&
        (row.amount_attempt_count ?? 0) + 1 >= MAX_DERIVED_RECOVERY_ATTEMPTS;
      stmts.push(
        buildAttemptUpdate(
          row,
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
          requireChangedEvent: true,
        }),
      );
      outcomes.push(derivedRetryExhausted ? "unrecoverable" : "retry");
      continue;
    }


    let amount: number | null = null;
    let amountSource: "event" | "unavailable" = "unavailable";
    let amountStatus: BlacklistAmountStatus = "provider_failed";
    let lastErrorClass: BlacklistRecoveryErrorClass | null = "provider_null";
    let lastProvider: BlacklistRecoveryProvider = "none";

    // Tron rows remain unresolved because no historical balance provider is available.
    if (config.chain.evmChainId != null) {
      const recovered = await recoverEvmEventAmount({
        row,
        config,
        etherscanApiKey,
        etherscanLimiter,
        runBudget,
        signal,
      });
      amount = recovered.amount;
      amountSource = recovered.amountSource;
      lastErrorClass = recovered.lastErrorClass;
      lastProvider = recovered.lastProvider;
    }

    amountStatus = recoveryAmountStatus(amount, row.event_type, lastErrorClass);
    if (amount != null) {
      const persistence = buildRecoveredBlacklistAmountPersistence(db, {
        eventId: row.id,
        eventType: row.event_type,
        config,
        amount,
        amountUsd: computeBlacklistAmountUsdAtEvent(config.stablecoin, amount),
        amountSource,
        amountStatus: "resolved",
        attemptedAt: attemptAt,
        lastErrorClass,
        lastProvider,
      }, { selectedState: row });
      const { targetStatus } = persistence;
      stmts.push(persistence.statement);
      stmts.push(
        buildBlacklistAmountRepairQueueUpdate(db, {
          eventId: row.id,
          outcome: targetStatus === "permanently_unavailable" ? "unrecoverable" : "resolved",
          attemptedAt: attemptAt,
          priorAttempts: row.queue_attempt_count ?? 0,
          errorClass: lastErrorClass,
          requireChangedEvent: true,
        }),
      );
      outcomes.push(targetStatus === "permanently_unavailable" ? "unrecoverable" : "resolved");
    } else {
      const wasLegacyDerived = row.amount_source === "derived";
      const derivedRetryExhausted =
        wasLegacyDerived &&
        row.amount_last_error_class !== "runtime_budget" &&
        row.amount_last_error_class !== "budget_exhausted" &&
        (row.amount_attempt_count ?? 0) + 1 >= MAX_DERIVED_RECOVERY_ATTEMPTS;
      const unrecoverable = derivedRetryExhausted || amountStatus === "permanently_unavailable";
      if (wasLegacyDerived) {
        stmts.push(
          buildAttemptUpdate(
            row,
            attemptAt,
            lastErrorClass,
            lastProvider,
            unrecoverable ? "permanently_unavailable" : undefined,
          ),
        );
      } else {
        stmts.push(buildAttemptUpdate(row, attemptAt, lastErrorClass, lastProvider, amountStatus));
      }
      stmts.push(
        buildBlacklistAmountRepairQueueUpdate(db, {
          eventId: row.id,
          outcome: unrecoverable ? "unrecoverable" : "retry",
          attemptedAt: attemptAt,
          priorAttempts: row.queue_attempt_count ?? 0,
          errorClass: lastErrorClass,
          requireChangedEvent: true,
        }),
      );
      outcomes.push(unrecoverable ? "unrecoverable" : "retry");
    }
  }

  // Keep each event CAS and its changes()-guarded queue transition together.
  for (let offset = 0; offset < stmts.length; offset += BACKFILL_BATCH_SIZE) {
    const results = await executeAtomicBatch(db, stmts.slice(offset, offset + BACKFILL_BATCH_SIZE), {
      signal, returnResults: true,
    });
    for (let index = 0; index < results.length; index += 2) {
      if (Number(results[index]?.meta?.changes ?? 0) === 0) continue;
      processedRepairRows++;
      const outcome = outcomes[(offset + index) / 2];
      if (outcome === "resolved") resolvedRepairRows++;
      else if (outcome === "unrecoverable") unrecoverableRepairRows++;
      else retriedRepairRows++;
    }
  }
  if (stmts.length > 0) {
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

