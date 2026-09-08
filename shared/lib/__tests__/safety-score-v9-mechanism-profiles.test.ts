import { describe, expect, it } from "vitest";
import {
  V9MechanismProfileReviewSchema,
  evaluateV9MechanismProfileCoverage,
  projectV9MechanismProfile,
  type V9MechanismProfileReview,
} from "../safety-score-v9/mechanism-profiles";

type HybridReview = Extract<V9MechanismProfileReview, { profile: "inflation-index-hybrid" }>;

function hybridReview(
  facts: Partial<HybridReview["facts"]> = {},
  metrics: Partial<Pick<HybridReview, "exogenousBackingShare" | "reflexiveBackingShare" | "contractionCapacityRatio">> = {},
): HybridReview {
  return {
    profile: "inflation-index-hybrid",
    exogenousBackingShare: 0.8,
    reflexiveBackingShare: 0.1,
    contractionCapacityRatio: 0.8,
    ...metrics,
    facts: {
      collateralCoverage: { disposition: "supported", quality: "adequate" },
      contractionLiquidity: { disposition: "supported", quality: "adequate" },
      indexOracle: { disposition: "supported", quality: "adequate" },
      reflexiveBackstop: { disposition: "supported", quality: "limited" },
      emergencyRecovery: { disposition: "supported", quality: "limited" },
      lossRecovery: { disposition: "supported", quality: "limited" },
      protocolRedemption: { disposition: "supported", quality: "adequate" },
      ...facts,
    },
  };
}

describe("Safety Score v9 mechanism scoring profiles", () => {
  it("projects allocated commodity claim evidence without hiding issuer nondisclosure", () => {
    const review = V9MechanismProfileReviewSchema.parse({
      profile: "allocated-commodity-claim",
      facts: {
        holderTitle: { disposition: "supported", quality: "strong" },
        physicalAllocation: { disposition: "supported", quality: "strong" },
        custodianSegregation: { disposition: "supported", quality: "strong" },
        bankruptcyRemoteness: { disposition: "supported", quality: "limited" },
        custodyContinuity: { disposition: "issuer-undisclosed" },
        auditCadence: { disposition: "supported", quality: "adequate" },
        reserveReconciliation: { disposition: "supported", quality: "strong" },
        insurance: { disposition: "issuer-undisclosed" },
        physicalRedemption: { disposition: "supported", quality: "limited" },
      },
    });

    expect(projectV9MechanismProfile(review)).toMatchObject({
      archetype: "fiat-cash",
      components: {
        claimAndSegregation: { observationState: "known", quality: "limited" },
        custodyContinuity: { observationState: "bounded-unknown", quality: null },
        assuranceAndReconciliation: { observationState: "known", quality: "adequate" },
      },
      exitFacts: {
        physicalRedemption: { disposition: "supported", quality: "limited" },
      },
    });
    expect(evaluateV9MechanismProfileCoverage(review).gaps).toEqual([
      { factKey: "custodyContinuity", responsibility: "issuer-undisclosed" },
      { factKey: "insurance", responsibility: "issuer-undisclosed" },
    ]);
  });

  it("projects an inflation-index hybrid through its actual collateral and oracle paths", () => {
    const review = hybridReview({
      contractionLiquidity: { disposition: "issuer-undisclosed" },
      emergencyRecovery: { disposition: "issuer-undisclosed" },
      lossRecovery: { disposition: "issuer-undisclosed" },
    }, { exogenousBackingShare: 0.817, reflexiveBackingShare: 0.076, contractionCapacityRatio: 0.817 });

    expect(projectV9MechanismProfile(review)).toMatchObject({
      archetype: "algorithmic",
      metrics: {
        exogenousBackingShare: 0.817,
        reflexiveBackingShare: 0.076,
        contractionCapacityRatio: 0.817,
      },
      components: {
        contractionCapacity: { observationState: "bounded-unknown", quality: null },
        confidenceAndIncentives: { observationState: "known", quality: "limited" },
        oracleAndControlAssumptions: { observationState: "known", quality: "adequate" },
        emergencyRecovery: { observationState: "bounded-unknown", quality: null },
        lossRecovery: { observationState: "bounded-unknown", quality: null },
      },
    });
  });

  it("keeps method and integration failures distinct from issuer nondisclosure", () => {
    const review = hybridReview({
      contractionLiquidity: { disposition: "integration-missing" },
      emergencyRecovery: { disposition: "method-unsupported" },
      lossRecovery: { disposition: "issuer-undisclosed" },
    });

    expect(evaluateV9MechanismProfileCoverage(review).gaps).toEqual([
      { factKey: "contractionLiquidity", responsibility: "integration-missing" },
      { factKey: "emergencyRecovery", responsibility: "method-unsupported" },
      { factKey: "lossRecovery", responsibility: "issuer-undisclosed" },
    ]);
    expect(projectV9MechanismProfile(review).components).toMatchObject({
      contractionCapacity: { observationState: "missing" },
      emergencyRecovery: { observationState: "unsupported" },
      lossRecovery: { observationState: "bounded-unknown" },
    });
  });

  it.each([
    ["issuer-undisclosed", "integration-missing", "missing"],
    ["integration-missing", "method-unsupported", "unsupported"],
  ] as const)("prioritizes %s / %s within one component", (first, second, observationState) => {
    const review = V9MechanismProfileReviewSchema.parse({
      profile: "allocated-commodity-claim",
      facts: {
        holderTitle: { disposition: "supported", quality: "strong" },
        physicalAllocation: { disposition: "supported", quality: "strong" },
        custodianSegregation: { disposition: "supported", quality: "strong" },
        bankruptcyRemoteness: { disposition: "supported", quality: "limited" },
        custodyContinuity: { disposition: first },
        auditCadence: { disposition: "supported", quality: "adequate" },
        reserveReconciliation: { disposition: "supported", quality: "strong" },
        insurance: { disposition: second },
        physicalRedemption: { disposition: "supported", quality: "limited" },
      },
    });
    expect(projectV9MechanismProfile(review).components.custodyContinuity).toMatchObject({
      observationState, quality: null,
    });
  });

  it("reports complete supported coverage while retaining the weakest failed constituent", () => {
    const review = hybridReview({ contractionLiquidity: { disposition: "supported", quality: "failed" } });
    expect(evaluateV9MechanismProfileCoverage(review)).toEqual({
      profile: "inflation-index-hybrid",
      complete: true,
      supportedFactKeys: [
        "collateralCoverage", "contractionLiquidity", "emergencyRecovery", "indexOracle",
        "lossRecovery", "protocolRedemption", "reflexiveBackstop",
      ],
      gaps: [],
    });
    expect(projectV9MechanismProfile(review).components.contractionCapacity).toMatchObject({
      observationState: "known", quality: "failed",
    });
  });

  it("rejects backing shares above the whole", () => {
    expect(() =>
      V9MechanismProfileReviewSchema.parse(hybridReview({}, {
        exogenousBackingShare: 0.9, reflexiveBackingShare: 0.2, contractionCapacityRatio: 0.9,
      })),
    ).toThrow();
  });
});
