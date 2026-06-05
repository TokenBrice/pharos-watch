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
import type { BlacklistEventType } from "@shared/types/market";
import { getChainRpc, type ChainRpcConfig } from "../../lib/chain-registry";
import {
  decodeAddressWord,
  decodeUint256AtSlotOrNull,
  decodeUint256Word,
  fetchEvmLogsForTopicWithCompleteness,
  readDataWord,
  type EtherscanLogEntry,
  type RateLimitedFetch,
} from "../../lib/evm-logs";
import { buildBlacklistRow, type BlacklistRow } from "./shared";
import {
  blacklistRuntimeBudgetReached,
  blacklistSubrequestBudgetReached,
  type BlacklistRunBudget,
} from "./run-budget";

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

export function shouldPreferRpcLogScan(chainId: string): boolean {
  return RPC_LOG_SCAN_CHAIN_IDS.has(chainId);
}

/** Maximum plausible size of an address[] batch event — well above any real
 * AccountsBlocked or AddedToDenyList batch we've observed (real batches are
 * small, typically <50 addresses). Guards against malformed or adversarial
 * decode explosions. */
const MAX_DECODED_ADDRESS_ARRAY = 500;

function decodeAddressArrayData(data: string): string[] {
  try {
    const [addresses] = decodeAbiParameters(
      [{ type: "address[]" }],
      data as `0x${string}`,
    );
    const result = [...addresses].map((a) => a.toLowerCase());
    if (result.length > MAX_DECODED_ADDRESS_ARRAY) {
      console.warn(
        `[blacklist] address[] event decoded ${result.length} entries; truncating to ${MAX_DECODED_ADDRESS_ARRAY}`,
      );
      return result.slice(0, MAX_DECODED_ADDRESS_ARRAY);
    }
    return result;
  } catch (error) {
    console.warn("[blacklist] Failed to decode address[] event data:", error);
    return [];
  }
}

function decodeAddressAtDataSlot(data: string, slotIndex: number): string | null {
  return decodeAddressWord(readDataWord(data, slotIndex));
}

/** Reads a uint256/bool slot from event data and resolves a blacklist/unblacklist
 *  direction. Returns `undefined` if the slot is missing/short so callers fall
 *  back to the event definition's default eventType. */
function resolveEventTypeFromDataBool(
  data: string,
  slotIndex: number,
): BlacklistEventType | undefined {
  const word = readDataWord(data, slotIndex);
  if (word == null) return undefined;
  return BigInt(word) !== 0n ? "blacklist" : "unblacklist";
}

function buildEvmBlacklistRow(
  config: ContractEventConfig,
  log: EvmLogLike,
  affectedAddress: string,
  amount: number | null,
  blockNumber: number,
  timestamp: number,
  rowSuffix = "",
  eventTypeOverride?: BlacklistEventType,
): BlacklistRow | null {
  const eventDef = getBlacklistEventByTopic(config, log.topics[0]);
  if (!eventDef) return null;
  const eventType = eventTypeOverride ?? eventDef.eventType;

  return buildBlacklistRow({
    id: `${config.chain.chainId}-${log.transactionHash}-${log.logIndex}${rowSuffix}`,
    stablecoin: config.stablecoin,
    chain: config.chain,
    eventType,
    address: affectedAddress,
    amount,
    txHash: log.transactionHash,
    blockNumber,
    timestamp,
    contractAddress: config.contractAddress,
    configKey: config.configKey,
    eventSignature: eventDef.signature,
    eventTopic0: log.topics[0] ?? null,
  });
}

function decodeEvmLogAmount(
  eventDef: BlacklistEventDef,
  log: EvmLogLike,
  decimals: number,
  addressFromTopic: boolean,
): number | null {
  if (!eventDef.hasAmount) return null;

  if (typeof eventDef.amountTopicIndex === "number" && log.topics.length > eventDef.amountTopicIndex) {
    return decodeUint256Word(log.topics[eventDef.amountTopicIndex], decimals);
  }
  if (typeof eventDef.amountDataIndex === "number") {
    return decodeUint256AtSlotOrNull(log.data, eventDef.amountDataIndex, decimals);
  }
  if (addressFromTopic) {
    return decodeUint256Word(readDataWord(log.data, 0), decimals);
  }
  return decodeUint256Word(readDataWord(log.data, 1), decimals);
}

