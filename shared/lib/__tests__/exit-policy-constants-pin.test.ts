import { describe, expect, it } from "vitest";
import policy from "@shared/data/safety-score-v9/methodology-policy-candidate-v1.json";
import { DEPEG_SEVERITY_BPS } from "@shared/lib/depeg-config";
import { EXIT_ROUTE_SCORING_TABLES } from "@shared/lib/exit-route-scoring";
import { REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS } from "@shared/lib/report-card-active-depeg";
import {
  REDEMPTION_ACCESS_SCORES,
  REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS,
  REDEMPTION_EXECUTION_SCORES,
  REDEMPTION_OUTPUT_ASSET_SCORES,
  REDEMPTION_ROUTE_FAMILY_CAPS,
  REDEMPTION_SETTLEMENT_SCORES,
  SAME_NOTIONAL_EXIT_OBSERVATION_FRESHNESS_POLICY,
  SAME_NOTIONAL_EXIT_REQUEST_POLICY,
} from "@shared/lib/redemption-backstop-scoring";

const exitPolicy = (policy as { semantic: { exit: Record<string, unknown> } }).semantic.exit;
const activeDepegCaps = (
  policy as { semantic: { formula: { activeDepegCaps: { kind: string; minimumBps: number }[] } } }
).semantic.formula.activeDepegCaps;

/**
 * CI validation of the one exit scoring engine.
 *
 * `shared/lib/exit-route-scoring.ts` is the single definition of the exit
 * scoring tables. The V9 methodology policy JSON stays the versioned,
 * replay-pinned artifact the evaluator reads at runtime — it is deliberately not
 * generated, because reissuing it is a methodology-version event. This file is
 * what stops the two from drifting: it asserts the policy JSON's `semantic.exit`
 * block against the source module, key by key.
 *
 * Wave 1 pinned two independently-authored copies to each other, which could
 * only report that drift had already happened. This asserts a derived copy
 * against its source, so the JSON is the only thing that can be wrong — and when
 * it is, the fix is to reissue the policy under a methodology bump, never to
 * edit this file.
 */
describe("the V9 exit policy is validated against the single exit-scoring source", () => {
  it("carries the source stress-request policy", () => {
    expect(exitPolicy.stressRequest).toEqual({
      notionalGridUsd: [...EXIT_ROUTE_SCORING_TABLES.request.notionalGridUsd],
      referenceNotionalUsd: EXIT_ROUTE_SCORING_TABLES.request.referenceNotionalUsd,
      supplyRatio: EXIT_ROUTE_SCORING_TABLES.request.supplyRatio,
      floorUsd: EXIT_ROUTE_SCORING_TABLES.request.floorUsd,
      capUsd: EXIT_ROUTE_SCORING_TABLES.request.capUsd,
      maxCostBps: EXIT_ROUTE_SCORING_TABLES.request.maxCostBps,
      settlementHorizonSec: EXIT_ROUTE_SCORING_TABLES.request.settlementHorizonSec,
    });
  });

  it.each([
    ["componentWeights", EXIT_ROUTE_SCORING_TABLES.componentWeights],
    ["accessScores", EXIT_ROUTE_SCORING_TABLES.accessScores],
    ["settlementScores", EXIT_ROUTE_SCORING_TABLES.settlementScores],
    ["executionScores", EXIT_ROUTE_SCORING_TABLES.executionScores],
    ["outputAssetScores", EXIT_ROUTE_SCORING_TABLES.outputAssetScores],
    ["routeFamilyCaps", EXIT_ROUTE_SCORING_TABLES.routeFamilyCaps],
    ["coverageRatioBreakpoints", EXIT_ROUTE_SCORING_TABLES.coverageRatioBreakpoints],
    ["absoluteCapacityBreakpoints", EXIT_ROUTE_SCORING_TABLES.absoluteCapacityBreakpoints],
    ["settlementDelayBands", EXIT_ROUTE_SCORING_TABLES.settlementDelayBands],
    ["queueBacklogBands", EXIT_ROUTE_SCORING_TABLES.queueBacklogBands],
    ["minimumRedeemBands", EXIT_ROUTE_SCORING_TABLES.minimumRedeemBands],
    ["holderEligibilityMultipliers", EXIT_ROUTE_SCORING_TABLES.holderEligibilityMultipliers],
    ["modeledConfidenceFactors", EXIT_ROUTE_SCORING_TABLES.modeledConfidenceFactors],
    ["observationConfidenceFactors", EXIT_ROUTE_SCORING_TABLES.observationConfidenceFactors],
    ["scoreableEvidenceKinds", EXIT_ROUTE_SCORING_TABLES.scoreableEvidenceKinds],
    ["documentedTermsMaxAgeSec", EXIT_ROUTE_SCORING_TABLES.documentedTermsMaxAgeSec],
  ])("carries the source %s", (key, source) => {
    expect(exitPolicy[key]).toEqual(source);
  });

  it("keeps the reviewed independent-route benefit limit", () => {
    // V9-native composition layer: the redundancy allowance has no counterpart
    // in the redemption domain view, so it is pinned as a reviewed literal.
    expect(exitPolicy.independentRouteBenefitLimit).toBe(0.1);
  });
});

