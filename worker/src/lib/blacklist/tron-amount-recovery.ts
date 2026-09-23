import { logWorkerEventArgs } from "../structured-log";
import { computeBlacklistAmountUsdAtEvent } from "@shared/lib/blacklist";
import type { BlacklistStablecoin } from "@shared/types/market";
import { throwIfAborted } from "../abort";
import {
  getBlacklistConfigByContract,
  getBlacklistConfigByKey,
  getBlacklistConfigsForSymbolAndChain,
  getBlacklistEventByTopic,
  type ContractEventConfig,
} from "../blacklist-contracts";
import { tronBase58ToHex, tronHexAddressToBase58 } from "../tron-address";
import { batchExecute } from "../db";
import type { RateLimitedFetch } from "../evm-logs";
import { decimalNumberFromBigInt } from "../bigint";
import { fetchBlacklistAssetPriceFromCache } from "./row-preparation";
import { blacklistRuntimeBudgetReached, blacklistSubrequestBudgetReached, type BlacklistRunBudget } from "./run-budget";
import { buildBlacklistAmountRepairQueueUpdate } from "./amount-repair-queue";
import { buildBlacklistAmountAttemptUpdate, buildRecoveredBlacklistAmountPersistence } from "./amount-persistence";
import {
  fetchTronHeadBlock,
  fetchTronRawTokenBalance,
  fetchTronTransactionInfo,
  fetchTronTransferWindow,
  TronReplayProviderError,
  type TronReplayProviderContext,
  type TronTrc20Transfer,
} from "./tron-replay-provider";
import type { BlacklistRecoveryErrorClass } from "./amount-recovery";

/**
 * Tron freeze amounts are not in the event payload and TronGrid exposes no
 * historical state read, so the frozen balance is reconstructed from the
 * token's confirmed transfer ledger: the amount is the address's cumulative
 * signed TRC20 flow through the freeze millisecond.
 *
 * The ledger is only trusted when it reconciles exactly with a raw confirmed
 * `balanceOf` read (`Σ signed transfers === balance`). That equality is the
 * completeness proof: a single unindexed, duplicated, or dropped transfer moves
 * the sum away from the chain's own balance, and the row stays unresolved.
 */
const TRON_REPLAY_MAX_ROWS_PER_RUN = 24;
// A single USDT address can carry thousands of transfers; the cap bounds the
// worst case while still covering ordinary freeze addresses. Rows over the cap
// stay unresolved and escalate to the operator CLI.
const TRON_REPLAY_MAX_PAGES_PER_HISTORY = 40;
const TRON_REPLAY_MAX_PAGES_PER_RUN = 120;
// The freeze must be old enough that the explorer index has had a runway past
// its block; a fresher freeze is simply retried on the next run.
const TRON_REPLAY_MIN_FREEZE_AGE_MS = 15 * 60_000;
const MAX_SAFE_RAW_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);
export const TRON_REPLAY_PROVENANCE_SOURCE = "trongrid-transfer-replay";

export interface TronReplayRow {
  id: string;
  stablecoin: string;
  event_type: string;
  address: string;
  tx_hash: string;
  block_number: number;
  timestamp: number;
  config_key: string | null;
  contract_address: string | null;
  queue_attempt_count: number;
}

export interface TronReplayRecovery {
  amount: number | null;
  lastErrorClass: BlacklistRecoveryErrorClass | null;
  evidenceObservedAt: number;
  historyPages: number;
}

class TronReplayEvidenceError extends Error {
  constructor(
    readonly errorClass: Extract<
      BlacklistRecoveryErrorClass,
      "ambiguous" | "provider_unsupported" | "provider_null" | "evidence_mismatch"
    >,
    message: string,
  ) {
    super(message);
  }
}

type TronReceiptLogs = ReadonlyArray<{ address: string; topics: readonly string[] }>;

function resolveTronConfig(row: TronReplayRow): ContractEventConfig | undefined {
  if (row.config_key) return getBlacklistConfigByKey(row.config_key);
  if (row.contract_address) return getBlacklistConfigByContract("tron", row.contract_address);
  const matches = getBlacklistConfigsForSymbolAndChain(row.stablecoin as BlacklistStablecoin, "tron");
  return matches.length === 1 ? matches[0] : undefined;
}

