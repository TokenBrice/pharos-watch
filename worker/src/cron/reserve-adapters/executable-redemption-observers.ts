import type { EvmRpcOptions } from "../../lib/evm-rpc";
import {
  fetchEvmBlockNumber,
  fetchEvmBlockHeader,
  fetchEvmBlockTimestamp,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmStorageAtBlock,
} from "../../lib/evm-rpc";
import type { AdapterContext } from "./types";
import { runAdapterIo } from "./concurrency";
import { runtimeCodeHash } from "./onchain-identity";
import { EXECUTABLE_REDEMPTION_OBSERVER_DEFINITIONS, type ExecutableRedemptionObserverId } from "@shared/types/redemption";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "@shared/lib/live-reserve-freshness";
import { EXECUTABLE_REDEMPTION_OBSERVATION_MAX_AGE_SEC } from "@shared/lib/redemption-backstop-capacity";
import { observeForestRoadUsdfr } from "./forest-road-usdfr-observer";
import { observeMonetrixFundedQueue } from "./monetrix-funded-queue-observer";
import { observeSaturnV2Queue } from "./saturn-v2-queue-observer";
import { observeApyusdUnlockReceipt } from "./apyusd-unlock-receipt-observer";
import {
  fail,
  type ExecutableRedemptionReadClient,
  type ExecutableRedemptionObservation,
  type ExecutableRedemptionObserverDescriptor,
  type ObserverOptions,
} from "./executable-redemption-read-client";
import { observeEarn } from "./ember-eearn-observer";
import { observeDStake } from "./dtrinity-dusd-observer";
import { observeSusnNoon } from "./noon-susn-observer";
import { observeLidoEarn } from "./lido-earnusd-observer";

const RPC_DEADLINE_MS = 10_000;
const OBSERVATION_BLOCK_LAG = 2;

export function getStableObservationBlockNumber(
  latestBlockNumber: number | null,
): number | null {
  if (
    latestBlockNumber == null ||
    !Number.isSafeInteger(latestBlockNumber) ||
    latestBlockNumber <= OBSERVATION_BLOCK_LAG
  ) {
    return null;
  }
  return latestBlockNumber - OBSERVATION_BLOCK_LAG;
}

function createDefaultClient(chain: string): ExecutableRedemptionReadClient {
  return {
    blockNumber: async (options) =>
      getStableObservationBlockNumber(await fetchEvmBlockNumber(chain, options)),
    blockTimestamp: (blockNumber, options) => fetchEvmBlockTimestamp(chain, blockNumber, options),
    blockHeader: (blockNumber, options) => fetchEvmBlockHeader(chain, blockNumber, options),
    codeHash: async (address, blockNumber, options) =>
      runtimeCodeHash(await fetchEvmCodeAtBlock(chain, address, blockNumber, options)),
    storage: (address, position, blockNumber, options) => fetchEvmStorageAtBlock(chain, address, position, blockNumber, options),
    multicall: (calls, blockNumber, options) => fetchEvmMulticall3Aggregate3AtBlock(chain, calls, blockNumber, options),
  };
}

export const EXECUTABLE_REDEMPTION_OBSERVERS = {
  "ember-eearn-batched": {
    ...EXECUTABLE_REDEMPTION_OBSERVER_DEFINITIONS["ember-eearn-batched"],
    observerId: "ember-eearn-batched", observe: observeEarn,
  },
  "dtrinity-dusd-withdrawal": {
    ...EXECUTABLE_REDEMPTION_OBSERVER_DEFINITIONS["dtrinity-dusd-withdrawal"],
    observerId: "dtrinity-dusd-withdrawal", observe: observeDStake,
  },
  "noon-susn-withdrawal": {
    ...EXECUTABLE_REDEMPTION_OBSERVER_DEFINITIONS["noon-susn-withdrawal"],
    observerId: "noon-susn-withdrawal", observe: observeSusnNoon,
  },
  "lido-earnusd-queue": {
    ...EXECUTABLE_REDEMPTION_OBSERVER_DEFINITIONS["lido-earnusd-queue"],
    observerId: "lido-earnusd-queue", observe: observeLidoEarn,
  },
  "usdfr-par-controller": {
    ...EXECUTABLE_REDEMPTION_OBSERVER_DEFINITIONS["usdfr-par-controller"],
    observerId: "usdfr-par-controller", observe: observeForestRoadUsdfr,
  },
  "apyusd-unlock-receipt": {
    ...EXECUTABLE_REDEMPTION_OBSERVER_DEFINITIONS["apyusd-unlock-receipt"],
    observerId: "apyusd-unlock-receipt", observe: observeApyusdUnlockReceipt,
  },
  "monetrix-funded-queue": {
    ...EXECUTABLE_REDEMPTION_OBSERVER_DEFINITIONS["monetrix-funded-queue"],
    observerId: "monetrix-funded-queue", observe: observeMonetrixFundedQueue,
  },
  "saturn-v2-queue": {
    ...EXECUTABLE_REDEMPTION_OBSERVER_DEFINITIONS["saturn-v2-queue"],
    observerId: "saturn-v2-queue", observe: observeSaturnV2Queue,
  },
} satisfies Record<ExecutableRedemptionObserverId, ExecutableRedemptionObserverDescriptor>;

