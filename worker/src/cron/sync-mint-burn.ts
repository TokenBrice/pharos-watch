import type { AlchemyLogEntry } from "../lib/alchemy-logs";
import {
  buildAlchemyUrl,
  getAlchemyBlockNumber,
  getAlchemyTransactionByHash,
  getAlchemyTransactionReceipt,
  fetchAlchemyLogs,
  resolveBlockTimestamps,
} from "../lib/alchemy-logs";
import {
  createBudget,
  budgetExhausted,
  decodeUint256AtSlot,
  decodeAddress,
} from "../lib/evm-logs";
import type { TopicFilter } from "../lib/evm-logs";
import {
  MINT_BURN_CONFIGS,
  type MintBurnContractConfig,
  type MintBurnEventDef,
  type MintBurnType,
  type MintBurnTier,
} from "../lib/mint-burn-contracts";
import {
  classifyBridgeAwareBurnRows,
  type MintBurnTxContext,
} from "../lib/mint-burn-bridge-classifier";
import { batchExecute } from "../lib/db";

// Safety margin when advancing sync state to chain head (prevents permanent event loss
// if block explorer indexing lags behind chain tip). 15 minutes in seconds.
const INDEXING_SAFETY_SEC = 900;

const ETHEREUM_CHAIN_ID = "ethereum";
const ETHEREUM_BLOCK_TIME_SEC = 12;
const ETHEREUM_SCAN_RANGE = 50_000;

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

function getMaxScanRange(): number {
  return ETHEREUM_SCAN_RANGE;
}

function evmSafetyMarginBlocks(): number {
  return Math.ceil(INDEXING_SAFETY_SEC / ETHEREUM_BLOCK_TIME_SEC);
}

function configKey(config: MintBurnContractConfig): string {
  return `${config.chain.chainId}-${config.contractAddress}`;
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

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  if (values.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }
  return chunks;
}

async function getMintBurnRunState(db: D1Database): Promise<MintBurnRunStateRow> {
  try {
    const row = await db
      .prepare(
        "SELECT next_config_index, degraded_streak FROM mint_burn_run_state WHERE job = ?",
      )
      .bind(MINT_BURN_JOB)
      .first<{ next_config_index: number; degraded_streak: number }>();

    return {
      nextConfigIndex: row?.next_config_index ?? 0,
      degradedStreak: row?.degraded_streak ?? 0,
    };
  } catch {
    // Migration may not exist in local/unit tests.
    return { nextConfigIndex: 0, degradedStreak: 0 };
  }
}

async function setMintBurnRunState(
  db: D1Database,
  nextConfigIndex: number,
  degradedStreak: number,
): Promise<void> {
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
  } catch {
    // Non-fatal in environments where migrations are behind.
  }
}

interface BurnClassificationCounters {
  effectiveBurns: number;
  bridgeBurns: number;
  reviewBurns: number;
}

async function resolveTxContext(
  alchemyUrl: string,
  txHash: string,
  budget: { count: number; limit: number },
  txContextCache: Map<string, MintBurnTxContext | null>,
  signal?: AbortSignal,
): Promise<MintBurnTxContext | null> {
  const cached = txContextCache.get(txHash);
  if (cached !== undefined) return cached;

  const [tx, receipt] = await Promise.all([
    getAlchemyTransactionByHash(alchemyUrl, txHash, budget, signal),
    getAlchemyTransactionReceipt(alchemyUrl, txHash, budget, signal),
  ]);

  if (!tx || !receipt) {
    txContextCache.set(txHash, null);
    return null;
  }

  const context: MintBurnTxContext = {
    to: tx.to,
    inputSelector: tx.input?.slice(0, 10) ?? null,
    logTopics: receipt.logs.flatMap((log) => log.topics ?? []),
  };
  txContextCache.set(txHash, context);
  return context;
}

