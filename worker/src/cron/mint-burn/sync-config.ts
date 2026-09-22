import type { MintBurnConservationRecord } from "@shared/types/status";
import { auditMintBurnConservation, getMintBurnConservationEligibility, persistMintBurnConservation, validateMintBurnParsedConservation, verifyPersistedMintBurnConservation } from "../../lib/mint-burn-conservation";
import { logWorkerEventArgs } from "../../lib/structured-log";
import type { AlchemyLogEntry, AlchemyTopicFilter } from "../../lib/alchemy-logs";
import { fetchAlchemyLogs, resolveBlockTimestamps } from "../../lib/alchemy-logs";
import { budgetExhausted, createBudget, decodeUint256AtSlotOrNull } from "../../lib/evm-logs";
import type { MintBurnTxContext } from "../../lib/mint-burn-bridge-classifier";
import { classifyBridgeBurnRows } from "../../lib/mint-burn-pipeline/classification";
import { parseMintBurnLogs } from "../../lib/mint-burn-pipeline/parse";
import { persistMintBurnRows } from "../../lib/mint-burn-pipeline/persistence";
import type {
  MintBurnAffectedHour,
  MintBurnPriceContext,
  MintBurnRow,
} from "../../lib/mint-burn-pipeline/types";
import type {
  MintBurnContractConfig,
  MintBurnEventDef,
  MintBurnTier,
} from "../../lib/mint-burn-contracts";

const DECODE_RETRY_LIMIT = 3;
const DECODE_QUARANTINE_REASON = "amount-decode-retry-exhausted" as const;

export interface MintBurnConfigSummary {
  key: string;
  symbol: string;
  chainId: string;
  tier: MintBurnTier;
  attempted: boolean;
  skippedReason: string | null;
  scanFrom: number | null;
  scanTo: number | null;
  advancedTo: number | null;
  maxBlockSeen: number;
  rowsRead: number;
  rowsParsed: number;
  rowsInserted: number;
  rowsIgnored: number;
  rowsDropped: number;
  rowsDroppedDecode: number;
  earliestDecodeFailureBlock: number | null;
  errors: number;
  rowsQuarantinedDecode?: number;
  decodeQuarantines?: Array<{
    blockNumber: number;
    transactionHash: string;
    logIndex: string;
    reason: typeof DECODE_QUARANTINE_REASON;
    attempts: number;
  }>;
  conservationFailure?: boolean;
  conservationStatus?: MintBurnConservationRecord["status"];
  conservationReason?: string;
  failedEventDefs: string[];
  eventCoverage: Array<{
    eventDef: string;
    status: "ok" | "partial" | "fetch-failed" | "budget";
    complete: boolean;
    scannedToBlock: number;
    rowsRead: number;
  }>;
  coverageFrontier: number | null;
  advanceReason:
    | "full-success-events"
    | "full-success-empty"
    | "partial-frontier"
    | "no-safe-frontier"
    | null;
  missingTimestampCount: number;
  earliestMissingTimestampBlock: number | null;
  txContextShortfalls: number;
  bridgeClassificationDeferredRows: number;
  requestBudgetLimit: number;
  requestBudgetUsed: number;
}

export interface SyncMintBurnConfigInput {
  db: D1Database;
  config: MintBurnContractConfig;
  key: string;
  tier: MintBurnTier;
  fromBlock: number;
  scanTo: number;
  chainHead: number;
  alchemyUrl: string;
  signal?: AbortSignal;
  configBudgetLimit: number;
  runTimestamp: number;
  priceContext: MintBurnPriceContext;
  chainTimestampCache: Map<number, number>;
  txContextCache: Map<string, MintBurnTxContext | null>;
  affectedHours: Map<string, MintBurnAffectedHour>;
  safetyMarginBlocks: number;
  deadlineMs?: number;
}

export interface SyncMintBurnConfigResult {
  summary: MintBurnConfigSummary;
  apiErrors: number;
  effectiveBurns: number;
  bridgeBurns: number;
  reviewBurns: number;
  atomicRoundtripsDetected: number;
  newLastBlock: number | null;
}

