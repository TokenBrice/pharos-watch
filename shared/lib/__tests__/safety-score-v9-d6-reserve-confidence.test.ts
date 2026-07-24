import { describe, expect, it } from "vitest";
import type { V9FactStatusV2, V9ReserveExposureFactV2 } from "../../types/safety-score-v9-facts";
import { evaluateV9ReserveExposures } from "../safety-score-v9/backing";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

const knownStatus = (rule: string): V9FactStatusV2 => ({
  applicability: { state: "required", policyRuleId: rule, rationale: null, gapId: null },
  observationState: "known",
  evidenceRefIds: [`evidence:${rule}`],
  gapIds: [],
});

function reserve(evidenceClass?: V9ReserveExposureFactV2["evidenceClass"]): V9ReserveExposureFactV2 {
  return {
    exposureKey: "cash",
    classificationKey: "class:cash",
    sourceGenerationId: "research:d6-fixture",
    provenance: "curated",
    ...(evidenceClass === undefined ? {} : { evidenceClass }),
    status: knownStatus("reserve.cash"),
    name: "Cash",
    weight: 1,
    trackedAssetId: null,
    assetClass: "cash",
    issuerOrObligorKey: "issuer:fixture",
    riskFactors: [],
    liquidityHorizon: "immediate",
    maturityDaysMax: null,
    failureDomains: [
      { kind: "reserve-issuer", key: "issuer:fixture" },
      { kind: "reserve-custodian", key: "custodian:fixture" },
    ],
  };
}

describe("D6 issuer-attested reserve confidence", () => {
  it("pins the proposed owner-ratify confidence multiplier at 0.80", () => {
    expect(V9_CANDIDATE_POLICY_V1.policy.semantic.backing.reserve.issuerAttestedConfidenceMultiplier).toBe(0.8);
  });

  it("discounts an admitted classification exactly once without adding uncertainty gaps", () => {
    const policyMultiplier = V9_CANDIDATE_POLICY_V1.policy.semantic.backing.reserve.issuerAttestedConfidenceMultiplier;
    const evaluate = (exposure: V9ReserveExposureFactV2) =>
      evaluateV9ReserveExposures(
        {
          assetId: "d6-fixture",
          reserveStatus: knownStatus("reserve.envelope"),
          reserveExposures: [exposure],
          gaps: [],
          resolvedUpstreamExposures: [],
        },
        V9_CANDIDATE_POLICY_V1,
      );

    const missingClass = evaluate(reserve());
    const baseline = evaluate(reserve("independent"));
    const discounted = evaluate(reserve("issuer-attested"));
    const staticValidated = evaluate(reserve("static-validated"));
    const baselineExposure = baseline.contributions.find((row) => row.componentKey === "reserve:cash")?.score;
    const discountedExposure = discounted.contributions.find((row) => row.componentKey === "reserve:cash")?.score;
    const staticValidatedExposure = staticValidated.contributions.find(
      (row) => row.componentKey === "reserve:cash",
    )?.score;
    const missingClassExposure = missingClass.contributions.find((row) => row.componentKey === "reserve:cash")?.score;
    expect(baselineExposure).toBeDefined();
    expect(discountedExposure).toBeCloseTo(baselineExposure! * policyMultiplier, 10);
    expect(staticValidatedExposure).toBe(discountedExposure);
    expect(missingClassExposure).toBe(discountedExposure);
    expect(discounted.score).toBeLessThan(baseline.score!);
    expect(discounted.unresolved).toEqual([]);
  });
});
