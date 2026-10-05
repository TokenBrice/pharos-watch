import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { recordOutcome } from "../../circuit-breaker";
import { CIRCUIT_SOURCE } from "../../constants";
import {
  buildRpcParityChainSummary,
  evaluateRpcParityGate,
  headLagThresholdBlocks,
  loadRpcProviderTrialReport,
  percentileNearestRank,
  RPC_PARITY_GATE_MIN_RUNS,
  RPC_PARITY_GATE_MIN_SUCCESS_RATE,
} from "../report";
import { recordRpcParityRun, RPC_PARITY_STORE_KEY } from "../store";
import { RPC_PARITY_TARGETS } from "../targets";
import type { RpcParityChainSample } from "../types";
import {
  fullParityRun,
  PARITY_NOW_SEC,
  PARITY_PRUNED_LOG_CHAIN,
  PARITY_REGISTRY_CHAIN,
  parityRunWindow,
  PARITY_REGISTRY_CHAIN_HEIGHTS,
  stepFailures,
  paritySample,
  type ParityRunFixture,
} from "./rpc-parity-test-support";

const fixtures = createLatestSchemaFixtureTracker();

afterEach(() => {
  fixtures.closeAll();
});

function summaryFor(
  chainId: string,
  runs: ParityRunFixture[],
  options: { blockTimeSec?: number; logsHistoryIsNone?: boolean } = {},
) {
  const target = RPC_PARITY_TARGETS.find((candidate) => candidate.chainId === chainId);
  if (!target) throw new Error(`missing target ${chainId}`);
  const samples = runs.flatMap((run) => run.samples).filter((sample) => sample.chainId === chainId);
  return buildRpcParityChainSummary({
    chainId,
    runs,
    latest: samples.length === 0
      ? null
      : {
        atSec: PARITY_NOW_SEC,
        dwellirHead: samples[samples.length - 1].dwellirHead,
        comparatorHead: samples[samples.length - 1].comparatorHead,
        commonBlock: samples[samples.length - 1].commonBlock,
      },
    dwellirHost: `${chainId}.n.dwellir.com`,
    fallbackComparator: { operator: "public", host: "example.invalid", source: "registry" },
    logsHistoryIsNone: options.logsHistoryIsNone ?? false,
    blockTimeSec: options.blockTimeSec ?? target.blockTimeSec,
  });
}

