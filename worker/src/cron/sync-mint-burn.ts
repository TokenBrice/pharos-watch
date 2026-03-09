import type { AlchemyLogEntry } from "../lib/alchemy-logs";
import {
  buildAlchemyUrl,
  getAlchemyBlockNumber,
  fetchAlchemyLogs,
  resolveBlockTimestamps,
} from "../lib/alchemy-logs";
import {
  createBudget,
  budgetExhausted,
} from "../lib/evm-logs";
import type { TopicFilter } from "../lib/evm-logs";
import {
  MINT_BURN_CONFIGS,
  type MintBurnContractConfig,
  type MintBurnEventDef,
  type MintBurnTier,
} from "../lib/mint-burn-contracts";
import type { MintBurnTxContext } from "../lib/mint-burn-bridge-classifier";
import { classifyBridgeBurnRows } from "../lib/mint-burn-pipeline/classification";
import { loadMintBurnPriceContextBatch } from "../lib/mint-burn-pipeline/context";
import { parseMintBurnLogs } from "../lib/mint-burn-pipeline/parse";
import { healNullPrices } from "../lib/mint-burn-pipeline/price-heal";
import {
  collectAffectedHours,
  insertMintBurnRows,
  recalcAffectedHours,
  updateBurnClassifications,
} from "../lib/mint-burn-pipeline/persistence";
import { detectAtomicRoundtrips } from "../lib/mint-burn-pipeline/roundtrip-detection";
import {
  ensureMintBurnSyncStateRows,
  mintBurnConfigKey,
  readMintBurnSyncStateBatch,
  upsertMintBurnSyncState,
} from "../lib/mint-burn-pipeline/sync-state";
import type { MintBurnAffectedHour, MintBurnRow } from "../lib/mint-burn-pipeline/types";
import type { CronProgressReporter } from "../lib/db";

const ETHEREUM_CHAIN_ID = "ethereum";
const MAX_SCAN_RANGE = 50_000;
const EVM_SAFETY_MARGIN_BLOCKS = 75; // Math.ceil(900s indexing safety / 12s block time)

const MINT_BURN_CRITICAL_JOB = "sync-mint-burn";
const MINT_BURN_EXTENDED_JOB = "sync-mint-burn-extended";
const GLOBAL_BUDGET_LIMIT = 200;
const CRITICAL_CONFIG_BUDGET_LIMIT = 60;
const EXTENDED_CONFIG_BUDGET_LIMIT = 25;
const DEGRADE_CONSECUTIVE_THRESHOLD = 2;
const ERROR_CONSECUTIVE_THRESHOLD = 3;
const SQL_IN_CHUNK_SIZE = 90;

type SyncMintBurnStatus = "ok" | "degraded" | "error";
export type MintBurnLane = "all" | "critical" | "extended";

export interface SyncMintBurnOptions {
  signal?: AbortSignal;
  disabledConfigIds?: Iterable<string>;
  disabledSymbols?: Iterable<string>;
  lane?: MintBurnLane;
  jobName?: string;
  onProgress?: CronProgressReporter;
}

interface MintBurnConfigSummary {
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
  requestBudgetLimit: number;
  requestBudgetUsed: number;
}

interface MintBurnRunStateRow {
  nextConfigIndex: number;
  degradedStreak: number;
}

function configKey(config: MintBurnContractConfig): string {
  return mintBurnConfigKey(config);
}

function configTier(config: MintBurnContractConfig): MintBurnTier {
  return config.tier ?? "critical";
}

function laneIncludesConfig(lane: MintBurnLane, config: MintBurnContractConfig): boolean {
  if (lane === "all") return true;
  return lane === configTier(config);
}

function resolveMintBurnJobName(lane: MintBurnLane, explicitJobName?: string): string {
  if (explicitJobName) return explicitJobName;
  return lane === "extended" ? MINT_BURN_EXTENDED_JOB : MINT_BURN_CRITICAL_JOB;
}

function eventDefLabel(eventDef: MintBurnEventDef): string {
  return `${eventDef.signature}:${eventDef.direction}`;
}

function minOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((min, value) => Math.min(min, value), values[0]);
}

