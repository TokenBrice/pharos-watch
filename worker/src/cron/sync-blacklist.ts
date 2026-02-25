import {
  CONTRACT_CONFIGS,
  type ContractEventConfig,
  type ChainConfig,
} from "../lib/blacklist-contracts";
import { ETHERSCAN_V2_BASE } from "../lib/constants";
import type { BlacklistEventType } from "../../../src/lib/types";
import { bigIntToDecimal } from "../lib/bigint";
import { getLastBlock, setLastBlock, batchExecute } from "../lib/db";
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

const EVM_SCANNED_TO_LATEST = 99999999;
const BACKFILL_BATCH_SIZE = 50;

// Safety margin when advancing sync state to chain head (prevents permanent event loss
// if block explorer indexing lags behind chain tip). 15 minutes in seconds/ms.
const INDEXING_SAFETY_SEC = 900;
const TRON_SAFETY_MS = INDEXING_SAFETY_SEC * 1000;

// Approximate block times (seconds) per EVM chain — used to compute safety margin in blocks.
const EVM_BLOCK_TIME: Record<number, number> = {
  1: 12,        // Ethereum
  42161: 0.25,  // Arbitrum
  8453: 2,      // Base
  10: 2,        // Optimism
  137: 2,       // Polygon
  43114: 2,     // Avalanche
  56: 3,        // BSC
};

function evmSafetyMarginBlocks(evmChainId: number): number {
  const blockTime = EVM_BLOCK_TIME[evmChainId] ?? 2;
  return Math.ceil(INDEXING_SAFETY_SEC / blockTime);
}

function buildExplorerTxUrl(chain: ChainConfig, txHash: string): string {
  if (chain.type === "tron") {
    return `${chain.explorerUrl}/#/transaction/${txHash}`;
  }
  return `${chain.explorerUrl}/tx/${txHash}`;
}

function buildExplorerAddressUrl(chain: ChainConfig, address: string): string {
  if (chain.type === "tron") {
    // Tronscan expects 41-prefix hex, not 0x-prefix
    const tronAddr = address.startsWith("0x") ? "41" + address.slice(2) : address;
    return `${chain.explorerUrl}/#/address/${tronAddr}`;
  }
  return `${chain.explorerUrl}/address/${address}`;
}

// --- Chain head (current block number) imported from evm-logs.ts ---

// --- Balance fetching ---

async function fetchEvmBalanceAtTag(
  evmChainId: number,
  contractAddress: string,
  address: string,
  tag: string,
  apiKey: string | null,
  rateLimit: RateLimitedFetch,
  decimals: number,
  budget: SubrequestBudget
): Promise<number | null> {
  if (budgetExhausted(budget)) return null;

  // balanceOf(address) selector = 0x70a08231
  const addr = (address.startsWith("0x") ? address.slice(2) : address).toLowerCase();
  const data = "0x70a08231" + addr.padStart(64, "0");

  const params = new URLSearchParams({
    chainid: evmChainId.toString(),
    module: "proxy",
    action: "eth_call",
    to: contractAddress,
    data,
    tag,
  });
  if (apiKey) params.set("apikey", apiKey);

  try {
    budget.count++;
    const json = await rateLimit(async () => {
      const res = await fetch(`${ETHERSCAN_V2_BASE}?${params}`);
      if (!res.ok) { await res.body?.cancel(); return null; }
      return res.json() as Promise<{ result?: string; error?: unknown }>;
    });

    // API failure, error response, or empty/invalid eth_call result → unknown
    if (!json?.result || json.error || !json.result.startsWith("0x") || json.result.length < 4) {
      return null;
    }

    return bigIntToDecimal(BigInt(json.result), decimals);
  } catch {
    return null;
  }
}

// dRPC network names for L2 chains (used to build RPC URL)
const DRPC_NETWORK: Record<string, string> = {
  arbitrum: "arbitrum",
  base: "base",
  optimism: "optimism",
  polygon: "polygon",
  avalanche: "avalanche",
  bsc: "bsc",
};