export function parseEvmLogs(
  config: ContractEventConfig,
  logs: EvmLogLike[],
  blockTimestamps?: Map<number, number>,
): BlacklistRow[] {
  const rows: BlacklistRow[] = [];
  let droppedForTimestamp = 0;
  for (const log of logs) {
    const eventDef = getBlacklistEventByTopic(config, log.topics[0]);
    if (!eventDef) continue;
    const blockNumber = parseInt(log.blockNumber, 16);
    const timestamp = log.timeStamp ? parseInt(log.timeStamp, 16) : (blockTimestamps?.get(blockNumber) ?? Number.NaN);
    if (isNaN(blockNumber) || isNaN(timestamp)) {
      droppedForTimestamp++;
      continue;
    }

    const eventTypeOverride =
      typeof eventDef.eventTypeFromDataBoolIndex === "number"
        ? resolveEventTypeFromDataBool(log.data, eventDef.eventTypeFromDataBoolIndex)
        : undefined;

    if (eventDef.addressArrayData) {
      const addresses = decodeAddressArrayData(log.data);
      addresses.forEach((affectedAddress, index) => {
        const row = buildEvmBlacklistRow(config, log, affectedAddress, null, blockNumber, timestamp, `-${index}`, eventTypeOverride);
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
    const affectedAddress = forcedDataAddress ?? (
      addressFromTopic
        ? decodeAddressWord(log.topics[topicIdx])
        : decodeAddressWord(readDataWord(log.data, 0))
    );
    if (!affectedAddress) continue;
    const amount = decodeEvmLogAmount(eventDef, log, config.decimals, addressFromTopic);

    const row = buildEvmBlacklistRow(config, log, affectedAddress, amount, blockNumber, timestamp, "", eventTypeOverride);
    if (row) rows.push(row);
  }
  if (droppedForTimestamp > 0) {
    console.warn(
      `[blacklist] parseEvmLogs for ${config.configKey}: dropped ${droppedForTimestamp} log(s) due to missing block/timestamp`,
    );
  }
  return rows;
}

export async function resolveRpcLogTarget(
  chainId: string,
  runBudget: Pick<BlacklistRunBudget, "subrequestBudget">,
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
    const chainHead = await getAlchemyBlockNumber(target.url, runBudget.subrequestBudget, signal);
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
  runBudget: BlacklistRunBudget,
  rateLimit: RateLimitedFetch,
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
  let apiError = false;
  let chainHead: number | null = null;
  let usedRpcLogs = false;
  let scannedToBlock: number | null = null;
  let incomplete = false;
  let coveredTopicCount = 0;
  let rpcTargetPromise: Promise<RpcLogTarget | null> | null = null;
  const getRpcTarget = (): Promise<RpcLogTarget | null> => {
    rpcTargetPromise ??= resolveRpcLogTarget(config.chain.chainId, runBudget, signal, chainRpcs);
    return rpcTargetPromise;
  };

  const topicHashes = getBlacklistTopicHashes(config);
  for (const topicHash of topicHashes) {
    throwIfAborted(signal);
    if (blacklistRuntimeBudgetReached(runBudget)) {
      incomplete = true;
      break;
    }
    if (blacklistSubrequestBudgetReached(runBudget)) {
      incomplete = true;
      break;
    }

    let rows: BlacklistRow[] = [];
    let fetched = false;
    let sourceHadGap = false;
    let topicScannedToBlock: number | null = null;
    const preferRpcLogs = shouldPreferRpcLogScan(config.chain.chainId);

    if (!preferRpcLogs) {
      const fetchedLogs = await fetchEvmLogsForTopicWithCompleteness(
        evmChainId,
        config.contractAddress,
        topicHash,
        apiKey,
        fromBlock,
        99999999,
        0,
        rateLimit,
        runBudget.subrequestBudget,
        signal,
      );
      if (fetchedLogs.scannedToBlock >= fromBlock) {
        const contiguousLogs = fetchedLogs.logs.filter((log) => {
          const block = parseInt(log.blockNumber, 16);
          return Number.isFinite(block) && block <= fetchedLogs.scannedToBlock;
        });
        rows = parseEvmLogs(config, contiguousLogs);
        fetched = true;
        topicScannedToBlock = fetchedLogs.scannedToBlock;
        sourceHadGap = !fetchedLogs.complete;
      } else if (!fetchedLogs.complete) {
        sourceHadGap = true;
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
                runBudget.subrequestBudget,
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
              ? await resolveBlockTimestamps(rpcTarget.rpcUrl, uniqueBlocks, runBudget.subrequestBudget, {
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
          topicScannedToBlock = eventScannedToBlock;

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
    if (topicScannedToBlock != null && topicScannedToBlock >= fromBlock) {
      coveredTopicCount++;
      scannedToBlock = scannedToBlock == null ? topicScannedToBlock : Math.min(scannedToBlock, topicScannedToBlock);
    }

    allRows.push(...rows);
  }

  const commonScannedToBlock = coveredTopicCount === topicHashes.length ? scannedToBlock : null;
  const coveredRows =
    commonScannedToBlock == null
      ? (apiError || incomplete ? [] : allRows)
      : allRows.filter((row) => row.block_number <= commonScannedToBlock);
  const coveredMaxBlock = coveredRows.reduce(
    (max, row) => Math.max(max, row.block_number),
    fromBlock,
  );

  return {
    rows: coveredRows,
    maxBlock: coveredMaxBlock,
    apiError,
    chainHead,
    usedRpcLogs,
    scannedToBlock: commonScannedToBlock,
    incomplete,
  };
}