function normalizeSyncMintBurnOptions(
  signalOrOptions?: AbortSignal | SyncMintBurnOptions,
): SyncMintBurnOptions {
  if (
    signalOrOptions &&
    typeof signalOrOptions === "object" &&
    "aborted" in signalOrOptions
  ) {
    return { signal: signalOrOptions as AbortSignal };
  }
  return signalOrOptions ?? {};
}

function normalizeDisabledConfigIdSet(values?: Iterable<string>): Set<string> {
  const set = new Set<string>();
  if (!values) return set;
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (normalized.length > 0) set.add(normalized);
  }
  return set;
}

function normalizeDisabledSymbolSet(values?: Iterable<string>): Set<string> {
  const set = new Set<string>();
  if (!values) return set;
  for (const value of values) {
    const normalized = value.trim().toUpperCase();
    if (normalized.length > 0) set.add(normalized);
  }
  return set;
}

function rotateArray<T>(values: T[], start: number): T[] {
  if (values.length === 0) return [];
  const idx = ((start % values.length) + values.length) % values.length;
  return [...values.slice(idx), ...values.slice(0, idx)];
}

async function getMintBurnRunState(
  db: D1Database,
  jobName: string,
): Promise<{ state: MintBurnRunStateRow; persistenceFailed: boolean }> {
  try {
    const row = await db
      .prepare(
        "SELECT next_config_index, degraded_streak FROM mint_burn_run_state WHERE job = ?",
      )
      .bind(jobName)
      .first<{ next_config_index: number; degraded_streak: number }>();

    return {
      state: {
        nextConfigIndex: row?.next_config_index ?? 0,
        degradedStreak: row?.degraded_streak ?? 0,
      },
      persistenceFailed: false,
    };
  } catch (error) {
    console.warn("[sync-mint-burn] Failed to load run-state; using defaults:", error);
    // Migration may not exist in local/unit tests.
    return {
      state: { nextConfigIndex: 0, degradedStreak: 0 },
      persistenceFailed: true,
    };
  }
}

async function setMintBurnRunState(
  db: D1Database,
  jobName: string,
  nextConfigIndex: number,
  degradedStreak: number,
): Promise<boolean> {
  try {
    const now = Math.floor(Date.now() / 1000);
    await db
      .prepare(
        `INSERT INTO mint_burn_run_state (job, next_config_index, degraded_streak, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(job) DO UPDATE SET
           next_config_index = excluded.next_config_index,
           degraded_streak = excluded.degraded_streak,
           updated_at = excluded.updated_at`,
      )
      .bind(jobName, nextConfigIndex, degradedStreak, now)
      .run();
    return true;
  } catch (error) {
    console.warn("[sync-mint-burn] Failed to persist run-state:", error);
    // Non-fatal in environments where migrations are behind.
    return false;
  }
}