// Fetch historical balanceOf via dRPC archive nodes.
// dRPC supports eth_call at arbitrary historical blocks on all L2 chains.
async function fetchBalanceViaDrpc(
  chainId: string,
  contractAddress: string,
  address: string,
  blockNumber: number,
  drpcApiKey: string,
  decimals: number,
  budget: SubrequestBudget
): Promise<number | null> {
  if (budgetExhausted(budget)) return null;

  const network = DRPC_NETWORK[chainId];
  if (!network) return null;

  const addr = (address.startsWith("0x") ? address.slice(2) : address).toLowerCase();
  const data = "0x70a08231" + addr.padStart(64, "0");
  const blockTag = "0x" + blockNumber.toString(16);

  try {
    budget.count++;
    const res = await fetch(
      `https://lb.drpc.org/ogrpc?network=${network}&dkey=${drpcApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: contractAddress, data }, blockTag],
        }),
      }
    );
    if (!res.ok) { await res.body?.cancel(); return null; }
    const json = (await res.json()) as { result?: string; error?: unknown };

    if (!json?.result || json.error || !json.result.startsWith("0x") || json.result.length < 4) {
      return null;
    }

    return bigIntToDecimal(BigInt(json.result), decimals);
  } catch {
    return null;
  }
}

async function fetchEvmTokenBalance(
  config: ContractEventConfig,
  address: string,
  blockNumber: number,
  etherscanApiKey: string | null,
  drpcApiKey: string | null,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget
): Promise<number | null> {
  // L2 chains: use dRPC archive for historical balanceOf.
  // Etherscan v2 free plan doesn't support eth_call on L2s.
  if (config.chain.evmChainId !== 1 && drpcApiKey) {
    return fetchBalanceViaDrpc(
      config.chain.chainId, config.contractAddress, address, blockNumber, drpcApiKey, config.decimals, budget
    );
  }

  // Ethereum mainnet: use Etherscan eth_call with historical block tag
  const blockTag = "0x" + blockNumber.toString(16);
  return fetchEvmBalanceAtTag(config.chain.evmChainId!, config.contractAddress, address, blockTag, etherscanApiKey, rateLimit, config.decimals, budget);
}

async function fetchTronTokenBalance(
  contractAddress: string,
  address: string,
  apiKey: string | null,
  rateLimit: RateLimitedFetch,
  decimals: number,
  budget: SubrequestBudget
): Promise<number | null> {
  if (budgetExhausted(budget)) return null;

  const headers: Record<string, string> = {};
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;

  // Convert 0x-prefixed EVM format to Tron's 41-prefixed hex format
  const tronAddress = address.startsWith("0x") ? "41" + address.slice(2) : address;

  try {
    budget.count++;
    const json = await rateLimit(async () => {
      const res = await fetch(`https://api.trongrid.io/v1/accounts/${tronAddress}`, { headers });
      if (!res.ok) { await res.body?.cancel(); return null; }
      return res.json() as Promise<{
        data: { trc20: Record<string, string>[] }[];
        success: boolean;
      }>;
    });

    if (!json?.success) return null;
    if (!json.data?.[0]) return 0; // Account doesn't exist — 0 balance
    if (!json.data[0].trc20) return 0;

    for (const tokenEntry of json.data[0].trc20) {
      if (contractAddress in tokenEntry) {
        return bigIntToDecimal(BigInt(tokenEntry[contractAddress]), decimals);
      }
    }

    return 0; // Account exists but has no balance of this token
  } catch {
    return null;
  }
}

// --- EVM log fetching imported from evm-logs.ts ---

interface BlacklistRow {
  id: string;
  stablecoin: string;
  chain_id: string;
  chain_name: string;
  event_type: string;
  address: string;
  amount: number | null;
  tx_hash: string;
  block_number: number;
  timestamp: number;
  explorer_tx_url: string;
  explorer_address_url: string;
}

