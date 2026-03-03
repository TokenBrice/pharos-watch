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
  decodeUint256AtSlot,
  decodeAddress,
} from "../lib/evm-logs";
import type { TopicFilter } from "../lib/evm-logs";
import { MINT_BURN_CONFIGS, type MintBurnContractConfig, type MintBurnEventDef } from "../lib/mint-burn-contracts";
import { batchExecute } from "../lib/db";

// Safety margin when advancing sync state to chain head (prevents permanent event loss
// if block explorer indexing lags behind chain tip). 15 minutes in seconds.
const INDEXING_SAFETY_SEC = 900;

// Approximate block times (seconds) per EVM chain — used to compute safety margin in blocks.
const EVM_BLOCK_TIME: Record<number, number> = {
  1:     12,    // Ethereum
  42161: 0.25,  // Arbitrum
  8453:  2,     // Base
  10:    2,     // Optimism
  43114: 2,     // Avalanche
};

// Maximum block range to scan per contract per cron cycle.
// Respects Alchemy PAYG eth_getLogs block range limits per chain.
// ETH/ARB/BASE/OPT = unlimited on PAYG — we self-cap at 50K for budget control.
// Avalanche ("all other chains") = 10K. Polygon = 2K.
const CHAIN_SCAN_RANGE: Record<number, number> = {
  1:     50_000,  // Ethereum — unlimited on PAYG, self-capped
  42161: 50_000,  // Arbitrum — unlimited on PAYG, self-capped
  8453:  50_000,  // Base — unlimited on PAYG, self-capped
  10:    50_000,  // Optimism — unlimited on PAYG, self-capped
  43114: 10_000,  // Avalanche — 10K Alchemy limit
  137:   2_000,   // Polygon — 2K Alchemy limit
};

function getMaxScanRange(evmChainId: number): number {
  return CHAIN_SCAN_RANGE[evmChainId] ?? 10_000;
}

function evmSafetyMarginBlocks(evmChainId: number): number {
  const blockTime = EVM_BLOCK_TIME[evmChainId] ?? 2;
  return Math.ceil(INDEXING_SAFETY_SEC / blockTime);
}

