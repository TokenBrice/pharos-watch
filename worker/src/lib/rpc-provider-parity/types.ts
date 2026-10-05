import type { DwellirBudgetState } from "../rpc-provider-budget";

/**
 * Shared types for the `observe-rpc-provider-parity` lane (Contract E).
 *
 * The lane measures Dwellir against each chain's current first operator and
 * stores only what the trial report can defend: per-run samples that name the
 * operators and the block heights actually read (ADR-33), never a summary
 * claim that cannot be traced back to a run.
 */

export type RpcParityErrorClass =
  | "range-cap" | "result-cap" | "rate-limited" | "capability" | "server-error"
  | "timeout" | "network" | "rpc-error" | "invalid-response";

export interface RpcParityLatencySummary { p50Ms: number | null; p95Ms: number | null; samples: number }

/** Read categories; latest includes the latest-tag call and its numeric references. */
export type RpcParityProbeStep = "head" | "state" | "logs" | "latest";
export const RPC_PARITY_PROBE_STEPS: readonly RpcParityProbeStep[] = ["head", "state", "logs", "latest"];
export const RPC_PARITY_LATEST_MAX_NUMERIC_CALLS = 10;
export const RPC_PARITY_MAX_CALLS_PER_OPERATOR = {
  dwellir: 10 + RPC_PARITY_LATEST_MAX_NUMERIC_CALLS, // sentinel, token bracket, stable hashes, state/logs
  comparator: 4, // primary head/state plus logs and a split log-origin warm-up head
} as const;
export const RPC_PARITY_SKIP_REASONS = ["no-comparator", "no-dwellir-entry", "deadline", "aborted"] as const;
export type RpcParitySkipReason = (typeof RPC_PARITY_SKIP_REASONS)[number];
export interface RpcParityChainSkip { chainId: string; reason: RpcParitySkipReason }
export type RpcParityFailedStepCounts = Record<RpcParityProbeStep, number>;
export type RpcParityStepFailures = Record<RpcParityProbeStep, boolean>;
export interface RpcParityCallObservation {
  step: RpcParityProbeStep;
  phase: "firstTouch" | "warm";
  latencyMs: number;
  errorClass: RpcParityErrorClass | null;
  /** Only when this call uses a different baseline than the sample's primary comparator. */
  comparator?: RpcParityComparatorRef;
}
export const RPC_PARITY_LATEST_FRESHNESS_VERDICTS = ["fresh", "stale", "indeterminate"] as const;
/** Append only: indices are persisted in v2–v5 observations. */
export const RPC_PARITY_LATEST_FRESHNESS_REASONS = [
  "matched-numeric-block", "no-bracket-match", "bracket-too-wide", "head-regressed", "step-failed",
  "served-block-in-range", "served-block-behind", "served-block-ahead", "bracket-reorg", "moving-bracket-no-match",
  "sentinel-unavailable",
] as const;

/** Append only: v3–v5 persist method indices (Multicall3=0, state bracket=1, ArbSys=2). */
export const RPC_PARITY_LATEST_PROBE_METHODS = ["multicall3-block-number", "state-bracket", "arbsys-block-number"] as const;
export type RpcParityLatestProbeMethod = (typeof RPC_PARITY_LATEST_PROBE_METHODS)[number];

export interface RpcParityLatestFreshness {
  verdict: (typeof RPC_PARITY_LATEST_FRESHNESS_VERDICTS)[number];
  reason: (typeof RPC_PARITY_LATEST_FRESHNESS_REASONS)[number];
  headBefore: number | null;
  headAfter: number | null;
  matchedBlock: number | null;
  latestValue?: string | null;
  numericValues?: { block: number; value: string }[];
  /** Absent on v2 samples; absence cannot satisfy the discrimination floor. */
  method?: RpcParityLatestProbeMethod;
  discriminating?: boolean;
  servedBlock?: number | null;
  lagBlocks?: number | null;
  toleranceBlocks?: number;
  /** Upper end of the token window, including a same-probe sentinel ahead of H2. */
  referenceEndBlock?: number | null;
  /** Exact target/selector; telemetry names actual attempts. Absent before v5. */
  call?: { to: string; data: string };
}

