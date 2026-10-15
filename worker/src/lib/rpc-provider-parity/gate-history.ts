import {
  combineRpcParityLatestFreshness,
  RPC_PARITY_LATEST_FRESHNESS_REASONS,
  RPC_PARITY_LATEST_FRESHNESS_VERDICTS,
  isRpcParityComparatorOperator,
  isRpcParityComparatorSource,
  RPC_PARITY_PROBE_STEPS,
  type RpcParityChainSample,
  type RpcParityChainSummary,
  type RpcParityComparatorRef,
  type RpcParityLatestFreshness,
} from "./types";

/** Exact counters, not reconstructed calls: no timings or token values. */
type MethodCounts = [attempts: number, successes: number, capability: number, referenceUnavailable: number];
type FreshnessCount = [verdict: number, discriminating: number, reason: number];
export type RpcParityGateSample = [
  chainId: string, host: string, comparator: RpcParityComparatorRef,
  flags: number, mismatchBlock: number | null,
  methods: MethodCounts[], freshness: FreshnessCount[],
  stale: RpcParityLatestFreshness | null, logsComparator: RpcParityComparatorRef | null,
];
export type RpcParityGateRun = [atSec: number, samples: RpcParityGateSample[]];

export function captureRpcParityGateRun(atSec: number, samples: readonly RpcParityChainSample[]): RpcParityGateRun {
  return [atSec, samples.map((sample): RpcParityGateSample => {
    const sentinel = sample.sentinelFreshness === undefined
      ? sample.latestFreshness?.method === "multicall3-block-number" || sample.latestFreshness?.method === "arbsys-block-number"
        ? sample.latestFreshness : null
      : sample.sentinelFreshness;
    const combined = sample.tokenFreshness ? combineRpcParityLatestFreshness(sentinel, sample.tokenFreshness) : sample.latestFreshness;
    const methods = (["dwellir", "comparator"] as const).flatMap((operator) => RPC_PARITY_PROBE_STEPS.map((step): MethodCounts => {
      const calls = sample.calls?.[operator].filter((call) => call.step === step) ?? [];
      return [calls.length, calls.filter((call) => call.errorClass === null).length,
        calls.filter((call) => call.errorClass === "capability").length,
        calls.filter((call) => call.errorClass === "reference-unavailable").length];
    }));
    let stale: RpcParityLatestFreshness | null = null;
    if (combined?.verdict === "stale") {
      // Detailed proofs retain values; the unpruned event preserves identity,
      // acquired budget and verdict without copying high-entropy token values.
      stale = { ...combined };
      delete stale.latestValue;
      delete stale.numericValues;
    }
    return [sample.chainId, sample.dwellirHost, sample.comparator,
      Number(sample.stateChecked) | Number(sample.stateChecked && sample.stateMatched) << 1
        | Number(sample.logChecked) << 2 | Number(sample.logChecked && sample.logMatched) << 3,
      (sample.stateChecked && !sample.stateMatched) || (sample.logChecked && !sample.logMatched) ? sample.commonBlock : null,
      methods, [combined, sentinel, sample.tokenFreshness].map((check): FreshnessCount => [
        check ? RPC_PARITY_LATEST_FRESHNESS_VERDICTS.indexOf(check.verdict) : -1,
        Number(check?.discriminating === true), check ? RPC_PARITY_LATEST_FRESHNESS_REASONS.indexOf(check.reason) : -1,
      ]), stale, sample.logsComparator === undefined ? sample.comparator : sample.logsComparator];
  })];
}

/** Reject invalid counters rather than converting damaged evidence into success. */
export function isRpcParityGateRun(raw: unknown): raw is RpcParityGateRun {
  if (!Array.isArray(raw) || raw.length !== 2 || !Number.isSafeInteger(raw[0]) || !Array.isArray(raw[1])) return false;
  const chains = new Set<string>();
  return raw[1].every((sample: unknown) => {
    if (!Array.isArray(sample) || sample.length !== 9) return false;
    const [chain, host, comparator, flags, block, methods, freshness, stale, logsComparator] = sample;
    if (typeof chain !== "string" || chains.has(chain) || comparator === null) return false;
    chains.add(chain);
    for (const ref of [comparator, logsComparator]) {
      if (ref === null && ref === logsComparator) continue;
      if (!ref || typeof ref !== "object" || !isRpcParityComparatorOperator(ref.operator)
        || typeof ref.host !== "string" || !isRpcParityComparatorSource(ref.source)) return false;
    }
    if (typeof chain !== "string" || typeof host !== "string" || !Number.isInteger(flags) || flags < 0 || flags > 15
      || !(block === null || Number.isSafeInteger(block)) || ((flags & 2) !== 0 && (flags & 1) === 0)
      || ((flags & 8) !== 0 && (flags & 4) === 0)) return false;
    if (!Array.isArray(methods) || methods.length !== RPC_PARITY_PROBE_STEPS.length * 2
      || !methods.every((counts: unknown) => Array.isArray(counts) && counts.length === 4
        && counts.every((count: unknown) => Number.isSafeInteger(count) && Number(count) >= 0)
        && counts[1] + counts[2] + counts[3] <= counts[0])) return false;
    if (!Array.isArray(freshness) || freshness.length !== 3 || !freshness.every((check: unknown) => Array.isArray(check)
      && check.length === 3 && Number.isInteger(check[0]) && check[0] >= -1 && check[0] < RPC_PARITY_LATEST_FRESHNESS_VERDICTS.length
      && (check[1] === 0 || check[1] === 1) && Number.isInteger(check[2]) && check[2] >= -1
      && check[2] < RPC_PARITY_LATEST_FRESHNESS_REASONS.length && (check[0] === -1) === (check[2] === -1))) return false;
    if (stale !== null && (!stale || typeof stale !== "object" || stale.verdict !== "stale"
      || !RPC_PARITY_LATEST_FRESHNESS_REASONS.includes(stale.reason)
      || ![stale.headBefore, stale.headAfter, stale.matchedBlock].every((value) => value === null || Number.isSafeInteger(value)))) return false;
    return (freshness[0][0] === RPC_PARITY_LATEST_FRESHNESS_VERDICTS.indexOf("stale")) === (stale !== null);
  });
}

