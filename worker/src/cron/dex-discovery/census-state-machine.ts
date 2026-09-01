import {
  decodeDexCensusAttemptResult,
  DEX_DISCOVERY_BOUNDED_CRAWL_REASON,
  DEX_DISCOVERY_FAILED_CRAWL_REASON,
  DEX_DISCOVERY_NON_EXHAUSTIVE_CENSUS_REASON,
  DEX_DISCOVERY_PROVIDER_OUTAGE_REASON,
  DEX_DISCOVERY_UNSUPPORTED_SCOPE_REASON,
  type DexCensusAttemptResult,
  type DexCensusEvidenceState,
  type DexCensusLegacyCodecValue,
  type DexDeploymentOutcome,
} from "@shared/lib/dex-deployment-coverage";

const OBSERVED_POOLS_REASON = "At least one eligible direct-token pool was observed";
const VERIFIED_NO_POOLS_REASON = "A provider completed the direct-token query with no eligible pool";
const DEGRADED_PROVIDER_REASON = "A completed direct-token provider response was schema-degraded";

export interface DexCensusAttemptSignals {
  observedPoolCount: number;
  providerCount: number;
  exhaustiveSucceeded: boolean;
  nonExhaustiveSucceededEmpty: boolean;
  providerDegraded: boolean;
  providerFailed: boolean;
  boundedReason?: "window" | "crawl-failed";
}

/**
 * Leaf-owned attempt transition. Foundation callers provide observations only;
 * U3 can evolve replay/convergence rules without reopening either producer.
 */
export function resolveDexCensusAttempt(
  signals: DexCensusAttemptSignals,
): DexCensusLegacyCodecValue {
  if (signals.observedPoolCount > 0) {
    return { attemptResult: "observed_pools", legacyReason: OBSERVED_POOLS_REASON };
  }
  if (signals.exhaustiveSucceeded) {
    return { attemptResult: "verified_no_pools", legacyReason: VERIFIED_NO_POOLS_REASON };
  }
  if (signals.nonExhaustiveSucceededEmpty) {
    return {
      attemptResult: "provider_non_exhaustive",
      legacyReason: DEX_DISCOVERY_NON_EXHAUSTIVE_CENSUS_REASON,
    };
  }
  if (signals.providerDegraded) {
    return { attemptResult: "provider_outage", legacyReason: DEGRADED_PROVIDER_REASON };
  }
  if (signals.providerCount === 0) {
    return { attemptResult: "unsupported_scope", legacyReason: DEX_DISCOVERY_UNSUPPORTED_SCOPE_REASON };
  }
  if (signals.providerFailed) {
    return { attemptResult: "provider_outage", legacyReason: DEX_DISCOVERY_PROVIDER_OUTAGE_REASON };
  }
  return {
    attemptResult: "bounded_pending",
    legacyReason: signals.boundedReason === "crawl-failed"
      ? DEX_DISCOVERY_FAILED_CRAWL_REASON
      : DEX_DISCOVERY_BOUNDED_CRAWL_REASON,
  };
}

export function isRetryableDexCensusLegacyReason(reason: string): boolean {
  return decodeDexCensusAttemptResult("provider_inaccessible", reason).attemptResult === "bounded_pending";
}

export type DexStoredCensusDisposition =
  | "observed-pools"
  | "verified-no-pools"
  | "bounded-pending"
  | "provider-outage"
  | "unsupported-scope"
  | "superseded"
  | "invalid";

export interface DexStoredCensusRowInput {
  outcome: DexDeploymentOutcome;
  reason: string;
  observedPoolCount: number;
  observedAt: number;
  discoveryLastCrawlAt: number | null;
  providerCount: number;
  nowSec: number;
  maxAgeSec: number;
  providerSetSuperseded: boolean;
}

export interface DexStoredCensusState {
  attemptResult: DexCensusAttemptResult;
  evidenceState: DexCensusEvidenceState;
  disposition: DexStoredCensusDisposition;
}

export function isStoredDexCensusEvidenceStale(input: {
  observedAt: number;
  nowSec: number;
  maxAgeSec: number;
}): boolean {
  return input.observedAt > input.nowSec || input.nowSec - input.observedAt > input.maxAgeSec;
}

/** The orthogonal persisted-row transition used by the coverage projection. */
export function classifyStoredDexCensusState(
  row: DexStoredCensusRowInput,
): DexStoredCensusState {
  const attemptResult = decodeDexCensusAttemptResult(row.outcome, row.reason).attemptResult;
  if (
    !Number.isInteger(row.observedAt) ||
    row.observedAt <= 0 ||
    !Number.isInteger(row.observedPoolCount) ||
    row.observedPoolCount < 0
  ) {
    return { attemptResult, evidenceState: "invalid", disposition: "invalid" };
  }
  const evidenceState: DexCensusEvidenceState =
    isStoredDexCensusEvidenceStale(row)
      ? "stale"
      : "current";

  if (row.outcome === "verified_no_pools") {
    if (
      !Number.isInteger(row.discoveryLastCrawlAt) ||
      (row.discoveryLastCrawlAt ?? 0) <= 0 ||
      (row.discoveryLastCrawlAt ?? 0) > row.nowSec ||
      row.observedPoolCount !== 0 ||
      row.providerCount === 0
    ) {
      return { attemptResult, evidenceState: "invalid", disposition: "invalid" };
    }
    if ((row.discoveryLastCrawlAt ?? 0) > row.observedAt) {
      return { attemptResult, evidenceState: "superseded", disposition: "superseded" };
    }
    return { attemptResult, evidenceState, disposition: "verified-no-pools" };
  }
  if (row.outcome === "observed_pools") {
    return row.observedPoolCount > 0 && row.providerCount > 0
      ? { attemptResult, evidenceState, disposition: "observed-pools" }
      : { attemptResult, evidenceState: "invalid", disposition: "invalid" };
  }
  if (row.outcome !== "provider_inaccessible" || row.observedPoolCount !== 0) {
    return { attemptResult, evidenceState: "invalid", disposition: "invalid" };
  }
  if (row.providerSetSuperseded) {
    return { attemptResult, evidenceState: "superseded", disposition: "superseded" };
  }
  if (row.providerCount === 0) {
    return { attemptResult, evidenceState, disposition: "unsupported-scope" };
  }
  if (attemptResult === "bounded_pending") {
    return { attemptResult, evidenceState, disposition: "bounded-pending" };
  }
  return { attemptResult, evidenceState, disposition: "provider-outage" };
}