function countMatchingFreezeLogs(
  config: ContractEventConfig,
  addressHex: string,
  tokenHex: string,
  logs: TronReceiptLogs,
): number {
  const addressTopic = `0x${addressHex.slice(2).padStart(64, "0")}`.toLowerCase();
  return logs.filter((log) => {
    if (log.address.toLowerCase() !== tokenHex) return false;
    const eventDef = getBlacklistEventByTopic(config, log.topics[0]);
    if (eventDef?.eventType !== "blacklist" || eventDef.hasAmount) return false;
    const addressIndex = eventDef.addressTopicIndex ?? 1;
    return log.topics[addressIndex]?.toLowerCase() === addressTopic;
  }).length;
}

export interface TronTransferLedgerSum {
  net: bigint;
  atBoundaryTransfers: number;
  unrelatedTransfers: number;
}

export function sumSignedTransfers(
  transfers: readonly TronTrc20Transfer[],
  accountBase58: string,
  upToTimestampMs: number,
): TronTransferLedgerSum {
  let net = BigInt(0);
  let atBoundaryTransfers = 0;
  let unrelatedTransfers = 0;
  for (const transfer of transfers) {
    if (transfer.to !== accountBase58 && transfer.from !== accountBase58) {
      unrelatedTransfers++;
      continue;
    }
    if (transfer.timestampMs > upToTimestampMs) continue;
    if (transfer.timestampMs === upToTimestampMs) {
      // A transfer in the freeze's own millisecond cannot be ordered against the
      // freeze event, so the frozen balance is not provable from this ledger.
      atBoundaryTransfers++;
    }
    net += (transfer.to === accountBase58 ? transfer.value : BigInt(0)) - (transfer.from === accountBase58 ? transfer.value : BigInt(0));
  }
  return { net, atBoundaryTransfers, unrelatedTransfers };
}

export async function recoverTronFreezeAmountForRow(
  row: TronReplayRow,
  config: ContractEventConfig,
  provider: TronReplayProviderContext,
): Promise<TronReplayRecovery> {
  const observedAt = Math.floor(Date.now() / 1000);
  let historyPages = 0;
  const failed = (errorClass: BlacklistRecoveryErrorClass): TronReplayRecovery => ({
    amount: null,
    lastErrorClass: errorClass,
    evidenceObservedAt: observedAt,
    historyPages,
  });

  if (config.chain.type !== "tron") return failed("provider_unsupported");
  const tokenHex = await tronBase58ToHex(config.contractAddress);
  const accountBase58 = await tronHexAddressToBase58(row.address);
  if (!tokenHex || !accountBase58) return failed("provider_unsupported");

  try {
    const receipt = await fetchTronTransactionInfo(provider, row.tx_hash);
    const freezeTimestampMs = row.timestamp * 1000;
    if (
      receipt.blockNumber !== row.block_number ||
      receipt.timestampMs !== freezeTimestampMs ||
      !receipt.succeeded
    ) {
      throw new TronReplayEvidenceError("evidence_mismatch", "freeze receipt does not match the stored event");
    }
    if (countMatchingFreezeLogs(config, row.address, tokenHex.toLowerCase(), receipt.logs) !== 1) {
      throw new TronReplayEvidenceError("evidence_mismatch", "freeze log is not uniquely proved by the receipt");
    }

    const anchor = await fetchTronHeadBlock(provider);
    if (anchor.timestampMs - freezeTimestampMs < TRON_REPLAY_MIN_FREEZE_AGE_MS) {
      throw new TronReplayEvidenceError("evidence_mismatch", "freeze is too recent for an indexed ledger");
    }

    const history = await fetchTronTransferWindow(
      provider,
      accountBase58,
      config.contractAddress,
      0,
      anchor.timestampMs,
      TRON_REPLAY_MAX_PAGES_PER_HISTORY,
    );
    historyPages = history.pages;
    if (!history.complete) {
      throw new TronReplayEvidenceError("evidence_mismatch", "confirmed transfer ledger is truncated");
    }
    const ledger = sumSignedTransfers(history.transfers, accountBase58, anchor.timestampMs);
    if (ledger.unrelatedTransfers > 0) {
      throw new TronReplayEvidenceError("evidence_mismatch", "ledger contains unrelated records");
    }

    // The raw confirmed balance is the completeness proof for the ledger: it can
    // only equal the cumulative signed flow when every transfer is present once.
    const balance = await fetchTronRawTokenBalance(provider, tokenHex, row.address);
    if (ledger.net !== balance) {
      throw new TronReplayEvidenceError("evidence_mismatch", "ledger does not reconcile with the confirmed balance");
    }

    const atFreeze = sumSignedTransfers(history.transfers, accountBase58, freezeTimestampMs);
    if (atFreeze.atBoundaryTransfers > 0) {
      throw new TronReplayEvidenceError("ambiguous", "transfers share the freeze millisecond");
    }
    const rawAmount = atFreeze.net;
    if (rawAmount <= BigInt(0) || rawAmount > MAX_SAFE_RAW_AMOUNT) {
      throw new TronReplayEvidenceError("evidence_mismatch", "derived frozen balance is not representable");
    }
    return {
      amount: decimalNumberFromBigInt(rawAmount, config.decimals),
      lastErrorClass: null,
      evidenceObservedAt: observedAt,
      historyPages,
    };
  } catch (error) {
    throwIfAborted(provider.signal);
    if (error instanceof TronReplayEvidenceError) return failed(error.errorClass);
    if (error instanceof TronReplayProviderError) return failed(error.errorClass);
    logWorkerEventArgs("lib", "warn", "[sync-blacklist] Tron freeze-amount replay failed:", error);
    return failed("provider_null");
  }
}

