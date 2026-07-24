import { describe, expect, it } from "vitest";
import candidatePolicyAsset from "@shared/data/safety-score-v9/methodology-policy-candidate-v1.json";
import {
  V9_REASON_CODES,
  V9StructuralSignalKindSchema,
  V9UnresolvedFactSchema,
  type V9MethodologyPolicy,
} from "@shared/types/safety-score-v9";
import {
  V9_CANDIDATE_POLICY_V1,
  assertV9ReasonCodesRegistered,
  assertV9UnresolvedFactsMatchPolicy,
  assertV9ValidatedPolicyEnvelope,
  loadV9MethodologyPolicy,
  normalizeV9UnresolvedFacts,
  resolveV9ReasonPolicy,
} from "../safety-score-v9/policy";
import { V9_BOUNDED_ATTRIBUTION_REASON_CODES } from "../../types/safety-score-v9-public";

function candidateClone(): V9MethodologyPolicy {
  return structuredClone(V9_CANDIDATE_POLICY_V1.policy);
}

describe("Safety Score v9 methodology policy", () => {
  it("loads the committed candidate with a frozen semantic digest", () => {
    expect(V9_CANDIDATE_POLICY_V1.policy.policyId).toBe("safety-score-v9-candidate-v2");
    expect(V9_CANDIDATE_POLICY_V1.policy.lifecycle).toBe("candidate");
    expect(V9_CANDIDATE_POLICY_V1.policy.releaseVersion).toBeNull();
    // ROTATION-1 (owner rulings 2026-07-23): share-band materiality 0.10/0.25, T5 credit 10,
    // undisclosedFeeRouteScoreCeiling 52, commodity-allocated reserve class.
    expect(V9_CANDIDATE_POLICY_V1.semanticDigest).toBe(
      "252458185ce45da7327db498f19ed42e7cf9014454870bf9582fa5ccdb64ff51",
    );
    const cdpPolicy = V9_CANDIDATE_POLICY_V1.policy.semantic.backing.structural.cdp;
    expect(cdpPolicy.instantaneousCollateralShock).toBe(0.5);
    expect(cdpPolicy.minimumLiquidationCapacityRatio).toBe(0.5);
    expect(cdpPolicy.stressMeasurementFreshness).toMatchObject({
      maxAgeSec: 259_200,
      ratification: "owner-ratified",
    });
    expect(Object.isFrozen(V9_CANDIDATE_POLICY_V1.policy.semantic.formula)).toBe(true);
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

  it("freezes the stays-NR reason set to integrity and classification failures", () => {
    // The rating-parity contract: missing research evidence is bounded, never
    // NR. Only pipeline-integrity and classification failures may reason-code
    // NR. Re-tiering a code back to NR must be an explicit, reviewed edit of
    // this list (see agents/safety-score-v9/rating-parity-plan.md §2).
    const staysNR = V9_CANDIDATE_POLICY_V1.policy.reasonRegistry
      .filter((entry) => entry.defaultTreatment === "NR")
      .map((entry) => entry.code)
      .sort();
    expect(staysNR).toEqual([
      "critical-unresolved",
      "future-dated-input-fact",
      "historical-critical-input",
      "implementation-parent-cycle",
      "insufficient-evidence",
      "missing-archetype",
      "missing-parent-score",
      "missing-pillar",
      "missing-pillar-evidence",
      "parent-cycle",
    ]);
    for (const entry of V9_CANDIDATE_POLICY_V1.policy.reasonRegistry) {
      if (entry.defaultTreatment !== "ceiling") continue;
      expect(entry.ceilingRule, entry.code).not.toBeNull();
      expect(resolveV9ReasonPolicy(V9_CANDIDATE_POLICY_V1, entry.code).ceiling?.limit, entry.code).toBeGreaterThan(0);
    }
  });

  it("keeps the public bounded-attribution code set aligned with policy", () => {
    const policyBounded = V9_CANDIDATE_POLICY_V1.policy.reasonRegistry
      .filter(
        (entry) =>
          (entry.boundedness === "exposure-bounded" ||
            entry.boundedness === "globally-bounded") &&
          (entry.defaultTreatment === "pillar" ||
            entry.defaultTreatment === "ceiling"),
      )
      .map((entry) => entry.code)
      .sort();
    expect([...V9_BOUNDED_ATTRIBUTION_REASON_CODES].sort()).toEqual(policyBounded);
  });

  it("binds aggregate gaps to explicit local-component policy paths", () => {
    const expectedKinds = {
      "incomplete-dex-route-coverage": ["optional-exit", "local-component"],
      "missing-bridge-routes": ["deployment-control", "local-component"],
      "missing-peg-input": ["peg", "local-component"],
      "missing-reserve-composition": ["collateral-exposure", "local-component"],
      "missing-runtime-route-evidence": ["optional-exit", "local-component"],
      "runtime-bridge-materiality-unavailable": ["deployment-control", "local-component"],
      "unreviewed-dependency-relationships": ["collateral-exposure", "serial-dependency", "local-component"],
    } as const;
    for (const [code, pathKinds] of Object.entries(expectedKinds)) {
      const entry = V9_CANDIDATE_POLICY_V1.policy.reasonRegistry.find((candidate) => candidate.code === code);
      expect(entry?.pathKinds, code).toEqual(expect.arrayContaining([...pathKinds]));
      expect(entry?.pathKinds, code).not.toContain("*");
    }

    expect(
      resolveV9ReasonPolicy(V9_CANDIDATE_POLICY_V1, "runtime-bridge-materiality-unavailable").reason,
    ).toMatchObject({ ownerDomain: "control", defaultTreatment: "ceiling" });
    expect(resolveV9ReasonPolicy(V9_CANDIDATE_POLICY_V1, "missing-archetype").reason).toMatchObject({
      ownerDomain: "methodology",
      pathKinds: ["methodology"],
    });
  });

  it("excludes lifecycle identity but includes every semantic decision", () => {
    const relabeled = candidateClone();
    relabeled.policyId = "safety-score-v9-candidate-v2";
    expect(loadV9MethodologyPolicy(relabeled).semanticDigest).toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);

    const promoted = candidateClone();
    promoted.lifecycle = "active";
    promoted.releaseVersion = "9.0";
    expect(loadV9MethodologyPolicy(promoted).semanticDigest).toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);

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

  it("loads retained schema-v1 materiality fields through the conservative compatibility adapter", () => {
    const retainedPolicy: unknown = structuredClone(candidateClone());
    const materiality = (retainedPolicy as { semantic: { materiality: Record<string, unknown> } }).semantic.materiality;
    delete materiality.commonModeHighShareThreshold;
    materiality.commonModeShareThreshold = 0.15;
    materiality.lowRiskBridgeTiers = ["canonical-rollup-bridge"];

    const loaded = loadV9MethodologyPolicy(retainedPolicy);
    expect(loaded.policy.semantic.materiality.commonModeHighShareThreshold).toBe(0.15);
    expect("lowRiskBridgeTiers" in loaded.policy.semantic.materiality).toBe(false);
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

    const missingCeilingRule = candidateClone();
    missingCeilingRule.reasonRegistry.find((entry) => entry.code === "material-unknown-reserve-exposure")!.ceilingRule =
      null;
    expect(() => loadV9MethodologyPolicy(missingCeilingRule)).toThrow(/ceiling rule is required/i);

    const nullCeilingReference = candidateClone();
    nullCeilingReference.reasonRegistry.find(
      (entry) => entry.code === "material-unknown-reserve-exposure",
    )!.ceilingRule = { source: "evidence-level", level: "strong" };
    expect(() => loadV9MethodologyPolicy(nullCeilingReference)).toThrow(/has no ceiling/i);
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

  it("makes registry treatment authoritative for unresolved facts and audit classification", () => {
    const raw = {
      code: "material-reserve-slice-unstructured" as const,
      reason: "Missing reviewed fields.",
      critical: true,
      responsibility: "integration-missing" as const,
    };
    expect(resolveV9ReasonPolicy(V9_CANDIDATE_POLICY_V1, raw.code)).toMatchObject({
      critical: false,
      reason: { defaultTreatment: "pillar", auditClassification: "missing-data" },
      ceiling: null,
    });
    expect(resolveV9ReasonPolicy(V9_CANDIDATE_POLICY_V1, "material-unknown-reserve-exposure")).toMatchObject({
      critical: false,
      reason: { defaultTreatment: "ceiling" },
      ceiling: { kind: "reason:material-unknown-reserve-exposure", limit: 69 },
    });
    expect(() => assertV9UnresolvedFactsMatchPolicy(V9_CANDIDATE_POLICY_V1, [raw])).toThrow(/contradict policy/);
    const normalized = normalizeV9UnresolvedFacts(V9_CANDIDATE_POLICY_V1, [raw]);
    expect(normalized[0]?.critical).toBe(false);
    expect(() => assertV9UnresolvedFactsMatchPolicy(V9_CANDIDATE_POLICY_V1, normalized)).not.toThrow();
    expect(() =>
      V9UnresolvedFactSchema.parse({
        code: "future-unregistered-reason",
        reason: "Unknown.",
        critical: true,
        responsibility: "method-unsupported",
      }),
    ).toThrow();
  });

  it("does not accept a caller-supplied digest as a validated policy", () => {
    const forgedPolicy = {
      policy: candidateClone(),
      semanticDigest: V9_CANDIDATE_POLICY_V1.semanticDigest,
    };
    expect(() => assertV9ValidatedPolicyEnvelope(forgedPolicy)).toThrow(/loadV9MethodologyPolicy/);
    expect(() => assertV9ReasonCodesRegistered(forgedPolicy, [])).toThrow(/loadV9MethodologyPolicy/);
    expect(() => normalizeV9UnresolvedFacts(forgedPolicy, [])).toThrow(/loadV9MethodologyPolicy/);
    expect(() => assertV9UnresolvedFactsMatchPolicy(forgedPolicy, [])).toThrow(/loadV9MethodologyPolicy/);
  });

  it("keeps the control-compensability headroom under the centralized-mint high ceiling", () => {
    // A control-25 unbounded-mint asset can be lifted only up to control + the
    // control-compensability headroom (25 + 30 = 55). That must never exceed the
    // centralized-mint high signal ceiling (59), so the reconciled-unbounded-mint
    // archetype is pinned at C and can never be lifted to C+/B by the headroom.
    // This makes the "C, not C+" boundary a policy invariant, not a coincidence.
    const formula = V9_CANDIDATE_POLICY_V1.policy.semantic.formula;
    const centralizedMintHigh =
      V9_CANDIDATE_POLICY_V1.policy.semantic.structural.signalLimits["centralized-mint"].high;
    expect(centralizedMintHigh).not.toBeNull();
    expect(25 + formula.controlCompensabilityHeadroom).toBeLessThanOrEqual(centralizedMintHigh!);
  });
});
