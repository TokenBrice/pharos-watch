import { describe, expect, it } from "vitest";
import candidatePolicyAsset from "@shared/data/safety-score-v9/methodology-policy-candidate-v1.json";
import {
  V9_REASON_CODES,
  V9StructuralSignalKindSchema,
  V9UnresolvedFactSchema,
  v9UnknownRungLedger,
  type V9MethodologyPolicy,
} from "@shared/types/safety-score-v9";
import {
  V9_CANDIDATE_POLICY_V1,
  assertV9ReasonCodesRegistered,
  assertV9UnresolvedFactsMatchPolicy,
  assertV9ValidatedPolicyEnvelope,
  loadV9MethodologyPolicy,
  resolveV9ReasonTreatment,
} from "../safety-score-v9/policy";
import type { V9EvidenceCause } from "../../types/safety-score-v9-causes";

function candidateClone(): V9MethodologyPolicy {
  return structuredClone(V9_CANDIDATE_POLICY_V1.policy);
}

describe("Safety Score v9 methodology policy", () => {
  it("retains immutable validated policy identity", () => {
    expect(Object.isFrozen(V9_CANDIDATE_POLICY_V1.policy.semantic.formula)).toBe(true);
    expect(Object.isFrozen(V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry)).toBe(true);
    expect(loadV9MethodologyPolicy(candidatePolicyAsset).semanticDigest).toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
  });
  it("enforces unbounded delivery below bounded physical and bounded physical at most fiat par", () => {
    const equal = candidateClone();
    equal.semantic.exit.unboundedDeliveryCap = equal.semantic.exit.outputAssetScores["physical-commodity-delivery"];
    expect(() => loadV9MethodologyPolicy(equal)).toThrow();
    const inverted = candidateClone();
    inverted.semantic.exit.outputAssetScores["physical-commodity-delivery"] = inverted.semantic.exit.outputAssetScores["stable-single"] + 1;
    expect(() => loadV9MethodologyPolicy(inverted)).toThrow();
    const valid = candidateClone();
    valid.semantic.exit.unboundedDeliveryCap = 54;
    expect(loadV9MethodologyPolicy(valid).policy.semantic.exit.unboundedDeliveryCap).toBe(54);
  });
  it("validates and digests the curated residual admission threshold", () => {
    const changed = candidateClone();
    changed.semantic.backing.reserve.maxUnclassifiedCuratedResidualPct /= 2;
    expect(loadV9MethodologyPolicy(changed).semanticDigest).not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
    for (const invalid of [-0.001, 100.001, Number.NaN, Number.POSITIVE_INFINITY]) {
      const policy = candidateClone();
      policy.semantic.backing.reserve.maxUnclassifiedCuratedResidualPct = invalid;
      expect(() => loadV9MethodologyPolicy(policy)).toThrow();
    }
  });

  it("walks every registered reason/cause with no hidden removed ceiling or missing-data NR", () => {
    for (const reason of V9_CANDIDATE_POLICY_V1.policy.reasonRegistry) {
      for (const cause of ["A", "B", "C", "U"] satisfies V9EvidenceCause[]) {
        const treatment = resolveV9ReasonTreatment(V9_CANDIDATE_POLICY_V1, reason.code, cause);
        expect(treatment.critical, `${reason.code}:${cause}`).toBe(false);
        expect(treatment.treatment, `${reason.code}:${cause}`).not.toBe("NR");
        if (reason.code === "missing-implementation-date" && cause !== "A" && cause !== "B") {
          expect(treatment.ceiling?.limit).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.formula.trackRecordCeilings[0]!.limit);
        } else expect(treatment.ceiling, `${reason.code}:${cause}`).toBeNull();
        if (cause === "A" || cause === "B") {
          expect(treatment.treatment).toBe("diagnostic");
          expect(treatment.scoringDisposition).toBe(cause === "A" ? "excluded-pipeline" : "excluded-uncurated");
        }
      }
    }
  });

  it("validates each moved score-bearing gate in its owning semantic domain", () => {
    const missingWithhold: unknown = candidateClone();
    delete (missingWithhold as { semantic: { formula: { withhold?: unknown } } }).semantic.formula.withhold;
    expect(() => loadV9MethodologyPolicy(missingWithhold)).toThrow();

    const invertedDangerFloors = candidateClone();
    invertedDangerFloors.semantic.formula.danger.fGatePegMultiplierFloor =
      invertedDangerFloors.semantic.formula.danger.withholdPegMultiplierFloor + 0.01;
    expect(() => loadV9MethodologyPolicy(invertedDangerFloors)).toThrow(/cannot exceed/i);

    const invalidEvidenceExpiry = candidateClone();
    invalidEvidenceExpiry.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec = 0;
    expect(() => loadV9MethodologyPolicy(invalidEvidenceExpiry)).toThrow();

    const invalidBridgeThreshold = candidateClone();
    invalidBridgeThreshold.semantic.control.materialBridgeHighShareThreshold = 1.01;
    expect(() => loadV9MethodologyPolicy(invalidBridgeThreshold)).toThrow();
  });

  const semanticMutations: [string, (policy: V9MethodologyPolicy) => void][] = [
    ["withhold score", (policy) => { policy.semantic.formula.withhold.maxScoreExclusive = 54; }],
    ["danger floor", (policy) => { policy.semantic.formula.danger.fGatePegMultiplierFloor = 0.79; }],
    ["danger grades", (policy) => { policy.semantic.formula.danger.dangerOnlyGrades = ["D", "F"]; }],
    ["bridge materiality", (policy) => { policy.semantic.control.materialBridgeHighShareThreshold = 0.24; }],
    ["collateral gated", (policy) => { policy.semantic.control.mintPostureQuality["collateral-gated"] = 51; policy.semantic.control.mintPostureQuality.unknown = 51; }],
    ["seasoned credit ceiling", (policy) => { policy.semantic.control.mintPostureGrading.adverseSeasonedCreditCeiling = 40; }],
    ["allocation required scope", (policy) => { policy.semantic.formula.wrapperAllocationScope.requiredScopes.privateCredit.leverage.push("immediate-custodian"); }],
    ["allocation leverage assessment", (policy) => { policy.semantic.formula.wrapperAllocationScope.leverageAssessments["bounded-up-to-1.5x"] = "high"; }],
    ["allocation custody assessment", (policy) => { policy.semantic.formula.wrapperAllocationScope.custodyAssessments["unsegregated"] = "critical"; }],
    ["bounded liquid age", (policy) => { policy.semantic.backing.reserve.boundedFacts.currentLiquidFractionMaxAgeSec += 1; }],
    ["bounded observed maturity quality", (policy) => { policy.semantic.backing.reserve.boundedFacts.observedMaturityQualityLevel = "adequate"; }],
    ["bounded current availability quality", (policy) => { policy.semantic.backing.reserve.boundedFacts.currentAvailabilityQualityLevel = "adequate"; policy.semantic.backing.reserve.liquidityQuality["seven-days"] = 90; }],
  ];
  const evidenceExpiry = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry;
  for (const field of Object.keys(evidenceExpiry) as (keyof typeof evidenceExpiry)[]) {
    semanticMutations.push([`evidence expiry: ${field}`, (policy) => { policy.semantic.evidence.evidenceExpiry[field] += 1; }]);
  }
  it.each(semanticMutations)("changes the semantic digest for %s", (_name, change) => {
    const policy = candidateClone();
    change(policy);
    expect(loadV9MethodologyPolicy(policy).semanticDigest).not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
  });

  it("canonicalizes bounded-fact vocabulary order but rejects informational stress protection", () => {
    const reordered = candidateClone();
    reordered.semantic.backing.reserve.boundedFacts.factKinds.reverse();
    reordered.semantic.backing.reserve.boundedFacts.scopeKinds.reverse();
    reordered.semantic.backing.reserve.boundedFacts.termUnits.reverse();
    expect(loadV9MethodologyPolicy(reordered).semanticDigest).toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
    const invalid = candidateClone();
    invalid.semantic.backing.reserve.boundedFacts.currentAvailabilityQualityLevel = "strong";
    expect(() => loadV9MethodologyPolicy(invalid)).toThrow();
  });

  it("keeps every C/U credit rung at max(current ordinary rung), excluding measured-adverse rungs", () => {
    const ledger = v9UnknownRungLedger(V9_CANDIDATE_POLICY_V1.policy.semantic);
    for (const row of ledger) {
      if (row.polarity === "credit") expect(row.value, row.path).toBe(Math.max(row.current, row.ordinaryMinimum!));
      else expect(row.value, row.path).toBe(row.current);
    }
    const lowered = candidateClone();
    lowered.semantic.control.mintPostureQuality.unknown = 49;
    expect(() => loadV9MethodologyPolicy(lowered)).toThrow();
    const excessive = candidateClone();
    excessive.semantic.control.mintPostureQuality.unknown = 51;
    expect(() => loadV9MethodologyPolicy(excessive)).toThrow();
  });

  it("loads a changed withholding danger threshold with a distinct digest", () => {
    const changedPolicy = candidateClone();
    changedPolicy.semantic.formula.danger.withholdPegMultiplierFloor = 0.84;
    const policy = loadV9MethodologyPolicy(changedPolicy);
    expect(policy.policy.semantic.formula.danger.withholdPegMultiplierFloor).toBe(0.84);
    expect(policy.semanticDigest).not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
  });

  it("makes object order and set-like array order digest-neutral", () => {
    const reordered = candidateClone();
    reordered.reasonRegistry.reverse();
    for (const entry of reordered.reasonRegistry) {
      entry.archetypes.reverse();
      entry.pathKinds.reverse();
      entry.permittedTreatments.reverse();
    }
    reordered.semantic.exit.scoreableEvidenceKinds.dex.reverse();
    reordered.semantic.accessPostureVocabulary.governance.reverse();
    reordered.semantic.backing.reserve.maturityNotApplicableClasses.reverse();
    reordered.semantic.backing.archetypes.cdp.serialComponentKeys.reverse();
    reordered.semantic.formula.assetPremiums[0]!.requiredOperationalComponents.reverse();
    reordered.semantic.formula.danger.withholdCentralizedMintSeverities.reverse();

    const loaded = loadV9MethodologyPolicy(reordered);
    expect(loaded.semanticDigest).toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
    expect(
      loadV9MethodologyPolicy({
        reasonRegistry: candidatePolicyAsset.reasonRegistry,
        semantic: candidatePolicyAsset.semantic,
        releaseVersion: candidatePolicyAsset.releaseVersion,
        lifecycle: candidatePolicyAsset.lifecycle,
        policyId: candidatePolicyAsset.policyId,
        schemaVersion: candidatePolicyAsset.schemaVersion,
      }).semanticDigest,
    ).toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
  });

  it("accepts a reversed reviewed mature-chain set without changing the digest", () => {
    const reordered = candidateClone();
    reordered.semantic.materiality.matureChains.reverse();
    expect(reordered.semantic.materiality.matureChains).not.toEqual(
      V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.matureChains,
    );
    expect(loadV9MethodologyPolicy(reordered).semanticDigest).toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
  });

  it("rejects an authored mature-chain set missing a reviewed slug", () => {
    const missing = candidateClone();
    missing.semantic.materiality.matureChains.pop();
    expect(() => loadV9MethodologyPolicy(missing)).toThrow(/must derive from chain-maturity-reviews/);
  });

  it("rejects non-string mature-chain members before canonicalizing the set", () => {
    const malformed = candidateClone();
    const raw = {
      ...malformed,
      semantic: {
        ...malformed.semantic,
        materiality: { ...malformed.semantic.materiality, matureChains: [42] },
      },
    };
    expect(() => loadV9MethodologyPolicy(raw)).toThrow(/must be an array of reviewed chain slugs/);
  });


  it("excludes valid policy identities and release versions but includes semantic decisions", () => {
    const relabeled = candidateClone();
    relabeled.policyId = "safety-score-v9-audit";
    expect(relabeled.policyId).not.toBe(V9_CANDIDATE_POLICY_V1.policy.policyId);
    expect(loadV9MethodologyPolicy(relabeled).semanticDigest).toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);

    const released = candidateClone();
    released.releaseVersion = "99.0";
    expect(released.releaseVersion).not.toBe(V9_CANDIDATE_POLICY_V1.policy.releaseVersion);
    expect(loadV9MethodologyPolicy(released).semanticDigest).toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);

    const reweighted = candidateClone();
    reweighted.semantic.formula.pillarWeights.backing = 0.39;
    reweighted.semantic.formula.pillarWeights.exit = 0.36;
    expect(loadV9MethodologyPolicy(reweighted).semanticDigest).not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);

    const reprioritized = candidateClone();
    reprioritized.semantic.formula.capTiePriority.reverse();
    expect(loadV9MethodologyPolicy(reprioritized).semanticDigest).not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);

    const backingReweighted = candidateClone();
    backingReweighted.semantic.backing.archetypes["fiat-cash"].componentWeights["claim-and-segregation"] = 0.17;
    backingReweighted.semantic.backing.archetypes["fiat-cash"].componentWeights["custody-continuity"] = 0.13;
    expect(loadV9MethodologyPolicy(backingReweighted).semanticDigest).not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
  });

  it("includes the parent-mechanism bypass decision in the semantic digest and rejects unbalanced native-family weights", () => {
    const changed = candidateClone();
    changed.semantic.backing.archetypes["protocol-position"].allowCompleteLiveParentMechanismBypass = true;
    expect(loadV9MethodologyPolicy(changed).semanticDigest).not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
    const unbalanced = candidateClone();
    unbalanced.semantic.backing.archetypes["shared-reserve"].componentWeights["liability-conservation"] = 0;
    expect(() => loadV9MethodologyPolicy(unbalanced)).toThrow();
    const missing = candidateClone();
    delete (missing.semantic.backing.archetypes["ucits-trs-fund"] as Partial<
      typeof missing.semantic.backing.archetypes["ucits-trs-fund"]
    >).allowCompleteLiveParentMechanismBypass;
    expect(() => loadV9MethodologyPolicy(missing)).toThrow();
  });

  it("rejects malformed weights, bands, grades, and policy bypass fields", () => {
    const weights = candidateClone();
    weights.semantic.formula.pillarWeights.backing = 0.5;
    expect(() => loadV9MethodologyPolicy(weights)).toThrow(/weights must sum to 1/i);

    const trackBands = candidateClone();
    trackBands.semantic.formula.trackRecordCeilings[1]!.minMonthsInclusive = 7;
    expect(() => loadV9MethodologyPolicy(trackBands)).toThrow(/contiguous/i);

    const grades = candidateClone();
    grades.semantic.formula.gradeThresholds.reverse();
    expect(() => loadV9MethodologyPolicy(grades)).toThrow(/every rated grade/i);

    const legacyMaterialityField: unknown = structuredClone(candidateClone());
    const legacyMateriality = (legacyMaterialityField as { semantic: { materiality: Record<string, unknown> } })
      .semantic.materiality;
    legacyMateriality.matureChainShareThreshold = legacyMateriality.commonModeShareThreshold;
    delete legacyMateriality.commonModeShareThreshold;
    expect(() => loadV9MethodologyPolicy(legacyMaterialityField)).toThrow();

    const invertedCommonModeTiers = candidateClone();
    invertedCommonModeTiers.semantic.materiality.commonModeHighShareThreshold =
      invertedCommonModeTiers.semantic.materiality.commonModeShareThreshold;
    expect(() => loadV9MethodologyPolicy(invertedCommonModeTiers)).toThrow(/must exceed/i);

    expect(() => loadV9MethodologyPolicy({ ...candidateClone(), assetIds: ["usdc"] })).toThrow();
  });

  it("requires exact signal, disposition, priority, and reason coverage", () => {
    const missingSignal = candidateClone();
    delete (missingSignal.semantic.structural.signalLimits as Partial<Record<string, unknown>>)["unsafe-backing"];
    expect(() => loadV9MethodologyPolicy(missingSignal)).toThrow();

    const missingDisposition = candidateClone();
    missingDisposition.semantic.evidence.dispositions.pop();
    expect(() => loadV9MethodologyPolicy(missingDisposition)).toThrow(/every fact class/i);

    const duplicatePriority = candidateClone();
    duplicatePriority.semantic.formula.capTiePriority[0] = duplicatePriority.semantic.formula.capTiePriority[1]!;
    expect(() => loadV9MethodologyPolicy(duplicatePriority)).toThrow(/every cap source/i);

    const missingReason = candidateClone();
    missingReason.reasonRegistry.pop();
    expect(() => loadV9MethodologyPolicy(missingReason)).toThrow(/every V9 reason code/i);

    const invalidTreatment = candidateClone();
    invalidTreatment.reasonRegistry.find((entry) => entry.code === "missing-pillar")!.defaultTreatment = "pillar";
    expect(() => loadV9MethodologyPolicy(invalidTreatment)).toThrow(/permitted treatments/i);

    const removedRule = candidateClone();
    expect(() => loadV9MethodologyPolicy({
      ...removedRule, reasonRegistry: removedRule.reasonRegistry.map((entry) => entry.code === "material-unknown-reserve-exposure"
        ? { ...entry, ceilingRule: { source: "evidence-level", level: "strong" } } : entry),
    })).toThrow();
  });

  it("closes the candidate registry over current reason and structural kinds", () => {
    expect(new Set(V9_CANDIDATE_POLICY_V1.policy.reasonRegistry.map((entry) => entry.code))).toEqual(
      new Set(V9_REASON_CODES),
    );
    expect(Object.keys(V9_CANDIDATE_POLICY_V1.policy.semantic.structural.signalLimits).sort()).toEqual(
      [...V9StructuralSignalKindSchema.options].sort(),
    );
    expect(() => assertV9ReasonCodesRegistered(V9_CANDIDATE_POLICY_V1, V9_REASON_CODES)).not.toThrow();
    expect(() => assertV9ReasonCodesRegistered(V9_CANDIDATE_POLICY_V1, ["future-unregistered-reason"])).toThrow(
      /future-unregistered-reason/,
    );
  });

  it("checks unresolved criticality against its cause rather than historical ownership labels", () => {
    const raw = {
      code: "material-reserve-slice-unstructured" as const, reason: "Missing reviewed fields.",
      cause: "U" as const, critical: true, responsibility: "issuer-undisclosed" as const,
    };
    expect(resolveV9ReasonTreatment(V9_CANDIDATE_POLICY_V1, raw.code, "U")).toMatchObject({
      critical: false, treatment: "pillar", ceiling: null,
    });
    expect(() => assertV9UnresolvedFactsMatchPolicy(V9_CANDIDATE_POLICY_V1, [raw])).toThrow();
    expect(() => assertV9UnresolvedFactsMatchPolicy(V9_CANDIDATE_POLICY_V1, [{ ...raw, critical: false }])).not.toThrow();
    expect(() => V9UnresolvedFactSchema.parse({ ...raw, code: "future-unregistered-reason" })).toThrow();
  });

  it("does not accept a caller-supplied digest as a validated policy", () => {
    const forgedPolicy = {
      policy: candidateClone(),
      semanticDigest: V9_CANDIDATE_POLICY_V1.semanticDigest,
    };
    expect(() => assertV9ValidatedPolicyEnvelope(forgedPolicy)).toThrow(/loadV9MethodologyPolicy/);
    expect(() => assertV9ReasonCodesRegistered(forgedPolicy, [])).toThrow(/loadV9MethodologyPolicy/);
    expect(() => assertV9UnresolvedFactsMatchPolicy(forgedPolicy, [])).toThrow(/loadV9MethodologyPolicy/);
  });

  it("keeps the control-compensability headroom under the centralized-mint high ceiling", () => {
    const formula = V9_CANDIDATE_POLICY_V1.policy.semantic.formula;
    const signalLimits = V9_CANDIDATE_POLICY_V1.policy.semantic.structural.signalLimits["centralized-mint"];
    const quality = V9_CANDIDATE_POLICY_V1.policy.semantic.control.mintPostureQuality;
    expect(signalLimits.high).not.toBeNull();
    expect(signalLimits.moderate).not.toBeNull();
    expect(25 + formula.controlCompensabilityHeadroom).toBeLessThanOrEqual(signalLimits.high!);
    expect(quality["unbounded-reconciliation-unknown"]).toBeLessThan(signalLimits.high!);
    expect(quality["collateral-gated"]).toBeLessThan(signalLimits.moderate!);
  });
});