export interface TronAmountBackfillResult {
  runtimeBudgetReached: boolean;
  attempted: number;
  resolved: number;
  retried: number;
  limit: number;
}

export interface TronAmountBackfillOptions {
  trongridApiKey: string | null;
  limiter: RateLimitedFetch;
  runBudget: BlacklistRunBudget;
  signal?: AbortSignal;
  maxRows?: number;
}

export async function backfillTronBlacklistAmounts(
  db: D1Database,
  options: TronAmountBackfillOptions,
): Promise<TronAmountBackfillResult> {
  const limit = Math.max(1, Math.min(TRON_REPLAY_MAX_ROWS_PER_RUN, Math.floor(options.maxRows ?? TRON_REPLAY_MAX_ROWS_PER_RUN)));
  const { runBudget, signal } = options;
  const result: TronAmountBackfillResult = { runtimeBudgetReached: false, attempted: 0, resolved: 0, retried: 0, limit };
  if (blacklistRuntimeBudgetReached(runBudget) || blacklistSubrequestBudgetReached(runBudget)) {
    result.runtimeBudgetReached = true;
    return result;
  }

  const rows = await db
    .prepare(
      `/* blacklist-tron-replay-candidates */
       SELECT events.id, events.stablecoin, events.event_type, events.address, events.block_number,
              events.timestamp, events.tx_hash, events.config_key, events.contract_address,
              COALESCE(queue.attempt_count, 0) AS queue_attempt_count
       FROM blacklist_events AS events
       LEFT JOIN blacklist_amount_repair_queue AS queue ON queue.event_id = events.id
       WHERE events.chain_id = 'tron'
         AND events.event_type = 'blacklist'
         AND events.amount_native IS NULL
         AND events.amount_status IN ('recoverable_pending', 'provider_failed', 'ambiguous')
         AND events.suppression_reason IS NULL
         AND COALESCE(queue.status, 'pending') IN ('pending', 'retry')
         AND COALESCE(queue.available_at, 0) <= unixepoch()
       ORDER BY COALESCE(queue.priority, 100) ASC, events.timestamp DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<TronReplayRow>();

  const candidates = rows.results ?? [];
  if (candidates.length === 0) return result;

  const statements: D1PreparedStatement[] = [];
  const assetPriceUsdBySymbol: Partial<Record<BlacklistStablecoin, number | null>> = {};
  const provider: TronReplayProviderContext = {
    apiKey: options.trongridApiKey,
    limiter: options.limiter,
    budget: runBudget.subrequestBudget,
    shouldStop: () => blacklistRuntimeBudgetReached(runBudget),
    ...(signal ? { signal } : {}),
  };
  let pagesUsed = 0;

  for (const row of candidates) {
    throwIfAborted(signal);
    if (blacklistRuntimeBudgetReached(runBudget)) {
      result.runtimeBudgetReached = true;
      break;
    }
    if (blacklistSubrequestBudgetReached(runBudget)) break;
    if (pagesUsed >= TRON_REPLAY_MAX_PAGES_PER_RUN) break;

    const attemptAt = Math.floor(Date.now() / 1000);
    result.attempted++;
    const config = resolveTronConfig(row);
    if (!config) {
      const errorClass: BlacklistRecoveryErrorClass =
        row.contract_address == null && row.config_key == null ? "config_missing" : "ambiguous_config";
      statements.push(
        buildBlacklistAmountAttemptUpdate(db, {
          eventId: row.id,
          attemptedAt: attemptAt,
          errorClass,
          lastProvider: "none",
        }),
      );
      statements.push(
        buildBlacklistAmountRepairQueueUpdate(db, {
          eventId: row.id,
          outcome: "retry",
          attemptedAt: attemptAt,
          priorAttempts: row.queue_attempt_count,
          errorClass,
        }),
      );
      result.retried++;
      continue;
    }

    const recovery = await recoverTronFreezeAmountForRow(row, config, provider);
    pagesUsed += recovery.historyPages;
    if (recovery.amount == null) {
      const errorClass = recovery.lastErrorClass ?? "provider_null";
      statements.push(
        buildBlacklistAmountAttemptUpdate(db, {
          eventId: row.id,
          attemptedAt: attemptAt,
          errorClass,
          lastProvider: "trongrid",
          // Ambiguous evidence is a distinct, reviewable state, not a provider outage.
          amountStatus: errorClass === "ambiguous" ? "ambiguous" : "provider_failed",
        }),
      );
      statements.push(
        buildBlacklistAmountRepairQueueUpdate(db, {
          eventId: row.id,
          outcome: "retry",
          attemptedAt: attemptAt,
          priorAttempts: row.queue_attempt_count,
          errorClass,
        }),
      );
      result.retried++;
      continue;
    }

    const symbol = config.stablecoin as BlacklistStablecoin;
    let assetPriceUsd = assetPriceUsdBySymbol[symbol];
    if (assetPriceUsd === undefined) {
      assetPriceUsd = await fetchBlacklistAssetPriceFromCache(db, symbol);
      assetPriceUsdBySymbol[symbol] = assetPriceUsd ?? null;
    }
    const persistence = buildRecoveredBlacklistAmountPersistence(db, {
      eventId: row.id,
      eventType: row.event_type,
      config,
      amount: recovery.amount,
      amountUsd: computeBlacklistAmountUsdAtEvent(config.stablecoin, recovery.amount, assetPriceUsd),
      amountSource: "derived",
      amountStatus: "resolved",
      attemptedAt: attemptAt,
      lastErrorClass: null,
      lastProvider: "trongrid",
      provenanceSource: TRON_REPLAY_PROVENANCE_SOURCE,
      provenanceObservedAt: recovery.evidenceObservedAt,
    });
    statements.push(persistence.statement);
    statements.push(
      buildBlacklistAmountRepairQueueUpdate(db, {
        eventId: row.id,
        outcome: persistence.targetStatus === "permanently_unavailable" ? "unrecoverable" : "resolved",
        attemptedAt: attemptAt,
        priorAttempts: row.queue_attempt_count,
        errorClass: null,
      }),
    );
    result.resolved++;
  }

  if (statements.length > 0) {
    await batchExecute(db, statements, { signal });
    logWorkerEventArgs("lib", "info", `[sync-blacklist] Replayed ${result.resolved} Tron freeze amount(s)`);
  }
  return result;
}
