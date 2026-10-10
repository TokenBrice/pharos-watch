import { BlacklistDecodeError, quarantineBlacklistDecodeFailure } from "../../lib/blacklist/decode-quarantine";
import { logWorkerEventArgs } from "../../lib/structured-log";
import { decodeAbiParameters } from "viem/utils";
import {
  fetchAlchemyLogs,
  getAlchemyBlockNumber,
  resolveBlockTimestamps,
  type AlchemyLogEntry,
  type AlchemyLogsFetchResult,
} from "../../lib/alchemy-logs";
import { throwIfAborted } from "../../lib/abort";
import {
  getBlacklistEventByTopic,
  getBlacklistTopicHashes,
  type BlacklistEventDef,
  type ContractEventConfig,
} from "../../lib/blacklist-contracts";
import type { BlacklistEventType } from "@shared/types/market";
import { getChainRpc, logScanRpcEndpoints, type ChainRpcConfig } from "../../lib/chain-registry";
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

/** Which column of `RPC_LOG_SCAN_WINDOWS` bounds a candidate's scan range. */
type RpcLogWindowClass = "alchemy" | "fallback";

type RpcLogCandidate = {
  url: string;
  windowClass: RpcLogWindowClass;
};

/**
 * Registry log-scan endpoints in failover order. `logScanRpcEndpoints` is the
 * only endpoint source here: the blacklist log lane must never reach a
 * supplemental (Dwellir) endpoint, even as a last-resort fallback.
 */