export async function syncMintBurn(
  db: D1Database,
  alchemyApiKey: string | null,
  signal?: AbortSignal,
): Promise<{ itemCount: number; metadata: string }> {
  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("sync-mint-burn aborted");
    }
  };

  throwIfAborted();
  const budget = createBudget(200);
  let totalNewEvents = 0;
  let contractsProcessed = 0;
  let contractsSkipped = 0;
  let apiErrors = 0;
  let rowsRead = 0;
  let rowsDropped = 0;

  // 1. Load last_block for all configs in one batch query
  const configKeys = MINT_BURN_CONFIGS.map(
    (c) => `${c.chain.chainId}-${c.contractAddress}`
  );
  const syncStates = await db.batch(
    configKeys.map((key) =>
      db.prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?").bind(key)
    )
  );
  const lastBlocks = new Map<string, number>();
  configKeys.forEach((key, i) => {
    const row = syncStates[i].results[0] as { last_block: number } | undefined;
    // Fall back to config's startBlock (not 0) to avoid scanning pre-deployment history
    const config = MINT_BURN_CONFIGS[i];
    lastBlocks.set(key, row?.last_block ?? (config.startBlock - 1));
  });

  // 2. Get current block number per chain (lazy cache — fetched on first use per chain ID)
  const chainHeadCache = new Map<number, number>();
  async function getChainHead(config: MintBurnContractConfig): Promise<number | null> {
    const evmChainId = config.chain.evmChainId;
    if (evmChainId === null) return null;
    if (chainHeadCache.has(evmChainId)) return chainHeadCache.get(evmChainId)!;
    const url = buildAlchemyUrl(config.chain.chainId, alchemyApiKey!);
    if (!url) return null;
    const head = await getAlchemyBlockNumber(url, budget, signal);
    if (head !== null) chainHeadCache.set(evmChainId, head);
    return head;
  }

  // Pre-check: fail fast if no API key
  if (!alchemyApiKey) {
    throw new Error("No ALCHEMY_API_KEY configured");
  }

  // Pre-fetch Ethereum chain head so an early failure returns a clear error
  const ethConfig = MINT_BURN_CONFIGS.find((c) => c.chain.evmChainId === 1);
  if (ethConfig) {
    const ethHead = await getChainHead(ethConfig);
    if (ethHead === null) {
      throw new Error("Failed to get Ethereum chain head");
    }
  }

  // 3. Load current prices for USD conversion (one query, cached in Map)
  const stablecoinIds = [...new Set(MINT_BURN_CONFIGS.map((c) => c.stablecoinId))];
  const priceRows = await db.prepare(
    "SELECT asset_id, price FROM price_cache WHERE asset_id IN (" +
    stablecoinIds.map(() => "?").join(",") + ")"
  ).bind(...stablecoinIds).all<{ asset_id: string; price: number }>();
  const prices = new Map<string, number>();
  for (const row of priceRows.results) {
    prices.set(row.asset_id, row.price);
  }
  const runTimestamp = Math.floor(Date.now() / 1000);

  // 3b. Load daily historical price snapshots for event-time USD valuation
  const priceHistoryRows = await db
    .prepare(
      "SELECT stablecoin_id, snapshot_date, price FROM supply_history WHERE stablecoin_id IN (" +
      stablecoinIds.map(() => "?").join(",") +
      ") AND price IS NOT NULL ORDER BY stablecoin_id, snapshot_date ASC",
    )
    .bind(...stablecoinIds)
    .all<{ stablecoin_id: string; snapshot_date: number; price: number }>();
  const priceHistory = new Map<string, { snapshotDate: number; price: number }[]>();
  for (const row of priceHistoryRows.results) {
    const series = priceHistory.get(row.stablecoin_id) ?? [];
    series.push({ snapshotDate: row.snapshot_date, price: row.price });
    priceHistory.set(row.stablecoin_id, series);
  }

  // 4. Process each config
  const allNewEvents: Array<{
    stablecoinId: string; chainId: string; hourTs: number;
  }> = [];

  for (const config of MINT_BURN_CONFIGS) {
    throwIfAborted();
    if (config.chain.evmChainId === null) { contractsSkipped++; continue; }
    if (budgetExhausted(budget)) { contractsSkipped++; continue; }

    const evmChainId = config.chain.evmChainId;
    const chainHead = await getChainHead(config);
    if (chainHead === null) { contractsSkipped++; continue; }

    const configKey = `${config.chain.chainId}-${config.contractAddress}`;
    const fromBlock = (lastBlocks.get(configKey) ?? 0) + 1;

    if (fromBlock > chainHead) {
      contractsSkipped++;
      continue;
    }

    // Cap scan range to prevent exponential recursion exhausting the budget.
    // Historical ranges (scanTo < chainHead) are safe to advance to fully;
    // near chain head the safety margin protects against indexing lag.
    const scanTo = Math.min(fromBlock + getMaxScanRange(evmChainId), chainHead);

    let maxBlockSeen = 0;
    let configEvents = 0;
    let configError = false;

    // Collect all logs for this config (across all event definitions)
    const allConfigLogs: { eventDef: MintBurnEventDef; logs: AlchemyLogEntry[] }[] = [];

    for (const eventDef of config.events) {
      if (budgetExhausted(budget)) break;

      const topics: TopicFilter[] = [{ index: 0, value: eventDef.topicHash }];
      if (eventDef.filterTopic) {
        topics.push({ index: eventDef.filterTopic.index, value: eventDef.filterTopic.value });
      }

      const url = buildAlchemyUrl(config.chain.chainId, alchemyApiKey!);
      if (!url) { configError = true; continue; }

      const logs = await fetchAlchemyLogs(url, config.contractAddress, topics, fromBlock, scanTo, budget, signal);

      if (logs === null) {
        apiErrors++;
        configError = true;
        continue;
      }
      rowsRead += logs.length;

      if (logs.length > 0) allConfigLogs.push({ eventDef, logs });
    }

    // Resolve block timestamps for all logs in a single batch
    const uniqueBlocks = [
      ...new Set(allConfigLogs.flatMap(({ logs }) => logs.map((l) => parseInt(l.blockNumber, 16))))
    ];
    const url = buildAlchemyUrl(config.chain.chainId, alchemyApiKey!);
    const blockTimestamps = url && uniqueBlocks.length > 0
      ? await resolveBlockTimestamps(url, uniqueBlocks, budget, signal)
      : new Map<number, number>();

    // Guard: if any block has no timestamp, treat as config error.
    if (uniqueBlocks.length > 0 && blockTimestamps.size < uniqueBlocks.length) {
      const missing = uniqueBlocks.length - blockTimestamps.size;
      console.warn(
        `[sync-mint-burn] ${config.symbol} on ${config.chain.chainName}: ` +
        `${missing}/${uniqueBlocks.length} blocks missing timestamps — skipping to retry next cycle`
      );
      apiErrors++;
      configError = true;
      // Count as processed (not skipped) — a fetch did occur, we just couldn't resolve timestamps.
      // configError = true prevents sync state from advancing, so the range will be retried.
      contractsProcessed++;
      continue;
    }

    // Parse and insert logs
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
      const rows = parsed.rows;
      rowsDropped += parsed.dropped;
      for (const row of rows) {
        maxBlockSeen = Math.max(maxBlockSeen, row.block_number);
        const hourTs = Math.floor(row.timestamp / 3600) * 3600;
        allNewEvents.push({ stablecoinId: config.stablecoinId, chainId: config.chain.chainId, hourTs });
      }

      if (rows.length > 0) {
        const stmts = rows.map((r) =>
          db.prepare(
            `INSERT OR IGNORE INTO mint_burn_events
             (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, price_used, price_timestamp, price_source,
              counterparty, tx_hash, block_number, timestamp, explorer_tx_url)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            r.id, r.stablecoin_id, r.symbol, r.chain_id, r.direction,
            r.amount, r.amount_usd, r.price_used, r.price_timestamp, r.price_source,
            r.counterparty, r.tx_hash, r.block_number, r.timestamp, r.explorer_tx_url
          )
        );
        await batchExecute(db, stmts);
        configEvents += rows.length;
      }
    }

    // Update sync state
    if (!configError) {
      let newLastBlock: number;
      if (maxBlockSeen > 0) {
        newLastBlock = maxBlockSeen;
      } else {
        // No events found — advance to end of scanned range.
        // Apply safety margin only near chain head to protect against indexing lag.
        const safetyBlocks = evmSafetyMarginBlocks(evmChainId);
        newLastBlock = Math.max(fromBlock - 1, Math.min(scanTo, chainHead - safetyBlocks));
      }
      await db.prepare(
        `INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)
         ON CONFLICT(config_key) DO UPDATE SET last_block = ?`
      ).bind(configKey, newLastBlock, newLastBlock).run();
    }

    totalNewEvents += configEvents;
    contractsProcessed++;
    console.log(
      `[sync-mint-burn] ${config.symbol} on ${config.chain.chainName}: ${configEvents} new events, block ${maxBlockSeen || "none"}`
    );
  }

  // 5. Recalculate affected hourly buckets
  const affectedHours = new Map<string, { stablecoinId: string; chainId: string; hourTs: number }>();
  for (const evt of allNewEvents) {
    const key = `${evt.stablecoinId}-${evt.chainId}-${evt.hourTs}`;
    affectedHours.set(key, evt);
  }

  if (affectedHours.size > 0) {
    const aggStmt = db.prepare(`
      INSERT OR REPLACE INTO mint_burn_hourly
        (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
         mint_volume_usd, burn_volume_usd, net_flow_usd)
      SELECT
        stablecoin_id, chain_id,
        (timestamp / 3600) * 3600 AS hour_ts,
        SUM(CASE WHEN direction = 'mint' THEN 1 ELSE 0 END),
        SUM(CASE WHEN direction = 'burn' THEN 1 ELSE 0 END),
        COALESCE(SUM(CASE WHEN direction = 'mint' THEN amount_usd ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN direction = 'burn' THEN amount_usd ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN direction = 'mint' THEN amount_usd ELSE -amount_usd END), 0)
      FROM mint_burn_events
      WHERE stablecoin_id = ? AND chain_id = ?
        AND timestamp >= ? AND timestamp < ?
      GROUP BY stablecoin_id, chain_id, hour_ts
    `);

    const aggBatches = [...affectedHours.values()].map((h) =>
      aggStmt.bind(h.stablecoinId, h.chainId, h.hourTs, h.hourTs + 3600)
    );
    await batchExecute(db, aggBatches);
  }

  // If every attempted contract failed at provider/API level, surface as a hard failure.
  // This keeps circuit-breaker health aligned when no useful work was completed.
  if (contractsProcessed === 0 && apiErrors > 0) {
    throw new Error("All mint/burn contract fetches failed due to provider/API errors");
  }

  console.log(`[sync-mint-burn] Completed with ${budget.count}/${budget.limit} subrequests`);
  return {
    itemCount: totalNewEvents,
    metadata: JSON.stringify({
      rowsRead,
      rowsWritten: totalNewEvents,
      rowsDropped,
      sourceCoverage: {
        contractsProcessed,
        contractsTotal: MINT_BURN_CONFIGS.length,
        contractsSkipped,
      },
      fallbackMode: null,
      validationFailures: apiErrors,
      contractsProcessed,
      contractsSkipped,
      apiErrors,
    }),
  };
}

// --- Log parsing ---

interface MintBurnRow {
  id: string;
  stablecoin_id: string;
  symbol: string;
  chain_id: string;
  direction: string;
  amount: number;
  amount_usd: number | null;
  price_used: number | null;
  price_timestamp: number | null;
  price_source: string | null;
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

function parseMintBurnLogs(
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
      counterparty,
      tx_hash: log.transactionHash,
      block_number: blockNum,
      timestamp,
      explorer_tx_url: `${config.chain.explorerUrl}/tx/${log.transactionHash}`,
    });
  }

  return { rows, dropped };
}
