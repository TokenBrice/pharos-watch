import { getBlacklistTrackerMethodologyVersionAt } from "@shared/lib/blacklist-tracker-version";
import { computeBlacklistAmountUsdAtEvent } from "@shared/lib/blacklist";
import { decodeAbiParameters } from "viem/utils";
import {
  fetchAlchemyLogs,
  getAlchemyBlockNumber,
  resolveBlockTimestamps,
  type AlchemyLogEntry,
} from "../../lib/alchemy-logs";
import { throwIfAborted } from "../../lib/abort";
import {
  getBlacklistEventByTopic,
  getBlacklistTopicHashes,
  type BlacklistEventDef,
  type ContractEventConfig,
} from "../../lib/blacklist-contracts";
import { getChainRpc, type ChainRpcConfig } from "../../lib/chain-registry";
import {
  budgetExhausted,
  decodeAddress,
  decodeUint256,
  decodeUint256AtSlot,
  fetchEvmLogsForTopic,
  type EtherscanLogEntry,
  type RateLimitedFetch,
  type SubrequestBudget,
} from "../../lib/evm-logs";
import { buildExplorerAddressUrl, buildExplorerTxUrl, type BlacklistRow } from "./shared";

const RPC_LOG_SCAN_CHAIN_IDS = new Set(["base", "optimism", "avalanche", "bsc", "gnosis"]);
/** Per-chain `eth_getLogs` windows. Gnosis is capped at 9_000 because dRPC's free
 *  tier rejects any range > 10_000 blocks (verified 2026-04-17). */
export const RPC_LOG_SCAN_WINDOWS: Record<string, { alchemy: number; fallback: number }> = {
  base:      { alchemy: 500_000, fallback: 50_000 },
  optimism:  { alchemy: 500_000, fallback: 50_000 },
  avalanche: { alchemy: 250_000, fallback: 2_000 },
  bsc:       { alchemy: 250_000, fallback: 50_000 },
  gnosis:    { alchemy: 9_000,   fallback: 9_000 },
};

type EvmLogLike = Pick<
  EtherscanLogEntry,
  "address" | "topics" | "data" | "blockNumber" | "transactionHash" | "logIndex"
> & {
  timeStamp?: string;
};

type RpcLogTarget = {
  rpcUrl: string;
  chainHead: number;
  scanWindowBlocks: number | null;
};

export interface FetchEvmEventsIncrementalResult {
  rows: BlacklistRow[];
  maxBlock: number;
  apiError: boolean;
  chainHead: number | null;
  usedRpcLogs: boolean;
  scannedToBlock: number | null;
  incomplete: boolean;
}

function shouldPreferRpcLogScan(chainId: string): boolean {
  return RPC_LOG_SCAN_CHAIN_IDS.has(chainId);
}

function runtimeBudgetReached(deadlineMs: number): boolean {
  return Date.now() >= deadlineMs;
}

function decodeAddressArrayData(data: string): string[] {
  try {
    const [addresses] = decodeAbiParameters(
      [{ type: "address[]" }],
      data as `0x${string}`,
    );
    return [...addresses].map((address) => address.toLowerCase());
  } catch (error) {
    console.warn("[blacklist] Failed to decode address[] event data:", error);
    return [];
  }
}

function decodeAddressAtDataSlot(data: string, slotIndex: number): string | null {
  const cleaned = data.startsWith("0x") ? data.slice(2) : data;
  const slot = cleaned.slice(slotIndex * 64, slotIndex * 64 + 64);
  return slot.length >= 64 ? decodeAddress(slot) : null;
}

function buildBlacklistRow(
  config: ContractEventConfig,
  log: EvmLogLike,
  affectedAddress: string,
  amount: number | null,
  blockNumber: number,
  timestamp: number,
  rowSuffix = "",
): BlacklistRow | null {
  const eventDef = getBlacklistEventByTopic(config, log.topics[0]);
  if (!eventDef) return null;
  const methodologyVersion = getBlacklistTrackerMethodologyVersionAt(timestamp);

  return {
    id: `${config.chain.chainId}-${log.transactionHash}-${log.logIndex}${rowSuffix}`,
    stablecoin: config.stablecoin,
    chain_id: config.chain.chainId,
    chain_name: config.chain.chainName,
    event_type: eventDef.eventType,
    address: affectedAddress,
    amount_native: amount,
    amount_usd_at_event: computeBlacklistAmountUsdAtEvent(config.stablecoin, amount),
    amount_source: amount != null ? "event" : "unavailable",
    amount_status: amount != null ? "resolved" : "recoverable_pending",
    tx_hash: log.transactionHash,
    block_number: blockNumber,
    timestamp,
    methodology_version: methodologyVersion,
    contract_address: config.contractAddress,
    config_key: config.configKey,
    event_signature: eventDef.signature,
    event_topic0: log.topics[0] ?? null,
    suppression_reason: null,
    amount_attempt_count: 0,
    amount_last_attempted_at: null,
    amount_last_error_class: null,
    amount_last_provider: null,
    explorer_tx_url: buildExplorerTxUrl(config.chain, log.transactionHash),
    explorer_address_url: buildExplorerAddressUrl(config.chain, affectedAddress),
  };
}

