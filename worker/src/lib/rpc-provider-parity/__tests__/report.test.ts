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
    expect(summary.headLagBlocks).toEqual({ p50: 2, p95: 2 });
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
    expect(summary.gate.failing).toContain("success-rate");
  });

  it("fails head-lag against the chain's own block time", () => {
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS, (chainId) => (
      chainId === PARITY_REGISTRY_CHAIN ? { lagBlocks: 4 } : {}
    ));
    // base runs at ~2s blocks: six seconds of tolerance is three blocks.
    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs, { blockTimeSec: 2 });
    expect(summary.headLagBlocks).toEqual({ p50: 4, p95: 4 });
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
    expect(slow.latency.dwellir.p95Ms).toBe(1_501);
    expect(slow.gate.failing).toContain("latency");
  });

  it("does not count failed reads as served latency", () => {
    const runs = parityRunWindow(RPC_PARITY_GATE_MIN_RUNS, (chainId) => (
      chainId === PARITY_REGISTRY_CHAIN ? { comparatorLatencyMs: null, dwellirLatencyMs: null } : {}
    ));
    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    expect(summary.latency).toEqual({
      dwellir: { p50Ms: null, p95Ms: null, samples: 0 },
      comparator: { p50Ms: null, p95Ms: null, samples: 0 },
    });
    expect(summary.gate.failing).toContain("latency");
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

  it("fails state parity when nothing was ever checked", () => {
    const runs = [{
      atSec: PARITY_NOW_SEC,
      samples: [sampleWith({ chainId: PARITY_REGISTRY_CHAIN, stateChecked: false, stateMatched: false })],
    }];
    const summary = summaryFor(PARITY_REGISTRY_CHAIN, runs);
    expect(summary.stateParity.checked).toBe(0);
    expect(summary.gate.failing).toContain("state-parity");
  });
});
