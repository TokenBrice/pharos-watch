import type { D1Database } from "@shared/types/cloudflare-runtime";
import { getCircuitRecord } from "../circuit-breaker";
import { CIRCUIT_SOURCE } from "../constants";
import { loadDwellirBudgetState, type DwellirBudgetEnv } from "../rpc-provider-budget";
import { logWorkerEvent } from "../structured-log";
import { readRpcParityStore, type RpcParityLatestState, type RpcParityStoredRun } from "./store";
import {
  RPC_PARITY_TARGETS,
  dwellirEntryForChain,
  dwellirHostForChain,
  plannedRpcParityComparator,
} from "./targets";
import type {
  RpcParityChainSample,
  RpcParityChainSummary,
  RpcParityComparatorRef,
  RpcParityErrorClass,
  RpcParityFailedStepCounts,
  RpcParityLatencySummary,
  RpcParityProbeStep,
  RpcParityStepFailures,
  RpcProviderTrialReport,
} from "./types";

/**
 * The trial report: every window statistic is computed from the retained
 * samples, so a number that cannot be traced to a run is never published.
 *
 * Nothing here throws. An unreadable cache row or circuit document becomes an
 * explicit `observationError` / null field, because an operator asking for the
 * trial's state must get that state, not a 500.
 */

/**
 * Evidence floor for a chain's window: the minimum retained runs, and the
 * minimum performed comparisons of each kind (comparable head pairs, state
 * checks, log checks) before the corresponding gate may pass.
 */
export const RPC_PARITY_GATE_MIN_RUNS = 24;
/** Dwellir head-read success rate over the window, with plan-capability refusals excluded. */
export const RPC_PARITY_GATE_MIN_SUCCESS_RATE = 0.995;
/** Accepted p95 head-read latency gap between Dwellir and the comparator. */
const RPC_PARITY_GATE_LATENCY_TOLERANCE_MS = 500;
/** Head-lag tolerance in chain time; the gate never requires fewer than three blocks. */
const RPC_PARITY_HEAD_LAG_WINDOW_SEC = 6;

/** Blocks of chain time the gate tolerates before a chain's head lag fails. */
export function headLagThresholdBlocks(blockTimeSec: number): number {
  if (!Number.isFinite(blockTimeSec) || blockTimeSec <= 0) return 3;
  return Math.max(3, Math.ceil(RPC_PARITY_HEAD_LAG_WINDOW_SEC / blockTimeSec));
}

/** Nearest-rank percentile — no interpolation, so every published value is a measured sample. */
export function percentileNearestRank(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1));
  return sorted[rank] ?? null;
}

const PROBE_STEPS: readonly RpcParityProbeStep[] = ["head", "state", "logs"];

function emptyFailedStepCounts(): RpcParityFailedStepCounts {
  return { head: 0, state: 0, logs: 0 };
}

/** The first failing step in probe order, which is the one whose call lost the comparison. */
function firstFailedStep(failures: RpcParityStepFailures): RpcParityProbeStep | null {
  return PROBE_STEPS.find((step) => failures[step]) ?? null;
}

function summarizeLatency(values: readonly (number | null)[]): RpcParityLatencySummary {
  const measured = values.filter((value): value is number => value !== null);
  return {
    p50Ms: percentileNearestRank(measured, 0.5),
    p95Ms: percentileNearestRank(measured, 0.95),
    samples: measured.length,
  };
}

/**
 * Gate ids reported in `gate.failing`. Each one is an observable claim about
 * the retained window, evaluated per chain.
 *
 * Sufficiency is gated separately from the measured values: a comparison the
 * lane could not perform is never a passing gate, so `head-lag` and `latency`
 * need `RPC_PARITY_GATE_MIN_RUNS` comparable samples, `state-parity` needs that
 * many state checks, and — where the chain is expected to serve logs at all —
 * `log-parity` needs that many log checks.
 */
export function evaluateRpcParityGate(summary: RpcParityChainSummary, blockTimeSec: number): { passed: boolean; failing: string[] } {
  const failing: string[] = [];
  if (summary.runs < RPC_PARITY_GATE_MIN_RUNS) {
    failing.push("runs");
  }
  if (summary.dwellirSuccessRate === null || summary.dwellirSuccessRate < RPC_PARITY_GATE_MIN_SUCCESS_RATE) {
    failing.push("success-rate");
  }
  if (summary.headLagBlocks.samples < RPC_PARITY_GATE_MIN_RUNS) {
    failing.push("insufficient-comparable-samples");
  }
  const lagThreshold = headLagThresholdBlocks(blockTimeSec);
  if (summary.headLagBlocks.p95 === null || summary.headLagBlocks.p95 > lagThreshold) {
    failing.push("head-lag");
  }
  if (summary.stateParity.checked < RPC_PARITY_GATE_MIN_RUNS) {
    failing.push("insufficient-state-checks");
  }
  if (summary.stateParity.mismatched > 0) {
    failing.push("state-parity");
  }
  if (summary.logParity.skippedReason === null) {
    if (summary.logParity.checked < RPC_PARITY_GATE_MIN_RUNS) {
      failing.push("insufficient-log-checks");
    }
    if (summary.logParity.mismatched > 0) {
      failing.push("log-parity");
    }
  }
  const dwellirP95 = summary.latency.dwellir.p95Ms;
  const comparatorP95 = summary.latency.comparator.p95Ms;
  if (dwellirP95 === null || comparatorP95 === null || dwellirP95 > comparatorP95 + RPC_PARITY_GATE_LATENCY_TOLERANCE_MS) {
    failing.push("latency");
  }
  return { passed: failing.length === 0, failing };
}

