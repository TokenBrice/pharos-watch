import { buildAlchemyUrl, fetchAlchemyLogs, getAlchemyBlockNumber, resolveBlockTimestamps,
  type AlchemyLogsFetchResult, type AlchemyTopicFilter, type ResolveBlockTimestampOptions } from "../alchemy-logs";
import type { ChainRpcConfig, RpcEndpoint } from "../chain-registry";
import { throwIfAborted } from "../abort";
import { budgetExhausted, type SubrequestBudget } from "../evm-logs";
import { fetchEvmBlockHeader, type EvmBlockHeader } from "../evm-rpc";
import { TronRpcError, type TronJsonRpcReader } from "../tron-jsonrpc";

export function mintBurnAlchemyEndpoint(url: string): RpcEndpoint {
  return { url, operator: "alchemy", keyed: true, position: "registry", stateHistory: "archive", logsHistory: "full" };
}

/** The supplied map must be the scheduled runtime's already-admitted map; never builds Dwellir. */
export function mintBurnRpcEndpoints(chainId: string, apiKey: string,
  chainRpcs?: ReadonlyMap<string, ChainRpcConfig>): readonly RpcEndpoint[] {
  if (chainId === "tron") return [];
  const url = buildAlchemyUrl(chainId, apiKey);
  if (!url) throw new Error(`Failed to build ${chainId} Alchemy URL`);
  const dwellir = chainRpcs?.get(chainId)?.endpoints.find((endpoint) => endpoint.operator === "dwellir"
    && !endpoint.routingDisabled && endpoint.logsHistory === "full");
  // Log/header support does not imply arbitrary historical state. Conservation
  // filters its separate hash-pinned state phase by stateHistory.
  const incumbent = chainRpcs?.get(chainId)?.endpoints.find((endpoint) => endpoint.url === url);
  const alchemy = { ...mintBurnAlchemyEndpoint(url),
    ...(incumbent?.finalizedTagUnsupported ? { finalizedTagUnsupported: true } : {}) };
  return dwellir ? [dwellir, alchemy] : [alchemy];
}

/** CHAIN owns tag capability admission and strict number/hash/timestamp validation. */
export async function getMintBurnFinalizedHead(chainId: string, endpoints: readonly RpcEndpoint[],
  budget: SubrequestBudget, signal?: AbortSignal, tronReader?: TronJsonRpcReader): Promise<EvmBlockHeader | null> {
  if (chainId === "tron") {
    const block = await tronReader?.getSolidHead();
    return block ? { ...block, hash: block.hash as `0x${string}` } : null;
  }
  return fetchEvmBlockHeader(chainId, "finalized", {
    chainRpcs: new Map([[chainId, { chainId, chainName: chainId, type: "evm", endpoints, explorerUrl: "" }]]),
    signal,
    maxRetries: 0,
    beforeRequest: () => {
      throwIfAborted(signal);
      if (budgetExhausted(budget)) return false;
      budget.count++;
      return true;
    },
  });
}

function boundLogRange(result: AlchemyLogsFetchResult | null, fromBlock: number, toBlock: number): AlchemyLogsFetchResult | null {
  if (!result) return null;
  const inRange = (log: AlchemyLogsFetchResult["logs"][number]) => {
    const block = Number(log.blockNumber);
    return Number.isSafeInteger(block) && block >= fromBlock && block <= toBlock;
  };
  // No replacement allocation for the ordinary, already range-validated response.
  const logs = result.logs.some((log) => !inRange(log)) ? result.logs.filter(inRange) : result.logs;
  const scannedToBlock = Math.max(fromBlock - 1, Math.min(toBlock, result.scannedToBlock));
  return logs === result.logs && scannedToBlock === result.scannedToBlock ? result : { ...result, logs, scannedToBlock };
}

