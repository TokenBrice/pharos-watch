import { logWorkerEventArgs } from "../../lib/structured-log";
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
import { buildBlacklistRow, type BlacklistRow, type BlacklistScanCoverageOutcome } from "../../lib/blacklist/shared";
import { blacklistRuntimeBudgetReached, blacklistSubrequestBudgetReached, type BlacklistRunBudget } from "../../lib/blacklist/run-budget";

const RPC_LOG_SCAN_CHAIN_IDS = new Set(["base", "optimism", "avalanche", "bsc", "gnosis"]);
const INDEXING_SAFETY_SEC = 15 * 60;
const EVM_BLOCK_TIME_SEC: Record<number, number> = {
  1: 12,
  42161: 0.25,
  8453: 2,
  10: 2,
  137: 2,
  43114: 2,
  56: 3,
  100: 5,
};

/** Explorer scans are normally cursor-to-safe-head. Arbitrum is explicitly
 * bounded because its high block height makes an accidental genesis-to-head
 * query both slow and difficult to prove complete. */
export const EXPLORER_LOG_SCAN_WINDOWS: Readonly<Record<string, number>> = {
  arbitrum: 25_000_000,
};
/** Per-chain `eth_getLogs` windows. Gnosis is capped at 9_000 because dRPC's free
 *  tier rejects any range > 10_000 blocks (verified 2026-04-17). */
