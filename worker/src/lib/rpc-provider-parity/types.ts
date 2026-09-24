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

export interface RpcParityChainSummary {
  chainId: string;
  dwellirHost: string;                       // e.g. "api-base-mainnet-archive.n.dwellir.com"
  comparator: { operator: "alchemy" | "drpc" | "public"; host: string; source: "registry" | "pin" };
  runs: number;                              // runs retained in the window
  dwellirSuccessRate: number | null;         // excludes "capability" errors from the denominator
  headLagBlocks: { p50: number | null; p95: number | null };   // comparatorHead - dwellirHead (positive = Dwellir behind)
  stateParity: { checked: number; matched: number; mismatched: number; lastMismatch: { atSec: number; block: number } | null };
  logParity: { checked: number; matched: number; mismatched: number; skippedReason: "logs-history-none" | null };
  /** Only for chains whose Dwellir logsHistory is "none" (zkSync): the same small window read far below Dwellir's retention on both operators, to track whether the silent-empty trap persists. */
  prunedLogProbe: { checked: number; dwellirEmptyWhileComparatorNonEmpty: number } | null;
  latency: { dwellir: RpcParityLatencySummary; comparator: RpcParityLatencySummary };
  errorClasses: Partial<Record<RpcParityErrorClass, number>>;
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
  stateChecked: boolean;
  stateMatched: boolean;
  logChecked: boolean;
  logMatched: boolean;
  prunedLogChecked: boolean;
  prunedLogTrap: boolean;
  dwellirLatencyMs: number | null;
  comparatorLatencyMs: number | null;
  /** Dwellir-side failure class; null when Dwellir answered every call this run. */
  errorClass: RpcParityErrorClass | null;
}

/** One run's samples, stamped with the run clock the slot fence and store prune on. */
export interface RpcParityRunSamples {
  atSec: number;
  samples: RpcParityChainSample[];
}