function parseEvmLogs(
  config: ContractEventConfig,
  eventType: BlacklistEventType,
  hasAmount: boolean,
  logs: EtherscanLogEntry[]
): BlacklistRow[] {
  return logs.map((log) => {
    const addressIndexed = log.topics.length > 1;
    const affectedAddress = addressIndexed
      ? decodeAddress(log.topics[1])
      : decodeAddress(log.data.slice(0, 66));

    // When address is indexed (in topics), amount is the first data field.
    // When address is non-indexed (in data), amount is the second data field.
    const amount = hasAmount
      ? addressIndexed
        ? log.data.length >= 66 ? decodeUint256(log.data, config.decimals) : null
        : log.data.length > 66 ? decodeUint256("0x" + log.data.slice(66), config.decimals) : null
      : null;

    const blockNumber = parseInt(log.blockNumber, 16);
    const timestamp = parseInt(log.timeStamp, 16);
    if (isNaN(blockNumber) || isNaN(timestamp)) return null;

    return {
      id: `${config.chain.chainId}-${log.transactionHash}-${log.logIndex}`,
      stablecoin: config.stablecoin,
      chain_id: config.chain.chainId,
      chain_name: config.chain.chainName,
      event_type: eventType,
      address: affectedAddress,
      amount,
      tx_hash: log.transactionHash,
      block_number: blockNumber,
      timestamp,
      explorer_tx_url: buildExplorerTxUrl(config.chain, log.transactionHash),
      explorer_address_url: buildExplorerAddressUrl(config.chain, affectedAddress),
    };
  }).filter((r): r is NonNullable<typeof r> => r !== null) as BlacklistRow[];
}

async function fetchEvmEventsIncremental(
  config: ContractEventConfig,
  apiKey: string | null,
  fromBlock: number,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget
): Promise<{ rows: BlacklistRow[]; maxBlock: number }> {
  const evmChainId = config.chain.evmChainId;
  if (evmChainId == null) return { rows: [], maxBlock: fromBlock };

  const allRows: BlacklistRow[] = [];
  let maxBlock = fromBlock;

  for (const eventDef of config.events) {
    if (budgetExhausted(budget)) break;

    const logs = await fetchEvmLogsForTopic(
      evmChainId,
      config.contractAddress,
      eventDef.topicHash,
      apiKey,
      fromBlock,
      99999999,
      0,
      rateLimit,
      budget
    );
    const rows = parseEvmLogs(config, eventDef.eventType, eventDef.hasAmount, logs);
    allRows.push(...rows);

    for (const row of rows) {
      if (row.block_number > maxBlock) maxBlock = row.block_number;
    }
  }

  return { rows: allRows, maxBlock };
}

// --- Tron fetching ---

interface TronEventResult {
  block_number: number;
  block_timestamp: number;
  transaction_id: string;
  event_index: number;
  event_name: string;
  result: Record<string, string>;
}

interface TronEventsResponse {
  data: TronEventResult[];
  meta?: { links?: { next?: string } };
  success: boolean;
}

const TRON_EVENT_NAME_MAP: Record<string, BlacklistEventType> = {
  AddedBlackList: "blacklist",
  RemovedBlackList: "unblacklist",
  DestroyedBlackFunds: "destroy",
};

const TRON_EVENT_NAMES = Object.keys(TRON_EVENT_NAME_MAP);

/**
 * Fetch Tron events incrementally.
 * NOTE: `lastTimestampMs` is a millisecond timestamp (stored in `blacklist_sync_state.last_block`).
 * For EVM chains, `last_block` stores actual block numbers. This semantic difference is
 * intentional: Tron events are ordered by timestamp, not block number.
 */
