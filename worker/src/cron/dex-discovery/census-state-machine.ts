import {
  decodeDexCensusAttemptResult,
  DEX_DISCOVERY_BOUNDED_CRAWL_REASON,
  DEX_DISCOVERY_FAILED_CRAWL_REASON,
  DEX_DISCOVERY_NON_EXHAUSTIVE_CENSUS_REASON,
  DEX_DISCOVERY_PROVIDER_OUTAGE_REASON,
  DEX_DISCOVERY_UNSUPPORTED_SCOPE_REASON,
  isDexCensusAttemptComplete,
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
  /** True when every provider failure was retryable (timeout, 429, or budget). */
  retryableProviderFailure?: boolean;
  boundedReason?: "window" | "crawl-failed";
}

function hasNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function hasValidAttemptSignals(signals: DexCensusAttemptSignals): boolean {
  return hasNonNegativeInteger(signals.observedPoolCount) &&
    hasNonNegativeInteger(signals.providerCount);
}

/**
 * Leaf-owned attempt transition. Foundation callers provide observations only;
 * U3 can evolve replay/convergence rules without reopening either producer.
 */
export function resolveDexCensusAttempt(
  signals: DexCensusAttemptSignals,
): DexCensusLegacyCodecValue {
  // The legacy columns have no invalid-attempt value. A malformed signal must
  // therefore take the retryable/incomplete path rather than manufacture an
  // empty census from a bad count or an inconsistent provider report.
  if (!hasValidAttemptSignals(signals)) {
    return {
      attemptResult: "bounded_pending",
      legacyReason: DEX_DISCOVERY_BOUNDED_CRAWL_REASON,
    };
  }
  if (signals.observedPoolCount > 0) {
    return { attemptResult: "observed_pools", legacyReason: OBSERVED_POOLS_REASON };
  }
  if (signals.exhaustiveSucceeded && signals.providerCount > 0) {
    return { attemptResult: "verified_no_pools", legacyReason: VERIFIED_NO_POOLS_REASON };
  }
  if (signals.nonExhaustiveSucceededEmpty && signals.providerCount > 0) {
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
  if (signals.providerFailed && signals.retryableProviderFailure !== true) {
    return { attemptResult: "provider_outage", legacyReason: DEX_DISCOVERY_PROVIDER_OUTAGE_REASON };
  }
  return {
    attemptResult: "bounded_pending",
    legacyReason: signals.boundedReason === "crawl-failed"
      ? DEX_DISCOVERY_FAILED_CRAWL_REASON
      : DEX_DISCOVERY_BOUNDED_CRAWL_REASON,
  };
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

function hasValidObservedAt(input: Pick<DexStoredCensusRowInput, "observedAt" | "nowSec">): boolean {
  return Number.isInteger(input.observedAt) && input.observedAt > 0 && input.observedAt <= input.nowSec;
}

function hasValidAttemptFence(input: Pick<DexStoredCensusRowInput, "discoveryLastCrawlAt" | "nowSec">): boolean {
  return Number.isInteger(input.discoveryLastCrawlAt) &&
    (input.discoveryLastCrawlAt ?? 0) > 0 &&
    (input.discoveryLastCrawlAt ?? 0) <= input.nowSec;
}

/** The orthogonal persisted-row transition used by the coverage projection. */
export function classifyStoredDexCensusState(
  row: DexStoredCensusRowInput,
): DexStoredCensusState {
  const attemptResult = decodeDexCensusAttemptResult(row.outcome, row.reason).attemptResult;
  if (
    !hasValidObservedAt(row) ||
    !hasNonNegativeInteger(row.observedPoolCount) ||
    !hasNonNegativeInteger(row.providerCount) ||
    !Number.isFinite(row.maxAgeSec) ||
    row.maxAgeSec < 0
  ) {
    return { attemptResult, evidenceState: "invalid", disposition: "invalid" };
  }
  const evidenceState: DexCensusEvidenceState =
    isStoredDexCensusEvidenceStale(row)
      ? "stale"
      : "current";

  if (row.outcome === "verified_no_pools") {
    if (
      row.observedPoolCount !== 0 ||
      row.providerCount === 0
    ) {
      return { attemptResult, evidenceState: "invalid", disposition: "invalid" };
    }
    if (!hasValidAttemptFence(row)) {
      return { attemptResult, evidenceState: "invalid", disposition: "invalid" };
    }
    if ((row.discoveryLastCrawlAt ?? 0) > row.observedAt) {
      return { attemptResult, evidenceState: "superseded", disposition: "superseded" };
    }
    return { attemptResult, evidenceState, disposition: "verified-no-pools" };
  }
  if (row.outcome === "observed_pools") {
    if (row.observedPoolCount <= 0 || row.providerCount === 0 || !hasValidAttemptFence(row)) {
      return { attemptResult, evidenceState: "invalid", disposition: "invalid" };
    }
    return (row.discoveryLastCrawlAt ?? 0) > row.observedAt
      ? { attemptResult, evidenceState: "superseded", disposition: "superseded" }
      : { attemptResult, evidenceState, disposition: "observed-pools" };
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
  if (!hasValidAttemptFence(row)) {
    return { attemptResult, evidenceState: "invalid", disposition: "invalid" };
  }
  if (attemptResult === "bounded_pending") {
    return { attemptResult, evidenceState, disposition: "bounded-pending" };
  }
  return { attemptResult, evidenceState, disposition: "provider-outage" };
}

/**
 * A completed census attempt is deliberately narrower than a useful row.
 * Evidence freshness and attempt result are independent, so callers must use
 * both dimensions before allowing a row to certify an empty scope.
 */
export function isCurrentDexCensusStateComplete(
  state: Pick<DexStoredCensusState, "attemptResult" | "evidenceState">,
): boolean {
  return isDexCensusAttemptComplete(state.evidenceState, state.attemptResult);
}