interface ChainSampleAt {
  atSec: number;
  sample: RpcParityChainSample;
}

function collectChainSamples(
  runs: readonly RpcParityStoredRun[],
  chainId: string,
): { runCount: number; samples: ChainSampleAt[] } {
  let runCount = 0;
  const samples: ChainSampleAt[] = [];
  for (const run of runs) {
    const matching = run.samples.filter((sample) => sample.chainId === chainId);
    if (matching.length === 0) continue;
    runCount += 1;
    for (const sample of matching) samples.push({ atSec: run.atSec, sample });
  }
  return { runCount, samples };
}

/** Builds one chain's window summary from the retained samples for that chain. */
export function buildRpcParityChainSummary(input: {
  chainId: string;
  runs: readonly RpcParityStoredRun[];
  latest: RpcParityLatestState | null;
  dwellirHost: string;
  fallbackComparator: RpcParityComparatorRef;
  logsHistoryIsNone: boolean;
  blockTimeSec: number;
}): RpcParityChainSummary {
  const { runCount, samples } = collectChainSamples(input.runs, input.chainId);
  const newest = samples[samples.length - 1]?.sample ?? null;
  const comparator = newest?.comparator ?? input.fallbackComparator;

  // Availability, not parity: Dwellir is credited only for runs in which every
  // read it was asked for answered. Plan refusals leave the denominator, so the
  // rate describes the calls the key was entitled to serve.
  const capabilitySamples = samples.filter(({ sample }) => sample.errorClass !== "capability");
  const servedSamples = capabilitySamples.filter(({ sample }) => (
    sample.headOk && !sample.failedSteps.dwellir.state && !sample.failedSteps.dwellir.logs
  ));
  const dwellirSuccessRate =
    capabilitySamples.length === 0 ? null : servedSamples.length / capabilitySamples.length;

  const lagValues = samples
    .map(({ sample }) => sample.lagBlocks)
    .filter((value): value is number => value !== null);

  let stateChecked = 0;
  let stateMismatched = 0;
  let lastMismatch: { atSec: number; block: number } | null = null;
  let logChecked = 0;
  let logMatched = 0;
  let prunedChecked = 0;
  let prunedTraps = 0;
  const errorClasses: Partial<Record<RpcParityErrorClass, number>> = {};
  const comparatorErrorClasses: Partial<Record<RpcParityErrorClass, number>> = {};
  const failedSteps = { dwellir: emptyFailedStepCounts(), comparator: emptyFailedStepCounts() };
  let lastComparatorFailure: RpcParityChainSummary["lastComparatorFailure"] = null;
  for (const { atSec, sample } of samples) {
    if (sample.stateChecked) {
      stateChecked += 1;
      if (sample.stateMatched) {
        // matched
      } else {
        stateMismatched += 1;
        if (sample.commonBlock !== null) lastMismatch = { atSec, block: sample.commonBlock };
      }
    }
    if (sample.logChecked) {
      logChecked += 1;
      if (sample.logMatched) logMatched += 1;
    }
    if (sample.prunedLogChecked) {
      prunedChecked += 1;
      if (sample.prunedLogTrap) prunedTraps += 1;
    }
    if (sample.errorClass) {
      errorClasses[sample.errorClass] = (errorClasses[sample.errorClass] ?? 0) + 1;
    }
    if (sample.comparatorErrorClass) {
      comparatorErrorClasses[sample.comparatorErrorClass] = (comparatorErrorClasses[sample.comparatorErrorClass] ?? 0) + 1;
    }
    for (const operator of ["dwellir", "comparator"] as const) {
      for (const step of PROBE_STEPS) {
        if (sample.failedSteps[operator][step]) failedSteps[operator][step] += 1;
      }
    }
    const comparatorStep = firstFailedStep(sample.failedSteps.comparator);
    if (comparatorStep !== null) {
      lastComparatorFailure = {
        atSec,
        step: comparatorStep,
        errorClass: sample.comparatorErrorClass ?? "invalid-response",
        httpStatus: sample.comparatorHttpStatus,
      };
    }
  }

  const summary: RpcParityChainSummary = {
    chainId: input.chainId,
    dwellirHost: newest?.dwellirHost ?? input.dwellirHost,
    comparator: { operator: comparator.operator, host: comparator.host, source: comparator.source },
    runs: runCount,
    dwellirSuccessRate,
    headLagBlocks: {
      p50: percentileNearestRank(lagValues, 0.5),
      p95: percentileNearestRank(lagValues, 0.95),
      samples: lagValues.length,
    },
    stateParity: {
      checked: stateChecked,
      matched: stateChecked - stateMismatched,
      mismatched: stateMismatched,
      lastMismatch,
    },
    logParity: {
      checked: logChecked,
      matched: logMatched,
      mismatched: logChecked - logMatched,
      skippedReason: input.logsHistoryIsNone ? "logs-history-none" : null,
    },
    prunedLogProbe: input.logsHistoryIsNone
      ? { checked: prunedChecked, dwellirEmptyWhileComparatorNonEmpty: prunedTraps }
      : null,
    latency: {
      dwellir: summarizeLatency(
        samples.map(({ sample }) => (sample.headOk ? sample.dwellirLatencyMs : null)),
      ),
      comparator: summarizeLatency(
        samples.map(({ sample }) => (sample.comparatorHeadOk ? sample.comparatorLatencyMs : null)),
      ),
    },
    errorClasses,
    comparatorErrorClasses,
    failedSteps,
    lastComparatorFailure,
    gate: { passed: false, failing: [] },
    last: input.latest
      ? {
        atSec: input.latest.atSec,
        dwellirHead: input.latest.dwellirHead,
        comparatorHead: input.latest.comparatorHead,
        commonBlock: input.latest.commonBlock,
      }
      : null,
  };
  summary.gate = evaluateRpcParityGate(summary, input.blockTimeSec);
  return summary;
}