/** Replace only counter-backed metrics; detailed head/latency evidence stays exact. */
export function applyRpcParityGateHistory(summary: RpcParityChainSummary, runs: readonly RpcParityGateRun[]): void {
  const entries = runs.flatMap(([atSec, samples]) => samples.filter((sample) => sample[0] === summary.chainId
    && sample[1] === summary.dwellirHost).map((sample) => ({ atSec, sample })));
  summary.gateWindow = {
    windowStartSec: entries[0]?.atSec ?? null,
    windowEndSec: entries[entries.length - 1]?.atSec ?? null,
    windowDurationSec: entries.length === 0 ? 0 : entries[entries.length - 1].atSec - entries[0].atSec,
    runs: entries.length,
  };
  if (entries.length === 0) return;
  summary.stateParity = { checked: 0, matched: 0, mismatched: 0, lastMismatch: null };
  summary.logParity = { ...summary.logParity, checked: 0, matched: 0, mismatched: 0 };
  const latest = summary.latestFreshness;
  const detailedStale = latest.lastStale;
  Object.assign(latest, { fresh: 0, stale: 0, indeterminate: 0, unknown: 0, discriminatingFresh: 0, nonDiscriminatingFresh: 0, reasons: {}, lastStale: null });
  for (const check of [latest.sentinel, latest.tokenState]) Object.assign(check, { fresh: 0, stale: 0, indeterminate: 0, unknown: 0, discriminatingFresh: 0 });
  for (const operator of ["dwellir", "comparator"] as const) for (const step of RPC_PARITY_PROBE_STEPS) {
    Object.assign(summary.availability[operator][step], { attempts: 0, successes: 0, capabilityRefusals: 0, referenceUnavailable: 0, unknownRuns: 0, successRate: null });
  }
  for (const { atSec, sample } of entries) {
    const [, , comparator, flags, block, methods, freshness, stale, logsComparator] = sample;
    if (flags & 1) {
      summary.stateParity.checked++;
      if (flags & 2) summary.stateParity.matched++;
      else {
        summary.stateParity.mismatched++;
        if (block !== null) summary.stateParity.lastMismatch = { atSec, block, comparator };
      }
    }
    if (flags & 4) {
      summary.logParity.checked++;
      if (flags & 8) summary.logParity.matched++;
      else summary.logParity.mismatched++;
    }
    for (const [index, check] of freshness.entries()) {
      const target = index === 0 ? latest : index === 1 ? latest.sentinel : latest.tokenState;
      const verdict = RPC_PARITY_LATEST_FRESHNESS_VERDICTS[check[0]];
      if (!verdict) target.unknown++;
      else {
        target[verdict]++;
        if (verdict === "fresh" && check[1]) target.discriminatingFresh++;
        if (index === 0) {
          if (verdict === "fresh" && !check[1]) latest.nonDiscriminatingFresh++;
          const reason = RPC_PARITY_LATEST_FRESHNESS_REASONS[check[2]];
          latest.reasons[reason] = (latest.reasons[reason] ?? 0) + 1;
        }
      }
    }
    if (stale) latest.lastStale = detailedStale?.atSec === atSec ? detailedStale : { ...stale, atSec };
    for (const [index, counts] of methods.entries()) {
      const operator = index < RPC_PARITY_PROBE_STEPS.length ? "dwellir" : "comparator";
      const step = RPC_PARITY_PROBE_STEPS[index % RPC_PARITY_PROBE_STEPS.length];
      const method = summary.availability[operator][step];
      method.attempts += counts[0]; method.successes += counts[1];
      method.capabilityRefusals += counts[2]; method.referenceUnavailable += counts[3];
      if (!counts[0]) method.unknownRuns++;
      const ref = step === "logs" ? logsComparator : comparator;
      if (operator === "comparator" && counts[0] && ref
        && !summary.comparatorsByStep[step].some((entry) => entry.host === ref.host && entry.operator === ref.operator && entry.source === ref.source)) {
        summary.comparatorsByStep[step].push(ref);
      }
    }
  }
  for (const operator of ["dwellir", "comparator"] as const) for (const step of RPC_PARITY_PROBE_STEPS) {
    const method = summary.availability[operator][step];
    const denominator = method.attempts - method.capabilityRefusals - method.referenceUnavailable;
    method.successRate = denominator === 0 ? null : method.successes / denominator;
  }
}