describe("rpc parity gate math", () => {
  it("passes a full healthy window", () => {
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS + 6);
    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    expect(summary.runs).toBe(RPC_PARITY_GATE_MIN_RUNS + 6);
    expect(summary.dwellirSuccessRate).toBe(1);
    expect(summary.headLagBlocks).toEqual({ p50: 2, p95: 2, samples: RPC_PARITY_GATE_MIN_RUNS + 6 });
    expect(summary.stateParity).toEqual({ checked: RPC_PARITY_GATE_MIN_RUNS + 6, matched: RPC_PARITY_GATE_MIN_RUNS + 6, mismatched: 0, lastMismatch: null });
    expect(summary.logParity).toEqual({ checked: RPC_PARITY_GATE_MIN_RUNS + 6, matched: RPC_PARITY_GATE_MIN_RUNS + 6, mismatched: 0, skippedReason: null });
    expect(summary.errorClasses).toEqual({});
    expect(summary.gate).toEqual({ passed: true, failing: [] });
    expect(summary.last).toEqual({
      atSec: PARITY_NOW_SEC,
      ...PARITY_REGISTRY_CHAIN_HEIGHTS,
    });
  });

  it("requires at least 24 retained runs", () => {
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS - 1);
    expect(summaryFor(PARITY_REGISTRY_CHAIN, runs).gate.failing).toContain("runs");
  });

  it("excludes capability refusals from the success-rate denominator", () => {
    const refusals = 40;
    const healthy = RPC_PARITY_GATE_MIN_RUNS;
    const runs = parityRunWindow(refusals + healthy, (chainId, runIndex) => (
      chainId !== PARITY_REGISTRY_CHAIN || runIndex < healthy
        ? {}
        : {
          headOk: false,
          comparatorHeadOk: false,
          comparatorHead: null,
          dwellirHead: null,
          commonBlock: null,
          lagBlocks: null,
          stateChecked: false,
          stateMatched: false,
          logChecked: false,
          logMatched: false,
          dwellirLatencyMs: null,
          comparatorLatencyMs: null,
          errorClass: "capability",
        }
    ));

    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    // Refusals are excluded from both sides of the ratio, so the rate still
    // describes the calls that were actually served.
    expect(summary.dwellirSuccessRate).toBe(1);
    expect(summary.errorClasses).toEqual({ capability: refusals });
    expect(summary.gate.passed).toBe(true);
  });

  it("fails the success-rate gate once refused calls are served and fail", () => {
    const healthy = RPC_PARITY_GATE_MIN_RUNS;
    const runs = parityRunWindow(healthy + 40, (chainId, runIndex) => (
      chainId !== PARITY_REGISTRY_CHAIN || runIndex < healthy
        ? {}
        : { headOk: false, dwellirHead: null, errorClass: "server-error" }
    ));
    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    expect(summary.dwellirSuccessRate).toBeCloseTo(healthy / (healthy + 40), 5);
    expect(summary.dwellirSuccessRate).toBeLessThan(RPC_PARITY_GATE_MIN_SUCCESS_RATE);
    expect(summary.gate.failing).toContain("success-rate:head");
  });

  it("refuses head-lag and latency on too few comparable samples", () => {
    const comparable = 10;
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS, (chainId, runIndex) => (
      chainId === PARITY_REGISTRY_CHAIN && runIndex >= comparable
        ? {
          headOk: false,
          dwellirHead: null,
          comparatorHeadOk: false,
          comparatorHead: null,
          commonBlock: null,
          lagBlocks: null,
          dwellirLatencyMs: null,
          comparatorLatencyMs: null,
          stateChecked: false,
          stateMatched: false,
          logChecked: false,
          logMatched: false,
          failedSteps: { dwellir: stepFailures({ head: true }), comparator: stepFailures({ head: true }) },
        }
        : {}
    ));

    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    expect(summary.runs).toBe(RPC_PARITY_GATE_MIN_RUNS);
    expect(summary.headLagBlocks.samples).toBe(comparable);
    expect(summary.gate.failing).toContain("insufficient-comparable-samples");
    // The measured lag is still healthy: the gate fails on evidence, not values.
    expect(summary.headLagBlocks.p95).toBe(2);
    expect(summary.gate.failing).not.toContain("head-lag");
    expect(summary.gate.failing).not.toContain("latency");
  });

  it("refuses state parity on too few state checks", () => {
    const checked = 12;
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS, (chainId, runIndex) => (
      chainId === PARITY_REGISTRY_CHAIN && runIndex >= checked
        ? { stateChecked: false, stateMatched: false, failedSteps: { dwellir: stepFailures({ state: true }), comparator: stepFailures() } }
        : {}
    ));

    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    expect(summary.stateParity.checked).toBe(checked);
    expect(summary.stateParity.mismatched).toBe(0);
    expect(summary.gate.failing).toContain("insufficient-state-checks");
    expect(summary.gate.failing).not.toContain("state-parity");
  });

  it("refuses log parity on too few log checks, but not where logs are absent by declaration", () => {
    const checked = 9;
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS, (chainId, runIndex) => (
      chainId === PARITY_REGISTRY_CHAIN && runIndex >= checked
        ? { logChecked: false, logMatched: false, failedSteps: { dwellir: stepFailures({ logs: true }), comparator: stepFailures() } }
        : {}
    ));

    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    expect(summary.logParity.checked).toBe(checked);
    expect(summary.gate.failing).toContain("insufficient-log-checks");
    expect(summary.gate.failing).not.toContain("log-parity");

    // zkSync declares no log history, so it carries no log-check requirement.
    const prunedRuns = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS, (chainId) => (
      chainId === PARITY_PRUNED_LOG_CHAIN
        ? { logChecked: false, logMatched: false, prunedLogChecked: true, prunedLogTrap: true }
        : {}
    ));
    const pruned = summaryFor(PARITY_PRUNED_LOG_CHAIN, prunedRuns, { logsHistoryIsNone: true });
    expect(pruned.gate.failing).not.toContain("insufficient-log-checks");
    expect(pruned.gate.passed).toBe(true);
  });

  it("passes every sufficiency rule exactly at the retained-run floor", () => {
    const summary = summaryFor(PARITY_REGISTRY_CHAIN, parityRunWindow(RPC_PARITY_GATE_MIN_RUNS));
    expect(summary.headLagBlocks.samples).toBe(RPC_PARITY_GATE_MIN_RUNS);
    expect(summary.stateParity.checked).toBe(RPC_PARITY_GATE_MIN_RUNS);
    expect(summary.logParity.checked).toBe(RPC_PARITY_GATE_MIN_RUNS);
    expect(summary.gate).toEqual({ passed: true, failing: [] });
  });

  it("counts comparator-side failures separately from Dwellir failures", () => {
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS, (chainId) => (
      chainId === PARITY_REGISTRY_CHAIN
        ? {
          headOk: true,
          comparatorHeadOk: false,
          comparatorHead: null,
          lagBlocks: null,
          comparatorErrorClass: "capability",
          comparatorHttpStatus: 1010,
          failedSteps: { dwellir: stepFailures(), comparator: stepFailures({ head: true }) },
        }
        : {}
    ));

    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    // A refused baseline is a comparator fact, never a Dwellir error class.
    expect(summary.errorClasses).toEqual({});
    expect(summary.comparatorErrorClasses).toEqual({ capability: RPC_PARITY_GATE_MIN_RUNS });
    expect(summary.failedSteps).toEqual({
      dwellir: { head: 0, state: 0, logs: 0, latest: 0 },
      comparator: { head: RPC_PARITY_GATE_MIN_RUNS, state: 0, logs: 0, latest: 0 },
    });
    expect(summary.lastComparatorFailure).toEqual({
      atSec: PARITY_NOW_SEC,
      step: "head",
      errorClass: "capability",
      httpStatus: 1010,
      comparator: { operator: "public", host: "mainnet.base.org", source: "registry" },
    });
    // No comparator baseline means no lag evidence, so the lag gate stays failed.
    expect(summary.headLagBlocks.p95).toBeNull();
    expect(summary.gate.failing).toContain("head-lag");
  });

  it("keeps an unavailable Dwellir read out of the mismatch counts and in the availability rate", () => {
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS, (chainId, runIndex) => {
      if (chainId !== PARITY_REGISTRY_CHAIN) return {};
      if (runIndex === RPC_PARITY_GATE_MIN_RUNS - 2) {
        return {
          stateChecked: false,
          stateMatched: false,
          failedSteps: { dwellir: stepFailures({ state: true }), comparator: stepFailures() },
          errorClass: "timeout",
        };
      }
      if (runIndex === RPC_PARITY_GATE_MIN_RUNS - 1) {
        return {
          logChecked: false,
          logMatched: false,
          failedSteps: { dwellir: stepFailures({ logs: true }), comparator: stepFailures() },
          errorClass: "timeout",
        };
      }
      return {};
    });

    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    // Unavailable is not unequal: neither read becomes a parity claim.
    expect(summary.stateParity.checked).toBe(RPC_PARITY_GATE_MIN_RUNS - 1);
    expect(summary.stateParity.mismatched).toBe(0);
    expect(summary.logParity.checked).toBe(RPC_PARITY_GATE_MIN_RUNS - 1);
    expect(summary.logParity.mismatched).toBe(0);
    expect(summary.gate.failing).toEqual(expect.arrayContaining([
      "insufficient-state-checks",
      "insufficient-log-checks",
      "success-rate:state",
      "success-rate:logs",
    ]));
    expect(summary.gate.failing).not.toContain("state-parity");
    expect(summary.gate.failing).not.toContain("log-parity");
    // Availability is where the failed reads belong.
    expect(summary.dwellirSuccessRate).toBeCloseTo((RPC_PARITY_GATE_MIN_RUNS - 2) / RPC_PARITY_GATE_MIN_RUNS, 6);
    expect(summary.errorClasses).toEqual({ timeout: 2 });
    expect(summary.failedSteps.dwellir).toEqual({ head: 0, state: 1, logs: 1, latest: 0 });
  });

  it("does not count a plan refusal as a Dwellir availability failure", () => {
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS + 2, (chainId, runIndex) => (
      chainId === PARITY_REGISTRY_CHAIN && runIndex >= RPC_PARITY_GATE_MIN_RUNS
        ? {
          headOk: false,
          dwellirHead: null,
          errorClass: "capability",
          failedSteps: { dwellir: stepFailures({ head: true }), comparator: stepFailures() },
        }
        : {}
    ));

    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    // Refusals leave the denominator, so the rate still describes served calls.
    expect(summary.dwellirSuccessRate).toBe(1);
    expect(summary.errorClasses).toEqual({ capability: 2 });
    expect(summary.gate.failing).not.toContain("success-rate:head");
  });

  it("reports the newest comparator failure with its step, class, and status", () => {
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS, (chainId, runIndex) => (
      chainId === PARITY_REGISTRY_CHAIN && runIndex === RPC_PARITY_GATE_MIN_RUNS - 2
        ? {
          failedSteps: { dwellir: stepFailures(), comparator: stepFailures({ state: true }) },
          comparatorErrorClass: "timeout",
          comparatorHttpStatus: null,
        }
        : chainId === PARITY_REGISTRY_CHAIN && runIndex === RPC_PARITY_GATE_MIN_RUNS - 1
          ? {
            failedSteps: { dwellir: stepFailures({ logs: true }), comparator: stepFailures({ logs: true }) },
            comparatorErrorClass: "server-error",
            comparatorHttpStatus: 502,
          }
          : {}
    ));

    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    expect(summary.failedSteps.comparator).toEqual({ head: 0, state: 1, logs: 1, latest: 0 });
    expect(summary.failedSteps.dwellir).toEqual({ head: 0, state: 0, logs: 1, latest: 0 });
    expect(summary.lastComparatorFailure).toEqual({
      atSec: PARITY_NOW_SEC,
      step: "logs",
      errorClass: "server-error",
      httpStatus: 502,
      comparator: { operator: "public", host: "mainnet.base.org", source: "registry" },
    });
  });

  it("leaves diagnostics empty for samples that never recorded a failure", () => {
    const summary = summaryFor(PARITY_REGISTRY_CHAIN, parityRunWindow(RPC_PARITY_GATE_MIN_RUNS));
    expect(summary.comparatorErrorClasses).toEqual({});
    expect(summary.failedSteps).toEqual({
      dwellir: { head: 0, state: 0, logs: 0, latest: 0 },
      comparator: { head: 0, state: 0, logs: 0, latest: 0 },
    });
    expect(summary.lastComparatorFailure).toBeNull();
  });

  it("fails head-lag against the chain's own block time", () => {
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS, (chainId) => (
      chainId === PARITY_REGISTRY_CHAIN ? { lagBlocks: 4 } : {}
    ));
    // base runs at ~2s blocks: six seconds of tolerance is three blocks.
    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs, { blockTimeSec: 2 });
    expect(summary.headLagBlocks).toEqual({ p50: 4, p95: 4, samples: RPC_PARITY_GATE_MIN_RUNS });
    expect(summary.gate.failing).toContain("head-lag");

    const tolerant = summaryFor(
      PARITY_REGISTRY_CHAIN,
      parityRunWindow(RPC_PARITY_GATE_MIN_RUNS, (chainId) => (
        chainId === PARITY_REGISTRY_CHAIN ? { lagBlocks: 20 } : {}
      )),
      { blockTimeSec: 0.25 },
    );
    expect(tolerant.headLagBlocks.p95).toBe(20);
    expect(tolerant.gate.failing).not.toContain("head-lag");
  });

  it("reports state and log mismatches with the block they were read at", () => {
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS, (chainId, runIndex) => (
      chainId === PARITY_REGISTRY_CHAIN && runIndex >= RPC_PARITY_GATE_MIN_RUNS - 1
        ? { stateMatched: false, logMatched: false }
        : {}
    ));
    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    expect(summary.stateParity.mismatched).toBe(1);
    expect(summary.stateParity.lastMismatch).toEqual({
      atSec: PARITY_NOW_SEC,
      block: PARITY_REGISTRY_CHAIN_HEIGHTS.commonBlock,
      comparator: { operator: "public", host: "mainnet.base.org", source: "registry" },
    });
    expect(summary.logParity.mismatched).toBe(1);
    expect(summary.gate.failing).toEqual(expect.arrayContaining(["state-parity", "log-parity"]));
  });

  it("skips log parity for a chain whose Dwellir log history is absent", () => {
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS, (chainId) => (
      chainId === PARITY_PRUNED_LOG_CHAIN
        ? { logChecked: false, logMatched: false, prunedLogChecked: true, prunedLogTrap: true }
        : {}
    ));
    const summary = summaryFor(PARITY_PRUNED_LOG_CHAIN, runs, { logsHistoryIsNone: true });
    expect(summary.logParity).toEqual({ checked: 0, matched: 0, mismatched: 0, skippedReason: "logs-history-none" });
    expect(summary.prunedLogProbe).toEqual({
      checked: RPC_PARITY_GATE_MIN_RUNS,
      dwellirEmptyWhileComparatorNonEmpty: RPC_PARITY_GATE_MIN_RUNS,
    });
    expect(summary.gate.passed).toBe(true);
  });

  it("holds latency to the comparator's p95 plus 500 ms, using served reads only", () => {
    const withinTolerance = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS, (chainId) => (
      chainId === PARITY_REGISTRY_CHAIN ? { dwellirLatencyMs: 1_500, comparatorLatencyMs: 1_000 } : {}
    ));
    expect(summaryFor(PARITY_REGISTRY_CHAIN, withinTolerance).gate.failing).not.toContain("latency");

    const overTolerance = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS, (chainId) => (
      chainId === PARITY_REGISTRY_CHAIN ? { dwellirLatencyMs: 1_501, comparatorLatencyMs: 1_000 } : {}
    ));
    const slow = summaryFor(PARITY_REGISTRY_CHAIN, overTolerance);
    expect(slow.latency.dwellir.warmRunMedian.p95Ms).toBe(1_501);
    expect(slow.gate.failing).toContain("latency");
  });

  it("does not count failed reads as served latency", () => {
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS, (chainId) => (
      chainId === PARITY_REGISTRY_CHAIN ? { comparatorLatencyMs: null, dwellirLatencyMs: null } : {}
    ));
    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    expect(summary.latency.dwellir.warmRunMedian).toEqual({ p50Ms: null, p95Ms: null, samples: 0 });
    expect(summary.latency.comparator.warmRunMedian).toEqual({ p50Ms: null, p95Ms: null, samples: 0 });
    expect(summary.gate.failing).toContain("insufficient-warm-samples");
    expect(summary.gate.failing).not.toContain("latency");
  });

  it("scales the head-lag threshold from the chain's nominal block time", () => {
    expect(headLagThresholdBlocks(12)).toBe(3);
    expect(headLagThresholdBlocks(2)).toBe(3);
    expect(headLagThresholdBlocks(1)).toBe(6);
    expect(headLagThresholdBlocks(0.25)).toBe(24);
    expect(headLagThresholdBlocks(0.01)).toBe(600);
    expect(headLagThresholdBlocks(0)).toBe(3);
    expect(percentileNearestRank([], 0.95)).toBeNull();
    expect(percentileNearestRank([40, 10, 30, 20], 0.5)).toBe(20);
    expect(percentileNearestRank([40, 10, 30, 20], 0.95)).toBe(40);
  });

  it("evaluates a gate from a summary alone", () => {
    const summary = summaryFor(PARITY_REGISTRY_CHAIN, parityRunWindow(RPC_PARITY_GATE_MIN_RUNS));
    expect(evaluateRpcParityGate(summary, 2).passed).toBe(true);
    expect(evaluateRpcParityGate({ ...summary, runs: 1 }, 2).failing).toContain("runs");
  });

  it.each([
    { chainId: "base", tolerance: 3 },
    { chainId: "arbitrum", tolerance: 24 },
    { chainId: "robinhood", tolerance: 6 },
  ])("reports the shared chain-time freshness budget for $chainId", ({ chainId, tolerance }) => {
    const summary = summaryFor(chainId, parityRunWindow(RPC_PARITY_GATE_MIN_RUNS));
    expect(summary.latestFreshness.blockTolerance).toBe(tolerance);
  });

  it("attributes split and historical comparator observations without rewriting the old state mismatch", () => {
    const stateRef = { operator: "public" as const, host: "hyperliquid.drpc.org", source: "pin" as const };
    const logRef = { operator: "alchemy" as const, host: "hyperliquid-mainnet.g.alchemy.com", source: "pin" as const };
    const oldSample = paritySample("hyperevm", { comparator: logRef, stateMatched: false });
    const newSample = paritySample("hyperevm", { comparator: stateRef, logsComparator: logRef });
    newSample.calls!.comparator = [
      { step: "head", phase: "firstTouch", latencyMs: 100, errorClass: null },
      { step: "state", phase: "warm", latencyMs: 50, errorClass: null },
      { step: "head", phase: "firstTouch", latencyMs: 120, errorClass: null, comparator: logRef },
      { step: "logs", phase: "warm", latencyMs: 60, errorClass: null, comparator: logRef },
    ];
    const runs = [
      { atSec: PARITY_NOW_SEC - 3600, samples: [oldSample] },
      { atSec: PARITY_NOW_SEC, samples: [newSample] },
    ];
    const summary = summaryFor("hyperevm", runs);
    expect(summary.comparator).toEqual(stateRef);
    expect(summary.logsComparator).toEqual(logRef);
    expect(summary.comparatorsByStep).toEqual({
      head: [logRef, stateRef], state: [logRef, stateRef], logs: [logRef], latest: [],
    });
    expect(summary.stateParity.lastMismatch).toEqual({
      atSec: PARITY_NOW_SEC - 3600, block: oldSample.commonBlock, comparator: logRef,
    });
    expect(summary.latency.comparator.warmRunMedian.samples).toBe(2);
    expect(summary.gate.failing).toContain("state-parity");
  });

  it("fails closed when the newest log comparator is unavailable despite a full historical window", () => {
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS);
    const unavailable = paritySample("hyperevm", { logsComparator: null, logChecked: false, logMatched: false });
    unavailable.calls!.comparator = unavailable.calls!.comparator.filter((call) => call.step !== "logs");
    unavailable.calls!.dwellir = unavailable.calls!.dwellir.filter((call) => call.step !== "logs");
    runs.push({ atSec: PARITY_NOW_SEC + 3600, samples: [unavailable] });
    const summary = summaryFor("hyperevm", runs);
    expect(summary.stateParity.checked).toBe(RPC_PARITY_GATE_MIN_RUNS + 1);
    expect(summary.logParity.checked).toBe(RPC_PARITY_GATE_MIN_RUNS);
    expect(summary.logsComparator).toBeNull();
    expect(summary.logParity.skippedReason).toBe("no-comparator");
    expect(summary.gate.failing).toContain("no-log-comparator");
  });

  it("names the failing log origin rather than the successful primary head baseline", () => {
    const logRef = { operator: "alchemy" as const, host: "hyperliquid-mainnet.g.alchemy.com", source: "pin" as const };
    const sample = paritySample("hyperevm", {
      logsComparator: logRef, comparatorErrorClass: "server-error", comparatorHttpStatus: 502,
      failedSteps: { dwellir: stepFailures(), comparator: stepFailures({ head: true }) },
    });
    sample.calls!.comparator = [
      { step: "head", phase: "firstTouch", latencyMs: 100, errorClass: null },
      { step: "state", phase: "warm", latencyMs: 50, errorClass: null },
      { step: "head", phase: "firstTouch", latencyMs: 120, errorClass: "server-error", comparator: logRef },
      { step: "logs", phase: "warm", latencyMs: 60, errorClass: null, comparator: logRef },
    ];
    const summary = summaryFor("hyperevm", [{ atSec: PARITY_NOW_SEC, samples: [sample] }]);
    expect(summary.lastComparatorFailure).toEqual({
      atSec: PARITY_NOW_SEC, step: "head", errorClass: "server-error", httpStatus: 502, comparator: logRef,
    });
  });

  it("does not turn legacy samples into method availability, warm latency or freshness passes", () => {
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS, () => ({ calls: undefined, latestFreshness: undefined }));
    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    expect(summary.availability.dwellir.state).toMatchObject({
      attempts: 0, unknownRuns: RPC_PARITY_GATE_MIN_RUNS, successRate: null,
    });
    expect(summary.latestFreshness.unknown).toBe(RPC_PARITY_GATE_MIN_RUNS);
    expect(summary.gate.failing).toEqual(expect.arrayContaining([
      "insufficient-state-attempts", "success-rate:state", "insufficient-warm-samples",
      "insufficient-latest-freshness-checks",
    ]));
  });

  it("holds any stale latest verdict and reports its block/value example", () => {
    const freshness = {
      verdict: "stale" as const, reason: "no-bracket-match" as const,
      headBefore: 100, headAfter: 101, matchedBlock: null, latestValue: "10",
      numericValues: [{ block: 101, value: "11" }, { block: 100, value: "11" }],
    };
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS, (chainId, index) => (
      chainId === PARITY_REGISTRY_CHAIN && index === RPC_PARITY_GATE_MIN_RUNS - 1
        ? { latestFreshness: freshness } : {}
    ));
    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    expect(summary.latestFreshness.stale).toBe(1);
    expect(summary.latestFreshness.lastStale).toEqual({ ...freshness, atSec: PARITY_NOW_SEC });
    expect(summary.gate.failing).toContain("latest-state-freshness");
  });
  it.each([false, undefined])("does not count a nondiscriminating or legacy fresh match toward the floor: %s", (discriminating) => {
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS, () => ({
      latestFreshness: {
        verdict: "fresh", reason: "matched-numeric-block",
        method: discriminating === undefined ? undefined : "state-bracket", discriminating,
        headBefore: 100, headAfter: 100, matchedBlock: 100,
      },
    }));
    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    expect(summary.latestFreshness).toMatchObject({
      fresh: RPC_PARITY_GATE_MIN_RUNS, discriminatingFresh: 0, nonDiscriminatingFresh: RPC_PARITY_GATE_MIN_RUNS,
    });
    expect(summary.gate.failing).toContain("insufficient-latest-freshness-checks");
  });

  it("exposes per-chain skip reasons without inventing reasons for legacy gaps", () => {
    const summary = summaryFor(PARITY_REGISTRY_CHAIN, [
      { atSec: PARITY_NOW_SEC - 7200, samples: [] },
      { atSec: PARITY_NOW_SEC - 3600, samples: [], skipped: [{ chainId: PARITY_REGISTRY_CHAIN, reason: "deadline" }] },
      { atSec: PARITY_NOW_SEC, samples: [], skipped: [{ chainId: PARITY_REGISTRY_CHAIN, reason: "aborted" }] },
    ]);
    expect(summary.runs).toBe(0);
    expect(summary.skips).toEqual({ "no-comparator": 0, "no-dwellir-entry": 0, deadline: 1, aborted: 1, unknown: 1 });
    expect(summary.lastSkip).toEqual({ atSec: PARITY_NOW_SEC, reason: "aborted" });
  });


  it("reports first-touch latency without using it to fail the warm gate", () => {
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS);
    for (const run of runs) {
      const sample = run.samples.find((entry) => entry.chainId === PARITY_REGISTRY_CHAIN)!;
      for (const call of sample.calls!.dwellir) if (call.phase === "firstTouch") call.latencyMs = 8_000;
    }
    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    expect(summary.latency.dwellir.firstTouch.head.p95Ms).toBe(8_000);
    expect(summary.latency.dwellir.warm.state.p95Ms).toBeLessThan(8_000);
    expect(summary.gate.failing).not.toContain("latency");
  });

  it("excludes capability refusals only from the method that refused them", () => {
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS);
    const last = runs[runs.length - 1].samples.find((sample) => sample.chainId === PARITY_REGISTRY_CHAIN)!;
    const state = last.calls!.dwellir.find((call) => call.step === "state")!;
    const logs = last.calls!.dwellir.find((call) => call.step === "logs")!;
    state.errorClass = "capability";
    logs.errorClass = "timeout";
    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    expect(summary.availability.dwellir.state).toMatchObject({ capabilityRefusals: 1, successRate: 1 });
    expect(summary.availability.dwellir.logs.successRate).toBeCloseTo(23 / 24);
    expect(summary.gate.failing).toContain("success-rate:logs");
    expect(summary.gate.failing).not.toContain("success-rate:state");
  });

  it("takes each run's actual warm median before the window percentile", () => {
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS);
    for (const run of runs) {
      const sample = run.samples.find((entry) => entry.chainId === PARITY_REGISTRY_CHAIN)!;
      const warm = sample.calls!.comparator.filter((call) => call.phase === "warm");
      warm[0].latencyMs = 100;
      warm[1].latencyMs = 900;
    }
    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    expect(summary.latency.comparator.warmRunMedian).toEqual({ p50Ms: 500, p95Ms: 500, samples: RPC_PARITY_GATE_MIN_RUNS });
  });
});