function getRpcLogCandidates(
  chainId: string,
  chainRpcs?: Map<string, ChainRpcConfig>,
): RpcLogCandidate[] {
  if (!chainRpcs) return [];
  const rpc = getChainRpc(chainRpcs, chainId);
  if (!rpc || rpc.type !== "evm") return [];
  return logScanRpcEndpoints(rpc)
    .filter((endpoint) => endpoint.url.length > 0)
    .map((endpoint) => ({
      url: endpoint.url,
      // Today's `alchemyPrimary`: only an Alchemy primary earns the wide window.
      windowClass: endpoint.operator === "alchemy" ? "alchemy" : "fallback",
    }));
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


function decodeAddressArrayData(data: string): string[] {
  try {
    const [addresses] = decodeAbiParameters([{ type: "address[]" }], data as `0x${string}`);
    return [...addresses].map((address) => address.toLowerCase());
  } catch {
    throw new BlacklistDecodeError("invalid-address-array");
  }
}

function decodeRequiredAddressWord(word: string | null | undefined): string | null {
  return typeof word === "string" && /^(0x)?0{24}[0-9a-f]{40}$/i.test(word) ? decodeAddressWord(word) : null;
}

function decodeAddressAtDataSlot(data: string, slotIndex: number): string | null {
  return decodeRequiredAddressWord(readDataWord(data, slotIndex));
}

/** Direction is required evidence; ABI bool accepts only zero or one. */
function resolveEventTypeFromDataBool(data: string, slotIndex: number): BlacklistEventType {
  const word = readDataWord(data, slotIndex);
  if (word == null || !/^0x[0-9a-f]{64}$/i.test(word) || (BigInt(word) !== 0n && BigInt(word) !== 1n)) {
    throw new BlacklistDecodeError("invalid-direction-bool");
  }
  return BigInt(word) === 1n ? "blacklist" : "unblacklist";
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

  if (typeof eventDef.amountTopicIndex === "number") {
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
  failures: { log: EvmLogLike; reason: BlacklistDecodeError["reason"] }[];
};

export function parseEvmLogsWithCoverage(
  config: ContractEventConfig,
  logs: EvmLogLike[],
  blockTimestamps?: Map<number, number>,
): ParsedEvmLogs {
  const rows: BlacklistRow[] = [];
  const failures: ParsedEvmLogs["failures"] = [];
  let droppedForTimestamp = 0;
  let coverageCeiling: number | null = null;
  for (const log of logs) {
    const eventDef = getBlacklistEventByTopic(config, log.topics[0]);
    if (!eventDef) continue;
    try {
    if (!/^0x[0-9a-f]{64}$/i.test(log.transactionHash)
      || !/^(0x[0-9a-f]+|[0-9]+)$/i.test(log.logIndex)
      || !Number.isSafeInteger(Number(log.logIndex))
      || !/^0x[0-9a-f]+$/i.test(log.blockNumber)
      || !Number.isSafeInteger(Number(log.blockNumber))) {
      throw new BlacklistDecodeError("invalid-log-identity");
    }
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
    if (typeof eventDef.addressDataIndex === "number" && forcedDataAddress == null) {
      throw new BlacklistDecodeError("invalid-address");
    }
    const addressFromTopic = forcedDataAddress == null && log.topics.length > topicIdx;
    const affectedAddress =
      forcedDataAddress ??
      (addressFromTopic ? decodeRequiredAddressWord(log.topics[topicIdx]) : decodeRequiredAddressWord(readDataWord(log.data, 0)));
    if (!affectedAddress) throw new BlacklistDecodeError("invalid-address");
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
    } catch (error) {
      if (!(error instanceof BlacklistDecodeError)) throw error;
      failures.push({ log, reason: error.reason });
      const block = Number(log.blockNumber);
      const ceiling = Number.isSafeInteger(block) ? block - 1 : -1;
      coverageCeiling = coverageCeiling == null ? ceiling : Math.min(coverageCeiling, ceiling);
    }
  }
  if (droppedForTimestamp > 0) {
    logWorkerEventArgs("handler", "warn",
      `[blacklist] parseEvmLogs for ${config.configKey}: dropped ${droppedForTimestamp} log(s) due to missing block/timestamp`,
    );
  }
  return { rows, coverageCeiling, failures };
}

async function parseEvmLogsWithRetry(
  db: D1Database,
  config: ContractEventConfig,
  logs: EvmLogLike[],
  observation: number,
  blockTimestamps?: Map<number, number>,
): Promise<ParsedEvmLogs> {
  const parsed = parseEvmLogsWithCoverage(config, logs, blockTimestamps);
  if (parsed.failures.length === 0) return parsed;
  const quarantined = new Set<EvmLogLike>();
  for (const failure of parsed.failures) {
    const log = failure.log;
    if (await quarantineBlacklistDecodeFailure(db, config.configKey,
      `${log.blockNumber}:${log.transactionHash}:${log.logIndex}`, failure.reason, log, observation)) {
      quarantined.add(log);
    }
  }
  return quarantined.size === 0 ? parsed
    : parseEvmLogsWithCoverage(config, logs.filter((log) => !quarantined.has(log)), blockTimestamps);
}

async function resolveRpcLogTarget(
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
        scanWindowBlocks: chainWindow ? chainWindow[target.windowClass] : null,
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
  let minCoveredScannedToBlock: number | null = null;
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
  const fetchRpcWindow = async (
    target: RpcLogTarget,
    topics: string[],
  ): Promise<{
    safeHead: number;
    scanToBlock: number;
    logs: AlchemyLogsFetchResult | null;
  }> => {
    const targetSafeHead = getEvmSafeHead(evmChainId, target.chainHead);
    const scanToBlock = target.scanWindowBlocks != null
      ? Math.min(targetSafeHead, fromBlock + target.scanWindowBlocks - 1)
      : targetSafeHead;
    const batches: AlchemyLogsFetchResult[] = [];
    // Respect Avalanche's 2,000-block provider cap per request, but admit enough
    // serial windows to exceed its normal six-hour chain growth.
    const finalBlock = config.chain.chainId === "avalanche" && target.scanWindowBlocks === 2_000
      ? Math.min(targetSafeHead, fromBlock + 16_000 - 1) : scanToBlock;
    let start = fromBlock;
    do {
      const end = Math.min(finalBlock, start + (target.scanWindowBlocks ?? finalBlock - start + 1) - 1);
      const batch = start > end
        ? { logs: [], complete: true, scannedToBlock: end, calls: 0, maxDepth: 0 }
        : await fetchAlchemyLogs(target.rpcUrl, config.contractAddress,
          [{ index: 0, value: topics.length === 1 ? topics[0]! : topics }], start, end,
          runBudget.subrequestBudget, signal, { deadlineMs: runBudget.deadlineMs });
      if (!batch) return { safeHead: targetSafeHead, scanToBlock: finalBlock, logs: null };
      batches.push(batch);
      if (!batch.complete || blacklistRuntimeBudgetReached(runBudget) || blacklistSubrequestBudgetReached(runBudget)) break;
      start = end + 1;
    } while (start <= finalBlock);
    const last = batches[batches.length - 1]!;
    return {
      safeHead: targetSafeHead, scanToBlock: finalBlock,
      logs: { logs: batches.flatMap((batch) => batch.logs),
        complete: last.complete && last.scannedToBlock >= finalBlock,
        scannedToBlock: last.scannedToBlock, calls: batches.reduce((n, batch) => n + batch.calls, 0),
        maxDepth: Math.max(...batches.map((batch) => batch.maxDepth)),
        failureReason: last.failureReason },
    };
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
        let providerScannedToBlock = Math.min(fetchedLogs.scannedToBlock, scanToBlock);
        let malformedHeld = false;
        for (const [index, rejected] of (fetchedLogs.rejectedLogs ?? []).entries()) {
          const raw = rejected != null && typeof rejected === "object" ? rejected as Record<string, unknown> : {};
          const retained = await quarantineBlacklistDecodeFailure(db, config.configKey,
            `${String(raw.blockNumber)}:${String(raw.transactionHash)}:${String(raw.logIndex)}:${index}`,
            "invalid-log-identity", raw, runBudget.deadlineMs);
          malformedHeld ||= !retained;
        }
        const intakeComplete = fetchedLogs.complete || (fetchedLogs.validatedToBlock != null && !malformedHeld);
        if (intakeComplete && fetchedLogs.validatedToBlock != null) providerScannedToBlock = Math.min(fetchedLogs.validatedToBlock, scanToBlock);
        if (providerScannedToBlock >= fromBlock) {
          const contiguousLogs = fetchedLogs.logs.filter((log) => {
            const block = parseInt(log.blockNumber, 16);
            return !Number.isFinite(block) || block <= providerScannedToBlock;
          });
          const parsed = await parseEvmLogsWithRetry(db, config, contiguousLogs, runBudget.deadlineMs);
          rows = parsed.rows;
          fetched = true;
          topicScannedToBlock =
            parsed.coverageCeiling == null
              ? providerScannedToBlock
              : Math.min(providerScannedToBlock, Math.max(fromBlock - 1, parsed.coverageCeiling));
          sourceHadGap = !intakeComplete || parsed.coverageCeiling != null;
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
        usedRpcLogs = true;
        const rpcWindow = await fetchRpcWindow(rpcTarget, rpcTopicHashes);
        safeHead = rpcWindow.safeHead;
        let scanToBlock = rpcWindow.scanToBlock;
        let fetchedLogs = rpcWindow.logs;

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
            const fallbackWindow = await fetchRpcWindow(fallbackTarget, rpcTopicHashes);
            const fallbackLogs = fallbackWindow.logs;
            if (fallbackLogs && fallbackLogs.scannedToBlock > fetchedLogs.scannedToBlock) {
              providerCalls += fetchedLogs.calls;
              maxSplitDepth = Math.max(maxSplitDepth, fetchedLogs.maxDepth);
              rpcTarget = fallbackTarget;
              chainHead = fallbackTarget.chainHead;
              safeHead = fallbackWindow.safeHead;
              scanToBlock = fallbackWindow.scanToBlock;
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
          topicScannedToBlock = eventScannedToBlock;

          const parsed = await parseEvmLogsWithRetry(db, config, fetchedLogs.logs as Array<AlchemyLogEntry>, runBudget.deadlineMs, blockTimestamps);
          if (parsed.coverageCeiling != null) {
            eventScannedToBlock = Math.min(eventScannedToBlock, Math.max(fromBlock - 1, parsed.coverageCeiling));
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
      minCoveredScannedToBlock =
        minCoveredScannedToBlock == null
          ? topicScannedToBlock
          : Math.min(minCoveredScannedToBlock, topicScannedToBlock);
    }

    allRows.push(...rows);
  }

  const coveredRows =
    minCoveredScannedToBlock == null
      ? []
      : allRows.filter((row) => row.block_number <= minCoveredScannedToBlock);
  const coveredMaxBlock = coveredRows.reduce((max, row) => Math.max(max, row.block_number), fromBlock - 1);
  if (!incomplete && !apiError && coveredTopicCount === topicHashes.length
    && (safeHead == null || minCoveredScannedToBlock == null || minCoveredScannedToBlock < safeHead)) {
    incomplete = true;
    failureSamples.push("behind-safe-head");
  }
  const coverageOutcome: BlacklistScanCoverageOutcome = incomplete
    ? "incomplete"
    : coveredTopicCount < topicHashes.length
      ? coveredTopicCount > 0
        ? "missing_topic"
        : "provider_error"
      : apiError
        ? minCoveredScannedToBlock != null && minCoveredScannedToBlock >= fromBlock
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
    scannedToBlock: coveredTopicCount < topicHashes.length ? fromBlock - 1 : minCoveredScannedToBlock,
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
