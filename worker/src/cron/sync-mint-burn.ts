import type { RateLimitedFetch, EtherscanLogEntry } from "../lib/evm-logs";
import {
  createBudget,
  budgetExhausted,
  getEvmBlockNumber,
  fetchEvmLogsForTopics,
  decodeUint256,
  decodeAddress,
} from "../lib/evm-logs";
import { MINT_BURN_CONFIGS, type MintBurnContractConfig } from "../lib/mint-burn-contracts";
import { batchExecute } from "../lib/db";

// Safety margin when advancing sync state to chain head (prevents permanent event loss
// if block explorer indexing lags behind chain tip). 15 minutes in seconds.
const INDEXING_SAFETY_SEC = 900;

// Approximate block time (seconds) for Ethereum — only chain in Phase 1.
const ETH_BLOCK_TIME = 12;

// Maximum block range to scan per contract per cron cycle.
// Prevents exponential recursion in fetchEvmLogsForTopics from exhausting the
// shared subrequest budget when scanning dense contracts (e.g. USDC) over large ranges.
// 50K blocks ≈ 7 days of Ethereum blocks. Full backfill of 2.6M blocks takes ~17 hours.
const MAX_SCAN_RANGE = 50_000;

function evmSafetyMarginBlocks(): number {
  return Math.ceil(INDEXING_SAFETY_SEC / ETH_BLOCK_TIME);
}

export async function syncMintBurn(
  db: D1Database,
  etherscanApiKey: string | null,
  etherscanRL: RateLimitedFetch,
  signal?: AbortSignal,
): Promise<{ itemCount: number; metadata: string }> {
  const budget = createBudget(200);
  let totalNewEvents = 0;
  let contractsProcessed = 0;
  let contractsSkipped = 0;
  let apiErrors = 0;

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

  // 2. Get current Ethereum block number (single call, shared across all configs)
  const chainHead = await getEvmBlockNumber(1, etherscanApiKey, etherscanRL, budget);
  if (chainHead === null) {
    return { itemCount: 0, metadata: JSON.stringify({ error: "Failed to get chain head" }) };
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

  // 4. Process each config
  const allNewEvents: Array<{
    stablecoinId: string; chainId: string; hourTs: number;
  }> = [];

  for (const config of MINT_BURN_CONFIGS) {
    if (config.chain.evmChainId === null) { contractsSkipped++; continue; }
    const configKey = `${config.chain.chainId}-${config.contractAddress}`;
    const fromBlock = (lastBlocks.get(configKey) ?? 0) + 1;

    if (fromBlock > chainHead) {
      contractsSkipped++;
      continue;
    }
    if (budgetExhausted(budget)) {
      contractsSkipped++;
      continue;
    }

    // Cap scan range to prevent exponential recursion exhausting the budget.
    // Historical ranges (scanTo < chainHead) are safe to advance to fully;
    // near chain head the safety margin protects against indexing lag.
    const scanTo = Math.min(fromBlock + MAX_SCAN_RANGE, chainHead);

    let maxBlockSeen = 0;
    let configEvents = 0;
    let configError = false;

    for (const eventDef of config.events) {
      if (budgetExhausted(budget)) break;

      // Build compound topics: [topic0 (event sig), topicN (zero address filter)]
      const topics = [{ index: 0, value: eventDef.topicHash }];
      if (eventDef.filterTopic) {
        topics.push({ index: eventDef.filterTopic.index, value: eventDef.filterTopic.value });
      }

      const logs = await fetchEvmLogsForTopics(
        config.chain.evmChainId, config.contractAddress, topics,
        etherscanApiKey, fromBlock, scanTo, 0, etherscanRL, budget
      );

      if (logs === null) {
        apiErrors++;
        configError = true;
        continue;
      }

      // Parse logs into DB rows
      const rows = parseMintBurnLogs(config, eventDef.direction, logs, prices);
      for (const row of rows) {
        maxBlockSeen = Math.max(maxBlockSeen, row.block_number);

        // Track affected hour buckets for aggregation
        const hourTs = Math.floor(row.timestamp / 3600) * 3600;
        allNewEvents.push({ stablecoinId: config.stablecoinId, chainId: config.chain.chainId, hourTs });
      }

      // Batch INSERT OR IGNORE
      if (rows.length > 0) {
        const stmts = rows.map((r) =>
          db.prepare(
            `INSERT OR IGNORE INTO mint_burn_events
             (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd,
              counterparty, tx_hash, block_number, timestamp, explorer_tx_url)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            r.id, r.stablecoin_id, r.symbol, r.chain_id, r.direction,
            r.amount, r.amount_usd, r.counterparty, r.tx_hash, r.block_number,
            r.timestamp, r.explorer_tx_url
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
        const safetyBlocks = evmSafetyMarginBlocks();
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

  console.log(`[sync-mint-burn] Completed with ${budget.count}/${budget.limit} subrequests`);
  return {
    itemCount: totalNewEvents,
    metadata: JSON.stringify({ contractsProcessed, contractsSkipped, apiErrors }),
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
  counterparty: string | null;
  tx_hash: string;
  block_number: number;
  timestamp: number;
  explorer_tx_url: string;
}

function parseMintBurnLogs(
  config: MintBurnContractConfig,
  direction: "mint" | "burn",
  logs: EtherscanLogEntry[],
  prices: Map<string, number>,
): MintBurnRow[] {
  const rows: MintBurnRow[] = [];

  for (const log of logs) {
    const amount = decodeUint256(log.data, config.decimals);
    if (amount <= 0 || amount < config.dustThreshold) continue;

    const blockNum = parseInt(log.blockNumber, 16);
    const logIndex = parseInt(log.logIndex, 16);
    const timestamp = parseInt(log.timeStamp, 16);
    if (isNaN(blockNum) || isNaN(timestamp)) continue;

    const id = `${config.chain.chainId}-${log.transactionHash}-${logIndex}`;

    // Counterparty: for mints it's topics[2] (recipient), for burns it's topics[1] (sender)
    const counterpartyTopic = direction === "mint" ? log.topics[2] : log.topics[1];
    const counterparty = counterpartyTopic ? decodeAddress(counterpartyTopic) : null;

    const price = prices.get(config.stablecoinId);
    const amountUsd = price != null ? amount * price : null;

    rows.push({
      id,
      stablecoin_id: config.stablecoinId,
      symbol: config.symbol,
      chain_id: config.chain.chainId,
      direction,
      amount,
      amount_usd: amountUsd,
      counterparty,
      tx_hash: log.transactionHash,
      block_number: blockNum,
      timestamp,
      explorer_tx_url: `${config.chain.explorerUrl}/tx/${log.transactionHash}`,
    });
  }

  return rows;
}