describe("rpc provider trial report", () => {
  it("reports the unconfigured provider without inventing observations", async () => {
    const { db } = fixtures.open();
    const report = await loadRpcProviderTrialReport(db, {}, PARITY_NOW_SEC);
    expect(report.provider).toBe("dwellir");
    expect(report.budget.configured).toBe(false);
    expect(report.budget.reason).toBe("not-configured");
    // No breaker row yet: the shared helper reports its synthesized closed
    // default, and the null timestamp shows nothing has been observed.
    expect(report.circuit).toEqual({ state: "closed", consecutiveFailures: 0, updatedAtSec: null });
    expect(report.observationError).toBeNull();
    expect(report.observation?.runsRetained).toBe(0);
    expect(report.observation?.chains).toHaveLength(RPC_PARITY_TARGETS.length);
    const base = report.observation?.chains.find((chain) => chain.chainId === PARITY_REGISTRY_CHAIN);
    expect(base?.runs).toBe(0);
    expect(base?.last).toBeNull();
    expect(base?.dwellirSuccessRate).toBeNull();
    expect(base?.gate.failing).toContain("runs");
    // A chain with no sample reports the planned keyless comparator, never a guess.
    expect(base?.comparator).toEqual({ operator: "public", host: "mainnet.base.org", source: "registry" });
  });

  it("summarizes retained samples and the breaker state", async () => {
    const { db } = fixtures.open();
    await recordRpcParityRun(db, fullParityRun(PARITY_NOW_SEC - 3600));
    await recordRpcParityRun(db, fullParityRun(PARITY_NOW_SEC));
    await recordOutcome(db, CIRCUIT_SOURCE.DWELLIR_EVM, false);

    const report = await loadRpcProviderTrialReport(db, { DWELLIR_API_KEY: "parity-test-key" }, PARITY_NOW_SEC);
    expect(report.budget.configured).toBe(true);
    expect(report.budget.usable).toBe(true);
    expect(report.observationError).toBeNull();
    expect(report.observation?.runsRetained).toBe(2);
    expect(report.observation?.windowStartSec).toBe(PARITY_NOW_SEC - 3600);
    expect(report.observation?.lastRunAtSec).toBe(PARITY_NOW_SEC);
    const base = report.observation?.chains.find((chain) => chain.chainId === PARITY_REGISTRY_CHAIN);
    expect(base?.runs).toBe(2);
    expect(base?.dwellirSuccessRate).toBe(1);
    expect(base?.last).toEqual({
      atSec: PARITY_NOW_SEC,
      ...PARITY_REGISTRY_CHAIN_HEIGHTS,
    });
    expect(report.circuit).toMatchObject({ state: "closed", consecutiveFailures: 1 });
    // The breaker row is written by the shared helper's own clock, not the run clock.
    expect(report.circuit?.updatedAtSec).toBeGreaterThan(PARITY_NOW_SEC);
  });

  it("surfaces an unreadable window as an error instead of throwing", async () => {
    const { db } = fixtures.open();
    await db.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(RPC_PARITY_STORE_KEY, "{}", PARITY_NOW_SEC)
      .run();
    const report = await loadRpcProviderTrialReport(db, {}, PARITY_NOW_SEC);
    expect(report.observation).toBeNull();
    expect(report.observationError).toContain(RPC_PARITY_STORE_KEY);
  });

  it("keeps reporting a null circuit when D1 reads fail", async () => {
    const { db } = fixtures.open();
    const failingDb = new Proxy(db, {
      get: (target, property, receiver) => {
        if (property === "prepare") {
          return () => {
            throw new Error("d1 unavailable");
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const report = await loadRpcProviderTrialReport(failingDb as typeof db, {}, PARITY_NOW_SEC);
    expect(report.circuit).toBeNull();
    expect(report.observation).toBeNull();
    expect(report.observationError).not.toBeNull();
  });
});

function sampleWith(overrides: Partial<RpcParityChainSample>): RpcParityChainSample {
  return { ...fullParityRun(PARITY_NOW_SEC).samples[0], ...overrides };
}

describe("rpc parity chain summary edge cases", () => {
  it("derives the comparator claim from the newest sample, not the planned fallback", () => {
    const runs = [{
      atSec: PARITY_NOW_SEC,
      samples: [sampleWith({ chainId: PARITY_REGISTRY_CHAIN, comparator: { operator: "alchemy", host: "base-mainnet.g.alchemy.com", source: "registry" } })],
    }];
    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    expect(summary.comparator).toEqual({ operator: "alchemy", host: "base-mainnet.g.alchemy.com", source: "registry" });
    expect(summary.dwellirHost).toBe("api-base-mainnet-archive.n.dwellir.com");
  });

  it("fails state parity sufficiency when nothing was ever checked", () => {
    const runs = [{
      atSec: PARITY_NOW_SEC,
      samples: [sampleWith({ chainId: PARITY_REGISTRY_CHAIN, stateChecked: false, stateMatched: false })],
    }];
    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    expect(summary.stateParity.checked).toBe(0);
    expect(summary.gate.failing).toContain("insufficient-state-checks");
    // A comparison that never happened is not a parity failure claim either.
    expect(summary.gate.failing).not.toContain("state-parity");
  });
});
