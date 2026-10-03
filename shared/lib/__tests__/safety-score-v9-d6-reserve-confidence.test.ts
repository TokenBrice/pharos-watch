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

  it("uses the admitted envelope's source strength for unidentified tails, never a known sibling's stronger source", () => {
    const evaluate = (evidenceClass?: V9ReserveExposureFactV2["evidenceClass"]) =>
      evaluateV9ReserveExposures({
        assetId: "d6-fixture", reserveStatus: knownStatus("reserve.envelope"),
        reserveExposures: [{ ...reserve("independent"), weight: 0.9 }],
        reserveResiduals: [{ residualId: "unknown", weight: 0.1, status: {
          ...knownStatus("reserve.tail"), observationState: "bounded-unknown", evidenceRefIds: [], gapIds: ["gap:tail"],
        } }],
        reserveCompositionProvenance: "curated", reserveCompositionEvidenceClass: evidenceClass,
        gaps: [{ gapId: "gap:tail", ownerDomain: "backing", policyRuleId: "reserve.tail",
          observationState: "bounded-unknown", reasonCode: "bounded-unknown-reserve-exposure",
          path: { kind: "local-component", componentKey: "tail" }, message: "Unresearched tail", evidenceRefIds: [] }],
        resolvedUpstreamExposures: [],
      }, V9_CANDIDATE_POLICY_V1);
    const independent = evaluate("independent"), attested = evaluate("issuer-attested");
    expect(independent.contributions.find(row => row.componentKey.startsWith("reserve:unclassified-residual:")))
      .toMatchObject({ score: 35, wholeAssetWeight: 0.1, cause: "U" });
    for (const strength of ["issuer-attested", "static-validated", undefined] as const) {
      expect(evaluate(strength).contributions.find(row => row.componentKey.startsWith("reserve:unclassified-residual:")))
        .toMatchObject({ score: 35 * 0.8, wholeAssetWeight: 0.1, cause: "U" });
    }
    expect(independent.contributions.find(row => row.componentKey === "reserve:cash")!.score)
      .toBe(attested.contributions.find(row => row.componentKey === "reserve:cash")!.score);
  });
});