async function fetchTronEventsIncremental(
  config: ContractEventConfig,
  apiKey: string | null,
  lastTimestampMs: number,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget
): Promise<{ rows: BlacklistRow[]; maxBlock: number }> {
  const rows: BlacklistRow[] = [];
  let maxBlock = 0;
  const headers: Record<string, string> = {};
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;

  for (const eventName of TRON_EVENT_NAMES) {
    if (budgetExhausted(budget)) break;

    const tsFilter = lastTimestampMs > 0 ? `&min_block_timestamp=${lastTimestampMs}` : "";
    let url: string | null = `https://api.trongrid.io/v1/contracts/${config.contractAddress}/events?event_name=${eventName}&limit=200&order_by=block_timestamp,desc${tsFilter}`;

    while (url) {
      if (budgetExhausted(budget)) break;

      budget.count++;
      const json: TronEventsResponse | null = await rateLimit(async () => {
        const res = await fetch(url!, { headers });
        if (!res.ok) {
          console.warn(`[blacklist] Tron API error: ${res.status}`);
          await res.body?.cancel();
          return null;
        }
        return res.json() as Promise<TronEventsResponse>;
      });

      if (!json?.success || !Array.isArray(json.data)) break;

      for (const evt of json.data) {
        const eventType = TRON_EVENT_NAME_MAP[evt.event_name];
        if (!eventType) continue;

        const affectedAddress = evt.result._user || evt.result._blackListedUser || evt.result["0"] || "";
        const amount =
          eventType === "destroy" && (evt.result._balance || evt.result._value || evt.result["1"])
            ? Number(evt.result._balance || evt.result._value || evt.result["1"]) / Math.pow(10, config.decimals)
            : null;

        if (evt.block_timestamp > maxBlock) maxBlock = evt.block_timestamp;

        rows.push({
          id: `${config.chain.chainId}-${evt.transaction_id}-${evt.event_index}`,
          stablecoin: config.stablecoin,
          chain_id: config.chain.chainId,
          chain_name: config.chain.chainName,
          event_type: eventType,
          address: affectedAddress,
          amount,
          tx_hash: evt.transaction_id,
          block_number: evt.block_number,
          timestamp: Math.floor(evt.block_timestamp / 1000),
          explorer_tx_url: buildExplorerTxUrl(config.chain, evt.transaction_id),
          explorer_address_url: buildExplorerAddressUrl(config.chain, affectedAddress),
        });
      }

      url = json.meta?.links?.next || null;
    }
  }

  return { rows, maxBlock };
}

// --- Enrichment: fetch balances for blacklist/unblacklist events ---

async function enrichRowBalances(
  rows: BlacklistRow[],
  config: ContractEventConfig,
  etherscanApiKey: string | null,
  trongridApiKey: string | null,
  drpcApiKey: string | null,
  etherscanLimiter: RateLimitedFetch,
  tronLimiter: RateLimitedFetch,
  budget: SubrequestBudget
): Promise<void> {
  for (const row of rows) {
    if (budgetExhausted(budget)) break;
    if (row.amount != null) continue;
    if (row.event_type !== "blacklist" && row.event_type !== "unblacklist" && row.event_type !== "destroy") continue;

    // Fetch balance at previous block: for destroy events this captures pre-wipe balance,
    // and for blacklist/unblacklist it avoids same-block edge cases where the balance
    // might appear different due to other transactions in the same block.
    const blockForBalance = row.block_number - 1;

    if (config.chain.type === "tron") {
      row.amount = await fetchTronTokenBalance(
        config.contractAddress, row.address, trongridApiKey, tronLimiter, config.decimals, budget
      );
    } else if (config.chain.evmChainId != null) {
      row.amount = await fetchEvmTokenBalance(
        config, row.address, blockForBalance, etherscanApiKey, drpcApiKey, etherscanLimiter, budget
      );
    }
  }
}

// --- Backfill: update existing events that have null amounts ---

