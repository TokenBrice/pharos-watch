import type { D1Database } from "@shared/types/cloudflare-runtime";
import { getCircuitRecord } from "../circuit-breaker";
import { CIRCUIT_SOURCE } from "../constants";
import { loadDwellirBudgetState, type DwellirBudgetEnv } from "../rpc-provider-budget";
import { logWorkerEvent } from "../structured-log";
import { readRpcParityStore, RPC_PARITY_RETENTION_SEC, type RpcParityLatestState, type RpcParityStoredRun } from "./store";
import {
  RPC_PARITY_TARGETS,
  dwellirEntryForChain,
  dwellirHostForChain,
  plannedRpcParityComparator,
} from "./targets";
import {
  combineRpcParityLatestFreshness,
  RPC_PARITY_PROBE_STEPS,
  RPC_PARITY_LATEST_MAX_NUMERIC_CALLS,
  type RpcParityChainSample,
  type RpcParityChainSummary,
  type RpcParityComparatorRef,
  type RpcParityErrorClass,
  type RpcParityFailedStepCounts,
  type RpcParityLatencySummary,
  type RpcParityProbeStep,
  type RpcParityStepFailures,
  type RpcProviderTrialReport,
  type RpcParityOperatorLatency,
  type RpcParityMethodAvailability,
  type RpcParityFreshnessCheckSummary,
  type RpcParityLatestFreshness,
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
/** Per-method availability, excluding only that method's capability refusals. */
export const RPC_PARITY_GATE_MIN_SUCCESS_RATE = 0.995;
/** Accepted gap between p95s of per-run warm medians, not first-touch calls. */
const RPC_PARITY_GATE_LATENCY_TOLERANCE_MS = 500;
/** Shared head/sentinel tolerance in chain time, with a minimum of three blocks. */
const RPC_PARITY_HEAD_LAG_WINDOW_SEC = 6;

/** Single block-budget authority for head lag and latest served-block freshness. */
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

const PROBE_STEPS = RPC_PARITY_PROBE_STEPS;

function emptyFailedStepCounts(): RpcParityFailedStepCounts {
  return { head: 0, state: 0, logs: 0, latest: 0 };
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

function countFreshnessCheck(
  summary: RpcParityFreshnessCheckSummary,
  freshness: RpcParityLatestFreshness | null | undefined,
): void {
  if (!freshness) summary.unknown++;
  else {
    summary[freshness.verdict]++;
    if (freshness.verdict === "fresh" && freshness.discriminating === true) summary.discriminatingFresh++;
  }
}

/**
 * Gate ids reported in `gate.failing`. Each one is an observable claim about
 * the retained window, evaluated per chain.
 *
 * Sufficiency is separate from values: comparable heads, state/log checks,
 * method attempts, determinate latest checks, and warm run medians each need
 * their own evidence floor. Missing measurements never satisfy a gate.
 */
export function evaluateRpcParityGate(summary: RpcParityChainSummary, blockTimeSec: number): { passed: boolean; failing: string[] } {
  const failing: string[] = [];
  if (summary.runs < RPC_PARITY_GATE_MIN_RUNS) {
    failing.push("runs");
  }
  for (const step of PROBE_STEPS) {
    const method = summary.availability.dwellir[step];
    if (method.attempts - method.capabilityRefusals < RPC_PARITY_GATE_MIN_RUNS) {
      failing.push(`insufficient-${step}-attempts`);
    }
    if (method.successRate === null || method.successRate < RPC_PARITY_GATE_MIN_SUCCESS_RATE) {
      failing.push(`success-rate:${step}`);
    }
  }
  // The configured sentinel owns sufficiency; token changes are opportunistic.
  const freshnessEvidence = RPC_PARITY_TARGETS.find((target) => target.chainId === summary.chainId)?.latestStateProbe === "state-bracket"
    ? summary.latestFreshness.tokenState : summary.latestFreshness.sentinel;
  if (freshnessEvidence.discriminatingFresh + freshnessEvidence.stale < RPC_PARITY_GATE_MIN_RUNS) {
    failing.push("insufficient-latest-freshness-checks");
  }
  if (summary.latestFreshness.stale > 0) failing.push("latest-state-freshness");
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
  if (summary.logParity.skippedReason !== "logs-history-none") {
    if (summary.logParity.skippedReason === "no-comparator") failing.push("no-log-comparator");
    if (summary.logParity.checked < RPC_PARITY_GATE_MIN_RUNS) {
      failing.push("insufficient-log-checks");
    }
    if (summary.logParity.mismatched > 0) {
      failing.push("log-parity");
    }
  }
  const dwellirWarm = summary.latency.dwellir.warmRunMedian;
  const comparatorWarm = summary.latency.comparator.warmRunMedian;
  if (dwellirWarm.samples < RPC_PARITY_GATE_MIN_RUNS || comparatorWarm.samples < RPC_PARITY_GATE_MIN_RUNS) {
    failing.push("insufficient-warm-samples");
  }
  if (dwellirWarm.p95Ms !== null && comparatorWarm.p95Ms !== null
    && dwellirWarm.p95Ms > comparatorWarm.p95Ms + RPC_PARITY_GATE_LATENCY_TOLERANCE_MS) {
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

function addComparatorRef(refs: RpcParityComparatorRef[], ref: RpcParityComparatorRef): void {
  for (const entry of refs) {
    if (entry.operator === ref.operator && entry.host === ref.host && entry.source === ref.source) return;
  }
  refs.push(ref);
}

/** Builds one chain's window summary from the retained samples for that chain. */
export function buildRpcParityChainSummary(input: {
  chainId: string;
  runs: readonly RpcParityStoredRun[];
  latest: RpcParityLatestState | null;
  dwellirHost: string;
  fallbackComparator: RpcParityComparatorRef;
  fallbackLogsComparator?: RpcParityComparatorRef;
  logsHistoryIsNone: boolean;
  blockTimeSec: number;
}): RpcParityChainSummary {
  const { runCount, samples } = collectChainSamples(input.runs, input.chainId);
  const newest = samples[samples.length - 1]?.sample ?? null;
  const comparator = newest?.comparator ?? input.fallbackComparator;
  const skips: RpcParityChainSummary["skips"] = { "no-comparator": 0, "no-dwellir-entry": 0, deadline: 0, aborted: 0, unknown: 0 };
  let lastSkip: RpcParityChainSummary["lastSkip"] = null;
  for (const run of input.runs) {
    const skipped = run.skipped?.find((entry) => entry.chainId === input.chainId);
    if (skipped) {
      skips[skipped.reason]++;
      if (lastSkip === null || run.atSec >= lastSkip.atSec) lastSkip = { atSec: run.atSec, reason: skipped.reason };
    } else if (!run.samples.some((sample) => sample.chainId === input.chainId)) {
      // Legacy rows have no skip evidence; absence does not prove a deadline.
      skips.unknown++;
    }
  }

  // Availability, not parity: Dwellir is credited only for runs in which every
  // read it was asked for answered. Plan refusals leave the denominator, so the
  // rate describes the calls the key was entitled to serve.
  const capabilitySamples = samples.filter(({ sample }) => sample.errorClass !== "capability");
  const servedSamples = capabilitySamples.filter(({ sample }) => (
    sample.headOk && !sample.failedSteps.dwellir.state && !sample.failedSteps.dwellir.logs && !sample.failedSteps.dwellir.latest
  ));
  const dwellirSuccessRate =
    capabilitySamples.length === 0 ? null : servedSamples.length / capabilitySamples.length;

  const lagValues = samples
    .map(({ sample }) => sample.lagBlocks)
    .filter((value): value is number => value !== null);

  let stateChecked = 0;
  let stateMismatched = 0;
  let lastMismatch: RpcParityChainSummary["stateParity"]["lastMismatch"] = null;
  let logChecked = 0;
  let logMatched = 0;
  let prunedChecked = 0;
  let prunedTraps = 0;
  const errorClasses: Partial<Record<RpcParityErrorClass, number>> = {};
  const comparatorErrorClasses: Partial<Record<RpcParityErrorClass, number>> = {};
  const failedSteps = { dwellir: emptyFailedStepCounts(), comparator: emptyFailedStepCounts() };
  let lastComparatorFailure: RpcParityChainSummary["lastComparatorFailure"] = null;
  const availability = {} as RpcParityChainSummary["availability"];
  const latency = {} as RpcParityChainSummary["latency"];
  const comparatorsByStep: RpcParityChainSummary["comparatorsByStep"] = { head: [], state: [], logs: [], latest: [] };
  for (const operator of ["dwellir", "comparator"] as const) {
    const methods = {} as Record<RpcParityProbeStep, RpcParityMethodAvailability>;
    const timing: RpcParityOperatorLatency = {
      firstTouch: {} as RpcParityOperatorLatency["firstTouch"],
      warm: {} as RpcParityOperatorLatency["warm"],
      warmRunMedian: summarizeLatency([]),
    };
    for (const step of PROBE_STEPS) {
      const calls = samples.flatMap(({ sample }) => {
        const observed = sample.calls?.[operator].filter((call) => call.step === step) ?? [];
        if (operator === "comparator") {
          const refs = comparatorsByStep[step];
          for (const call of observed) addComparatorRef(refs, call.comparator ?? sample.comparator);
          if (observed.length === 0 && (step === "head" ? sample.comparatorHeadOk || sample.failedSteps.comparator.head
            : step === "state" ? sample.stateChecked || sample.failedSteps.comparator.state || sample.failedSteps.dwellir.state
              : step === "logs" ? sample.logChecked || sample.prunedLogChecked || sample.failedSteps.comparator.logs || sample.failedSteps.dwellir.logs : false)) {
            addComparatorRef(refs, step === "logs" ? sample.logsComparator ?? sample.comparator : sample.comparator);
          }
        }
        return observed;
      });
      const capabilityRefusals = calls.filter((call) => call.errorClass === "capability").length;
      const successes = calls.filter((call) => call.errorClass === null).length;
      methods[step] = {
        attempts: calls.length, successes, capabilityRefusals,
        unknownRuns: samples.filter(({ sample }) => !sample.calls
          || !sample.calls[operator].some((call) => call.step === step)).length,
        successRate: calls.length === capabilityRefusals ? null : successes / (calls.length - capabilityRefusals),
      };
      for (const phase of ["firstTouch", "warm"] as const) {
        // Failed calls remain visible in per-call timing; the readiness latency
        // statistic uses successful reads, with failures gated by availability.
        timing[phase][step] = summarizeLatency(calls.filter((call) => call.phase === phase).map((call) => call.latencyMs));
      }
    }
    const medians = samples.map(({ sample }) => {
      const warm = sample.calls?.[operator].filter((call) => call.phase === "warm" && call.errorClass === null) ?? [];
      if (warm.length < 2) return null;
      const sorted = warm.map((call) => call.latencyMs).sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
    });
    timing.warmRunMedian = summarizeLatency(medians);
    availability[operator] = methods;
    latency[operator] = timing;
  }
  const latestFreshness: RpcParityChainSummary["latestFreshness"] = {
    fresh: 0, stale: 0, indeterminate: 0, unknown: 0, discriminatingFresh: 0, nonDiscriminatingFresh: 0, reasons: {},
    maxNumericCalls: RPC_PARITY_LATEST_MAX_NUMERIC_CALLS, blockTolerance: headLagThresholdBlocks(input.blockTimeSec), lastStale: null,
    sentinel: { fresh: 0, stale: 0, indeterminate: 0, unknown: 0, discriminatingFresh: 0 },
    tokenState: { fresh: 0, stale: 0, indeterminate: 0, unknown: 0, discriminatingFresh: 0 },
  };
  for (const { atSec, sample } of samples) {
    const sentinel = sample.sentinelFreshness === undefined
      ? sample.latestFreshness?.method === "multicall3-block-number" || sample.latestFreshness?.method === "arbsys-block-number"
        ? sample.latestFreshness : null
      : sample.sentinelFreshness;
    countFreshnessCheck(latestFreshness.sentinel, sentinel);
    countFreshnessCheck(latestFreshness.tokenState, sample.tokenFreshness);
    const freshness = sample.tokenFreshness
      ? combineRpcParityLatestFreshness(sentinel, sample.tokenFreshness) : sample.latestFreshness;
    if (!freshness) latestFreshness.unknown++;
    else {
      latestFreshness[freshness.verdict]++;
      if (freshness.verdict === "fresh") {
        if (freshness.discriminating === true) latestFreshness.discriminatingFresh++;
        else latestFreshness.nonDiscriminatingFresh++;
      }
      latestFreshness.reasons[freshness.reason] = (latestFreshness.reasons[freshness.reason] ?? 0) + 1;
      if (freshness.verdict === "stale") latestFreshness.lastStale = { ...freshness, atSec };
    }
    if (sample.stateChecked) {
      stateChecked += 1;
      if (sample.stateMatched) {
        // matched
      } else {
        stateMismatched += 1;
        if (sample.commonBlock !== null) lastMismatch = { atSec, block: sample.commonBlock, comparator: sample.comparator };
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
    const failedCall = sample.calls?.comparator.find((call) => call.errorClass !== null);
    const comparatorStep = failedCall?.step ?? firstFailedStep(sample.failedSteps.comparator);
    if (comparatorStep !== null) {
      lastComparatorFailure = {
        atSec,
        step: comparatorStep,
        errorClass: sample.comparatorErrorClass ?? "invalid-response",
        httpStatus: sample.comparatorHttpStatus,
        comparator: failedCall?.comparator ?? sample.comparator,
      };
    }
  }

  const summary: RpcParityChainSummary = {
    chainId: input.chainId,
    dwellirHost: newest?.dwellirHost ?? input.dwellirHost,
    comparator: { operator: comparator.operator, host: comparator.host, source: comparator.source },
    logsComparator: newest ? newest.logsComparator === undefined ? newest.comparator : newest.logsComparator
      : input.fallbackLogsComparator ?? input.fallbackComparator,
    comparatorsByStep,
    runs: runCount,
    skips,
    lastSkip,
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
      skippedReason: input.logsHistoryIsNone ? "logs-history-none" : newest?.logsComparator === null ? "no-comparator" : null,
    },
    prunedLogProbe: input.logsHistoryIsNone
      ? { checked: prunedChecked, dwellirEmptyWhileComparatorNonEmpty: prunedTraps }
      : null,
    latency,
    availability,
    latestFreshness,
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
    fallbackLogsComparator: target ? plannedRpcParityComparator(target, "logs") : undefined,
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

  const cutoffSec = nowSec - RPC_PARITY_RETENTION_SEC;
  const runs = row.runs.filter((run) => run.atSec >= cutoffSec);

  const chains = RPC_PARITY_TARGETS.map((target) => {
    const entry = dwellirEntryForChain(target.chainId);
    const latest = row.latest[target.chainId];
    return buildRpcParityChainSummary({
      chainId: target.chainId,
      runs,
      latest: latest && latest.atSec >= cutoffSec ? latest : null,
      dwellirHost: dwellirHostForChain(target.chainId) ?? `${target.chainId}.n.dwellir.com`,
      fallbackComparator: plannedRpcParityComparator(target),
      fallbackLogsComparator: plannedRpcParityComparator(target, "logs"),
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
      windowStartSec: runs[0]?.atSec ?? null,
      lastRunAtSec: runs[runs.length - 1]?.atSec ?? null,
      runsRetained: runs.length,
      chains,
    },
    observationError: null,
  };
}
