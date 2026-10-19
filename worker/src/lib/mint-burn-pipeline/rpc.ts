import { buildAlchemyUrl, fetchAlchemyLogs, getAlchemyBlockNumber, resolveBlockTimestamps,
  type AlchemyLogsFetchResult, type AlchemyTopicFilter, type ResolveBlockTimestampOptions } from "../alchemy-logs";
import type { ChainRpcConfig, RpcEndpoint } from "../chain-registry";
import { throwIfAborted } from "../abort";
import { budgetExhausted, type SubrequestBudget } from "../evm-logs";

export function mintBurnAlchemyEndpoint(url: string): RpcEndpoint {
  return { url, operator: "alchemy", keyed: true, position: "registry", stateHistory: "archive", logsHistory: "full" };
}

/** The supplied map must be the scheduled runtime's already-admitted map; never builds Dwellir. */
export function mintBurnRpcEndpoints(chainId: string, apiKey: string,
  chainRpcs?: ReadonlyMap<string, ChainRpcConfig>): readonly RpcEndpoint[] {
  const url = buildAlchemyUrl(chainId, apiKey);
  if (!url) throw new Error(`Failed to build ${chainId} Alchemy URL`);
  const dwellir = chainRpcs?.get(chainId)?.endpoints.find((endpoint) => endpoint.operator === "dwellir"
    && !endpoint.routingDisabled && endpoint.logsHistory === "full");
  // Log/header support does not imply arbitrary historical state. Conservation
  // filters its separate hash-pinned state phase by stateHistory.
  return dwellir ? [dwellir, mintBurnAlchemyEndpoint(url)] : [mintBurnAlchemyEndpoint(url)];
}

export async function getMintBurnBlockNumber(endpoints: readonly RpcEndpoint[], budget: SubrequestBudget,
  signal?: AbortSignal, endpointHeads?: Map<string, number>): Promise<number | null> {
  for (const endpoint of endpoints) {
    throwIfAborted(signal);
    const head = endpointHeads?.get(endpoint.url) ?? await getAlchemyBlockNumber(endpoint.url, budget, signal);
    if (head != null) {
      endpointHeads?.set(endpoint.url, head);
      return head;
    }
  }
  return null;
}

/** Resume only at the proven contiguous frontier, discarding logs beyond an unproven gap. */
export async function fetchMintBurnLogs(endpoints: readonly RpcEndpoint[], contractAddress: string,
  topics: AlchemyTopicFilter[], fromBlock: number, toBlock: number, budget: SubrequestBudget,
  signal?: AbortSignal, options?: { deadlineMs?: number; endpointHeads?: Map<string, number> }): Promise<AlchemyLogsFetchResult | null> {
  if (endpoints.length === 1) {
    return fetchAlchemyLogs(endpoints[0].url, contractAddress, topics, fromBlock, toBlock, budget, signal,
      options?.deadlineMs != null ? { deadlineMs: options.deadlineMs } : undefined);
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
    const result = await fetchAlchemyLogs(endpoint.url, contractAddress, topics, start, endpointTo, budget, signal,
      endpoint.operator === "dwellir" ? { ...options, endpoint } : options?.deadlineMs != null ? { deadlineMs: options.deadlineMs } : undefined);
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
  budget: SubrequestBudget, options?: ResolveBlockTimestampOptions): Promise<Map<number, number>> {
  const resolved = new Map<number, number>();
  for (const endpoint of endpoints) {
    throwIfAborted(options?.signal);
    const pending = blocks.filter((block) => !resolved.has(block));
    if (pending.length === 0 || budgetExhausted(budget)) break;
    const timestamps = await resolveBlockTimestamps(endpoint.url, pending, budget, options);
    for (const [block, timestamp] of timestamps) resolved.set(block, timestamp);
  }
  return resolved;
}
