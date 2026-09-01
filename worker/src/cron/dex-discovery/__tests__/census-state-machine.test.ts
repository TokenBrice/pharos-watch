import { describe, expect, it } from "vitest";
import {
  DEX_DISCOVERY_BOUNDED_CRAWL_REASON,
  DEX_DISCOVERY_NON_EXHAUSTIVE_CENSUS_REASON,
  DEX_DISCOVERY_PROVIDER_OUTAGE_REASON,
  DEX_DISCOVERY_UNSUPPORTED_SCOPE_REASON,
} from "@shared/lib/dex-deployment-coverage";
import {
  classifyStoredDexCensusState,
  isCurrentDexCensusStateComplete,
  resolveDexCensusAttempt,
  type DexCensusAttemptSignals,
  type DexStoredCensusRowInput,
} from "../census-state-machine";

const NOW_SEC = 1_800_000_000;

function signals(overrides: Partial<DexCensusAttemptSignals> = {}): DexCensusAttemptSignals {
  return {
    observedPoolCount: 0,
    providerCount: 1,
    exhaustiveSucceeded: false,
    nonExhaustiveSucceededEmpty: false,
    providerDegraded: false,
    providerFailed: false,
    ...overrides,
  };
}

function storedRow(overrides: Partial<DexStoredCensusRowInput> = {}): DexStoredCensusRowInput {
  return {
    outcome: "verified_no_pools",
    reason: "A provider completed the direct-token query with no eligible pool",
    observedPoolCount: 0,
    observedAt: NOW_SEC - 60,
    discoveryLastCrawlAt: NOW_SEC - 120,
    providerCount: 1,
    nowSec: NOW_SEC,
    maxAgeSec: 86_400,
    providerSetSuperseded: false,
    ...overrides,
  };
}

describe("DEX census attempt state machine", () => {
  it("never certifies an empty attempt without a provider", () => {
    expect(resolveDexCensusAttempt(signals({ providerCount: 0, exhaustiveSucceeded: true }))).toEqual({
      attemptResult: "unsupported_scope",
      legacyReason: DEX_DISCOVERY_UNSUPPORTED_SCOPE_REASON,
    });
  });

  it("keeps an uncompleted or retryable crawl bounded", () => {
    expect(resolveDexCensusAttempt(signals())).toEqual({
      attemptResult: "bounded_pending",
      legacyReason: DEX_DISCOVERY_BOUNDED_CRAWL_REASON,
    });
    expect(resolveDexCensusAttempt(signals({
      providerFailed: true,
      retryableProviderFailure: true,
    }))).toMatchObject({ attemptResult: "bounded_pending" });
  });

  it("distinguishes hard outage and non-exhaustive empty responses", () => {
    expect(resolveDexCensusAttempt(signals({ providerFailed: true }))).toEqual({
      attemptResult: "provider_outage",
      legacyReason: DEX_DISCOVERY_PROVIDER_OUTAGE_REASON,
    });
    expect(resolveDexCensusAttempt(signals({ nonExhaustiveSucceededEmpty: true }))).toEqual({
      attemptResult: "provider_non_exhaustive",
      legacyReason: DEX_DISCOVERY_NON_EXHAUSTIVE_CENSUS_REASON,
    });
    expect(resolveDexCensusAttempt(signals({ providerDegraded: true }))).toMatchObject({
      attemptResult: "provider_outage",
    });
  });

  it("lets an observed pool win over every empty or failure signal", () => {
    expect(resolveDexCensusAttempt(signals({
      observedPoolCount: 1,
      exhaustiveSucceeded: true,
      providerFailed: true,
    }))).toMatchObject({ attemptResult: "observed_pools" });
  });

  it("fails closed to bounded work for malformed attempt counts", () => {
    expect(resolveDexCensusAttempt(signals({ observedPoolCount: Number.NaN }))).toEqual({
      attemptResult: "bounded_pending",
      legacyReason: DEX_DISCOVERY_BOUNDED_CRAWL_REASON,
    });
  });
});

describe("DEX census evidence state machine", () => {
  it("accepts only a current, fenced verified-empty row as complete", () => {
    const state = classifyStoredDexCensusState(storedRow());

    expect(state).toEqual({
      attemptResult: "verified_no_pools",
      evidenceState: "current",
      disposition: "verified-no-pools",
    });
    expect(isCurrentDexCensusStateComplete(state)).toBe(true);
  });

  it("keeps stale empty evidence non-complete", () => {
    const state = classifyStoredDexCensusState(storedRow({
      observedAt: NOW_SEC - 86_401,
      discoveryLastCrawlAt: NOW_SEC - 86_401,
    }));

    expect(state).toMatchObject({
      attemptResult: "verified_no_pools",
      evidenceState: "stale",
      disposition: "verified-no-pools",
    });
    expect(isCurrentDexCensusStateComplete(state)).toBe(false);
  });

  it("rejects future evidence and missing attempt provenance", () => {
    expect(classifyStoredDexCensusState(storedRow({ observedAt: NOW_SEC + 1 }))).toMatchObject({
      evidenceState: "invalid",
      disposition: "invalid",
    });
    expect(classifyStoredDexCensusState(storedRow({ discoveryLastCrawlAt: null }))).toMatchObject({
      evidenceState: "invalid",
      disposition: "invalid",
    });
  });

  it("supersedes both empty and observed rows after a newer target attempt", () => {
    expect(classifyStoredDexCensusState(storedRow({
      discoveryLastCrawlAt: NOW_SEC - 30,
    }))).toMatchObject({ evidenceState: "superseded", disposition: "superseded" });
    expect(classifyStoredDexCensusState(storedRow({
      outcome: "observed_pools",
      reason: "At least one eligible direct-token pool was observed",
      observedPoolCount: 1,
      discoveryLastCrawlAt: NOW_SEC - 30,
    }))).toMatchObject({ evidenceState: "superseded", disposition: "superseded" });
  });

  it("keeps provider scope and provider failure orthogonal", () => {
    expect(classifyStoredDexCensusState(storedRow({
      outcome: "provider_inaccessible",
      reason: DEX_DISCOVERY_UNSUPPORTED_SCOPE_REASON,
      providerCount: 0,
      discoveryLastCrawlAt: null,
    }))).toMatchObject({
      attemptResult: "unsupported_scope",
      evidenceState: "current",
      disposition: "unsupported-scope",
    });
    expect(classifyStoredDexCensusState(storedRow({
      outcome: "provider_inaccessible",
      reason: DEX_DISCOVERY_PROVIDER_OUTAGE_REASON,
    })).disposition).toBe("provider-outage");
  });
});
