import { MINT_BURN_CONFIGS, type MintBurnContractConfig, type MintBurnEventDef } from "../lib/mint-burn-contracts";
import { batchExecute } from "../lib/db";
import {
  type SubrequestBudget,
  type RateLimitedFetch,
  type EtherscanLogEntry,
  createBudget,
  budgetExhausted,
  createRateLimiter,
  decodeAddress,
  decodeUint256,
  fetchEvmLogsForTopic,
  getEvmBlockNumber,
} from "../lib/evm-logs";

interface MintBurnRow {
  id: string;
  stablecoin: string;
  chain_id: string;
  chain_name: string;
  event_type: string;
  amount: number;
  address: string | null;
  tx_hash: string;
  block_number: number;
  timestamp: number;
  explorer_tx_url: string;
}

function buildExplorerTxUrl(explorerUrl: string, txHash: string): string {
  return `${explorerUrl}/tx/${txHash}`;
}

function parseLogs(
  config: MintBurnContractConfig,
  eventDef: MintBurnEventDef,
  logs: EtherscanLogEntry[]
): MintBurnRow[] {
  const rows: MintBurnRow[] = [];

  for (const log of logs) {
    const blockNumber = parseInt(log.blockNumber, 16);
    const timestamp = parseInt(log.timeStamp, 16);
    if (isNaN(blockNumber) || isNaN(timestamp)) continue;

    const amount = decodeUint256(log.data.slice(0, 66), config.decimals);

    let address: string | null = null;
    if (eventDef.hasAddress) {
      if (eventDef.eventType === "mint") {
        // Mint(address indexed minter, address indexed to, uint256 amount)
        // Store the recipient (topics[2])
        address = log.topics.length > 2 ? decodeAddress(log.topics[2]) : decodeAddress(log.topics[1]);
      } else {
        // Burn(address indexed burner, uint256 amount)
        address = decodeAddress(log.topics[1]);
      }
    }

    rows.push({
      id: `${config.chain.chainId}-${log.transactionHash}-${log.logIndex}`,
      stablecoin: config.stablecoin,
      chain_id: config.chain.chainId,
      chain_name: config.chain.chainName,
      event_type: eventDef.eventType,
      amount,
      address,
      tx_hash: log.transactionHash,
      block_number: blockNumber,
      timestamp,
      explorer_tx_url: buildExplorerTxUrl(config.chain.explorerUrl, log.transactionHash),
    });
  }

  return rows;
}

// --- Sync state helpers (separate table from blacklist) ---

async function getLastBlock(db: D1Database, configKey: string): Promise<number> {
  const row = await db
    .prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?")
    .bind(configKey)
    .first<{ last_block: number }>();
  return row?.last_block ?? 0;
}

async function setLastBlock(db: D1Database, configKey: string, block: number): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)")
    .bind(configKey, block)
    .run();
}

// --- Orchestrator ---

/** Max block range per fetch to avoid Etherscan timeouts and budget exhaustion */
const CHUNK_SIZE = 500_000;

async function insertRows(db: D1Database, rows: MintBurnRow[]): Promise<void> {
  if (rows.length === 0) return;
  const stmts = rows.map((row) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO mint_burn_events
         (id, stablecoin, chain_id, chain_name, event_type, amount, address, tx_hash, block_number, timestamp, explorer_tx_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        row.id,
        row.stablecoin,
        row.chain_id,
        row.chain_name,
        row.event_type,
        row.amount,
        row.address,
        row.tx_hash,
        row.block_number,
        row.timestamp,
        row.explorer_tx_url
      )
  );
  await batchExecute(db, stmts);
}

