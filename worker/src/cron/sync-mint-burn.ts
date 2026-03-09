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
import {
  ensureMintBurnSyncStateRows,
  mintBurnConfigKey,
  readMintBurnSyncStateBatch,
  upsertMintBurnSyncState,
} from "../lib/mint-burn-pipeline/sync-state";
import type { MintBurnAffectedHour } from "../lib/mint-burn-pipeline/types";

const ETHEREUM_CHAIN_ID = "ethereum";
const MAX_SCAN_RANGE = 50_000;
const EVM_SAFETY_MARGIN_BLOCKS = 75; // Math.ceil(900s indexing safety / 12s block time)

const MINT_BURN_JOB = "sync-mint-burn";
const GLOBAL_BUDGET_LIMIT = 200;
const DEGRADE_CONSECUTIVE_THRESHOLD = 2;
const ERROR_CONSECUTIVE_THRESHOLD = 3;
const SQL_IN_CHUNK_SIZE = 90;

type SyncMintBurnStatus = "ok" | "degraded" | "error";

export interface SyncMintBurnOptions {
  signal?: AbortSignal;
  disabledConfigIds?: Iterable<string>;
  disabledSymbols?: Iterable<string>;
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

function eventDefLabel(eventDef: MintBurnEventDef): string {
  return `${eventDef.signature}:${eventDef.direction}`;
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
): Promise<{ state: MintBurnRunStateRow; persistenceFailed: boolean }> {
  try {
    const row = await db
      .prepare(
        "SELECT next_config_index, degraded_streak FROM mint_burn_run_state WHERE job = ?",
      )
      .bind(MINT_BURN_JOB)
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
      .bind(MINT_BURN_JOB, nextConfigIndex, degradedStreak, now)
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
    (config) => config.chain.chainId === ETHEREUM_CHAIN_ID,
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

  const runStateSnapshot = await getMintBurnRunState(db);
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
    };
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

    const maxRange = MAX_SCAN_RANGE;
    const scanTo = Math.min(fromBlock + maxRange - 1, chainHead);
    summary.scanFrom = fromBlock;
    summary.scanTo = scanTo;

    const allConfigLogs: Array<{ eventDef: MintBurnEventDef; logs: AlchemyLogEntry[] }> = [];
    let successfulEventDefs = 0;

    for (const eventDef of config.events) {
      if (budgetExhausted(budget)) {
        summary.failedEventDefs.push(`${eventDefLabel(eventDef)}:budget`);
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
        budget,
        signal,
      );

      if (!fetched) {
        apiErrors++;
        summary.errors++;
        summary.failedEventDefs.push(`${eventDefLabel(eventDef)}:fetch-failed`);
        continue;
      }

      rowsRead += fetched.logs.length;
      summary.rowsRead += fetched.logs.length;

      if (!fetched.complete) {
        apiErrors++;
        summary.errors++;
        summary.failedEventDefs.push(`${eventDefLabel(eventDef)}:partial-coverage`);
      } else {
        successfulEventDefs++;
      }

      if (fetched.logs.length > 0) {
        allConfigLogs.push({ eventDef, logs: fetched.logs });
      }
    }

    const uniqueBlocks = [
      ...new Set(allConfigLogs.flatMap(({ logs }) => logs.map((log) => parseInt(log.blockNumber, 16)))),
    ];
    const blockTimestamps = uniqueBlocks.length > 0
      ? await resolveBlockTimestamps(alchemyUrl, uniqueBlocks, budget, {
          signal,
          localCache: chainTimestampCache,
          persistentCache: {
            db,
            chainId: config.chain.chainId,
          },
        })
      : new Map<number, number>();

    if (uniqueBlocks.length > 0 && blockTimestamps.size < uniqueBlocks.length) {
      const missing = uniqueBlocks.length - blockTimestamps.size;
      apiErrors++;
      summary.errors++;
      summary.failedEventDefs.push(`timestamps:${missing}`);
      console.warn(
        `[sync-mint-burn] ${config.symbol} on ${config.chain.chainName}: ` +
        `${missing}/${uniqueBlocks.length} blocks missing timestamps`,
      );
    }

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
        budget,
        txContextCache,
        signal,
      );
      effectiveBurns += burnCounts.effectiveBurns;
      bridgeBurns += burnCounts.bridgeBurns;
      reviewBurns += burnCounts.reviewBurns;

      for (const row of parsed.rows) {
        summary.maxBlockSeen = Math.max(summary.maxBlockSeen, row.block_number);
      }
      collectAffectedHours(parsed.rows, affectedHours);

      if (parsed.rows.length > 0) {
        const insertResult = await insertMintBurnRows(db, parsed.rows);

        rowsInserted += insertResult.inserted;
        rowsIgnored += insertResult.ignored;

        summary.rowsInserted += insertResult.inserted;
        summary.rowsIgnored += insertResult.ignored;

        await updateBurnClassifications(db, parsed.rows);
      }
    }

    // Advance sync state whenever at least one event definition completed with full coverage.
    if (successfulEventDefs > 0) {
      let newLastBlock: number;
      if (summary.maxBlockSeen > 0) {
        newLastBlock = summary.maxBlockSeen;
      } else if (summary.failedEventDefs.length > 0) {
        // Partial failures: make forward progress but keep overlap for retries.
        const step = Math.max(1, Math.floor((scanTo - fromBlock + 1) / 2));
        newLastBlock = Math.min(scanTo, fromBlock + step - 1);
      } else {
        // Full success and no events found: advance to end of scanned range,
        // preserving a safety margin near chain head.
        const safetyBlocks = EVM_SAFETY_MARGIN_BLOCKS;
        newLastBlock = Math.max(
          fromBlock - 1,
          Math.min(scanTo, chainHead - safetyBlocks),
        );
      }

      await upsertMintBurnSyncState(db, key, newLastBlock, "replace");

      lastBlocksAfterRun.set(key, newLastBlock);
      summary.advancedTo = newLastBlock;
    }

    console.log(
      `[sync-mint-burn] ${config.symbol} on ${config.chain.chainName}: ` +
      `${summary.rowsInserted} inserted, ${summary.rowsIgnored} ignored, ` +
      `scan ${fromBlock}-${scanTo}, advancedTo=${summary.advancedTo ?? "none"}`,
    );

    const fullEventCoverage = successfulEventDefs === config.events.length;
    finalizeSummary(
      fullEventCoverage && summary.errors === 0
        ? "satisfied"
        : "unsatisfied",
    );
  }

  await recalcAffectedHours(db, affectedHours);

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
    criticalCoverageRatio < 1 ||
    apiErrors > 1;
  const degradedStreak = degradedSignal ? runState.degradedStreak + 1 : 0;

  let status: SyncMintBurnStatus = "ok";
  if (degradedStreak >= ERROR_CONSECUTIVE_THRESHOLD) {
    status = "error";
  } else if (degradedStreak >= DEGRADE_CONSECUTIVE_THRESHOLD) {
    status = "degraded";
  }

  const nextConfigIndex = enabledConfigs.length > 0
    ? (startIndex + 1) % enabledConfigs.length
    : 0;
  const runStatePersisted = await setMintBurnRunState(db, nextConfigIndex, degradedStreak);
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
    apiErrors,
    validationFailures: apiErrors,
    fallbackMode: null,
    burnClassification: {
      effectiveBurns,
      bridgeBurns,
      reviewBurns,
    },
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

  console.log(`[sync-mint-burn] Completed with ${budget.count}/${budget.limit} subrequests (${status})`);

  return {
    itemCount: rowsInserted,
    metadata,
    status,
  };
}