/**
 * The redemption domain view's public constants are now projections of the same
 * source, not a second authored copy. These assertions are cheap identity checks
 * that catch a re-literalization during a future edit.
 */
describe("the redemption domain view projects the single exit-scoring source", () => {
  it("re-exports the source tables rather than re-declaring them", () => {
    expect(REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS).toBe(EXIT_ROUTE_SCORING_TABLES.componentWeights);
    expect(REDEMPTION_ACCESS_SCORES).toBe(EXIT_ROUTE_SCORING_TABLES.accessScores);
    expect(REDEMPTION_SETTLEMENT_SCORES).toBe(EXIT_ROUTE_SCORING_TABLES.settlementScores);
    expect(REDEMPTION_EXECUTION_SCORES).toBe(EXIT_ROUTE_SCORING_TABLES.executionScores);
    expect(REDEMPTION_OUTPUT_ASSET_SCORES).toBe(EXIT_ROUTE_SCORING_TABLES.outputAssetScores);
    expect(REDEMPTION_ROUTE_FAMILY_CAPS).toBe(EXIT_ROUTE_SCORING_TABLES.routeFamilyCaps);
  });

  it("derives the same-notional request and freshness policies from the source", () => {
    expect(SAME_NOTIONAL_EXIT_REQUEST_POLICY).toEqual({
      maxCostBps: EXIT_ROUTE_SCORING_TABLES.request.maxCostBps,
      settlementHorizonSec: EXIT_ROUTE_SCORING_TABLES.request.settlementHorizonSec,
    });
    expect(SAME_NOTIONAL_EXIT_OBSERVATION_FRESHNESS_POLICY.documentedTermsMaxAgeSec).toBe(
      EXIT_ROUTE_SCORING_TABLES.documentedTermsMaxAgeSec,
    );
  });
});

/**
 * The "severe depeg" band (25%) was written three times: the redemption lane, the
 * digest's critical-risk copy, and the V9 policy JSON. The first two now project
 * `DEPEG_SEVERITY_BPS.severe`; the policy JSON stays the scoring owner (ADR-19)
 * and is asserted against the vocabulary here, so a reissue that moves the band
 * without moving the vocabulary fails CI instead of diverging silently.
 */
describe("the depeg severity vocabulary matches the V9 policy JSON", () => {
  it("pins the policy's F-range active-depeg cap to DEPEG_SEVERITY_BPS.severe", () => {
    const severeCap = activeDepegCaps.find((cap) => cap.kind === "active-depeg:f");
    expect(severeCap?.minimumBps).toBe(DEPEG_SEVERITY_BPS.severe);
  });

  it("keeps the redemption-lane threshold on the same vocabulary entry", () => {
    expect(REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS).toBe(DEPEG_SEVERITY_BPS.severe);
  });
});