function decodeEvmLogAmount(
  eventDef: BlacklistEventDef,
  log: EvmLogLike,
  decimals: number,
  addressFromTopic: boolean,
): number | null {
  if (!eventDef.hasAmount) return null;

  if (typeof eventDef.amountTopicIndex === "number" && log.topics.length > eventDef.amountTopicIndex) {
    return decodeUint256(log.topics[eventDef.amountTopicIndex]!, decimals);
  }
  if (typeof eventDef.amountDataIndex === "number") {
    return decodeUint256AtSlot(log.data, eventDef.amountDataIndex, decimals);
  }
  if (addressFromTopic) {
    return log.data.length >= 66 ? decodeUint256(log.data, decimals) : null;
  }
  return log.data.length > 66 ? decodeUint256("0x" + log.data.slice(66), decimals) : null;
}

export function parseEvmLogs(
  config: ContractEventConfig,
  logs: EvmLogLike[],
  blockTimestamps?: Map<number, number>,
): BlacklistRow[] {
  const rows: BlacklistRow[] = [];
  for (const log of logs) {
    const eventDef = getBlacklistEventByTopic(config, log.topics[0]);
    if (!eventDef) continue;
    const blockNumber = parseInt(log.blockNumber, 16);
    const timestamp = log.timeStamp ? parseInt(log.timeStamp, 16) : (blockTimestamps?.get(blockNumber) ?? Number.NaN);
    if (isNaN(blockNumber) || isNaN(timestamp)) continue;

    if (eventDef.addressArrayData) {
      const addresses = decodeAddressArrayData(log.data);
      addresses.forEach((affectedAddress, index) => {
        const row = buildBlacklistRow(config, log, affectedAddress, null, blockNumber, timestamp, `-${index}`);
        if (row) rows.push(row);
      });
      continue;
    }

    const topicIdx = eventDef.addressTopicIndex ?? 1;
    const forcedDataAddress =
      typeof eventDef.addressDataIndex === "number"
        ? decodeAddressAtDataSlot(log.data, eventDef.addressDataIndex)
        : null;
    const addressFromTopic = forcedDataAddress == null && log.topics.length > topicIdx;
    const affectedAddress = forcedDataAddress ?? (addressFromTopic ? decodeAddress(log.topics[topicIdx]) : decodeAddress(log.data.slice(0, 66)));
    const amount = decodeEvmLogAmount(eventDef, log, config.decimals, addressFromTopic);

    const row = buildBlacklistRow(config, log, affectedAddress, amount, blockNumber, timestamp);
    if (row) rows.push(row);
  }
  return rows;
}

export async function resolveRpcLogTarget(
  chainId: string,
  budget: SubrequestBudget,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<RpcLogTarget | null> {
  if (!chainRpcs) return null;
  const rpc = getChainRpc(chainRpcs, chainId);
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

export async function fetchEvmEventsIncremental(
  db: D1Database,
  config: ContractEventConfig,
  apiKey: string | null,
  fromBlock: number,
  timestampCache: Map<number, number>,
  deadlineMs: number,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<FetchEvmEventsIncrementalResult> {
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
  let rpcTargetPromise: Promise<RpcLogTarget | null> | null = null;
  const getRpcTarget = (): Promise<RpcLogTarget | null> => {
    rpcTargetPromise ??= resolveRpcLogTarget(config.chain.chainId, budget, signal, chainRpcs);
    return rpcTargetPromise;
  };

  for (const topicHash of getBlacklistTopicHashes(config)) {
    throwIfAborted(signal);
    if (runtimeBudgetReached(deadlineMs)) {
      incomplete = true;
      break;
    }
    if (budgetExhausted(budget)) {
      incomplete = true;
      break;
    }

    let rows: BlacklistRow[] = [];
    let fetched = false;
    let sourceHadGap = false;
    const preferRpcLogs = shouldPreferRpcLogScan(config.chain.chainId);

    if (!preferRpcLogs) {
      const logs = await fetchEvmLogsForTopic(
        evmChainId,
        config.contractAddress,
        topicHash,
        apiKey,
        fromBlock,
        99999999,
        0,
        rateLimit,
        budget,
        signal,
      );
      if (logs !== null) {
        rows = parseEvmLogs(config, logs);
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
                [{ index: 0, value: topicHash }],
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

          rows = parseEvmLogs(config, fetchedLogs.logs as Array<AlchemyLogEntry>, blockTimestamps);
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
