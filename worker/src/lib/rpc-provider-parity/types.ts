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

/** The three read steps of one chain probe, in the order they run. */
export type RpcParityProbeStep = "head" | "state" | "logs";

/** Per-step failure counts for one operator over the retained window. */
export interface RpcParityFailedStepCounts { head: number; state: number; logs: number }

/** Which steps produced no usable answer for one operator in one sample. */
export interface RpcParityStepFailures { head: boolean; state: boolean; logs: boolean }

export interface RpcParityChainSummary {
  chainId: string;
  dwellirHost: string;                       // e.g. "api-base-mainnet-archive.n.dwellir.com"
  comparator: { operator: "alchemy" | "drpc" | "public"; host: string; source: "registry" | "pin" };
  runs: number;                              // runs retained in the window
  /** Runs in which every Dwellir read answered, over the plan-capability-excluded denominator. */
  dwellirSuccessRate: number | null;
  /** comparatorHead - dwellirHead (positive = Dwellir behind), over the comparable samples below. */
  headLagBlocks: { p50: number | null; p95: number | null; samples: number };
  stateParity: { checked: number; matched: number; mismatched: number; lastMismatch: { atSec: number; block: number } | null };
  logParity: { checked: number; matched: number; mismatched: number; skippedReason: "logs-history-none" | null };
  /** Only for chains whose Dwellir logsHistory is "none" (zkSync): the same small window read far below Dwellir's retention on both operators, to track whether the silent-empty trap persists. */
  prunedLogProbe: { checked: number; dwellirEmptyWhileComparatorNonEmpty: number } | null;
  latency: { dwellir: RpcParityLatencySummary; comparator: RpcParityLatencySummary };
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
}

/** One run's samples, stamped with the run clock the slot fence and store prune on. */
export interface RpcParityRunSamples {
  atSec: number;
  samples: RpcParityChainSample[];
}