export function getExecutableRedemptionObserver(id: ExecutableRedemptionObserverId): ExecutableRedemptionObserverDescriptor | null {
  return Object.prototype.hasOwnProperty.call(EXECUTABLE_REDEMPTION_OBSERVERS, id)
    ? EXECUTABLE_REDEMPTION_OBSERVERS[id as keyof typeof EXECUTABLE_REDEMPTION_OBSERVERS]
    : null;
}

export function hasExecutableRedemptionObserver(coinId: string): boolean {
  return Object.values(EXECUTABLE_REDEMPTION_OBSERVERS).some((descriptor) =>
    descriptor.coinId === coinId && descriptor.sourceLane === "reserve-backed");
}

export async function observeExecutableRedemptionRoute(
  coinId: string,
  contractAddress: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
  options: ObserverOptions = {},
  observerId?: ExecutableRedemptionObserverId,
): Promise<ExecutableRedemptionObservation | null> {
  const descriptor = observerId
    ? getExecutableRedemptionObserver(observerId)
    : Object.values(EXECUTABLE_REDEMPTION_OBSERVERS).find((entry) => entry.coinId === coinId);
  if (!descriptor) {
    if (observerId) fail(coinId, `unknown observer ${observerId}`);
    return null;
  }
  if (descriptor.coinId !== coinId || contractAddress.toLowerCase() !== descriptor.inputContract.toLowerCase()) {
    fail(coinId, `tracked contract identity drift (${contractAddress})`);
  }
  if (signal.aborted) throw signal.reason ?? new Error("Executable observer aborted");
  const client = options.client ?? createDefaultClient(descriptor.chain);
  // This observer reads a current chain head late in a long sequential reserve
  // run. The run-scoped context clock can be several minutes old by then, so
  // compare the block against the wall clock unless a test explicitly pins it.
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1_000);
  const rpcOptions: EvmRpcOptions = {
    ...options.rpcOptions,
    chainRpcs: ctx?.chainRpcs ?? options.rpcOptions?.chainRpcs,
    extraRpcUrls: options.extraRpcUrls ?? options.rpcOptions?.extraRpcUrls,
    signal,
    timeoutMs: 3_000,
    deadlineMs: Date.now() + RPC_DEADLINE_MS,
    maxRetries: 0,
  };
  const blockNumber = await runAdapterIo(
    ctx,
    `${coinId}-redemption-block-number`,
    () => client.blockNumber(rpcOptions),
    { signal },
  );
  if (blockNumber == null || !Number.isSafeInteger(blockNumber) || blockNumber <= 0) fail(coinId, "block number unavailable");
  const blockTimestamp = await runAdapterIo(
    ctx,
    `${coinId}-redemption-block-timestamp`,
    () => client.blockTimestamp(blockNumber, rpcOptions),
    { signal },
  );
  if (
    blockTimestamp == null || !Number.isSafeInteger(blockTimestamp) || blockTimestamp <= 0 ||
    blockTimestamp < nowSec - EXECUTABLE_REDEMPTION_OBSERVATION_MAX_AGE_SEC ||
    blockTimestamp > nowSec + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC
  ) {
    fail(coinId, "block timestamp is unavailable or out of range");
  }
  let observedBlockHash: string | undefined;
  if (descriptor.sourceLane === "direct" && descriptor.capacityCapability === "measured") {
    if (!client.blockHeader) fail(coinId, "block header transport unavailable");
    const header = await runAdapterIo(ctx, `${coinId}-redemption-block-header`,
      () => client.blockHeader!(blockNumber, rpcOptions), { signal });
    if (!header || header.number !== blockNumber || header.timestamp !== blockTimestamp || !/^0x[0-9a-f]{64}$/i.test(header.hash)) {
      fail(coinId, "block header identity unavailable");
    }
    observedBlockHash = header.hash;
    rpcOptions.stateBlockHash = header.hash;
    rpcOptions.multicallFallbackBlockHash = header.hash;
  }
  const observation = await descriptor.observe(blockNumber, blockTimestamp, rpcOptions, client, ctx, signal);
  if (signal.aborted) throw signal.reason ?? new Error("Executable observer aborted");
  if (observation.outputAssetKeys.length !== descriptor.outputAssetKeys.length ||
      !descriptor.outputAssetKeys.every((key) => observation.outputAssetKeys.includes(key))) {
    fail(coinId, "output asset identity drift");
  }
  return observedBlockHash
    ? { ...observation, diagnostics: { ...observation.diagnostics, observedBlockHash } }
    : observation;
}
