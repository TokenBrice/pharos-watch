import { CONTRACT_CONFIGS, type ContractEventConfig, type ChainConfig } from "../lib/blacklist-contracts";
import { ETHERSCAN_V2_BASE } from "../lib/constants";
import type { BlacklistEventType } from "@shared/types";
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
import {
  fetchAlchemyLogs,
  getAlchemyBlockNumber,
  resolveBlockTimestamps,
  type AlchemyLogEntry,
} from "../lib/alchemy-logs";
import { getChainRpc } from "../lib/chain-registry";
import { getBlacklistTrackerMethodologyVersionAt } from "@shared/lib/blacklist-tracker-version";
import { fetchWithRetry } from "../lib/fetch-retry";
import { throwIfAborted } from "../lib/abort";
import type { CronProgressReporter } from "../lib/db";

const EVM_SCANNED_TO_LATEST = 99999999;
const BACKFILL_BATCH_SIZE = 50;
const RPC_LOG_SCAN_CHAIN_IDS = new Set(["base", "optimism", "avalanche", "bsc"]);
const SYNC_BLACKLIST_RUNTIME_BUDGET_MS = 7 * 60_000;
const SYNC_BLACKLIST_MIN_CONFIG_WINDOW_MS = 60_000;
const RPC_LOG_SCAN_WINDOWS: Record<string, { alchemy: number; fallback: number }> = {
  base: { alchemy: 500_000, fallback: 50_000 },
  optimism: { alchemy: 500_000, fallback: 50_000 },
  avalanche: { alchemy: 250_000, fallback: 2_000 },
  bsc: { alchemy: 250_000, fallback: 50_000 },
};

type SyncBlacklistResult = {
  itemCount: number;
  metadata: string;
  status: "ok" | "degraded" | "error";
};

// Safety margin when advancing sync state to chain head (prevents permanent event loss
// if block explorer indexing lags behind chain tip). 15 minutes in seconds/ms.
const INDEXING_SAFETY_SEC = 900;
const TRON_SAFETY_MS = INDEXING_SAFETY_SEC * 1000;