export async function syncMintBurn(
  db: D1Database,
  alchemyApiKey: string | null,
  signalOrOptions?: AbortSignal | SyncMintBurnOptions,
): Promise<{ itemCount: number; metadata: string; status?: SyncMintBurnStatus }> {
  const options = normalizeSyncMintBurnOptions(signalOrOptions);
  const signal = options.signal;
  const lane = options.lane ?? "all";
  const jobName = resolveMintBurnJobName(lane, options.jobName);
  const reportProgress = options.onProgress;

  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("sync-mint-burn aborted");
    }
  };

  throwIfAborted();

  const budget = createBudget(GLOBAL_BUDGET_LIMIT);

  const disabledConfigIds = normalizeDisabledConfigIdSet(options.disabledConfigIds);
  const disabledSymbols = normalizeDisabledSymbolSet(options.disabledSymbols);

  const allTrackableConfigs = MINT_BURN_CONFIGS.filter(
    (config) => config.chain.chainId === ETHEREUM_CHAIN_ID && laneIncludesConfig(lane, config),
  );
  const enabledConfigs: MintBurnContractConfig[] = [];
  const disabledConfigReasons = new Map<string, string>();

  for (const config of allTrackableConfigs) {
    const key = configKey(config);
    const symbol = config.symbol.toUpperCase();
    const isDisabledByConfig = config.enabled === false;
    const isDisabledBySymbol = disabledSymbols.has(symbol);
    const isDisabledById =
      disabledConfigIds.has(config.stablecoinId.toLowerCase()) ||
      disabledConfigIds.has(key.toLowerCase());

    if (isDisabledByConfig || isDisabledBySymbol || isDisabledById) {
      const reason =
        isDisabledByConfig ? "config-disabled" :
        isDisabledBySymbol ? "symbol-disabled" :
        "id-disabled";
      disabledConfigReasons.set(key, reason);
      continue;
    }

    enabledConfigs.push(config);
  }

  const configsDisabled = disabledConfigReasons.size;
  const contractsTotal = allTrackableConfigs.length;

  if (enabledConfigs.length === 0) {
    const metadata = JSON.stringify({
      lane,
      jobName,
      rowsRead: 0,
      rowsParsed: 0,
      rowsInserted: 0,
      rowsIgnored: 0,
      rowsDropped: 0,
      sourceCoverage: {
        contractsProcessed: 0,
        contractsSkipped: 0,
        contractsEnabled: 0,
        contractsDisabled: configsDisabled,
        contractsTotal,
      },
      configsDisabled,
      contractsProcessed: 0,
      contractsSkipped: 0,
      apiErrors: 0,
      fallbackMode: null,
      validationFailures: 0,
      configBreakdown: [],
      laggingConfigs: [],
      degradedSignal: false,
      degradedStreak: 0,
      coverageRatio: 1,
      nullPricesHealed: 0,
    });

    return {
      itemCount: 0,
      metadata,
      status: "ok",
    };
  }

  if (!alchemyApiKey) {
    throw new Error("No ALCHEMY_API_KEY configured");
  }
  const apiKey = alchemyApiKey;

  const runStateSnapshot = await getMintBurnRunState(db, jobName);
  const runState = runStateSnapshot.state;
  const startIndex = runState.nextConfigIndex % enabledConfigs.length;
  const rotatedConfigs = rotateArray(enabledConfigs, startIndex);
  // Always process critical contracts first so extended backlogs cannot starve
  // core coverage when budget pressure is high.
  const configs = [
    ...rotatedConfigs.filter((config) => configTier(config) === "critical"),
    ...rotatedConfigs.filter((config) => configTier(config) === "extended"),
  ];

  await ensureMintBurnSyncStateRows(db, configs);
  const lastBlocks = await readMintBurnSyncStateBatch(db, configs);
  const lastBlocksAfterRun = new Map(lastBlocks);

  const alchemyUrl = buildAlchemyUrl(ETHEREUM_CHAIN_ID, apiKey);
  if (!alchemyUrl) {
    throw new Error("Failed to build Ethereum Alchemy URL");
  }
  const chainHead = await getAlchemyBlockNumber(alchemyUrl, budget, signal);
  if (chainHead === null) {
    throw new Error("Failed to get Ethereum chain head");
  }

  const chainTimestampCache = new Map<number, number>();
  const txContextCache = new Map<string, MintBurnTxContext | null>();

  const stablecoinIds = [...new Set(configs.map((config) => config.stablecoinId))];
  const runTimestamp = Math.floor(Date.now() / 1000);
  const { prices, priceHistory } = await loadMintBurnPriceContextBatch(
    db,
    stablecoinIds,
    SQL_IN_CHUNK_SIZE,
  );

  await reportProgress?.({
    stage: lane === "extended" ? "extended-queue" : lane === "critical" ? "critical-queue" : "queue",
    itemsDone: 0,
    itemsTotal: configs.length,
    message: `Preparing ${configs.length} config(s) for ${lane} mint/burn sync`,
    metadata: {
      lane,
      jobName,
      contractsEnabled: enabledConfigs.length,
      contractsTotal,
    },
  });

  let rowsRead = 0;
  let rowsParsed = 0;
  let rowsInserted = 0;
  let rowsIgnored = 0;
  let rowsDropped = 0;
  let contractsProcessed = 0;
  let contractsSkipped = 0;
  let contractsDeferredExtended = 0;
  let apiErrors = 0;
  let effectiveBurns = 0;
  let bridgeBurns = 0;
  let reviewBurns = 0;
  let atomicRoundtripsTotal = 0;
  const criticalContractsEnabled = enabledConfigs.filter((config) => configTier(config) === "critical").length;
  let criticalContractsSatisfied = 0;
  let criticalContractsUnsatisfied = 0;

  const configBreakdown: MintBurnConfigSummary[] = [];
  const affectedHours = new Map<string, MintBurnAffectedHour>();

  for (let i = 0; i < configs.length; i++) {
    throwIfAborted();

    const config = configs[i];
    const key = configKey(config);
    const tier = configTier(config);

    const summary: MintBurnConfigSummary = {
      key,
      symbol: config.symbol,
      chainId: config.chain.chainId,
      tier,
      attempted: false,
      skippedReason: null,
      scanFrom: null,
      scanTo: null,
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
      requestBudgetLimit: 0,
      requestBudgetUsed: 0,
    };
    await reportProgress?.({
      stage: "scan-config",
      itemsDone: i,
      itemsTotal: configs.length,
      message: `Scanning ${config.symbol} on ${config.chain.chainName}`,
      metadata: {
        lane,
        jobName,
        configKey: key,
        symbol: config.symbol,
        tier,
        budgetUsed: budget.count,
        budgetLimit: budget.limit,
      },
    });
    const finalizeSummary = (criticalOutcome: "satisfied" | "unsatisfied" | "n/a" = "n/a"): void => {
      if (tier === "critical") {
        if (criticalOutcome === "satisfied") {
          criticalContractsSatisfied++;
        } else if (criticalOutcome === "unsatisfied") {
          criticalContractsUnsatisfied++;
        }
      }
      configBreakdown.push(summary);
    };

    if (config.chain.chainId !== ETHEREUM_CHAIN_ID) {
      summary.skippedReason = "non-ethereum-config";
      contractsSkipped++;
      finalizeSummary("unsatisfied");
      continue;
    }

    if (budgetExhausted(budget)) {
      summary.skippedReason = "global-budget-exhausted";
      contractsSkipped++;
      finalizeSummary("unsatisfied");
      continue;
    }

    const remainingCritical = configs
      .slice(i)
      .filter((next) => configTier(next) === "critical").length;
    const remainingBudget = budget.limit - budget.count;
    const shouldDeferExtended = tier === "extended" && remainingBudget <= Math.max(10, remainingCritical * 6);
    if (shouldDeferExtended) {
      summary.skippedReason = "extended-deferred-under-pressure";
      contractsDeferredExtended++;
      contractsSkipped++;
      finalizeSummary();
      continue;
    }

    const fromBlock = (lastBlocksAfterRun.get(key) ?? (config.startBlock - 1)) + 1;
    if (fromBlock > chainHead) {
      summary.skippedReason = "up-to-date";
      contractsSkipped++;
      finalizeSummary("satisfied");
      continue;
    }

    summary.attempted = true;
    contractsProcessed++;
    const configBudget = createBudget(
      Math.max(
        1,
        Math.min(
          budget.limit - budget.count,
          tier === "critical" ? CRITICAL_CONFIG_BUDGET_LIMIT : EXTENDED_CONFIG_BUDGET_LIMIT,
        ),
      ),
    );
    summary.requestBudgetLimit = configBudget.limit;

    const maxRange = MAX_SCAN_RANGE;
    const scanTo = Math.min(fromBlock + maxRange - 1, chainHead);
    summary.scanFrom = fromBlock;
    summary.scanTo = scanTo;

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

      rowsRead += fetched.logs.length;
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

    const uniqueBlocks = [
      ...new Set(allConfigLogs.flatMap(({ logs }) => logs.map((log) => parseInt(log.blockNumber, 16)))),
    ];
    const blockTimestamps = uniqueBlocks.length > 0
      ? await resolveBlockTimestamps(alchemyUrl, uniqueBlocks, configBudget, {
          signal,
          localCache: chainTimestampCache,
          persistentCache: {
            db,
            chainId: config.chain.chainId,
          },
        })
      : new Map<number, number>();

    const missingTimestampBlocks = uniqueBlocks
      .filter((blockNum) => !blockTimestamps.has(blockNum))
      .sort((a, b) => a - b);
    summary.missingTimestampCount = missingTimestampBlocks.length;
    summary.earliestMissingTimestampBlock = missingTimestampBlocks[0] ?? null;

    if (missingTimestampBlocks.length > 0) {
      const missing = missingTimestampBlocks.length;
      apiErrors++;
      summary.errors++;
      summary.failedEventDefs.push(`timestamps:${missing}`);
      console.warn(
        `[sync-mint-burn] ${config.symbol} on ${config.chain.chainName}: ` +
        `${missing}/${uniqueBlocks.length} blocks missing timestamps`,
      );
    }

    // Phase 1: Parse + classify bridge burns per eventDef (preserves Alchemy budget batching)
    const allParsedRows: MintBurnRow[] = [];

    for (const { eventDef, logs } of allConfigLogs) {
      const parsed = parseMintBurnLogs(
        config,
        eventDef,
        logs,
        blockTimestamps,
        prices,
        priceHistory,
        runTimestamp,
      );

      rowsDropped += parsed.dropped;
      summary.rowsDropped += parsed.dropped;

      rowsParsed += parsed.rows.length;
      summary.rowsParsed += parsed.rows.length;

      const burnCounts = await classifyBridgeBurnRows(
        parsed.rows,
        config,
        alchemyUrl,
        configBudget,
        txContextCache,
        signal,
      );
      effectiveBurns += burnCounts.effectiveBurns;
      bridgeBurns += burnCounts.bridgeBurns;
      reviewBurns += burnCounts.reviewBurns;

      allParsedRows.push(...parsed.rows);
    }

    // Phase 2: Detect atomic roundtrips across ALL eventDefs for this config.
    // Must see all rows to find mint+burn pairs in the same transaction.
    const roundtripsDetected = detectAtomicRoundtrips(allParsedRows);
    atomicRoundtripsTotal += roundtripsDetected;

    // Phase 3: Track, collect, insert.
    for (const row of allParsedRows) {
      summary.maxBlockSeen = Math.max(summary.maxBlockSeen, row.block_number);
    }
    collectAffectedHours(allParsedRows, affectedHours);

    if (allParsedRows.length > 0) {
      const insertResult = await insertMintBurnRows(db, allParsedRows);

      rowsInserted += insertResult.inserted;
      rowsIgnored += insertResult.ignored;

      summary.rowsInserted += insertResult.inserted;
      summary.rowsIgnored += insertResult.ignored;

      await updateBurnClassifications(db, allParsedRows);
    }

    const fullEventCoverage =
      summary.eventCoverage.length === config.events.length &&
      summary.eventCoverage.every((coverage) => coverage.complete);
    const eventCoverageFrontier = minOrNull(
      summary.eventCoverage.map((coverage) => coverage.scannedToBlock),
    );
    const timestampCoverageFrontier = summary.earliestMissingTimestampBlock != null
      ? summary.earliestMissingTimestampBlock - 1
      : null;
    const partialCoverageFrontier = minOrNull(
      [eventCoverageFrontier, timestampCoverageFrontier]
        .filter((value): value is number => value != null),
    );
    summary.coverageFrontier = partialCoverageFrontier;

    let newLastBlock: number | null = null;
    if (fullEventCoverage && summary.missingTimestampCount === 0) {
      if (summary.maxBlockSeen > 0) {
        newLastBlock = summary.maxBlockSeen;
        summary.advanceReason = "full-success-events";
      } else {
        // Full success and no events found: advance to end of scanned range,
        // preserving a safety margin near chain head.
        const safetyBlocks = EVM_SAFETY_MARGIN_BLOCKS;
        newLastBlock = Math.max(
          fromBlock - 1,
          Math.min(scanTo, chainHead - safetyBlocks),
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
      await upsertMintBurnSyncState(db, key, newLastBlock, "replace");
      lastBlocksAfterRun.set(key, newLastBlock);
      summary.advancedTo = newLastBlock;
    }
    summary.requestBudgetUsed = configBudget.count;
    budget.count += configBudget.count;

    console.log(
      `[sync-mint-burn] ${config.symbol} on ${config.chain.chainName}: ` +
      `${summary.rowsInserted} inserted, ${summary.rowsIgnored} ignored, ` +
      `scan ${fromBlock}-${scanTo}, advancedTo=${summary.advancedTo ?? "none"}`,
    );

    finalizeSummary(
      fullEventCoverage && summary.errors === 0
        ? "satisfied"
        : "unsatisfied",
    );
  }

  await recalcAffectedHours(db, affectedHours);
  await reportProgress?.({
    stage: "recalc-hours",
    itemsDone: configs.length,
    itemsTotal: configs.length,
    message: `Recalculating ${affectedHours.size} affected hourly bucket(s)`,
    metadata: {
      lane,
      jobName,
      affectedHours: affectedHours.size,
      budgetUsed: budget.count,
      budgetLimit: budget.limit,
    },
  });

  const laggingConfigs = configs
    .map((config) => {
      const key = configKey(config);
      const last = lastBlocksAfterRun.get(key) ?? (config.startBlock - 1);
      const lagBlocks = Math.max(0, chainHead - last);
      return {
        key,
        symbol: config.symbol,
        chainId: config.chain.chainId,
        lagBlocks,
        head: chainHead,
        lastBlock: last,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => b.lagBlocks - a.lagBlocks)
    .slice(0, 6);

  const coverageRatio = enabledConfigs.length > 0 ? contractsProcessed / enabledConfigs.length : 1;
  const criticalCoverageRatio =
    criticalContractsEnabled > 0 ? criticalContractsSatisfied / criticalContractsEnabled : 1;
  const degradedSignal =
    lane === "extended"
      ? apiErrors > 1
      : criticalCoverageRatio < 1 || apiErrors > 1;
  const degradedStreak = degradedSignal ? runState.degradedStreak + 1 : 0;

  let status: SyncMintBurnStatus = "ok";
  if (lane !== "extended" && degradedStreak >= ERROR_CONSECUTIVE_THRESHOLD) {
    status = "error";
  } else if (degradedStreak >= DEGRADE_CONSECUTIVE_THRESHOLD) {
    status = "degraded";
  }

  const nextConfigIndex = enabledConfigs.length > 0
    ? (startIndex + 1) % enabledConfigs.length
    : 0;
  const runStatePersisted = await setMintBurnRunState(db, jobName, nextConfigIndex, degradedStreak);
  const runStatePersistenceFailed = runStateSnapshot.persistenceFailed || !runStatePersisted;

  if (runStatePersistenceFailed && status === "ok") {
    status = "degraded";
  }

  // Auto-heal NULL prices for recent events (only on non-error runs).
  let nullPricesHealed = 0;
  if (status !== "error") {
    try {
      const healResult = await healNullPrices(db, Math.floor(Date.now() / 1000));
      nullPricesHealed = healResult.healed;
      if (healResult.affectedHours.size > 0) {
        await recalcAffectedHours(db, healResult.affectedHours);
      }
    } catch (error) {
      console.warn("[sync-mint-burn] Price heal failed (non-fatal):", error);
    }
  }

  const metadata = JSON.stringify({
    lane,
    jobName,
    rowsRead,
    rowsParsed,
    rowsInserted,
    rowsIgnored,
    rowsDropped,
    sourceCoverage: {
      contractsProcessed,
      contractsSkipped,
      contractsEnabled: enabledConfigs.length,
      contractsDisabled: configsDisabled,
      contractsTotal,
    },
    configsDisabled,
    contractsProcessed,
    contractsSkipped,
    contractsDeferredExtended,
    budgetUsed: budget.count,
    budgetLimit: budget.limit,
    apiErrors,
    validationFailures: apiErrors,
    fallbackMode: null,
    burnClassification: {
      effectiveBurns,
      bridgeBurns,
      reviewBurns,
    },
    atomicRoundtripsDetected: atomicRoundtripsTotal,
    criticalCoverage: {
      contractsEnabled: criticalContractsEnabled,
      contractsSatisfied: criticalContractsSatisfied,
      contractsUnsatisfied: criticalContractsUnsatisfied,
      ratio: criticalCoverageRatio,
    },
    configBreakdown,
    laggingConfigs,
    coverageRatio,
    degradedSignal,
    degradedStreak,
    runStatePersistenceFailed,
    nullPricesHealed,
  });

  await reportProgress?.({
    stage: "complete",
    itemsDone: configs.length,
    itemsTotal: configs.length,
    message: `Completed ${lane} mint/burn sync`,
    metadata: {
      lane,
      jobName,
      status,
      contractsProcessed,
      contractsSkipped,
      budgetUsed: budget.count,
      budgetLimit: budget.limit,
    },
  });

  console.log(`[sync-mint-burn] Completed with ${budget.count}/${budget.limit} subrequests (${status})`);

  return {
    itemCount: rowsInserted,
    metadata,
    status,
  };
}
