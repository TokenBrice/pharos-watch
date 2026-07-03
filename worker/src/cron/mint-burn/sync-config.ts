import type { AlchemyLogEntry } from "../../lib/alchemy-logs";
import { fetchAlchemyLogs, resolveBlockTimestamps } from "../../lib/alchemy-logs";
import { budgetExhausted, createBudget, decodeUint256AtSlot } from "../../lib/evm-logs";
import type { TopicFilter } from "../../lib/evm-logs";
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
  errors: number;
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
  const amount = decodeUint256AtSlot(log.data, slot, config.decimals);
  if (amount <= 0 || amount < config.dustThreshold) return null;

  const blockNum = parseInt(log.blockNumber, 16);
  const logIndex = parseInt(log.logIndex, 16);
  if (!Number.isFinite(blockNum) || !Number.isFinite(logIndex)) return null;
  return blockNum;
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

    const topics: TopicFilter[] = [{ index: 0, value: eventDef.topicHash }];
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
    console.warn(
      `[sync-mint-burn] ${config.symbol} on ${config.chain.chainName}: ` +
      `${missingTimestampBlocks.length}/${timestampRequiredBlocks.length} candidate blocks missing timestamps`,
    );
  }

  const allParsedRows: MintBurnRow[] = [];
  for (const { eventDef, logs } of allConfigLogs) {
    const parsed = parseMintBurnLogs(
      config,
      eventDef,
      logs,
      blockTimestamps,
      priceContext.prices,
      priceContext.priceHistory,
      runTimestamp,
    );

    summary.rowsDropped += parsed.dropped;
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
    summary.maxBlockSeen = Math.max(summary.maxBlockSeen, row.block_number);
  }
  const persistResult = await persistMintBurnRows(db, persistableRows, affectedHours, { signal });
  summary.rowsInserted += persistResult.inserted;
  summary.rowsIgnored += persistResult.ignored;

  const fullEventCoverage =
    summary.eventCoverage.length === config.events.length &&
    summary.eventCoverage.every((coverage) => coverage.complete);
  const eventCoverageFrontier = minOrNull(
    summary.eventCoverage.map((coverage) => coverage.scannedToBlock),
  );
  const timestampCoverageFrontier = summary.earliestMissingTimestampBlock != null
    ? summary.earliestMissingTimestampBlock - 1
    : null;
  const txContextCoverageFrontier = deferredRows.length > 0
    ? Math.min(...deferredRows.map((row) => row.block_number)) - 1
    : null;
  const partialCoverageFrontier = minOrNull(
    [eventCoverageFrontier, timestampCoverageFrontier, txContextCoverageFrontier]
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
