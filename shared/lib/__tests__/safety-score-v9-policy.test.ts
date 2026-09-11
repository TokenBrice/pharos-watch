import { describe, expect, it } from "vitest";
import candidatePolicyAsset from "@shared/data/safety-score-v9/methodology-policy-candidate-v1.json";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "../methodology-versions/constants";
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
  resolveV9ReasonPolicy,
} from "../safety-score-v9/policy";
import { V9_BOUNDED_ATTRIBUTION_REASON_CODES } from "../../types/safety-score-v9-public";

function candidateClone(): V9MethodologyPolicy {
  return structuredClone(V9_CANDIDATE_POLICY_V1.policy);
}

describe("Safety Score v9 methodology policy", () => {
  it("loads the committed V9 policy with a frozen semantic digest", () => {
    expect(V9_CANDIDATE_POLICY_V1.policy.policyId).toBe("safety-score-v9");
    expect(V9_CANDIDATE_POLICY_V1.policy.lifecycle).toBe("active");
    // The policy asset ships under the active methodology version; the
    // sensitivity tooling enforces the same equality at runtime.
    expect(V9_CANDIDATE_POLICY_V1.policy.releaseVersion).toBe(SAFETY_SCORE_METHODOLOGY_VERSION);
    // ROTATION-1 (owner rulings 2026-07-23): share-band materiality 0.10/0.25, T5 credit 10,
    // undisclosedFeeRouteScoreCeiling 52, commodity-allocated reserve class and
    // non-counterparty reserve-issuer concentration exemption, plus the
    // fail-closed native-USDT market-anchor and longevity premium.
    // 2026-07-27 owner rulings: inherited-access-exposure (same diagnostic
    // treatment as missing-access-review) for evidenced structural freeze
    // dispositions, and peg-supply-floor-withheld (same peg-unverified
    // ceiling as missing-peg-input) for deviations withheld by the $1M
    // supply floor - both measured-structural, both score-neutral clones.
    // 2026-07-31 owner ruling: unresolved-control-identity also admits the
    // deployment-control path kind. Gap-accounting only - the queue stops
    // filing 62 deployment-scoped control gaps as reconcile-policy-binding
    // work; scores, grades, pillars and binding caps are unchanged across all
    // 335 assets. The full 62-row scope (22 owner-gate rows plus 40 beyond it,
    // including the 28 USDT bridge-control rows) was explicitly acknowledged:
    // pathKinds is per-reason-code, so the rows cannot be admitted separately.
    // Rotate only with reviewed semantic changes; release history lives in
    // shared/data/methodology-changelogs/safety-score/v9-activation.ts.
    expect(V9_CANDIDATE_POLICY_V1.semanticDigest).toBe(
      "fa4af0387d3be293f6d6f3882900f0b5a567ed80bd4afa0a7e80563e8a11b455",
    );
    expect(V9_CANDIDATE_POLICY_V1.policy.semantic.formula.withhold).toEqual({
      maxScoreExclusive: 55,
      minimumLimitedPillarCount: 2,
      requiresLimitedBacking: true,
    });
    expect(V9_CANDIDATE_POLICY_V1.policy.semantic.formula.danger).toEqual({
      withholdPegMultiplierFloor: 0.9,
      fGatePegMultiplierFloor: 0.8,
      preExitPegMultiplierFloor: 0.9,
      adverseAttributionPegMultiplierFloor: 0.9,
      activeDepegMinimumBpsExclusive: 0,
      withholdCentralizedMintSeverities: ["high", "critical"],
      fGateCentralizedMintSeverities: ["critical"],
      preExitCentralizedMintSeverities: ["critical"],
      dangerOnlyGrades: ["F"],
    });
    expect(V9_CANDIDATE_POLICY_V1.policy.semantic.control.materialBridgeHighShareThreshold).toBe(0.25);
    const cdpPolicy = V9_CANDIDATE_POLICY_V1.policy.semantic.backing.structural.cdp;
    expect(cdpPolicy.instantaneousCollateralShock).toBe(0.5);
    expect(cdpPolicy.minimumLiquidationCapacityRatio).toBe(0.5);
    expect(cdpPolicy.stressMeasurementFreshness).toMatchObject({
      maxAgeSec: 259_200,
      ratification: "owner-ratified",
    });
    expect(Object.isFrozen(V9_CANDIDATE_POLICY_V1.policy.semantic.formula)).toBe(true);
    expect(Object.isFrozen(V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry)).toBe(true);
  });

  it("registers the scoped control question reason with the control-scoped-gap ceiling above control-unverified", () => {
    const resolved = resolveV9ReasonPolicy(V9_CANDIDATE_POLICY_V1, "scoped-control-question");
    expect(resolved.critical).toBe(false);
    expect(resolved.ceiling).toEqual({ kind: "reason:scoped-control-question", limit: 69 });
    expect(resolved.ceiling!.limit).toBeGreaterThan(
      V9_CANDIDATE_POLICY_V1.policy.semantic.structural.namedReasonCeilings["control-unverified"],
    );
  });

  it("separates annual reserve-classification review from monthly composition freshness and grace", () => {
    expect(V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry).toEqual({
      reviewedResearchMaxAgeSec: 365 * 86_400,
      accessReviewMaxAgeSec: 365 * 86_400,
      researchOverlayMaxAgeSec: 365 * 86_400,
      mechanismOverlayMaxAgeSec: 365 * 86_400,
      issuerAttestedReserveMaxAgeSec: 365 * 86_400,
      reviewedReserveClassificationMaxAgeSec: 365 * 86_400,
      reviewedReserveCompositionMaxAgeSec: 31 * 86_400,
      reviewedReserveCompositionGraceSec: 7 * 86_400,
    });
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
    ["unknown reconciliation", (policy) => { policy.semantic.control.mintPostureQuality["unbounded-reconciliation-unknown"] = 36; }],
    ["collateral gated", (policy) => { policy.semantic.control.mintPostureQuality["collateral-gated"] = 51; }],
    ["seasoned credit ceiling", (policy) => { policy.semantic.control.mintPostureGrading.adverseSeasonedCreditCeiling = 40; }],
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

  it("pins the reviewed mint posture ladder keys and grading values", () => {
    const quality = V9_CANDIDATE_POLICY_V1.policy.semantic.control.mintPostureQuality;
    const grading = V9_CANDIDATE_POLICY_V1.policy.semantic.control.mintPostureGrading;
    expect(quality).toMatchObject({
      "unbounded-or-compromised": 25,
      "unbounded-reconciliation-unknown": 35,
      unknown: 45,
      "collateral-gated": 50,
      "concentrated-admin": 55,
      "unbounded-reconciled": 55,
      "none-resolved": 100,
    });
    expect(Object.keys(quality).sort()).toEqual(
      [
        "bounded-admin",
        "collateral-gated",
        "concentrated-admin",
        "none-resolved",
        "partially-bounded-admin",
        "unbounded-or-compromised",
        "unbounded-reconciled",
        "unbounded-reconciliation-unknown",
        "unknown",
      ].sort(),
    );
    expect(grading.adverseSeasonedCreditCeiling).toBe(39);
    expect(grading.seasonedCreditPoints).toBe(10);
    expect(grading.seasonedCreditMinMonths).toBe(60);
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
    expect(() =>
      assertV9UnresolvedFactsMatchPolicy(V9_CANDIDATE_POLICY_V1, [{ ...raw, critical: false }]),
    ).not.toThrow();
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
    expect(() => assertV9UnresolvedFactsMatchPolicy(forgedPolicy, [])).toThrow(/loadV9MethodologyPolicy/);
  });

  it("keeps the control-compensability headroom under the centralized-mint high ceiling", () => {
    // A control-25 unbounded-mint asset can be lifted only up to control + the
    // control-compensability headroom (25 + 30 = 55). That must never exceed the
    // centralized-mint high signal ceiling (59), so the reconciled-unbounded-mint
    // archetype is pinned at C and can never be lifted to C+/B by the headroom.
    // This makes the "C, not C+" boundary a policy invariant, not a coincidence.
    // 9.32: the new rungs deliberately share their band-mates' ceilings — the
    // 35 unknown-reconciliation rung sits under the same high ceiling (its blend
    // lift is trimmed at 59, exactly like unbounded-reconciled without
    // supervision), and the 50 collateral-gated rung sits under the moderate
    // ceiling (74) like the concentrated rung. The invariant for them is that
    // the in-pillar posture price stays BELOW its own signal ceiling, so the
    // ceiling can only trim blend lift and never prices a card below its
    // measured posture.
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