export function createMintBurnConfigSummary(
  config: MintBurnContractConfig,
  key: string,
  tier: MintBurnTier,
  options: {
    attempted?: boolean;
    scanFrom?: number | null;
    scanTo?: number | null;
    requestBudgetLimit?: number;
  } = {},
): MintBurnConfigSummary {
  return {
    key,
    symbol: config.symbol,
    chainId: config.chain.chainId,
    tier,
    attempted: options.attempted ?? false,
    skippedReason: null,
    scanFrom: options.scanFrom ?? null,
    scanTo: options.scanTo ?? null,
    advancedTo: null,
    maxBlockSeen: 0,
    rowsRead: 0,
    rowsParsed: 0,
    rowsInserted: 0,
    rowsIgnored: 0,
    rowsDropped: 0,
    rowsDroppedDecode: 0,
    earliestDecodeFailureBlock: null,
    rowsQuarantinedDecode: 0,
    decodeQuarantines: [],
    errors: 0,
    failedEventDefs: [],
    eventCoverage: [],
    coverageFrontier: null,
    advanceReason: null,
    missingTimestampCount: 0,
    earliestMissingTimestampBlock: null,
    txContextShortfalls: 0,
    bridgeClassificationDeferredRows: 0,
    requestBudgetLimit: options.requestBudgetLimit ?? 0,
    requestBudgetUsed: 0,
  };
}

function eventDefLabel(eventDef: MintBurnEventDef): string {
  return `${eventDef.signature}:${eventDef.direction}`;
}

function minOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((min, value) => Math.min(min, value), values[0]);
}

function timestampRequiredBlockForLog(
  config: MintBurnContractConfig,
  eventDef: MintBurnEventDef,
  log: AlchemyLogEntry,
): number | null {
  const slot = eventDef.amountEncoding === "nth-data-uint256" ? (eventDef.dataSlot ?? 0) : 0;
  const amount = decodeUint256AtSlotOrNull(log.data, slot, config.decimals);
  if (amount == null || amount <= 0 || amount < config.dustThreshold) return null;

  const blockNum = parseInt(log.blockNumber, 16);
  const logIndex = parseInt(log.logIndex, 16);
  if (!Number.isFinite(blockNum) || !Number.isFinite(logIndex)) return null;
  return blockNum;
}

async function shouldQuarantineDecodeFailure(
  db: D1Database,
  configKey: string,
  log: AlchemyLogEntry,
  runTimestamp: number,
): Promise<{ quarantined: boolean; attempts: number }> {
  const cacheKey = `mint-burn:decode-retry:${configKey}:${log.blockNumber}:${log.transactionHash}:${log.logIndex}`;
  try {
    const prior = await db.prepare("SELECT value FROM cache WHERE key = ?").bind(cacheKey).first<{ value: string }>();
    const parsed = prior ? JSON.parse(prior.value) as { attempts?: unknown } : null;
    const attempts = (typeof parsed?.attempts === "number" ? parsed.attempts : 0) + 1;
    const quarantined = attempts >= DECODE_RETRY_LIMIT;
    await db.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(cacheKey, JSON.stringify({
        attempts,
        quarantined,
        reason: quarantined ? DECODE_QUARANTINE_REASON : "amount-decode-retry",
      }), runTimestamp)
      .run();
    return { quarantined, attempts };
  } catch (error) {
    logWorkerEventArgs("handler", "warn", "[sync-mint-burn] decode retry state unavailable:", error);
    return { quarantined: false, attempts: 0 };
  }
}