export async function classifyBridgeBurnRows(
  rows: MintBurnRow[],
  config: MintBurnContractConfig,
  alchemyUrl: string,
  budget: { count: number; limit: number },
  txContextCache: Map<string, MintBurnTxContext | null>,
  signal?: AbortSignal,
): Promise<BurnClassificationCounters> {
  const burnRows = rows.filter((row) => row.direction === "burn");
  if (burnRows.length === 0) {
    return { effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0 };
  }

  const txHashes = [...new Set(burnRows.map((row) => row.tx_hash))];
  const txContextByHash = new Map<string, MintBurnTxContext | null>();
  for (const txHash of txHashes) {
    const context = await resolveTxContext(
      alchemyUrl,
      txHash,
      budget,
      txContextCache,
      signal,
    );
    txContextByHash.set(txHash, context);
  }

  classifyBridgeAwareBurnRows(rows, config.bridgeDetection, txContextByHash);

  let effectiveBurns = 0;
  let bridgeBurns = 0;
  let reviewBurns = 0;
  for (const row of burnRows) {
    if (row.burn_type === "bridge_burn") {
      bridgeBurns++;
    } else if (row.burn_type === "review_required") {
      reviewBurns++;
    } else {
      effectiveBurns++;
    }
  }

  return { effectiveBurns, bridgeBurns, reviewBurns };
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
      rowsWritten: 0,
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

  const runState = await getMintBurnRunState(db);
  const startIndex = runState.nextConfigIndex % enabledConfigs.length;
  const rotatedConfigs = rotateArray(enabledConfigs, startIndex);
  // Always process critical contracts first so extended backlogs cannot starve
  // core coverage when budget pressure is high.
  const configs = [
    ...rotatedConfigs.filter((config) => configTier(config) === "critical"),
    ...rotatedConfigs.filter((config) => configTier(config) === "extended"),
  ];

  // Ensure every enabled config has a sync-state row.
  const initStateStmts = configs.map((config) =>
    db
      .prepare("INSERT OR IGNORE INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)")
      .bind(configKey(config), config.startBlock - 1),
  );
  await batchExecute(db, initStateStmts);

  // Load last_block for all configs in one batch query.
  const stateRows = await db.batch(
    configs.map((config) =>
      db
        .prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?")
        .bind(configKey(config)),
    ),
  );
  const lastBlocks = new Map<string, number>();
  configs.forEach((config, idx) => {
    const row = stateRows[idx]?.results?.[0] as { last_block: number } | undefined;
    lastBlocks.set(configKey(config), row?.last_block ?? (config.startBlock - 1));
  });
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

  // Load current prices for USD conversion.
  const stablecoinIds = [...new Set(configs.map((config) => config.stablecoinId))];
  const prices = new Map<string, number>();
  if (stablecoinIds.length > 0) {
    const idChunks = chunkArray(stablecoinIds, SQL_IN_CHUNK_SIZE);
    for (const idChunk of idChunks) {
      const priceRows = await db
        .prepare(
          "SELECT asset_id, price FROM price_cache WHERE asset_id IN (" +
          idChunk.map(() => "?").join(",") +
          ")",
        )
        .bind(...idChunk)
        .all<{ asset_id: string; price: number }>();

      for (const row of priceRows.results ?? []) {
        prices.set(row.asset_id, row.price);
      }
    }
  }

  const runTimestamp = Math.floor(Date.now() / 1000);

  // Load daily historical price snapshots for event-time valuation.
  const priceHistory = new Map<string, { snapshotDate: number; price: number }[]>();
  if (stablecoinIds.length > 0) {
    const idChunks = chunkArray(stablecoinIds, SQL_IN_CHUNK_SIZE);
    for (const idChunk of idChunks) {
      const priceHistoryRows = await db
        .prepare(
          "SELECT stablecoin_id, snapshot_date, price FROM supply_history WHERE stablecoin_id IN (" +
          idChunk.map(() => "?").join(",") +
          ") AND price IS NOT NULL ORDER BY stablecoin_id, snapshot_date ASC",
        )
        .bind(...idChunk)
        .all<{ stablecoin_id: string; snapshot_date: number; price: number }>();

      for (const row of priceHistoryRows.results ?? []) {
        const series = priceHistory.get(row.stablecoin_id) ?? [];
        series.push({ snapshotDate: row.snapshot_date, price: row.price });
        priceHistory.set(row.stablecoin_id, series);
      }
    }
  }

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
  const allNewEvents: Array<{ stablecoinId: string; chainId: string; hourTs: number }> = [];

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

    const maxRange = getMaxScanRange();
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
        const hourTs = Math.floor(row.timestamp / 3600) * 3600;
        allNewEvents.push({
          stablecoinId: config.stablecoinId,
          chainId: config.chain.chainId,
          hourTs,
        });
      }

      if (parsed.rows.length > 0) {
        const insertStmts = parsed.rows.map((row) =>
          db.prepare(
            `INSERT OR IGNORE INTO mint_burn_events
             (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, price_used, price_timestamp, price_source,
              burn_type, burn_review_reason, counterparty, tx_hash, block_number, timestamp, explorer_tx_url)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            row.id,
            row.stablecoin_id,
            row.symbol,
            row.chain_id,
            row.direction,
            row.amount,
            row.amount_usd,
            row.price_used,
            row.price_timestamp,
            row.price_source,
            row.burn_type,
            row.burn_review_reason,
            row.counterparty,
            row.tx_hash,
            row.block_number,
            row.timestamp,
            row.explorer_tx_url,
          ),
        );

        const inserted = await batchExecute(db, insertStmts);
        const ignored = Math.max(0, parsed.rows.length - inserted);

        rowsInserted += inserted;
        rowsIgnored += ignored;

        summary.rowsInserted += inserted;
        summary.rowsIgnored += ignored;

        const burnRows = parsed.rows.filter((row) => row.direction === "burn");
        if (burnRows.length > 0) {
          const updateBurnClassificationStmts = burnRows.map((row) =>
            db.prepare(
              `UPDATE mint_burn_events
               SET burn_type = ?, burn_review_reason = ?
               WHERE id = ?`,
            ).bind(
              row.burn_type,
              row.burn_review_reason,
              row.id,
            ),
          );
          await batchExecute(db, updateBurnClassificationStmts);
        }
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
        const safetyBlocks = evmSafetyMarginBlocks();
        newLastBlock = Math.max(
          fromBlock - 1,
          Math.min(scanTo, chainHead - safetyBlocks),
        );
      }

      await db
        .prepare(
          `INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)
           ON CONFLICT(config_key) DO UPDATE SET last_block = excluded.last_block`,
        )
        .bind(key, newLastBlock)
        .run();

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

  // Recalculate affected hourly buckets.
  const affectedHours = new Map<string, { stablecoinId: string; chainId: string; hourTs: number }>();
  for (const event of allNewEvents) {
    const key = `${event.stablecoinId}-${event.chainId}-${event.hourTs}`;
    affectedHours.set(key, event);
  }

  if (affectedHours.size > 0) {
    const aggStmt = db.prepare(
      `INSERT OR REPLACE INTO mint_burn_hourly
        (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
         mint_volume_usd, burn_volume_usd, net_flow_usd)
       SELECT
        stablecoin_id,
        chain_id,
        (timestamp / 3600) * 3600 AS hour_ts,
        SUM(CASE WHEN direction = 'mint' THEN 1 ELSE 0 END),
        SUM(CASE WHEN direction = 'burn' AND burn_type = 'effective_burn' THEN 1 ELSE 0 END),
        COALESCE(SUM(CASE WHEN direction = 'mint' THEN amount_usd ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN direction = 'burn' AND burn_type = 'effective_burn' THEN amount_usd ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN direction = 'mint' THEN amount_usd WHEN direction = 'burn' AND burn_type = 'effective_burn' THEN -amount_usd ELSE 0 END), 0)
       FROM mint_burn_events
       WHERE stablecoin_id = ? AND chain_id = ?
         AND timestamp >= ? AND timestamp < ?
       GROUP BY stablecoin_id, chain_id, hour_ts`,
    );

    const aggStmts = [...affectedHours.values()].map((hour) =>
      aggStmt.bind(hour.stablecoinId, hour.chainId, hour.hourTs, hour.hourTs + 3600),
    );
    await batchExecute(db, aggStmts);
  }

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
  await setMintBurnRunState(db, nextConfigIndex, degradedStreak);

  const metadata = JSON.stringify({
    rowsRead,
    rowsParsed,
    rowsWritten: rowsInserted,
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
  });

  console.log(`[sync-mint-burn] Completed with ${budget.count}/${budget.limit} subrequests (${status})`);

  return {
    itemCount: rowsInserted,
    metadata,
    status,
  };
}

// --- Log parsing ---

export interface MintBurnRow {
  id: string;
  stablecoin_id: string;
  symbol: string;
  chain_id: string;
  direction: "mint" | "burn";
  amount: number;
  amount_usd: number | null;
  price_used: number | null;
  price_timestamp: number | null;
  price_source: string | null;
  burn_type: MintBurnType | null;
  burn_review_reason: string | null;
  counterparty: string | null;
  tx_hash: string;
  block_number: number;
  timestamp: number;
  explorer_tx_url: string;
}

function resolveEventPrice(
  stablecoinId: string,
  timestamp: number,
  prices: Map<string, number>,
  priceHistory: Map<string, { snapshotDate: number; price: number }[]>,
  runTimestamp: number,
): { price: number | null; priceTimestamp: number | null; priceSource: string | null } {
  const eventDay = Math.floor(timestamp / 86400) * 86400;
  const history = priceHistory.get(stablecoinId) ?? [];

  // Latest daily snapshot at or before event day.
  let bestIdx = -1;
  let lo = 0;
  let hi = history.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (history[mid].snapshotDate <= eventDay) {
      bestIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (bestIdx >= 0) {
    const hit = history[bestIdx];
    return {
      price: hit.price,
      priceTimestamp: hit.snapshotDate,
      priceSource: "supply-history-daily",
    };
  }

  // Fallback to current price cache when historical snapshot is unavailable.
  const current = prices.get(stablecoinId);
  if (current != null) {
    return {
      price: current,
      priceTimestamp: runTimestamp,
      priceSource: "price-cache-current",
    };
  }

  return { price: null, priceTimestamp: null, priceSource: null };
}

export function parseMintBurnLogs(
  config: MintBurnContractConfig,
  eventDef: MintBurnEventDef,
  logs: AlchemyLogEntry[],
  blockTimestamps: Map<number, number>,
  prices: Map<string, number>,
  priceHistory: Map<string, { snapshotDate: number; price: number }[]>,
  runTimestamp: number,
): { rows: MintBurnRow[]; dropped: number } {
  const rows: MintBurnRow[] = [];
  const direction = eventDef.direction;
  let dropped = 0;

  for (const log of logs) {
    const slot = eventDef.amountEncoding === "nth-data-uint256" ? (eventDef.dataSlot ?? 0) : 0;
    const amount = decodeUint256AtSlot(log.data, slot, config.decimals);
    if (amount <= 0 || amount < config.dustThreshold) {
      dropped++;
      continue;
    }

    const blockNum = parseInt(log.blockNumber, 16);
    const logIndex = parseInt(log.logIndex, 16);
    const timestamp = blockTimestamps.get(blockNum) ?? 0;
    if (isNaN(blockNum) || !timestamp) {
      dropped++;
      continue;
    }

    const id = `${config.chain.chainId}-${log.transactionHash}-${logIndex}`;

    // Counterparty: for mints it's topics[2] (recipient), for burns it's topics[1] (sender)
    const counterpartyTopic = direction === "mint" ? log.topics[2] : log.topics[1];
    const counterparty = counterpartyTopic ? decodeAddress(counterpartyTopic) : null;

    const eventPrice = resolveEventPrice(
      config.stablecoinId,
      timestamp,
      prices,
      priceHistory,
      runTimestamp,
    );
    const amountUsd = eventPrice.price != null ? amount * eventPrice.price : null;

    rows.push({
      id,
      stablecoin_id: config.stablecoinId,
      symbol: config.symbol,
      chain_id: config.chain.chainId,
      direction,
      amount,
      amount_usd: amountUsd,
      price_used: eventPrice.price,
      price_timestamp: eventPrice.priceTimestamp,
      price_source: eventPrice.priceSource,
      burn_type: direction === "burn" ? "effective_burn" : null,
      burn_review_reason: null,
      counterparty,
      tx_hash: log.transactionHash,
      block_number: blockNum,
      timestamp,
      explorer_tx_url: `${config.chain.explorerUrl}/tx/${log.transactionHash}`,
    });
  }

  return { rows, dropped };
}