/** Stale evidence always wins; absent sentinels use the actual token verdict. */
export function combineRpcParityLatestFreshness(
  sentinel: RpcParityLatestFreshness | null,
  token: RpcParityLatestFreshness,
): RpcParityLatestFreshness {
  if (sentinel?.verdict === "stale") return sentinel;
  if (token.verdict === "stale") return token;
  if (sentinel === null) return token;
  if (sentinel.verdict !== "fresh") return sentinel;
  if (token.verdict === "fresh"
    || (token.verdict === "indeterminate" && token.reason === "bracket-too-wide")) return sentinel;
  return token;
}

export interface RpcParityFreshnessCheckSummary {
  fresh: number; stale: number; indeterminate: number; unknown: number;
  discriminatingFresh: number;
}
export interface RpcParityMethodAvailability {
  attempts: number;
  successes: number;
  capabilityRefusals: number;
  unknownRuns: number;
  successRate: number | null;
}
export interface RpcParityOperatorLatency {
  firstTouch: Record<RpcParityProbeStep, RpcParityLatencySummary>;
  warm: Record<RpcParityProbeStep, RpcParityLatencySummary>;
  /** p95 of each run's median of successful warm calls (at least two calls). */
  warmRunMedian: RpcParityLatencySummary;
}

export interface RpcParityChainSummary {
  chainId: string;
  dwellirHost: string;                       // e.g. "api-base-mainnet-archive.n.dwellir.com"
  comparator: { operator: "alchemy" | "drpc" | "public"; host: string; source: "registry" | "pin" };
  /** Newest logs baseline (planned when unsampled); null records an unavailable pin. */
  logsComparator: RpcParityComparatorRef | null;
  /** Actual baseline references behind each method's retained observations. */
  comparatorsByStep: Record<RpcParityProbeStep, RpcParityComparatorRef[]>;
  runs: number;                              // runs retained in the window
  skips: Record<RpcParitySkipReason | "unknown", number>;
  lastSkip: { atSec: number; reason: RpcParitySkipReason } | null;
  /** Runs in which every Dwellir read answered, over the plan-capability-excluded denominator. */
  dwellirSuccessRate: number | null;
  /** comparatorHead - dwellirHead (positive = Dwellir behind), over the comparable samples below. */
  headLagBlocks: { p50: number | null; p95: number | null; samples: number };
  stateParity: { checked: number; matched: number; mismatched: number; lastMismatch: { atSec: number; block: number; comparator: RpcParityComparatorRef } | null };
  logParity: { checked: number; matched: number; mismatched: number; skippedReason: "logs-history-none" | "no-comparator" | null };
  /** Only for chains whose Dwellir logsHistory is "none" (zkSync): the same small window read far below Dwellir's retention on both operators, to track whether the silent-empty trap persists. */
  prunedLogProbe: { checked: number; dwellirEmptyWhileComparatorNonEmpty: number } | null;
  latency: { dwellir: RpcParityOperatorLatency; comparator: RpcParityOperatorLatency };
  availability: Record<"dwellir" | "comparator", Record<RpcParityProbeStep, RpcParityMethodAvailability>>;
  latestFreshness: {
    fresh: number; stale: number; indeterminate: number; unknown: number;
    discriminatingFresh: number; nonDiscriminatingFresh: number;
    reasons: Partial<Record<RpcParityLatestFreshness["reason"], number>>;
    maxNumericCalls: number;
    blockTolerance: number;
    lastStale: (RpcParityLatestFreshness & { atSec: number }) | null;
    sentinel: RpcParityFreshnessCheckSummary;
    tokenState: RpcParityFreshnessCheckSummary;
  };
  errorClasses: Partial<Record<RpcParityErrorClass, number>>;
  /** Comparator-side failure classes over the window: an unreadable baseline is not a Dwellir fault. */
  comparatorErrorClasses: Partial<Record<RpcParityErrorClass, number>>;
  /** Which steps failed, per operator, over the retained window. */
  failedSteps: { dwellir: RpcParityFailedStepCounts; comparator: RpcParityFailedStepCounts };
  /** The newest comparator failure with its step, class, and HTTP status (Cloudflare 403/1010 etc.). */
  lastComparatorFailure: {
    atSec: number;
    step: RpcParityProbeStep;
    errorClass: RpcParityErrorClass;
    httpStatus: number | null;
    comparator: RpcParityComparatorRef;
  } | null;
  gate: { passed: boolean; failing: string[] };   // plan §4 gates evaluated over the retained window
  last: { atSec: number; dwellirHead: number | null; comparatorHead: number | null; commonBlock: number | null } | null;
}

