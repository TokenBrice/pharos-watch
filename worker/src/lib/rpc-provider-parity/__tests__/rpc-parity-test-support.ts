import { RPC_PARITY_TARGETS } from "../targets";
import { mergeRpcParityRun, type RpcParityStoreRow } from "../store";
import { combineRpcParityLatestFreshness, RPC_PARITY_LATEST_MAX_NUMERIC_CALLS, type RpcParityChainSample, type RpcParityRunSamples, type RpcParityStepFailures } from "../types";
import { headLagThresholdBlocks } from "../report";

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
  const target = RPC_PARITY_TARGETS.find((entry) => entry.chainId === chainId);
  if (!target) throw new Error(`missing parity target for ${chainId}`);
  const sample: RpcParityChainSample = {
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
    comparatorErrorClass: null,
    comparatorHttpStatus: null,
    failedSteps: { dwellir: stepFailures(), comparator: stepFailures() },
    ...overrides,
  };
  if (!("latestFreshness" in overrides)) {
    const head = sample.dwellirHead ?? 380_000_000;
    const tolerance = headLagThresholdBlocks(target.blockTimeSec);
    const covered = tolerance + 1 <= RPC_PARITY_LATEST_MAX_NUMERIC_CALLS;
    if (!("sentinelFreshness" in overrides)) sample.sentinelFreshness = target.latestStateProbe === "state-bracket" ? null : {
      verdict: "fresh", reason: "served-block-in-range", headBefore: head, headAfter: head,
      matchedBlock: null, method: target.latestStateProbe, discriminating: true,
      servedBlock: head, lagBlocks: 0, toleranceBlocks: tolerance, latestValue: `0x${head.toString(16)}`, numericValues: [],
      call: target.latestStateProbe === "arbsys-block-number"
        ? { to: "0x0000000000000000000000000000000000000064", data: "0xa3b1b31d" }
        : { to: "0xca11bde05977b3631167028862be2a173976ca11", data: "0x42cbb15c" },
    };
    if (!("tokenFreshness" in overrides)) sample.tokenFreshness = {
      verdict: covered ? "fresh" : "indeterminate", reason: covered ? "matched-numeric-block" : "bracket-too-wide",
      headBefore: head, headAfter: head, referenceEndBlock: head,
      matchedBlock: covered ? head : null, method: "state-bracket", discriminating: covered, toleranceBlocks: tolerance,
      latestValue: "0x100",
      numericValues: covered ? Array.from({ length: tolerance + 1 }, (_, index) => ({
        block: head - index, value: index === 0 ? "0x100" : "0xff",
      })) : [],
      call: { to: target.contract, data: "0x18160ddd" },
    };
    sample.latestFreshness = sample.tokenFreshness
      ? combineRpcParityLatestFreshness(sample.sentinelFreshness ?? null, sample.tokenFreshness)
      : sample.sentinelFreshness ?? undefined;
  }
  if (!("calls" in overrides)) {
    sample.calls = { dwellir: [], comparator: [] };
    for (const operator of ["dwellir", "comparator"] as const) {
      for (const step of ["head", "state", "logs", "latest"] as const) {
        if (operator === "comparator" && step === "latest") continue;
        const latencyMs = operator === "dwellir" ? sample.dwellirLatencyMs : sample.comparatorLatencyMs;
        if (latencyMs === null) continue;
        const failed = sample.failedSteps[operator][step] || (step === "head"
          && !(operator === "dwellir" ? sample.headOk : sample.comparatorHeadOk));
        sample.calls[operator].push({
          step, phase: step === "head" ? "firstTouch" : "warm", latencyMs,
          errorClass: failed ? (operator === "dwellir" ? sample.errorClass : sample.comparatorErrorClass) ?? "timeout" : null,
        });
      }
    }
  }
  return sample;
}

/** Step-failure flags for one operator; every step is healthy unless named. */
export function stepFailures(overrides: Partial<RpcParityStepFailures> = {}): RpcParityStepFailures {
  return { head: false, state: false, logs: false, latest: false, ...overrides };
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
  skipped?: RpcParityRunSamples["skipped"];
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