export async function syncMintBurnConfig(input: SyncMintBurnConfigInput): Promise<SyncMintBurnConfigResult> {
  const {
    db,
    config,
    key,
    tier,
    fromBlock,
    scanTo,
    chainHead,
    alchemyUrl,
    signal,
    configBudgetLimit,
    runTimestamp,
    priceContext,
    chainTimestampCache,
    txContextCache,
    affectedHours,
    safetyMarginBlocks,
    deadlineMs,
  } = input;
  const configBudget = createBudget(configBudgetLimit);
  const summary = createMintBurnConfigSummary(config, key, tier, {
    attempted: true,
    scanFrom: fromBlock,
    scanTo,
    requestBudgetLimit: configBudget.limit,
  });

  let apiErrors = 0;
  let effectiveBurns = 0;
  let bridgeBurns = 0;
  let reviewBurns = 0;

  const allConfigLogs: Array<{ eventDef: MintBurnEventDef; logs: AlchemyLogEntry[] }> = [];
  for (const eventDef of config.events) {
    const label = eventDefLabel(eventDef);
    if (budgetExhausted(configBudget)) {
      summary.failedEventDefs.push(`${label}:budget`);
      summary.eventCoverage.push({
        eventDef: label,
        status: "budget",
        complete: false,
        scannedToBlock: fromBlock - 1,
        rowsRead: 0,
      });
      continue;
    }

    const topics: AlchemyTopicFilter[] = [{ index: 0, value: eventDef.topicHash }];
    if (eventDef.filterTopic) {
      topics.push({ index: eventDef.filterTopic.index, value: eventDef.filterTopic.value });
    }

    const fetched = await fetchAlchemyLogs(
      alchemyUrl,
      config.contractAddress,
      topics,
      fromBlock,
      scanTo,
      configBudget,
      signal,
      deadlineMs != null ? { deadlineMs } : undefined,
    );

    if (!fetched) {
      apiErrors++;
      summary.errors++;
      summary.failedEventDefs.push(`${label}:fetch-failed`);
      summary.eventCoverage.push({
        eventDef: label,
        status: "fetch-failed",
        complete: false,
        scannedToBlock: fromBlock - 1,
        rowsRead: 0,
      });
      continue;
    }

    summary.rowsRead += fetched.logs.length;
    summary.eventCoverage.push({
      eventDef: label,
      status: fetched.complete ? "ok" : "partial",
      complete: fetched.complete,
      scannedToBlock: fetched.scannedToBlock,
      rowsRead: fetched.logs.length,
    });

    if (!fetched.complete) {
      apiErrors++;
      summary.errors++;
      summary.failedEventDefs.push(`${label}:partial-coverage`);
    }

    if (fetched.logs.length > 0) {
      allConfigLogs.push({ eventDef, logs: fetched.logs });
    }
  }

  const timestampRequiredBlocks = [
    ...new Set(allConfigLogs.flatMap(({ eventDef, logs }) =>
      logs
        .map((log) => timestampRequiredBlockForLog(config, eventDef, log))
        .filter((block): block is number => block != null),
    )),
  ];
  const blockTimestamps = timestampRequiredBlocks.length > 0
    ? await resolveBlockTimestamps(alchemyUrl, timestampRequiredBlocks, configBudget, {
        signal,
        localCache: chainTimestampCache,
        deadlineMs,
        persistentCache: {
          db,
          chainId: config.chain.chainId,
        },
      })
    : new Map<number, number>();

  const missingTimestampBlocks = timestampRequiredBlocks
    .filter((blockNum) => !blockTimestamps.has(blockNum))
    .sort((a, b) => a - b);
  summary.missingTimestampCount = missingTimestampBlocks.length;
  summary.earliestMissingTimestampBlock = missingTimestampBlocks[0] ?? null;

  if (missingTimestampBlocks.length > 0) {
    apiErrors++;
    summary.errors++;
    summary.failedEventDefs.push(`timestamps:${missingTimestampBlocks.length}`);
    logWorkerEventArgs("handler", "warn",
      `[sync-mint-burn] ${config.symbol} on ${config.chain.chainName}: ` +
      `${missingTimestampBlocks.length}/${timestampRequiredBlocks.length} candidate blocks missing timestamps`,
    );
  }

  const allParsedRows: MintBurnRow[] = [];
  for (const { eventDef, logs } of allConfigLogs) {
    const parseableLogs: AlchemyLogEntry[] = [];
    for (const log of logs) {
      const slot = eventDef.amountEncoding === "nth-data-uint256" ? (eventDef.dataSlot ?? 0) : 0;
      if (decodeUint256AtSlotOrNull(log.data, slot, config.decimals) != null) {
        parseableLogs.push(log);
        continue;
      }

      const retry = await shouldQuarantineDecodeFailure(db, key, log, runTimestamp);
      if (!retry.quarantined) {
        parseableLogs.push(log);
        continue;
      }

      const blockNumber = parseInt(log.blockNumber, 16);
      summary.rowsDroppedDecode++;
      summary.rowsQuarantinedDecode = (summary.rowsQuarantinedDecode ?? 0) + 1;
      summary.decodeQuarantines?.push({
        blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        reason: DECODE_QUARANTINE_REASON,
        attempts: retry.attempts,
      });
      logWorkerEventArgs("handler", "warn",
        `[sync-mint-burn] ${config.symbol} on ${config.chain.chainName}: quarantined undecodable log ` +
        `${log.transactionHash}:${log.logIndex} after ${retry.attempts} attempts (${DECODE_QUARANTINE_REASON})`,
      );
    }
    if (parseableLogs.length !== logs.length) {
      logs.splice(0, logs.length, ...parseableLogs);
    }

    const parsed = parseMintBurnLogs(
      config,
      eventDef,
      parseableLogs,
      blockTimestamps,
      priceContext.prices,
      priceContext.priceHistory,
      runTimestamp,
    );

    summary.rowsDropped += parsed.dropped;
    summary.rowsDroppedDecode += parsed.droppedDecode;
    if (parsed.earliestDecodeFailureBlock != null) {
      summary.earliestDecodeFailureBlock = summary.earliestDecodeFailureBlock == null
        ? parsed.earliestDecodeFailureBlock
        : Math.min(summary.earliestDecodeFailureBlock, parsed.earliestDecodeFailureBlock);
    }
    if (parsed.droppedDecode > 0) {
      logWorkerEventArgs("handler", "warn",
        `[sync-mint-burn] ${config.symbol} on ${config.chain.chainName}: ` +
        `dropped ${parsed.droppedDecode} ${eventDefLabel(eventDef)} log(s) with truncated amount data`,
      );
      apiErrors++;
      summary.errors++;
      summary.failedEventDefs.push(`${eventDefLabel(eventDef)}:amount-decode`);
    }
    summary.rowsParsed += parsed.rows.length;

    allParsedRows.push(...parsed.rows);
  }

  const burnCounts = await classifyBridgeBurnRows(
    allParsedRows,
    config,
    alchemyUrl,
    configBudget,
    txContextCache,
    signal,
    { deadlineMs },
  );
  summary.txContextShortfalls = burnCounts.txContextShortfalls;
  const deferredTxHashSet = new Set(burnCounts.deferredTxHashes);
  const deferredRows = deferredTxHashSet.size > 0
    ? allParsedRows.filter((row) => deferredTxHashSet.has(row.tx_hash))
    : [];
  if (burnCounts.txContextShortfalls > 0) {
    apiErrors++;
    summary.errors++;
    summary.failedEventDefs.push(`tx-context:${burnCounts.txContextShortfalls}`);
    summary.bridgeClassificationDeferredRows = deferredRows.length;
  }
  effectiveBurns += burnCounts.effectiveBurns;
  bridgeBurns += burnCounts.bridgeBurns;
  reviewBurns += burnCounts.reviewBurns;

  const persistableRows = deferredTxHashSet.size > 0
    ? allParsedRows.filter((row) => !deferredTxHashSet.has(row.tx_hash))
    : allParsedRows;

  for (const row of persistableRows) {
    if (row.block_number >= fromBlock && row.block_number <= scanTo) {
      summary.maxBlockSeen = Math.max(summary.maxBlockSeen, row.block_number);
    }
  }
  const fullEventCoverage =
    summary.eventCoverage.length === config.events.length &&
    summary.eventCoverage.every((coverage) => coverage.complete && coverage.scannedToBlock >= scanTo) &&
    summary.rowsDroppedDecode === (summary.rowsQuarantinedDecode ?? 0);
  let conservationFence = false;
  let parserFailure = false;
  let conservationAudit: MintBurnConservationRecord | null = null;
  if (getMintBurnConservationEligibility(config).supported) {
    const audit = await auditMintBurnConservation({
      config, logs: allConfigLogs, fromBlock, toBlock: scanTo, checkedAt: Math.floor(Date.now() / 1000),
      complete: fullEventCoverage, rpcUrl: alchemyUrl, budget: configBudget, signal, deadlineMs,
    });
    conservationFence = audit.status === "mismatch" || [
      "invalid-rpc-quantity", "unsafe-rpc-quantity", "invalid-raw-log", "inconsistent-log-block-hash",
      "conflicting-duplicate-log", "ambiguous-zero-transfer", "closing-log-hash-mismatch", "boundary-reorg",
    ].includes(audit.reason ?? "");
    if (fullEventCoverage && summary.missingTimestampCount === 0) {
      try {
        validateMintBurnParsedConservation(config, allConfigLogs, fromBlock, scanTo, allParsedRows);
      } catch {
        parserFailure = true;
        conservationFence = true;
        if (audit.status !== "mismatch") audit.status = "unavailable";
        audit.reason = "parsed-raw-event-correspondence-failed";
      }
    }
    if (audit.status === "ok" && (summary.missingTimestampCount > 0 || summary.txContextShortfalls > 0)) {
      audit.status = "unavailable";
      audit.reason = "incomplete-event-persistence-context";
    }
    conservationAudit = audit;
    // Publish a verified discrepancy even if the subsequent row write fails.
    if (audit.status === "mismatch") await persistMintBurnConservation(db, audit, signal);
    summary.conservationStatus = audit.status;
    summary.conservationReason = audit.reason;
    if (conservationFence) {
      summary.errors++;
      summary.failedEventDefs.push(`conservation:${audit.reason ?? audit.status}`);
    }
  }
  let persistResult;
  try {
    persistResult = await persistMintBurnRows(db, parserFailure ? [] : persistableRows, affectedHours, { signal });
  } catch (error) {
    if (conservationAudit && conservationAudit.status !== "mismatch") {
      await persistMintBurnConservation(db, { ...conservationAudit, status: "unavailable", reason: "event-row-write-failed" }, signal);
    }
    throw error;
  }
  if (conservationAudit?.status === "ok") {
    let correspondence;
    try {
      correspondence = await verifyPersistedMintBurnConservation(db, persistableRows, signal, deadlineMs);
    } catch (error) {
      await persistMintBurnConservation(db, { ...conservationAudit, status: "unavailable", reason: "persisted-event-readback-failed" }, signal);
      throw error;
    }
    if (correspondence !== "ok") {
      conservationAudit.status = "unavailable";
      conservationAudit.reason = correspondence === "mismatch"
        ? "persisted-event-correspondence-failed" : "persisted-event-readback-deadline";
      conservationFence ||= correspondence === "mismatch";
      summary.conservationStatus = conservationAudit.status;
      summary.conservationReason = conservationAudit.reason;
      if (conservationFence) {
        summary.errors++;
        summary.failedEventDefs.push(`conservation:${conservationAudit.reason}`);
      }
    }
  }
  if (conservationAudit && conservationAudit.status !== "mismatch") {
    await persistMintBurnConservation(db, conservationAudit, signal);
  }
  summary.rowsInserted += persistResult.inserted;
  summary.rowsIgnored += persistResult.ignored;

  const eventCoverageFrontier = minOrNull(
    summary.eventCoverage.map((coverage) => coverage.scannedToBlock),
  );
  const timestampCoverageFrontier = summary.earliestMissingTimestampBlock != null
    ? summary.earliestMissingTimestampBlock - 1
    : null;
  const txContextCoverageFrontier = deferredRows.length > 0
    ? Math.min(...deferredRows.map((row) => row.block_number)) - 1
    : null;
  const decodeCoverageFrontier = summary.earliestDecodeFailureBlock != null
    ? summary.earliestDecodeFailureBlock - 1
    : null;
  const partialCoverageFrontier = minOrNull(
    [eventCoverageFrontier, timestampCoverageFrontier, txContextCoverageFrontier, decodeCoverageFrontier]
      .filter((value): value is number => value != null),
  );
  summary.coverageFrontier = partialCoverageFrontier;

  let newLastBlock: number | null = null;
  if (
    fullEventCoverage &&
    summary.missingTimestampCount === 0 &&
    summary.txContextShortfalls === 0
  ) {
    if (summary.maxBlockSeen > 0) {
      // Keep event-containing scans anchored to the newest event we actually
      // parsed. A successful eth_getLogs response is not independently
      // provable as exhaustive, so advancing across later empty-looking blocks
      // could permanently skip provider-omitted events in the same window.
      newLastBlock = summary.maxBlockSeen;
      summary.advanceReason = "full-success-events";
    } else {
      newLastBlock = Math.max(
        fromBlock - 1,
        Math.min(scanTo, chainHead - safetyMarginBlocks),
      );
      summary.advanceReason = "full-success-empty";
    }
  } else if (partialCoverageFrontier != null && partialCoverageFrontier >= fromBlock) {
    newLastBlock = partialCoverageFrontier;
    summary.advanceReason = "partial-frontier";
  } else {
    summary.advanceReason = "no-safe-frontier";
  }

  summary.conservationFailure = conservationFence;
  if (conservationFence) {
    newLastBlock = null;
    summary.advanceReason = "no-safe-frontier";
  }
  if (newLastBlock != null) {
    summary.advancedTo = newLastBlock;
  }
  summary.requestBudgetUsed = configBudget.count;

  return {
    summary,
    apiErrors,
    effectiveBurns,
    bridgeBurns,
    reviewBurns,
    atomicRoundtripsDetected: persistResult.roundtripsDetected,
    newLastBlock,
  };
}