// Approximate block times (seconds) per EVM chain — used to compute safety margin in blocks.
const EVM_BLOCK_TIME: Record<number, number> = {
  1: 12, // Ethereum
  42161: 0.25, // Arbitrum
  8453: 2, // Base
  10: 2, // Optimism
  137: 2, // Polygon
  43114: 2, // Avalanche
  56: 3, // BSC
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

function shouldPreferRpcLogScan(chainId: string): boolean {
  return RPC_LOG_SCAN_CHAIN_IDS.has(chainId);
}

function runtimeBudgetReached(deadlineMs: number): boolean {
  return Date.now() >= deadlineMs;
}

function shouldStopBeforeNextConfig(deadlineMs: number): boolean {
  return Date.now() + SYNC_BLACKLIST_MIN_CONFIG_WINDOW_MS >= deadlineMs;
}

// --- Balance fetching ---

async function fetchEvmBalanceAtTag(
  evmChainId: number,
  contractAddress: string,
  address: string,
  tag: string,
  apiKey: string | null,
  rateLimit: RateLimitedFetch,
  decimals: number,
  budget: SubrequestBudget,
  signal?: AbortSignal,
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
      const res = await fetchWithRetry(`${ETHERSCAN_V2_BASE}?${params}`, signal ? { signal } : undefined);
      if (!res) return null;
      return res.json() as Promise<{ result?: string; error?: unknown }>;
    });

    // API failure, error response, or empty/invalid eth_call result → unknown
    if (!json?.result || json.error || !json.result.startsWith("0x") || json.result.length < 4) {
      return null;
    }

    return bigIntToDecimal(BigInt(json.result), decimals);
  } catch (e) {
    console.warn("[sync-blacklist] fetchEvmBalanceAtTag failed:", e);
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
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<number | null> {
  if (budgetExhausted(budget)) return null;

  const network = DRPC_NETWORK[chainId];
  if (!network) return null;

  const addr = (address.startsWith("0x") ? address.slice(2) : address).toLowerCase();
  const data = "0x70a08231" + addr.padStart(64, "0");
  const blockTag = "0x" + blockNumber.toString(16);

  try {
    budget.count++;
    const res = await fetchWithRetry(`https://lb.drpc.org/ogrpc?network=${network}&dkey=${drpcApiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: contractAddress, data }, blockTag],
      }),
      signal,
    });
    if (!res) return null;
    const json = (await res.json()) as { result?: string; error?: unknown };

    if (!json?.result || json.error || !json.result.startsWith("0x") || json.result.length < 4) {
      return null;
    }

    return bigIntToDecimal(BigInt(json.result), decimals);
  } catch (e) {
    console.warn("[sync-blacklist] fetchBalanceViaDrpc failed:", e);
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
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<number | null> {
  // L2 chains: use dRPC archive for historical balanceOf.
  // Etherscan v2 free plan doesn't support eth_call on L2s.
  if (config.chain.evmChainId !== 1 && drpcApiKey) {
    return fetchBalanceViaDrpc(
      config.chain.chainId,
      config.contractAddress,
      address,
      blockNumber,
      drpcApiKey,
      config.decimals,
      budget,
      signal,
    );
  }

  // Ethereum mainnet: use Etherscan eth_call with historical block tag
  const blockTag = "0x" + blockNumber.toString(16);
  return fetchEvmBalanceAtTag(
    config.chain.evmChainId!,
    config.contractAddress,
    address,
    blockTag,
    etherscanApiKey,
    rateLimit,
    config.decimals,
    budget,
    signal,
  );
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
  methodology_version: string;
  explorer_tx_url: string;
  explorer_address_url: string;
}

type EvmLogLike = Pick<
  EtherscanLogEntry,
  "address" | "topics" | "data" | "blockNumber" | "transactionHash" | "logIndex"
> & {
  timeStamp?: string;
};

function parseEvmLogs(
  config: ContractEventConfig,
  eventType: BlacklistEventType,
  hasAmount: boolean,
  logs: EvmLogLike[],
  blockTimestamps?: Map<number, number>,
): BlacklistRow[] {
  return logs
    .map((log) => {
      const addressIndexed = log.topics.length > 1;
      const affectedAddress = addressIndexed ? decodeAddress(log.topics[1]) : decodeAddress(log.data.slice(0, 66));

      // When address is indexed (in topics), amount is the first data field.
      // When address is non-indexed (in data), amount is the second data field.
      const amount = hasAmount
        ? addressIndexed
          ? log.data.length >= 66
            ? decodeUint256(log.data, config.decimals)
            : null
          : log.data.length > 66
            ? decodeUint256("0x" + log.data.slice(66), config.decimals)
            : null
        : null;

      const blockNumber = parseInt(log.blockNumber, 16);
      const timestamp = log.timeStamp ? parseInt(log.timeStamp, 16) : (blockTimestamps?.get(blockNumber) ?? Number.NaN);
      if (isNaN(blockNumber) || isNaN(timestamp)) return null;
      const methodologyVersion = getBlacklistTrackerMethodologyVersionAt(timestamp);

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
        methodology_version: methodologyVersion,
        explorer_tx_url: buildExplorerTxUrl(config.chain, log.transactionHash),
        explorer_address_url: buildExplorerAddressUrl(config.chain, affectedAddress),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null) as BlacklistRow[];
}

async function resolveRpcLogTarget(
  chainId: string,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<{ rpcUrl: string; chainHead: number; scanWindowBlocks: number | null } | null> {
  const rpc = getChainRpc(chainId);
  if (!rpc || rpc.type !== "evm") return null;

  const rpcTargets = [
    { url: rpc.rpcUrl, alchemyPrimary: rpc.alchemyPrimary === true },
    { url: rpc.fallbackRpcUrl, alchemyPrimary: false },
  ].filter(
    (target): target is { url: string; alchemyPrimary: boolean } =>
      typeof target.url === "string" && target.url.length > 0,
  );

  for (const target of rpcTargets) {
    const chainHead = await getAlchemyBlockNumber(target.url, budget, signal);
    if (chainHead != null) {
      const chainWindow = RPC_LOG_SCAN_WINDOWS[chainId];
      return {
        rpcUrl: target.url,
        chainHead,
        scanWindowBlocks: chainWindow ? (target.alchemyPrimary ? chainWindow.alchemy : chainWindow.fallback) : null,
      };
    }
  }

  return null;
}

async function fetchEvmEventsIncremental(
  db: D1Database,
  config: ContractEventConfig,
  apiKey: string | null,
  fromBlock: number,
  timestampCache: Map<number, number>,
  deadlineMs: number,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<{
  rows: BlacklistRow[];
  maxBlock: number;
  apiError: boolean;
  chainHead: number | null;
  usedRpcLogs: boolean;
  scannedToBlock: number | null;
  incomplete: boolean;
}> {
  const evmChainId = config.chain.evmChainId;
  if (evmChainId == null) {
    return {
      rows: [],
      maxBlock: fromBlock,
      apiError: false,
      chainHead: null,
      usedRpcLogs: false,
      scannedToBlock: null,
      incomplete: false,
    };
  }

  const allRows: BlacklistRow[] = [];
  let maxBlock = fromBlock;
  let apiError = false;
  let chainHead: number | null = null;
  let usedRpcLogs = false;
  let scannedToBlock: number | null = null;
  let incomplete = false;
  let rpcTargetPromise: Promise<{ rpcUrl: string; chainHead: number; scanWindowBlocks: number | null } | null> | null = null;
  const getRpcTarget = (): Promise<{ rpcUrl: string; chainHead: number; scanWindowBlocks: number | null } | null> => {
    rpcTargetPromise ??= resolveRpcLogTarget(config.chain.chainId, budget, signal);
    return rpcTargetPromise;
  };

  for (const eventDef of config.events) {
    throwIfAborted(signal);
    if (runtimeBudgetReached(deadlineMs)) {
      incomplete = true;
      break;
    }
    if (budgetExhausted(budget)) break;

    let rows: BlacklistRow[] = [];
    let fetched = false;
    let sourceHadGap = false;
    const preferRpcLogs = shouldPreferRpcLogScan(config.chain.chainId);

    if (!preferRpcLogs) {
      const logs = await fetchEvmLogsForTopic(
        evmChainId,
        config.contractAddress,
        eventDef.topicHash,
        apiKey,
        fromBlock,
        99999999,
        0,
        rateLimit,
        budget,
        signal,
      );

      if (logs !== null) {
        rows = parseEvmLogs(config, eventDef.eventType, eventDef.hasAmount, logs);
        fetched = true;
      }
    }

    if (!fetched) {
      const rpcTarget = await getRpcTarget();
      if (rpcTarget) {
        chainHead = rpcTarget.chainHead;
        usedRpcLogs = true;
        const scanToBlock = rpcTarget.scanWindowBlocks != null
          ? Math.min(rpcTarget.chainHead, fromBlock + rpcTarget.scanWindowBlocks - 1)
          : rpcTarget.chainHead;

        const fetchedLogs =
          fromBlock > scanToBlock
            ? { logs: [], complete: true, scannedToBlock: scanToBlock, calls: 0, maxDepth: 0 }
            : await fetchAlchemyLogs(
                rpcTarget.rpcUrl,
                config.contractAddress,
                [{ index: 0, value: eventDef.topicHash }],
                fromBlock,
                scanToBlock,
                budget,
                signal,
              );

        if (fetchedLogs) {
          const uniqueBlocks = [
            ...new Set(
              fetchedLogs.logs.map((log) => parseInt(log.blockNumber, 16)).filter((block) => Number.isFinite(block)),
            ),
          ];
          const blockTimestamps =
            uniqueBlocks.length > 0
              ? await resolveBlockTimestamps(rpcTarget.rpcUrl, uniqueBlocks, budget, {
                  signal,
                  localCache: timestampCache,
                  persistentCache: {
                    db,
                    chainId: config.chain.chainId,
                  },
                })
              : new Map<number, number>();
          let eventScannedToBlock = fetchedLogs.scannedToBlock;
          if (uniqueBlocks.length > blockTimestamps.size) {
            const earliestMissingBlock = uniqueBlocks
              .filter((block) => !blockTimestamps.has(block))
              .reduce((min, block) => Math.min(min, block), Number.POSITIVE_INFINITY);
            if (Number.isFinite(earliestMissingBlock)) {
              eventScannedToBlock = Math.min(eventScannedToBlock, earliestMissingBlock - 1);
            }
          }
          scannedToBlock = scannedToBlock == null ? eventScannedToBlock : Math.min(scannedToBlock, eventScannedToBlock);

          rows = parseEvmLogs(
            config,
            eventDef.eventType,
            eventDef.hasAmount,
            fetchedLogs.logs as Array<AlchemyLogEntry>,
            blockTimestamps,
          );
          fetched = true;
          sourceHadGap =
            !fetchedLogs.complete || (uniqueBlocks.length > 0 && blockTimestamps.size < uniqueBlocks.length);
        }
      }
    }

    if (!fetched) {
      apiError = true;
      continue;
    }

    if (sourceHadGap) {
      apiError = true;
    }

    allRows.push(...rows);

    for (const row of rows) {
      if (row.block_number > maxBlock) maxBlock = row.block_number;
    }
  }

  return {
    rows: allRows,
    maxBlock,
    apiError,
    chainHead,
    usedRpcLogs,
    scannedToBlock,
    incomplete,
  };
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
  deadlineMs: number,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<{ rows: BlacklistRow[]; maxBlock: number; incomplete: boolean }> {
  const rows: BlacklistRow[] = [];
  let maxBlock = 0;
  let incomplete = false;
  const headers: Record<string, string> = {};
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;

  for (const eventName of TRON_EVENT_NAMES) {
    throwIfAborted(signal);
    if (runtimeBudgetReached(deadlineMs)) {
      incomplete = true;
      break;
    }
    if (budgetExhausted(budget)) break;

    const tsFilter = lastTimestampMs > 0 ? `&min_block_timestamp=${lastTimestampMs}` : "";
    let url: string | null =
      `https://api.trongrid.io/v1/contracts/${config.contractAddress}/events?event_name=${eventName}&limit=200&order_by=block_timestamp,desc${tsFilter}`;

    while (url) {
      throwIfAborted(signal);
      if (runtimeBudgetReached(deadlineMs)) {
        incomplete = true;
        break;
      }
      if (budgetExhausted(budget)) break;

      budget.count++;
      const json: TronEventsResponse | null = await rateLimit(async () => {
        const res = await fetchWithRetry(url!, { headers, signal });
        if (!res) return null;
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
        const timestamp = Math.floor(evt.block_timestamp / 1000);
        const methodologyVersion = getBlacklistTrackerMethodologyVersionAt(timestamp);

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
          timestamp,
          methodology_version: methodologyVersion,
          explorer_tx_url: buildExplorerTxUrl(config.chain, evt.transaction_id),
          explorer_address_url: buildExplorerAddressUrl(config.chain, affectedAddress),
        });
      }

      url = json.meta?.links?.next || null;
    }

    if (incomplete) break;
  }

  return { rows, maxBlock, incomplete };
}

// --- Enrichment: fetch balances for blacklist/unblacklist events ---

async function enrichRowBalances(
  rows: BlacklistRow[],
  config: ContractEventConfig,
  etherscanApiKey: string | null,
  drpcApiKey: string | null,
  etherscanLimiter: RateLimitedFetch,
  budget: SubrequestBudget,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<void> {
  for (const row of rows) {
    throwIfAborted(signal);
    if (runtimeBudgetReached(deadlineMs)) break;
    if (budgetExhausted(budget)) break;
    if (row.amount != null) continue;
    if (row.event_type !== "blacklist" && row.event_type !== "unblacklist" && row.event_type !== "destroy") continue;

    // Fetch balance at previous block: for destroy events this captures pre-wipe balance,
    // and for blacklist/unblacklist it avoids same-block edge cases where the balance
    // might appear different due to other transactions in the same block.
    const blockForBalance = row.block_number - 1;

    if (config.chain.type === "tron") {
      // TronGrid account balance endpoint returns current state, not event-time state.
      // To avoid false precision, keep Tron blacklist/unblacklist amounts null unless
      // the amount is emitted natively in the event payload (e.g. destroy).
      continue;
    } else if (config.chain.evmChainId != null) {
      row.amount = await fetchEvmTokenBalance(
        config,
        row.address,
        blockForBalance,
        etherscanApiKey,
        drpcApiKey,
        etherscanLimiter,
        budget,
        signal,
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
  budget: SubrequestBudget,
  signal?: AbortSignal,
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
      const res = await fetchWithRetry(`${ETHERSCAN_V2_BASE}?${params}`, signal ? { signal } : undefined);
      if (!res) return null;
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
  } catch (e) {
    console.warn("[sync-blacklist] fetchDestroyAmountFromLog failed:", e);
    return null;
  }
}

async function backfillAmounts(
  db: D1Database,
  etherscanApiKey: string | null,
  drpcApiKey: string | null,
  etherscanLimiter: RateLimitedFetch,
  budget: SubrequestBudget,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<{ runtimeBudgetReached: boolean }> {
  if (runtimeBudgetReached(deadlineMs)) {
    return { runtimeBudgetReached: true };
  }

  const result = await db
    .prepare(
      `SELECT id, chain_id, event_type, address, block_number, stablecoin, tx_hash
       FROM blacklist_events
       WHERE event_type IN ('blacklist', 'unblacklist', 'destroy')
         AND amount IS NULL
       LIMIT ?`,
    )
    .bind(BACKFILL_BATCH_SIZE)
    .all<{
      id: string;
      chain_id: string;
      event_type: string;
      address: string;
      block_number: number;
      stablecoin: string;
      tx_hash: string;
    }>();

  if (!result.results?.length) return { runtimeBudgetReached: false };

  const stmts: D1PreparedStatement[] = [];
  let runtimeBudgetHit = false;

  for (const row of result.results) {
    throwIfAborted(signal);
    if (runtimeBudgetReached(deadlineMs)) {
      runtimeBudgetHit = true;
      break;
    }
    if (budgetExhausted(budget)) break;

    const config = CONTRACT_CONFIGS.find((c) => c.chain.chainId === row.chain_id && c.stablecoin === row.stablecoin);
    if (!config) continue;

    let amount: number | null = null;

    if (row.event_type === "destroy" && config.chain.type === "evm" && config.chain.evmChainId != null) {
      // For destroy events, re-fetch the event log to get the amount from event data.
      // This is more reliable than balanceOf, especially on L2s without archive state.
      amount = await fetchDestroyAmountFromLog(
        config.chain.evmChainId,
        config.contractAddress,
        row.tx_hash,
        config,
        etherscanApiKey,
        etherscanLimiter,
        budget,
        signal,
      );
      // Fall back to balanceOf at block-1 only if log parsing failed
      if (amount == null) {
        amount = await fetchEvmTokenBalance(
          config,
          row.address,
          row.block_number - 1,
          etherscanApiKey,
          drpcApiKey,
          etherscanLimiter,
          budget,
          signal,
        );
      }
    } else if (config.chain.type === "tron") {
      // Skip Tron amount backfill for non-event-native amounts. Current-balance based
      // reconstruction is not event-time accurate.
      continue;
    } else if (config.chain.evmChainId != null) {
      amount = await fetchEvmTokenBalance(
        config,
        row.address,
        row.block_number - 1,
        etherscanApiKey,
        drpcApiKey,
        etherscanLimiter,
        budget,
        signal,
      );
    }

    if (amount != null) {
      stmts.push(db.prepare("UPDATE blacklist_events SET amount = ? WHERE id = ?").bind(amount, row.id));
    }
  }

  if (stmts.length > 0) {
    await batchExecute(db, stmts);
    console.log(`[sync-blacklist] Backfilled amounts for ${stmts.length} events`);
  }

  return { runtimeBudgetReached: runtimeBudgetHit };
}

// --- Orchestrator ---

async function insertRows(db: D1Database, rows: BlacklistRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  const stmts = rows.map((row) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO blacklist_events
         (id, stablecoin, chain_id, chain_name, event_type, address, amount, tx_hash, block_number, timestamp, methodology_version, explorer_tx_url, explorer_address_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        row.methodology_version,
        row.explorer_tx_url,
        row.explorer_address_url,
      ),
  );
  return batchExecute(db, stmts);
}

export async function syncBlacklist(
  db: D1Database,
  etherscanApiKey: string | null,
  trongridApiKey: string | null,
  drpcApiKey: string | null,
  externalEtherscanRL?: RateLimitedFetch,
  signal?: AbortSignal,
  onProgress?: CronProgressReporter,
): Promise<SyncBlacklistResult> {
  const etherscanLimiter = externalEtherscanRL ?? createRateLimiter(4);
  const tronLimiter = createRateLimiter(3);
  const budget = createBudget(900);
  const deadlineMs = Date.now() + SYNC_BLACKLIST_RUNTIME_BUDGET_MS;
  let totalFetchedEvents = 0;
  let totalInsertedRows = 0;
  let contractsSkipped = 0;
  let apiErrors = 0;
  let rpcLogConfigs = 0;
  let runtimeBudgetHit = false;
  const apiErrorClasses: Record<string, number> = {};
  const apiErrorConfigs: Array<{
    configKey: string;
    stablecoin: string;
    chainId: string;
    reason: string;
  }> = [];
  const chainTimestampCaches = new Map<string, Map<number, number>>();
  const getChainTimestampCache = (chainId: string): Map<number, number> => {
    let cache = chainTimestampCaches.get(chainId);
    if (!cache) {
      cache = new Map<number, number>();
      chainTimestampCaches.set(chainId, cache);
    }
    return cache;
  };

  const configStates = await Promise.all(
    CONTRACT_CONFIGS.map(async (config) => {
      const configKey = `${config.chain.chainId}-${config.contractAddress}`;
      const lastBlock = await getLastBlock(db, configKey);
      return { config, configKey, lastBlock };
    }),
  );
  const zeroCursorConfigs = configStates.filter((state) => state.lastBlock === 0).map((state) => state.configKey);
  const recordApiErrorConfig = (configKey: string, stablecoin: string, chainId: string, reason: string): void => {
    if (apiErrorConfigs.length >= 10) return;
    apiErrorConfigs.push({ configKey, stablecoin, chainId, reason });
  };

  // Backfill NULL amounts first — this has priority over new event scanning
  // because the worker may time out before completing the full config loop.
  try {
    const backfill = await backfillAmounts(
      db,
      etherscanApiKey,
      drpcApiKey,
      etherscanLimiter,
      budget,
      deadlineMs,
      signal,
    );
    runtimeBudgetHit ||= backfill.runtimeBudgetReached;
  } catch (err) {
    console.warn("[sync-blacklist] Backfill failed:", err);
  }
  console.log(`[sync-blacklist] Backfill done, budget: ${budget.count}/${budget.limit}`);
  await onProgress?.({
    stage: "backfill-amounts",
    itemsDone: 0,
    itemsTotal: configStates.length,
    message: `Backfill pass complete; scanning ${configStates.length} blacklist config(s)`,
    metadata: {
      budgetUsed: budget.count,
      budgetLimit: budget.limit,
    },
  });

  // Sort by lastBlock ascending so least-synced configs go first
  configStates.sort((a, b) => a.lastBlock - b.lastBlock);

  // Cache current block per EVM chain to avoid redundant API calls
  const chainHeadCache = new Map<number, number>();

  for (let ci = 0; ci < configStates.length; ci++) {
    throwIfAborted(signal);
    if (shouldStopBeforeNextConfig(deadlineMs)) {
      runtimeBudgetHit = true;
      contractsSkipped = configStates.length - ci;
      console.warn(`[sync-blacklist] Runtime budget reached, skipping ${contractsSkipped} remaining contracts`);
      break;
    }
    const { config, configKey, lastBlock } = configStates[ci];
    await onProgress?.({
      stage: "scan-config",
      itemsDone: ci,
      itemsTotal: configStates.length,
      message: `Scanning ${config.stablecoin} on ${config.chain.chainName}`,
      metadata: {
        configKey,
        stablecoin: config.stablecoin,
        chainId: config.chain.chainId,
        budgetUsed: budget.count,
        budgetLimit: budget.limit,
      },
    });
    if (budgetExhausted(budget)) {
      contractsSkipped = configStates.length - ci;
      console.log(
        `[sync-blacklist] Budget exhausted (${budget.count}/${budget.limit}), skipping ${contractsSkipped} remaining contracts`,
      );
      break;
    }

    try {
      let result: {
        rows: BlacklistRow[];
        maxBlock: number;
        apiError?: boolean;
        chainHead?: number | null;
        usedRpcLogs?: boolean;
        scannedToBlock?: number | null;
        incomplete?: boolean;
      };

      if (config.chain.type === "tron") {
        result = await fetchTronEventsIncremental(
          config,
          trongridApiKey,
          lastBlock,
          deadlineMs,
          tronLimiter,
          budget,
          signal,
        );

        await enrichRowBalances(
          result.rows,
          config,
          etherscanApiKey,
          drpcApiKey,
          etherscanLimiter,
          budget,
          deadlineMs,
          signal,
        );
        totalInsertedRows += await insertRows(db, result.rows);

        if (result.incomplete) {
          runtimeBudgetHit = true;
          console.warn(
            `[sync-blacklist] Runtime budget reached while scanning ${config.stablecoin} on ${config.chain.chainName}, keeping sync at ts ${lastBlock}`,
          );
        } else {
          // When no events found, advance toward current time but leave a safety margin
          // to avoid permanently skipping events the explorer hasn't indexed yet.
          const newBlock = result.rows.length > 0 ? result.maxBlock : Math.max(Date.now() - TRON_SAFETY_MS, lastBlock);
          if (newBlock > lastBlock) {
            await setLastBlock(db, configKey, newBlock);
          }
        }
      } else {
        const evmChainId = config.chain.evmChainId!;
        // If lastBlock hit the sentinel (99999999), reset to 0 to re-scan.
        const wasReset = lastBlock >= EVM_SCANNED_TO_LATEST;
        const configuredStartBlock =
          typeof config.startBlock === "number" && Number.isFinite(config.startBlock) && config.startBlock > 0
            ? Math.floor(config.startBlock)
            : 0;
        const fromBlock = wasReset
          ? configuredStartBlock
          : lastBlock > 0
            ? lastBlock + 1
            : configuredStartBlock;
        result = await fetchEvmEventsIncremental(
          db,
          config,
          etherscanApiKey,
          fromBlock,
          getChainTimestampCache(config.chain.chainId),
          deadlineMs,
          etherscanLimiter,
          budget,
          signal,
        );
        if (result.usedRpcLogs) {
          rpcLogConfigs++;
        }

        await enrichRowBalances(
          result.rows,
          config,
          etherscanApiKey,
          drpcApiKey,
          etherscanLimiter,
          budget,
          deadlineMs,
          signal,
        );
        totalInsertedRows += await insertRows(db, result.rows);

        let newBlock: number;
        if (result.incomplete) {
          runtimeBudgetHit = true;
          newBlock = lastBlock;
          console.warn(
            `[sync-blacklist] Runtime budget reached while scanning ${config.stablecoin} on ${config.chain.chainName}, keeping sync at block ${lastBlock}`,
          );
        } else if (result.apiError) {
          const partialAdvance = result.scannedToBlock;
          apiErrors++;
          recordApiErrorConfig(
            configKey,
            config.stablecoin,
            config.chain.chainId,
            partialAdvance != null && partialAdvance > lastBlock ? "partial-coverage" : "no-coverage",
          );
          if (partialAdvance != null && partialAdvance > lastBlock) {
            newBlock = partialAdvance;
            console.warn(
              `[sync-blacklist] Partial coverage scanning ${config.stablecoin} on ${config.chain.chainName}, advancing sync from ${lastBlock} to ${newBlock}`,
            );
          } else {
            console.warn(
              `[sync-blacklist] API error scanning ${config.stablecoin} on ${config.chain.chainName}, keeping sync at block ${lastBlock}`,
            );
            newBlock = lastBlock;
          }
        } else if (result.rows.length > 0) {
          newBlock = result.maxBlock;
        } else {
          // Genuine no events — advance sync state toward chain head, but leave a safety
          // margin to avoid permanently skipping events that the explorer hasn't indexed yet.
          if (!chainHeadCache.has(evmChainId)) {
            const head =
              result.chainHead ??
              (await getEvmBlockNumber(evmChainId, etherscanApiKey, etherscanLimiter, budget, signal));
            if (head) chainHeadCache.set(evmChainId, head);
          }
          const head = chainHeadCache.get(evmChainId);
          const margin = evmSafetyMarginBlocks(evmChainId);
          if (
            result.usedRpcLogs &&
            result.scannedToBlock != null &&
            head != null &&
            result.scannedToBlock < head
          ) {
            newBlock = Math.max(result.scannedToBlock, lastBlock);
          } else {
            // Fall back: if sentinel was reset, use the configured start block rather than staying stuck at sentinel.
            newBlock = head
              ? Math.max(head - margin, lastBlock)
              : wasReset
                ? configuredStartBlock
                : lastBlock;
          }
        }

        if (newBlock !== lastBlock) {
          await setLastBlock(db, configKey, newBlock);
        }
      }

      totalFetchedEvents += result.rows.length;
      const syncLabel = config.chain.type === "tron" ? "ts" : "block";
      console.log(
        `[sync-blacklist] ${config.stablecoin} on ${config.chain.chainName}: ${result.rows.length} new events, ${syncLabel} ${result.maxBlock}`,
      );
    } catch (err) {
      apiErrors++;
      const errorClass = err instanceof Error ? err.name : "UnknownError";
      apiErrorClasses[errorClass] = (apiErrorClasses[errorClass] ?? 0) + 1;
      recordApiErrorConfig(configKey, config.stablecoin, config.chain.chainId, `exception:${errorClass}`);
      console.warn(`[sync-blacklist] Failed ${config.stablecoin} on ${config.chain.chainName}:`, err);
    }
  }

  console.log(`[sync-blacklist] Completed with ${budget.count}/${budget.limit} subrequests`);
  await onProgress?.({
    stage: "complete",
    itemsDone: configStates.length,
    itemsTotal: configStates.length,
    message: "Completed blacklist sync",
    metadata: {
      rowsWritten: totalInsertedRows,
      eventsFetched: totalFetchedEvents,
      budgetUsed: budget.count,
      budgetLimit: budget.limit,
      contractsSkipped,
      apiErrors,
    },
  });
  const status: SyncBlacklistResult["status"] =
    apiErrors > 0
      ? apiErrors > CONTRACT_CONFIGS.length / 2
        ? "error"
        : "degraded"
      : runtimeBudgetHit
        ? "degraded"
        : "ok";
  return {
    status,
    itemCount: totalInsertedRows,
    metadata: JSON.stringify({
      rowsWritten: totalInsertedRows,
      eventsFetched: totalFetchedEvents,
      contractsSkipped,
      apiErrors,
      apiErrorConfigs,
      zeroCursorConfigCount: zeroCursorConfigs.length,
      zeroCursorConfigs: zeroCursorConfigs.slice(0, 10),
      rpcLogConfigs,
      apiErrorClasses,
      budgetUsed: budget.count,
      budgetLimit: budget.limit,
      runtimeBudgetReached: runtimeBudgetHit,
      runtimeBudgetMs: SYNC_BLACKLIST_RUNTIME_BUDGET_MS,
    }),
  };
}