// Re-fetch event log from Etherscan to extract the amount from event data.
// Used for destroy events where balanceOf is unreliable (especially on L2s).
async function fetchDestroyAmountFromLog(
  evmChainId: number,
  contractAddress: string,
  txHash: string,
  config: ContractEventConfig,
  apiKey: string | null,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget
): Promise<number | null> {
  if (budgetExhausted(budget)) return null;

  // Fetch the transaction receipt to get logs
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
      const res = await fetch(`${ETHERSCAN_V2_BASE}?${params}`);
      if (!res.ok) { await res.body?.cancel(); return null; }
      return res.json() as Promise<{ result?: { logs?: EtherscanLogEntry[] } }>;
    });

    if (!json?.result?.logs) return null;

    // Find the destroy event log in the receipt
    const destroyEvents = config.events.filter((e) => e.eventType === "destroy" && e.hasAmount);
    for (const log of json.result.logs) {
      if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
      const matchingEvent = destroyEvents.find((e) => log.topics[0] === e.topicHash);
      if (!matchingEvent) continue;

      // Parse amount from the log data
      const addressIndexed = log.topics.length > 1;
      if (addressIndexed) {
        return log.data.length >= 66 ? decodeUint256(log.data, config.decimals) : null;
      } else {
        return log.data.length > 66 ? decodeUint256("0x" + log.data.slice(66), config.decimals) : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function backfillAmounts(
  db: D1Database,
  etherscanApiKey: string | null,
  trongridApiKey: string | null,
  drpcApiKey: string | null,
  etherscanLimiter: RateLimitedFetch,
  tronLimiter: RateLimitedFetch,
  budget: SubrequestBudget
): Promise<void> {
  const result = await db
    .prepare(
      `SELECT id, chain_id, event_type, address, block_number, stablecoin, tx_hash
       FROM blacklist_events
       WHERE event_type IN ('blacklist', 'unblacklist', 'destroy')
         AND (amount IS NULL OR (amount = 0 AND event_type = 'blacklist'))
       LIMIT ?`
    )
    .bind(BACKFILL_BATCH_SIZE)
    .all<{ id: string; chain_id: string; event_type: string; address: string; block_number: number; stablecoin: string; tx_hash: string }>();

  if (!result.results?.length) return;

  const stmts: D1PreparedStatement[] = [];

  for (const row of result.results) {
    if (budgetExhausted(budget)) break;

    const config = CONTRACT_CONFIGS.find((c) => c.chain.chainId === row.chain_id && c.stablecoin === row.stablecoin);
    if (!config) continue;

    let amount: number | null = null;

    if (row.event_type === "destroy" && config.chain.type === "evm" && config.chain.evmChainId != null) {
      // For destroy events, re-fetch the event log to get the amount from event data.
      // This is more reliable than balanceOf, especially on L2s without archive state.
      amount = await fetchDestroyAmountFromLog(
        config.chain.evmChainId, config.contractAddress, row.tx_hash, config, etherscanApiKey, etherscanLimiter, budget
      );
      // Fall back to balanceOf at block-1 only if log parsing failed
      if (amount == null) {
        amount = await fetchEvmTokenBalance(
          config, row.address, row.block_number - 1, etherscanApiKey, drpcApiKey, etherscanLimiter, budget
        );
      }
    } else if (config.chain.type === "tron") {
      amount = await fetchTronTokenBalance(
        config.contractAddress, row.address, trongridApiKey, tronLimiter, config.decimals, budget
      );
    } else if (config.chain.evmChainId != null) {
      amount = await fetchEvmTokenBalance(
        config, row.address, row.block_number - 1, etherscanApiKey, drpcApiKey, etherscanLimiter, budget
      );
    }

    if (amount != null) {
      stmts.push(
        db.prepare("UPDATE blacklist_events SET amount = ? WHERE id = ?").bind(amount, row.id)
      );
    }
  }

  if (stmts.length > 0) {
    await batchExecute(db, stmts);
    console.log(`[sync-blacklist] Backfilled amounts for ${stmts.length} events`);
  }
}

// --- Orchestrator ---

async function insertRows(db: D1Database, rows: BlacklistRow[]): Promise<void> {
  if (rows.length === 0) return;

  const stmts = rows.map((row) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO blacklist_events
         (id, stablecoin, chain_id, chain_name, event_type, address, amount, tx_hash, block_number, timestamp, explorer_tx_url, explorer_address_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        row.id,
        row.stablecoin,
        row.chain_id,
        row.chain_name,
        row.event_type,
        row.address,
        row.amount,
        row.tx_hash,
        row.block_number,
        row.timestamp,
        row.explorer_tx_url,
        row.explorer_address_url
      )
  );
  await batchExecute(db, stmts);
}

export async function syncBlacklist(
  db: D1Database,
  etherscanApiKey: string | null,
  trongridApiKey: string | null,
  drpcApiKey: string | null
): Promise<{ itemCount: number; metadata: string }> {
  const etherscanLimiter = createRateLimiter(4);
  const tronLimiter = createRateLimiter(3);
  const budget = createBudget(900);
  let totalNewEvents = 0;
  let contractsSkipped = 0;

  const configStates = await Promise.all(
    CONTRACT_CONFIGS.map(async (config) => {
      const configKey = `${config.chain.chainId}-${config.contractAddress}`;
      const lastBlock = await getLastBlock(db, configKey);
      return { config, configKey, lastBlock };
    })
  );

  // Backfill NULL amounts first — this has priority over new event scanning
  // because the worker may time out before completing the full config loop.
  try {
    await backfillAmounts(db, etherscanApiKey, trongridApiKey, drpcApiKey, etherscanLimiter, tronLimiter, budget);
  } catch (err) {
    console.warn("[sync-blacklist] Backfill failed:", err);
  }
  console.log(`[sync-blacklist] Backfill done, budget: ${budget.count}/${budget.limit}`);

  // Sort by lastBlock ascending so least-synced configs go first
  configStates.sort((a, b) => a.lastBlock - b.lastBlock);

  // Cache current block per EVM chain to avoid redundant API calls
  const chainHeadCache = new Map<number, number>();

  for (let ci = 0; ci < configStates.length; ci++) {
    const { config, configKey, lastBlock } = configStates[ci];
    if (budgetExhausted(budget)) {
      contractsSkipped = configStates.length - ci;
      console.log(`[sync-blacklist] Budget exhausted (${budget.count}/${budget.limit}), skipping ${contractsSkipped} remaining contracts`);
      break;
    }

    try {
      let result: { rows: BlacklistRow[]; maxBlock: number };

      if (config.chain.type === "tron") {
        result = await fetchTronEventsIncremental(config, trongridApiKey, lastBlock, tronLimiter, budget);

        await enrichRowBalances(
          result.rows, config, etherscanApiKey, trongridApiKey, drpcApiKey, etherscanLimiter, tronLimiter, budget
        );
        await insertRows(db, result.rows);

        // When no events found, advance toward current time but leave a safety margin
        // to avoid permanently skipping events the explorer hasn't indexed yet.
        const newBlock = result.rows.length > 0 ? result.maxBlock : Math.max(Date.now() - TRON_SAFETY_MS, lastBlock);
        if (newBlock > lastBlock) {
          await setLastBlock(db, configKey, newBlock);
        }
      } else {
        const evmChainId = config.chain.evmChainId!;
        // If lastBlock hit the sentinel (99999999), reset to 0 to re-scan.
        const wasReset = lastBlock >= EVM_SCANNED_TO_LATEST;
        const fromBlock = wasReset ? 0 : lastBlock > 0 ? lastBlock + 1 : 0;
        result = await fetchEvmEventsIncremental(config, etherscanApiKey, fromBlock, etherscanLimiter, budget);

        await enrichRowBalances(
          result.rows, config, etherscanApiKey, trongridApiKey, drpcApiKey, etherscanLimiter, tronLimiter, budget
        );
        await insertRows(db, result.rows);

        let newBlock: number;
        if (result.rows.length > 0) {
          newBlock = result.maxBlock;
        } else {
          // No new events — advance sync state toward chain head, but leave a safety
          // margin to avoid permanently skipping events that the explorer hasn't indexed yet.
          if (!chainHeadCache.has(evmChainId)) {
            const head = await getEvmBlockNumber(evmChainId, etherscanApiKey, etherscanLimiter, budget);
            if (head) chainHeadCache.set(evmChainId, head);
          }
          const head = chainHeadCache.get(evmChainId);
          const margin = evmSafetyMarginBlocks(evmChainId);
          // Fall back: if sentinel was reset, use 0 rather than staying stuck at sentinel
          newBlock = head ? Math.max(head - margin, lastBlock) : (wasReset ? 0 : lastBlock);
        }

        if (newBlock !== lastBlock) {
          await setLastBlock(db, configKey, newBlock);
        }
      }

      totalNewEvents += result.rows.length;
      const syncLabel = config.chain.type === "tron" ? "ts" : "block";
      console.log(
        `[sync-blacklist] ${config.stablecoin} on ${config.chain.chainName}: ${result.rows.length} new events, ${syncLabel} ${result.maxBlock}`
      );
    } catch (err) {
      console.warn(`[sync-blacklist] Failed ${config.stablecoin} on ${config.chain.chainName}:`, err);
    }
  }

  console.log(`[sync-blacklist] Completed with ${budget.count}/${budget.limit} subrequests`);
  return {
    itemCount: totalNewEvents,
    metadata: JSON.stringify({ contractsSkipped, budgetUsed: budget.count, budgetLimit: budget.limit }),
  };
}
