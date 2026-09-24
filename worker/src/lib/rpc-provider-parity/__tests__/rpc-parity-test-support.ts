import { RPC_PARITY_TARGETS } from "../targets";
import { mergeRpcParityRun, type RpcParityStoreRow } from "../store";
import type { RpcParityChainSample, RpcParityRunSamples } from "../types";

/**
 * Shared fixtures for the parity lane's tests. Heights and latencies use
 * worst-case widths (nine-digit heights, four-digit latencies) so the size
 * assertions measure the largest row this lane can actually write.
 */

export const PARITY_NOW_SEC = 1_789_000_000;
/** The chain used for single-chain scenarios: a registry chain with full log history. */
export const PARITY_REGISTRY_CHAIN = "base";
/** The chain whose Dwellir log history is declared absent. */
export const PARITY_PRUNED_LOG_CHAIN = "zksync";

export function paritySample(
  chainId: string,
  overrides: Partial<RpcParityChainSample> = {},
): RpcParityChainSample {
  return {
    chainId,
    comparator: { operator: "public", host: "mainnet.base.org", source: "registry" },
    dwellirHost: "api-base-mainnet-archive.n.dwellir.com",
    headOk: true,
    comparatorHeadOk: true,
    comparatorHead: 380_000_002,
    dwellirHead: 380_000_000,
    commonBlock: 379_999_000,
    lagBlocks: 2,
    stateChecked: true,
    stateMatched: true,
    logChecked: true,
    logMatched: true,
    prunedLogChecked: false,
    prunedLogTrap: false,
    dwellirLatencyMs: 1_000,
    comparatorLatencyMs: 1_000,
    errorClass: null,
    ...overrides,
  };
}

export function fullParityRun(
  atSec: number,
  overrides: (chainId: string, index: number) => Partial<RpcParityChainSample> = () => ({}),
): RpcParityRunSamples {
  return {
    atSec,
    samples: RPC_PARITY_TARGETS.map((target, index) => paritySample(
      target.chainId,
      {
        comparatorHead: 380_000_002 + index * 1_000,
        dwellirHead: 380_000_000 + index * 1_000,
        commonBlock: 379_999_000 + index * 1_000,
        dwellirLatencyMs: 1_000 + (index % 90) * 10,
        comparatorLatencyMs: 1_000 + (index % 70) * 10,
        ...overrides(target.chainId, index),
      },
    )),
  };
}

/** Merges the given runs into a retained window, newest last. */
export function buildParityRow(atSecs: readonly number[]): RpcParityStoreRow {
  let row: RpcParityStoreRow | null = null;
  for (const atSec of atSecs) {
    row = mergeRpcParityRun(row, fullParityRun(atSec), { nowSec: atSec }).row;
  }
  if (!row) throw new Error("no run merged");
  return row;
}

/** A retained run as the report reads it: the run clock plus that run's chain samples. */
export interface ParityRunFixture {
  atSec: number;
  samples: RpcParityChainSample[];
}

/** A run window of `runCount` hourly runs ending at `PARITY_NOW_SEC`, index 0 oldest. */
export function parityRunWindow(
  runCount: number,
  overrides?: (chainId: string, runIndex: number) => Partial<RpcParityChainSample>,
): ParityRunFixture[] {
  return Array.from({ length: runCount }, (_, runIndex) => {
    const atSec = PARITY_NOW_SEC - (runCount - 1 - runIndex) * 3600;
    return {
      atSec,
      samples: fullParityRun(atSec, (chainId) => overrides?.(chainId, runIndex) ?? {}).samples,
    };
  });
}

/** The registry chain's heights in every generated fixture, derived from one synthetic run. */
export const PARITY_REGISTRY_CHAIN_HEIGHTS = (() => {
  const sample = fullParityRun(PARITY_NOW_SEC).samples.find(
    (candidate) => candidate.chainId === PARITY_REGISTRY_CHAIN,
  );
  if (!sample) throw new Error("fixture chain missing");
  return {
    dwellirHead: sample.dwellirHead,
    comparatorHead: sample.comparatorHead,
    commonBlock: sample.commonBlock,
  };
})();