function emptyChainSummary(chainId: string, blockTimeSec: number): RpcParityChainSummary {
  const target = RPC_PARITY_TARGETS.find((candidate) => candidate.chainId === chainId);
  const entry = dwellirEntryForChain(chainId);
  return buildRpcParityChainSummary({
    chainId,
    runs: [],
    latest: null,
    dwellirHost: `${entry?.host ?? chainId}.n.dwellir.com`,
    fallbackComparator: target ? plannedRpcParityComparator(target) : { operator: "public", host: "", source: "registry" },
    logsHistoryIsNone: entry?.logsHistory === "none",
    blockTimeSec,
  });
}

async function loadDwellirCircuitState(
  db: D1Database,
): Promise<RpcProviderTrialReport["circuit"]> {
  try {
    const record = await getCircuitRecord(db, CIRCUIT_SOURCE.DWELLIR_EVM);
    const timestamps = [record.lastSuccessAt, record.lastFailureAt, record.openedAt]
      .filter((value): value is number => typeof value === "number");
    return {
      state: record.state,
      consecutiveFailures: record.consecutiveFailures,
      updatedAtSec: timestamps.length === 0 ? null : Math.max(...timestamps),
    };
  } catch (error) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "dwellir_parity_circuit_unreadable",
      message: "Dwellir circuit state could not be read for the trial report",
      provider: "dwellir",
      source: CIRCUIT_SOURCE.DWELLIR_EVM,
      error,
    });
    return null;
  }
}

export async function loadRpcProviderTrialReport(
  db: D1Database,
  env: DwellirBudgetEnv,
  nowSec: number,
): Promise<RpcProviderTrialReport> {
  const budget = await loadDwellirBudgetState(db, env, nowSec);
  const circuit = await loadDwellirCircuitState(db);
  const store = await readRpcParityStore(db);
  if (store.error !== null) {
    return {
      provider: "dwellir",
      generatedAtSec: nowSec,
      budget,
      circuit,
      observation: null,
      observationError: store.error,
    };
  }

  const row = store.row;
  if (!row) {
    return {
      provider: "dwellir",
      generatedAtSec: nowSec,
      budget,
      circuit,
      observation: {
        windowStartSec: null,
        lastRunAtSec: null,
        runsRetained: 0,
        chains: RPC_PARITY_TARGETS.map((target) => emptyChainSummary(target.chainId, target.blockTimeSec)),
      },
      observationError: null,
    };
  }

  const chains = RPC_PARITY_TARGETS.map((target) => {
    const entry = dwellirEntryForChain(target.chainId);
    return buildRpcParityChainSummary({
      chainId: target.chainId,
      runs: row.runs,
      latest: row.latest[target.chainId] ?? null,
      dwellirHost: dwellirHostForChain(target.chainId) ?? `${target.chainId}.n.dwellir.com`,
      fallbackComparator: plannedRpcParityComparator(target),
      logsHistoryIsNone: entry?.logsHistory === "none",
      blockTimeSec: target.blockTimeSec,
    });
  });

  return {
    provider: "dwellir",
    generatedAtSec: nowSec,
    budget,
    circuit,
    observation: {
      windowStartSec: row.runs[0]?.atSec ?? null,
      lastRunAtSec: row.runs[row.runs.length - 1]?.atSec ?? null,
      runsRetained: row.runs.length,
      chains,
    },
    observationError: null,
  };
}