export async function syncMintBurn(
  db: D1Database,
  etherscanApiKey: string | null
): Promise<{ itemCount: number; metadata: string }> {
  console.log(`[sync-mint-burn] Starting sync (${MINT_BURN_CONFIGS.length} configs)`);
  const rateLimit = createRateLimiter(4);
  const budget = createBudget(900);
  let totalNewEvents = 0;
  let configsSkipped = 0;

  // Load sync state for all configs
  const configStates = await Promise.all(
    MINT_BURN_CONFIGS.map(async (config) => {
      const configKey = `${config.stablecoin}-${config.chain.chainId}`;
      const lastBlock = await getLastBlock(db, configKey);
      return { config, configKey, lastBlock };
    })
  );

  // Sort by lastBlock ascending — least-synced first
  configStates.sort((a, b) => a.lastBlock - b.lastBlock);

  // Pre-fetch chain heads to know scan targets
  const chainHeadCache = new Map<number, number>();
  const uniqueChainIds = new Set(MINT_BURN_CONFIGS.map((c) => c.chain.evmChainId).filter((id): id is number => id != null));
  for (const evmChainId of uniqueChainIds) {
    if (budgetExhausted(budget)) break;
    try {
      const head = await getEvmBlockNumber(evmChainId, etherscanApiKey, rateLimit, budget);
      if (head) chainHeadCache.set(evmChainId, head);
    } catch (err) {
      console.warn(`[sync-mint-burn] Failed to get head for chain ${evmChainId}:`, err);
    }
  }
  console.log(`[sync-mint-burn] Chain heads: ${JSON.stringify(Object.fromEntries(chainHeadCache))}`);

  for (let i = 0; i < configStates.length; i++) {
    const { config, configKey, lastBlock } = configStates[i];
    if (budgetExhausted(budget)) {
      configsSkipped = configStates.length - i;
      console.log(`[sync-mint-burn] Budget exhausted (${budget.count}/${budget.limit}), skipping ${configsSkipped} remaining configs`);
      break;
    }

    const evmChainId = config.chain.evmChainId;
    if (evmChainId == null) continue;

    const chainHead = chainHeadCache.get(evmChainId) ?? 99999999;
    const startBlock = lastBlock > 0 ? lastBlock + 1 : config.deployBlock;

    // Already caught up
    if (startBlock >= chainHead) {
      console.log(`[sync-mint-burn] ${config.stablecoin} on ${config.chain.chainName}: up to date at block ${lastBlock}`);
      continue;
    }

    try {
      let configEvents = 0;
      let cursor = startBlock;

      // Scan in chunks of CHUNK_SIZE blocks
      while (cursor < chainHead && !budgetExhausted(budget)) {
        const chunkEnd = Math.min(cursor + CHUNK_SIZE - 1, chainHead);
        const chunkRows: MintBurnRow[] = [];
        let chunkMaxBlock = cursor;

        for (const eventDef of config.events) {
          if (budgetExhausted(budget)) break;

          const logs = await fetchEvmLogsForTopic(
            evmChainId,
            config.contractAddress,
            eventDef.topicHash,
            etherscanApiKey,
            cursor,
            chunkEnd,
            0,
            rateLimit,
            budget
          );

          const rows = parseLogs(config, eventDef, logs);
          chunkRows.push(...rows);

          for (const row of rows) {
            if (row.block_number > chunkMaxBlock) chunkMaxBlock = row.block_number;
          }
        }

        // Insert and save progress after each chunk
        await insertRows(db, chunkRows);
        await setLastBlock(db, configKey, chunkEnd);
        configEvents += chunkRows.length;
        cursor = chunkEnd + 1;
      }

      totalNewEvents += configEvents;
      const pct = ((cursor - startBlock) / (chainHead - startBlock) * 100).toFixed(0);
      console.log(
        `[sync-mint-burn] ${config.stablecoin} on ${config.chain.chainName}: ${configEvents} new events, scanned to block ${cursor - 1} (${pct}%)`
      );
    } catch (err) {
      console.warn(`[sync-mint-burn] Failed ${config.stablecoin} on ${config.chain.chainName}:`, err);
    }
  }

  console.log(`[sync-mint-burn] Completed with ${budget.count}/${budget.limit} subrequests`);
  return {
    itemCount: totalNewEvents,
    metadata: JSON.stringify({ configsSkipped, budgetUsed: budget.count, budgetLimit: budget.limit }),
  };
}