/** Resume only at the proven contiguous frontier, discarding logs beyond an unproven gap. */
export async function fetchMintBurnLogs(endpoints: readonly RpcEndpoint[], contractAddress: string,
  topics: AlchemyTopicFilter[], fromBlock: number, toBlock: number, budget: SubrequestBudget,
  signal?: AbortSignal, options?: { deadlineMs?: number; endpointHeads?: Map<string, number>; tronReader?: TronJsonRpcReader }): Promise<AlchemyLogsFetchResult | null> {
  if (options?.tronReader) {
    if (topics.length !== 1 || topics[0].index !== 0) throw new Error("Unsupported Tron mint/burn topic filter");
    const before = budget.count;
    const topic = topics[0].value;
    let result;
    try {
      result = await options.tronReader.getLogs(contractAddress, typeof topic === "string" ? [topic] : [...topic], fromBlock, toBlock);
    } catch (error) {
      throwIfAborted(signal);
      return { logs: [], complete: false, scannedToBlock: fromBlock - 1,
        calls: budget.count - before, maxDepth: 0,
        failureReason: error instanceof TronRpcError ? error.reason : "tron-rpc-read-failed" };
    }
    const hex = (value: number) => `0x${value.toString(16)}`;
    return { logs: result.logs.map((log) => ({ ...log, blockNumber: hex(log.blockNumber),
      transactionIndex: hex(log.transactionIndex), logIndex: hex(log.logIndex), removed: false })),
      complete: result.complete && result.scannedToBlock >= toBlock, scannedToBlock: result.scannedToBlock,
      calls: budget.count - before, maxDepth: result.maxSplitDepth, failureReason: result.reason ?? undefined };
  }
  if (endpoints.length === 1) {
    return boundLogRange(await fetchAlchemyLogs(endpoints[0].url, contractAddress, topics, fromBlock, toBlock, budget, signal,
      options?.deadlineMs != null ? { deadlineMs: options.deadlineMs } : undefined), fromBlock, toBlock);
  }
  let combined: AlchemyLogsFetchResult | null = null;
  let start = fromBlock;
  for (const endpoint of endpoints) {
    throwIfAborted(signal);
    if (budgetExhausted(budget) || (options?.deadlineMs != null && Date.now() >= options.deadlineMs)) break;
    // Reuse only this endpoint's own run-local head, never another provider's ceiling.
    // Every scan is capped to the run's initial head, so a later head read adds no coverage.
    const endpointHead = options?.endpointHeads?.get(endpoint.url)
      ?? await getAlchemyBlockNumber(endpoint.url, budget, signal);
    if (endpointHead == null || !Number.isSafeInteger(endpointHead) || endpointHead < 0) continue;
    options?.endpointHeads?.set(endpoint.url, endpointHead);
    const endpointTo = Math.min(toBlock, endpointHead);
    if (endpointTo < start) {
      combined ??= { logs: [], complete: false, scannedToBlock: start - 1, calls: 0, maxDepth: 0,
        failureReason: "provider-head-lag" };
      continue;
    }
    const result = boundLogRange(await fetchAlchemyLogs(endpoint.url, contractAddress, topics, start, endpointTo, budget, signal,
      endpoint.operator === "dwellir" ? { ...options, endpoint } : options?.deadlineMs != null ? { deadlineMs: options.deadlineMs } : undefined),
      start, endpointTo);
    if (!result) continue;
    if (result.complete && endpointTo < toBlock) {
      result.complete = false;
      result.failureReason = "provider-head-lag";
    }
    // Recursive recovery can return logs from the right half despite an unproven left half.
    const provenLogs = result.complete ? result.logs : result.logs.filter((log) => Number(log.blockNumber) <= result.scannedToBlock);
    if (!combined) combined = { ...result, logs: provenLogs };
    else {
      combined.logs.push(...provenLogs);
      combined.calls += result.calls;
      combined.maxDepth = Math.max(combined.maxDepth, result.maxDepth);
      combined.scannedToBlock = result.scannedToBlock;
      combined.complete = result.complete;
      combined.failureReason = result.failureReason;
    }
    if (result.complete) return combined;
    start = Math.max(start, result.scannedToBlock + 1);
  }
  return combined;
}

export async function resolveMintBurnBlockTimestamps(endpoints: readonly RpcEndpoint[], blocks: number[],
  budget: SubrequestBudget, options?: ResolveBlockTimestampOptions & { tronReader?: TronJsonRpcReader }): Promise<Map<number, number>> {
  const resolved = new Map<number, number>();
  if (options?.tronReader) {
    for (const number of [...new Set(blocks)]) {
      throwIfAborted(options.signal);
      try {
        const block = await options.tronReader.getBlock(number);
        const expectedHash = options.blockHashes?.get(number);
        if (expectedHash !== undefined && expectedHash.toLowerCase() !== block.hash) continue;
        resolved.set(number, block.timestamp);
      } catch {
        throwIfAborted(options.signal);
        if (budgetExhausted(budget) || (options.deadlineMs != null && Date.now() >= options.deadlineMs)) break;
      }
    }
    return resolved;
  }
  for (const endpoint of endpoints) {
    throwIfAborted(options?.signal);
    const pending = blocks.filter((block) => !resolved.has(block));
    if (pending.length === 0 || budgetExhausted(budget)) break;
    const timestamps = await resolveBlockTimestamps(endpoint.url, pending, budget, options);
    for (const [block, timestamp] of timestamps) resolved.set(block, timestamp);
  }
  return resolved;
}
