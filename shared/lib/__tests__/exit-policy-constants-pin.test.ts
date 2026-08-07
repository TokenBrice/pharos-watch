import { describe, expect, it } from "vitest";
import policy from "@shared/data/safety-score-v9/methodology-policy-candidate-v1.json";
import {
  REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS,
  SAME_NOTIONAL_EXIT_REQUEST_POLICY,
  SAME_NOTIONAL_EXIT_OBSERVATION_FRESHNESS_POLICY,
} from "@shared/lib/redemption-backstop-scoring";

const exitPolicy = (policy as { semantic: { exit: Record<string, unknown> } }).semantic.exit;

// Drift tripwire: this file pins `semantic.exit` in
// methodology-policy-candidate-v1.json to the two independently-authored
// runtime copies (the redemption-backstop scoring constants here, and the
// tripled stress-request constants in
// exit-policy-stress-request-triple-pin.test.ts). It intentionally does not
// re-derive either side from the other; a failing assertion here means the
// policy JSON and its runtime copy have already drifted and must be
// reconciled by hand before this test can pass again.
describe("exit policy constants stay pinned to the backstop tables", () => {
  it("component weights match", () => {
    expect(exitPolicy.componentWeights).toEqual({ ...REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS });
  });

  it("stress request matches the shared request policy", () => {
    expect(exitPolicy.stressRequest).toMatchObject({
      supplyRatio: 0.05,
      floorUsd: 100_000,
      capUsd: 25_000_000,
      maxCostBps: SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps,
      settlementHorizonSec: SAME_NOTIONAL_EXIT_REQUEST_POLICY.settlementHorizonSec,
      notionalGridUsd: [100_000, 1_000_000, 10_000_000, 25_000_000],
    });
  });

  it("documented-terms max age matches", () => {
    expect(exitPolicy.documentedTermsMaxAgeSec).toBe(
      SAME_NOTIONAL_EXIT_OBSERVATION_FRESHNESS_POLICY.documentedTermsMaxAgeSec,
    );
  });

  it("route family caps and benefit limit hold their reviewed values", () => {
    expect(exitPolicy.routeFamilyCaps).toEqual({ queueRedeem: 70, offchainIssuer: 65 });
    expect(exitPolicy.independentRouteBenefitLimit).toBe(0.1);
  });

  it("breakpoint and band tables hold their reviewed values", () => {
    // Pasted verbatim from methodology-policy-candidate-v1.json at
    // implementation time (2026-08-07). These are asserted as literals, not
    // derived from the JSON under test, so silent drift on either side fails.
    expect(exitPolicy.coverageRatioBreakpoints).toEqual([
      { value: 0, score: 0 },
      { value: 0.01, score: 20 },
      { value: 0.05, score: 40 },
      { value: 0.1, score: 60 },
      { value: 0.25, score: 80 },
      { value: 0.5, score: 100 },
    ]);
    expect(exitPolicy.absoluteCapacityBreakpoints).toEqual([
      { value: 0, score: 0 },
      { value: 100_000, score: 20 },
      { value: 1_000_000, score: 40 },
      { value: 10_000_000, score: 60 },
      { value: 50_000_000, score: 80 },
      { value: 250_000_000, score: 100 },
    ]);
    expect(exitPolicy.settlementDelayBands).toEqual([
      { maxSec: 3600, multiplier: 1 },
      { maxSec: 86400, multiplier: 0.9 },
      { maxSec: 604800, multiplier: 0.75 },
      { maxSec: null, multiplier: 0.6 },
    ]);
    expect(exitPolicy.queueBacklogBands).toEqual([
      { threshold: 1, multiplier: 0.65 },
      { threshold: 0.5, multiplier: 0.8 },
      { threshold: 0, multiplier: 0.9 },
    ]);
    expect(exitPolicy.minimumRedeemBands).toEqual([
      { threshold: 1_000_000, multiplier: 0.75 },
      { threshold: 10_000, multiplier: 0.9 },
    ]);
    expect(exitPolicy.holderEligibilityMultipliers).toEqual({
      "any-holder": 1,
      "verified-customer": 0.9,
      "whitelisted-primary": 0.85,
      "pre-incident-holder": 0.85,
      "issuer-discretionary": 0.6,
      unknown: 0.85,
    });
    expect(exitPolicy.modeledConfidenceFactors).toEqual({
      high: 1,
      medium: 0.75,
      low: 0.35,
    });
    expect(exitPolicy.observationConfidenceFactors).toEqual({
      high: 1,
      medium: 0.85,
      low: 0.6,
      unknown: 0.35,
    });
    expect(exitPolicy.scoreableEvidenceKinds).toEqual({
      dex: ["measured-executable-depth", "reserve-based-amm-simulation", "direct-orderbook-depth"],
      redemption: ["documented-terms", "live-reserve-state", "onchain-contract-state"],
    });
  });
});
