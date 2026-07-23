import { describe, expect, it } from "vitest";
import {
  V9MechanismProfileReviewSchema,
  evaluateV9MechanismProfileCoverage,
  projectV9MechanismProfile,
} from "../safety-score-v9/mechanism-profiles";

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
    const review = V9MechanismProfileReviewSchema.parse({
      profile: "inflation-index-hybrid",
      exogenousBackingShare: 0.817,
      reflexiveBackingShare: 0.076,
      contractionCapacityRatio: 0.817,
      facts: {
        collateralCoverage: { disposition: "supported", quality: "adequate" },
        contractionLiquidity: { disposition: "issuer-undisclosed" },
        indexOracle: { disposition: "supported", quality: "adequate" },
        reflexiveBackstop: { disposition: "supported", quality: "limited" },
        emergencyRecovery: { disposition: "issuer-undisclosed" },
        lossRecovery: { disposition: "issuer-undisclosed" },
        protocolRedemption: { disposition: "supported", quality: "adequate" },
      },
    });

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
    const review = V9MechanismProfileReviewSchema.parse({
      profile: "inflation-index-hybrid",
      exogenousBackingShare: 0.8,
      reflexiveBackingShare: 0.1,
      contractionCapacityRatio: 0.8,
      facts: {
        collateralCoverage: { disposition: "supported", quality: "adequate" },
        contractionLiquidity: { disposition: "integration-missing" },
        indexOracle: { disposition: "supported", quality: "adequate" },
        reflexiveBackstop: { disposition: "supported", quality: "limited" },
        emergencyRecovery: { disposition: "method-unsupported" },
        lossRecovery: { disposition: "issuer-undisclosed" },
        protocolRedemption: { disposition: "supported", quality: "adequate" },
      },
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

  it("rejects backing shares above the whole", () => {
    expect(() =>
      V9MechanismProfileReviewSchema.parse({
        profile: "inflation-index-hybrid",
        exogenousBackingShare: 0.9,
        reflexiveBackingShare: 0.2,
        contractionCapacityRatio: 0.9,
        facts: {
          collateralCoverage: { disposition: "supported", quality: "adequate" },
          contractionLiquidity: { disposition: "supported", quality: "adequate" },
          indexOracle: { disposition: "supported", quality: "adequate" },
          reflexiveBackstop: { disposition: "supported", quality: "limited" },
          emergencyRecovery: { disposition: "supported", quality: "limited" },
          lossRecovery: { disposition: "supported", quality: "limited" },
          protocolRedemption: { disposition: "supported", quality: "adequate" },
        },
      }),
    ).toThrow();
  });
});