export const RPC_LOG_SCAN_WINDOWS: Record<string, { alchemy: number; fallback: number }> = {
  arbitrum: { alchemy: 25_000_000, fallback: 250_000 },
  base: { alchemy: 500_000, fallback: 50_000 },
  optimism: { alchemy: 500_000, fallback: 50_000 },
  avalanche: { alchemy: 250_000, fallback: 2_000 },
  bsc: { alchemy: 250_000, fallback: 50_000 },
  gnosis: { alchemy: 9_000, fallback: 9_000 },
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

function getRpcLogCandidates(
  chainId: string,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Array<{ url: string; alchemyPrimary: boolean }> {
  if (!chainRpcs) return [];
  const rpc = getChainRpc(chainRpcs, chainId);
  if (!rpc || rpc.type !== "evm") return [];
  return [
    { url: rpc.rpcUrl, alchemyPrimary: rpc.alchemyPrimary === true },
    { url: rpc.fallbackRpcUrl, alchemyPrimary: false },
  ].filter(
    (target): target is { url: string; alchemyPrimary: boolean } =>
      typeof target.url === "string" && target.url.length > 0,
  );
}

export interface FetchEvmEventsIncrementalResult {
  rows: BlacklistRow[];
  maxBlock: number;
  apiError: boolean;
  chainHead: number | null;
  usedRpcLogs: boolean;
  scannedToBlock: number | null;
  safeHead: number | null;
  incomplete: boolean;
  coverageOutcome: BlacklistScanCoverageOutcome;
  topicCount: number;
  coveredTopicCount: number;
  providerCalls: number;
  maxSplitDepth: number;
  failureSamples: string[];
}

export function shouldPreferRpcLogScan(chainId: string): boolean {
  return RPC_LOG_SCAN_CHAIN_IDS.has(chainId);
}

export function getEvmSafeHead(evmChainId: number, chainHead: number): number {
  const blockTime = EVM_BLOCK_TIME_SEC[evmChainId] ?? 2;
  return Math.max(0, chainHead - Math.ceil(INDEXING_SAFETY_SEC / blockTime));
}

/** Maximum plausible size of an address[] batch event — well above any real
 * AccountsBlocked or AddedToDenyList batch we've observed (real batches are
 * small, typically <50 addresses). Guards against malformed or adversarial
 * decode explosions. */
const MAX_DECODED_ADDRESS_ARRAY = 500;

function decodeAddressArrayData(data: string): string[] {
  try {
    const [addresses] = decodeAbiParameters([{ type: "address[]" }], data as `0x${string}`);
    const result = [...addresses].map((a) => a.toLowerCase());
    if (result.length > MAX_DECODED_ADDRESS_ARRAY) {
      logWorkerEventArgs("handler", "warn",
        `[blacklist] address[] event decoded ${result.length} entries; truncating to ${MAX_DECODED_ADDRESS_ARRAY}`,
      );
      return result.slice(0, MAX_DECODED_ADDRESS_ARRAY);
    }
    return result;
  } catch (error) {
    logWorkerEventArgs("handler", "warn", "[blacklist] Failed to decode address[] event data:", error);
    return [];
  }
}

function decodeAddressAtDataSlot(data: string, slotIndex: number): string | null {
  return decodeAddressWord(readDataWord(data, slotIndex));
}

/** Reads a uint256/bool slot from event data and resolves a blacklist/unblacklist
 *  direction. Returns `undefined` if the slot is missing/short so callers fall
 *  back to the event definition's default eventType. */
function resolveEventTypeFromDataBool(data: string, slotIndex: number): BlacklistEventType | undefined {
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

type ParsedEvmLogs = {
  rows: BlacklistRow[];
  coverageCeiling: number | null;
};

function parseEvmLogsWithCoverage(
  config: ContractEventConfig,
  logs: EvmLogLike[],
  blockTimestamps?: Map<number, number>,
): ParsedEvmLogs {
  const rows: BlacklistRow[] = [];
  let droppedForTimestamp = 0;
  let coverageCeiling: number | null = null;
  for (const log of logs) {
    const eventDef = getBlacklistEventByTopic(config, log.topics[0]);
    if (!eventDef) continue;
    const blockNumber = parseInt(log.blockNumber, 16);
    const timestamp = log.timeStamp ? parseInt(log.timeStamp, 16) : (blockTimestamps?.get(blockNumber) ?? Number.NaN);
    if (isNaN(blockNumber) || isNaN(timestamp)) {
      droppedForTimestamp++;
      const candidateCeiling = Number.isFinite(blockNumber) ? blockNumber - 1 : -1;
      coverageCeiling = coverageCeiling == null ? candidateCeiling : Math.min(coverageCeiling, candidateCeiling);
      continue;
    }

    const eventTypeOverride =
      typeof eventDef.eventTypeFromDataBoolIndex === "number"
        ? resolveEventTypeFromDataBool(log.data, eventDef.eventTypeFromDataBoolIndex)
        : undefined;

    if (eventDef.addressArrayData) {
      const addresses = decodeAddressArrayData(log.data);
      addresses.forEach((affectedAddress, index) => {
        const row = buildEvmBlacklistRow(
          config,
          log,
          affectedAddress,
          null,
          blockNumber,
          timestamp,
          `-${index}`,
          eventTypeOverride,
        );
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
    const affectedAddress =
      forcedDataAddress ??
      (addressFromTopic ? decodeAddressWord(log.topics[topicIdx]) : decodeAddressWord(readDataWord(log.data, 0)));
    if (!affectedAddress) continue;
    const amount = decodeEvmLogAmount(eventDef, log, config.decimals, addressFromTopic);

    const row = buildEvmBlacklistRow(
      config,
      log,
      affectedAddress,
      amount,
      blockNumber,
      timestamp,
      "",
      eventTypeOverride,
    );
    if (row) rows.push(row);
  }
  if (droppedForTimestamp > 0) {
    logWorkerEventArgs("handler", "warn",
      `[blacklist] parseEvmLogs for ${config.configKey}: dropped ${droppedForTimestamp} log(s) due to missing block/timestamp`,
    );
  }
  return { rows, coverageCeiling };
}

export function parseEvmLogs(
  config: ContractEventConfig,
  logs: EvmLogLike[],
  blockTimestamps?: Map<number, number>,
): BlacklistRow[] {
  return parseEvmLogsWithCoverage(config, logs, blockTimestamps).rows;
}

export async function resolveRpcLogTarget(
  chainId: string,
  runBudget: Pick<BlacklistRunBudget, "subrequestBudget">,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  excludedUrls: ReadonlySet<string> = new Set(),
): Promise<RpcLogTarget | null> {
  for (const target of getRpcLogCandidates(chainId, chainRpcs)) {
    throwIfAborted(signal);
    if (excludedUrls.has(target.url)) continue;
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
  knownChainHead?: number | null,
): Promise<FetchEvmEventsIncrementalResult> {
  const evmChainId = config.chain.evmChainId;
  if (evmChainId == null) {
    return {
      rows: [],
      maxBlock: fromBlock - 1,
      apiError: false,
      chainHead: null,
      usedRpcLogs: false,
      scannedToBlock: null,
      safeHead: null,
      incomplete: false,
      coverageOutcome: "quiet",
      topicCount: 0,
      coveredTopicCount: 0,
      providerCalls: 0,
      maxSplitDepth: 0,
      failureSamples: [],
    };
  }

  const allRows: BlacklistRow[] = [];
  let apiError = false;
  let chainHead: number | null = knownChainHead ?? null;
  let safeHead: number | null = chainHead == null ? null : getEvmSafeHead(evmChainId, chainHead);
  let usedRpcLogs = false;
  let scannedToBlock: number | null = null;
  let incomplete = false;
  let coveredTopicCount = 0;
  let providerCalls = 0;
  let maxSplitDepth = 0;
  const failureSamples: string[] = [];
  let explorerUnavailable = false;
  let rpcTargetPromise: Promise<RpcLogTarget | null> | null = null;
  const getRpcTarget = (): Promise<RpcLogTarget | null> => {
    rpcTargetPromise ??= resolveRpcLogTarget(config.chain.chainId, runBudget, signal, chainRpcs);
    return rpcTargetPromise;
  };

  const topicHashes = getBlacklistTopicHashes(config);
  const preferRpcLogs = shouldPreferRpcLogScan(config.chain.chainId);
  throwIfAborted(signal);
  if (safeHead != null && fromBlock > safeHead + 1) {
    return {
      rows: [],
      maxBlock: fromBlock - 1,
      apiError: true,
      chainHead,
      usedRpcLogs: false,
      scannedToBlock: null,
      safeHead,
      incomplete: true,
      coverageOutcome: "cursor_ahead",
      topicCount: topicHashes.length,
      coveredTopicCount: 0,
      providerCalls: 0,
      maxSplitDepth: 0,
      failureSamples: [],
    };
  }
  for (let topicIndex = 0; topicIndex < topicHashes.length; topicIndex++) {
    const topicHash = topicHashes[topicIndex]!;
    if (preferRpcLogs && topicIndex > 0) break;
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
    let noRangeRequired = false;
    const rpcTopicHashes = preferRpcLogs && topicIndex === 0 ? topicHashes : [topicHash];

    if (!preferRpcLogs && !explorerUnavailable && safeHead != null) {
      const explorerWindow = EXPLORER_LOG_SCAN_WINDOWS[config.chain.chainId];
      const scanToBlock = explorerWindow == null ? safeHead : Math.min(safeHead, fromBlock + explorerWindow - 1);
      if (fromBlock > scanToBlock) {
        fetched = true;
        noRangeRequired = true;
        topicScannedToBlock = fromBlock - 1;
      } else {
        const fetchedLogs = await fetchEvmLogsForTopicWithCompleteness(
          evmChainId,
          config.contractAddress,
          topicHash,
          apiKey,
          fromBlock,
          scanToBlock,
          0,
          rateLimit,
          runBudget.subrequestBudget,
          signal,
        );
        providerCalls += fetchedLogs.calls;
        maxSplitDepth = Math.max(maxSplitDepth, fetchedLogs.maxDepth);
        const providerScannedToBlock = Math.min(fetchedLogs.scannedToBlock, scanToBlock);
        if (providerScannedToBlock >= fromBlock) {
          const contiguousLogs = fetchedLogs.logs.filter((log) => {
            const block = parseInt(log.blockNumber, 16);
            return Number.isFinite(block) && block <= providerScannedToBlock;
          });
          const parsed = parseEvmLogsWithCoverage(config, contiguousLogs);
          rows = parsed.rows;
          fetched = true;
          topicScannedToBlock =
            parsed.coverageCeiling == null
              ? providerScannedToBlock
              : Math.min(providerScannedToBlock, Math.max(fromBlock - 1, parsed.coverageCeiling));
          sourceHadGap = !fetchedLogs.complete || parsed.coverageCeiling != null;
        } else if (!fetchedLogs.complete) {
          sourceHadGap = true;
          explorerUnavailable = true;
        }
      }
    }

    if (!fetched) {
      let rpcTarget = await getRpcTarget();
      if (rpcTarget) {
        chainHead = rpcTarget.chainHead;
        safeHead = getEvmSafeHead(evmChainId, rpcTarget.chainHead);
        usedRpcLogs = true;
        const scanToBlock =
          rpcTarget.scanWindowBlocks != null
            ? Math.min(safeHead, fromBlock + rpcTarget.scanWindowBlocks - 1)
            : safeHead;

        let fetchedLogs =
          fromBlock > scanToBlock
            ? { logs: [], complete: true, scannedToBlock: scanToBlock, calls: 0, maxDepth: 0 }
            : await fetchAlchemyLogs(
                rpcTarget.rpcUrl,
                config.contractAddress,
                [{ index: 0, value: rpcTopicHashes.length === 1 ? topicHash : rpcTopicHashes }],
                fromBlock,
                scanToBlock,
                runBudget.subrequestBudget,
                signal,
                { deadlineMs: runBudget.deadlineMs },
              );

        if (
          fetchedLogs
          && !fetchedLogs.complete
          && fetchedLogs.scannedToBlock < fromBlock
          && fromBlock <= scanToBlock
        ) {
          const primaryFailureReason = fetchedLogs.failureReason ?? "no-coverage";
          const fallbackTarget = await resolveRpcLogTarget(
            config.chain.chainId,
            runBudget,
            signal,
            chainRpcs,
            new Set([rpcTarget.rpcUrl]),
          );
          if (fallbackTarget) {
            if (failureSamples.length < 4) {
              failureSamples.push(`primary-failover:${primaryFailureReason}`.slice(0, 120));
            }
            const fallbackSafeHead = getEvmSafeHead(evmChainId, fallbackTarget.chainHead);
            const fallbackScanToBlock = fallbackTarget.scanWindowBlocks != null
              ? Math.min(fallbackSafeHead, fromBlock + fallbackTarget.scanWindowBlocks - 1)
              : fallbackSafeHead;
            const fallbackLogs = fromBlock > fallbackScanToBlock
              ? { logs: [], complete: true, scannedToBlock: fallbackScanToBlock, calls: 0, maxDepth: 0 }
              : await fetchAlchemyLogs(
                  fallbackTarget.rpcUrl,
                  config.contractAddress,
                  [{ index: 0, value: rpcTopicHashes.length === 1 ? topicHash : rpcTopicHashes }],
                  fromBlock,
                  fallbackScanToBlock,
                  runBudget.subrequestBudget,
                  signal,
                  { deadlineMs: runBudget.deadlineMs },
                );
            if (fallbackLogs && fallbackLogs.scannedToBlock > fetchedLogs.scannedToBlock) {
              providerCalls += fetchedLogs.calls;
              maxSplitDepth = Math.max(maxSplitDepth, fetchedLogs.maxDepth);
              rpcTarget = fallbackTarget;
              chainHead = fallbackTarget.chainHead;
              safeHead = fallbackSafeHead;
              fetchedLogs = fallbackLogs;
            } else if (fallbackLogs) {
              providerCalls += fallbackLogs.calls;
              maxSplitDepth = Math.max(maxSplitDepth, fallbackLogs.maxDepth);
              if (fallbackLogs.failureReason && failureSamples.length < 4) {
                failureSamples.push(`fallback:${fallbackLogs.failureReason}`.slice(0, 120));
              }
            }
          }
        }

        if (fetchedLogs) {
          providerCalls += fetchedLogs.calls;
          maxSplitDepth = Math.max(maxSplitDepth, fetchedLogs.maxDepth);
          if (fetchedLogs.failureReason && failureSamples.length < 4) {
            failureSamples.push(fetchedLogs.failureReason.slice(0, 120));
          }
          noRangeRequired = fromBlock > scanToBlock;
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
          let eventScannedToBlock = Math.min(fetchedLogs.scannedToBlock, scanToBlock);
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

          const parsed = parseEvmLogsWithCoverage(config, fetchedLogs.logs as Array<AlchemyLogEntry>, blockTimestamps);
          if (parsed.coverageCeiling != null) {
            eventScannedToBlock = Math.min(eventScannedToBlock, Math.max(fromBlock - 1, parsed.coverageCeiling));
            scannedToBlock =
              scannedToBlock == null ? eventScannedToBlock : Math.min(scannedToBlock, eventScannedToBlock);
            topicScannedToBlock = eventScannedToBlock;
          }
          rows = parsed.rows;
          fetched = true;
          sourceHadGap =
            !fetchedLogs.complete ||
            parsed.coverageCeiling != null ||
            (uniqueBlocks.length > 0 && blockTimestamps.size < uniqueBlocks.length);
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
    if (topicScannedToBlock != null && (topicScannedToBlock >= fromBlock || noRangeRequired)) {
      coveredTopicCount += preferRpcLogs ? rpcTopicHashes.length : 1;
      scannedToBlock = scannedToBlock == null ? topicScannedToBlock : Math.min(scannedToBlock, topicScannedToBlock);
    }

    allRows.push(...rows);
  }

  const commonScannedToBlock = coveredTopicCount === topicHashes.length ? scannedToBlock : null;
  const coveredRows =
    commonScannedToBlock == null ? [] : allRows.filter((row) => row.block_number <= commonScannedToBlock);
  const coveredMaxBlock = coveredRows.reduce((max, row) => Math.max(max, row.block_number), fromBlock - 1);
  const coverageOutcome: BlacklistScanCoverageOutcome = incomplete
    ? "incomplete"
    : coveredTopicCount < topicHashes.length
      ? coveredTopicCount > 0
        ? "missing_topic"
        : "provider_error"
      : apiError
        ? commonScannedToBlock != null && commonScannedToBlock >= fromBlock
          ? "partial"
          : "provider_error"
        : coveredRows.length === 0
          ? "quiet"
          : "complete";

  return {
    rows: coveredRows,
    maxBlock: coveredMaxBlock,
    apiError,
    chainHead,
    usedRpcLogs,
    scannedToBlock: commonScannedToBlock,
    safeHead,
    incomplete,
    coverageOutcome,
    topicCount: topicHashes.length,
    coveredTopicCount,
    providerCalls,
    maxSplitDepth,
    failureSamples,
  };
}