export interface RpcProviderTrialReport {
  provider: "dwellir";
  generatedAtSec: number;
  budget: DwellirBudgetState;
  circuit: { state: string; consecutiveFailures: number | null; updatedAtSec: number | null } | null;
  observation: {
    windowStartSec: number | null;
    lastRunAtSec: number | null;
    runsRetained: number;
    chains: RpcParityChainSummary[];
  } | null;
  observationError: string | null;
}

/** Operator/source vocabulary of the comparator side of a parity sample. */
export type RpcParityComparatorOperator = RpcParityChainSummary["comparator"]["operator"];
export type RpcParityComparatorSource = RpcParityChainSummary["comparator"]["source"];

/** A comparator as actually resolved for a run (registry endpoint or reviewed public pin). */
export interface RpcParityComparatorRef {
  operator: RpcParityComparatorOperator;
  host: string;
  source: RpcParityComparatorSource;
}

/**
 * One chain's outcome for one run. Stored verbatim (in the compact wire form
 * of `store.ts`) so the report is computed from observations, not from
 * per-chain counters that could drift from the samples behind them.
 */
export interface RpcParityChainSample {
  chainId: string;
  comparator: RpcParityComparatorRef;
  /** Absent on legacy/single-baseline samples; null explicitly means no logs comparator. */
  logsComparator?: RpcParityComparatorRef | null;
  dwellirHost: string;
  /** Dwellir answered `eth_blockNumber`. */
  headOk: boolean;
  /** The comparator answered `eth_blockNumber`; without it no lag/common block exists. */
  comparatorHeadOk: boolean;
  comparatorHead: number | null;
  dwellirHead: number | null;
  /** min(heads) - margin, the historical block both operators were read at. */
  commonBlock: number | null;
  lagBlocks: number | null;
  /** Both operators returned a `totalSupply` value, so a comparison happened (R1). */
  stateChecked: boolean;
  /** A performed comparison whose values differ; always false when unchecked. */
  stateMatched: boolean;
  /** Both operators returned a log set for the window, so a comparison happened (R1). */
  logChecked: boolean;
  /** A performed comparison whose log sets differ; always false when unchecked. */
  logMatched: boolean;
  /** Both operators answered the deep pruned window, so the trap could be judged. */
  prunedLogChecked: boolean;
  /** The judged trap: Dwellir empty while the comparator returned logs. */
  prunedLogTrap: boolean;
  dwellirLatencyMs: number | null;
  comparatorLatencyMs: number | null;
  /** Dwellir-side failure class; null when Dwellir answered every call this run. */
  errorClass: RpcParityErrorClass | null;
  /** Comparator-side failure class; null when the comparator answered every call this run. */
  comparatorErrorClass: RpcParityErrorClass | null;
  /**
   * HTTP status of the comparator's first failed call when a response arrived —
   * an egress 403/1010 is a different problem from a timeout, and the class
   * alone cannot tell them apart.
   */
  comparatorHttpStatus: number | null;
  /** Which steps failed, per operator, in this sample. */
  failedSteps: { dwellir: RpcParityStepFailures; comparator: RpcParityStepFailures };
  /** Absent on v1 samples: old head timings never become warm evidence. */
  calls?: Record<"dwellir" | "comparator", RpcParityCallObservation[]>;
  /** Combined verdict on dual-check samples; the single recorded check on legacy samples. */
  latestFreshness?: RpcParityLatestFreshness;
  /** Absent on legacy observations; null names an unavailable block sentinel (XDC). */
  sentinelFreshness?: RpcParityLatestFreshness | null;
  tokenFreshness?: RpcParityLatestFreshness;
}

/** One run's samples, stamped with the run clock the slot fence and store prune on. */
export interface RpcParityRunSamples {
  atSec: number;
  samples: RpcParityChainSample[];
  skipped?: RpcParityChainSkip[];
}
