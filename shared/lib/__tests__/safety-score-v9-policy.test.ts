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
  getV9ScoreBearingGatesPolicy,
  loadV9MethodologyPolicy,
  resolveV9ReasonPolicy,
} from "../safety-score-v9/policy";
import { V9_SCORE_BEARING_GATES_POLICY_V923 } from "../safety-score-v9/score-bearing-gates-policy";
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
    // 9.1 (2026-08-08): semantic.control gains `mintMergedSignals` — the merged
    // mint grader's resolved-incident decay caps, key-custody reclassification,
    // fine multisig quorum ladder, and Safe module modifier. Calibrated against
    // the Wave-1 release baseline to zero letter-grade flips; see the drift
    // report attached to the 9.1 changelog entry.
    // 9.12 (2026-08-08): `resolvedIncidentQualityCaps` moves 79/85/90 ->
    // 55/70/85. 9.1 shipped the decay mechanism at the strongest ladder that
    // flipped no grade, which was a calibration constraint rather than a
    // judgment; the severity is now chosen on merit and every rung is an
    // existing V9 posture value. One disclosed grade flip (pyusd-paypal A- -> B)
    // and one score-only move (reusd-resupply 47 -> 45).
    // 9.13 (2026-08-08): risk-absorption wrapper ownership selects an existing
    // parent-cap tier outside the policy formula, so the semantic digest is unchanged.
    // 9.14 engine phase (2026-08-08): `semantic.backing.archetypes` gains the
    // `commodity-claim` rubric (reserveWeight 0.55; title-and-allocation 0.15,
    // custody-continuity 0.10, assurance-and-reconciliation 0.13,
    // physical-redemption 0.07). Vocabulary only — no existing archetype rubric,
    // signal, weight, or ceiling changes, and no asset resolves to the new
    // archetype until the phase-2 migration, so no score or grade moves.
    // 9.17 (2026-08-11): oracle applicability separates genuinely oracleless
    // mechanisms (95) from privileged internal pricing (45); reviewed
    // not-applicable paths emit no scored component.
    // 9.25 (2026-08-18): `accessPostureVocabulary.primaryExit` gains
    // "undisclosed" so a missing exit surface stops publishing as the reviewed
    // negative "none". Published-vocabulary only — primaryExit is a posture
    // projection, not a scoring input, and the 2026-08-18 capture replays with
    // every score, grade, and pillar score byte-identical.
    // 9.26 (2026-08-18): the reason registry gains the diagnostic twin
    // "nonmaterial-bridge-supply-unmatched", so unattributed bridge supply below
    // the deployment materiality floor is published without a ceiling instead of
    // taking the material reason's 55. Registry addition only — no existing
    // reason, treatment, ceiling, weight, or threshold changes.
    // 9.27 (2026-08-18): the registry gains "scoped-control-question" and
    // `namedReasonCeilings` gains "control-scoped-gap" (69): a reviewer-named,
    // fresh, scoped open control question takes the 69 ceiling instead of the
    // 55 control-unverified ceiling. Existing reasons, treatments, weights, and
    // the other named ceilings are unchanged.
    // 9.3 (2026-08-20): mintPostureQuality["none-resolved"] moves 95 -> 100 —
    // the mint component's top rung scores the proven absence of privileged
    // mint ability instead of reserving unreachable headroom. Every other
    // rung, credit, signal, gate, and ceiling is unchanged.
    // 9.32 (2026-08-21): mintPostureQuality gains
    // "unbounded-reconciliation-unknown"=35 and "collateral-gated"=50; grading
    // gains adverseSeasonedCreditCeiling=39. Digest rotates with those keys.
    // 9.33 (2026-08-21): exit gains staleObservationConfidenceFactor=0.6 — a
    // route whose observation aged past its lane freshness bound is derated to
    // the same credit as other low-confidence evidence instead of leaving the
    // capacity denominator outright. No other exit weight, factor, or ceiling
    // moves; the digest rotates with the added key.
    // Reserve evidence expiry now separates a 365-day classification review
    // from a 31-day composition window plus seven-day reporting grace. These
    // score-bearing gate names and values rotate the semantic digest.
    // 2026-08-24 chain-maturity adjudication: matureChains is derived from the
    // dated five-gate registry and adds cardano, conflux, gnosis, hedera,
    // klaytn (Kaia), rootstock, and sui. The digest rotates with that set.
    expect(V9_CANDIDATE_POLICY_V1.semanticDigest).toBe(
      "c10342b0d35780de7f9d5fa571443db683505e5a4da1b54ee64b869623c0a1bc",
    );
    expect(getV9ScoreBearingGatesPolicy(V9_CANDIDATE_POLICY_V1)).toEqual(
      V9_SCORE_BEARING_GATES_POLICY_V923,
    );
    const cdpPolicy = V9_CANDIDATE_POLICY_V1.policy.semantic.backing.structural.cdp;
    expect(cdpPolicy.instantaneousCollateralShock).toBe(0.5);
    expect(cdpPolicy.minimumLiquidationCapacityRatio).toBe(0.5);
    expect(cdpPolicy.stressMeasurementFreshness).toMatchObject({
      maxAgeSec: 259_200,
      ratification: "owner-ratified",
    });
    expect(Object.isFrozen(V9_CANDIDATE_POLICY_V1.policy.semantic.formula)).toBe(true);
    expect(Object.isFrozen(getV9ScoreBearingGatesPolicy(V9_CANDIDATE_POLICY_V1).evidenceExpiry)).toBe(true);
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
    expect(V9_SCORE_BEARING_GATES_POLICY_V923.evidenceExpiry).toMatchObject({
      reviewedReserveClassificationMaxAgeSec: 365 * 86_400,
      reviewedReserveCompositionMaxAgeSec: 31 * 86_400,
      reviewedReserveCompositionGraceSec: 7 * 86_400,
    });
  });

  it("changes the semantic digest for every formerly external score-bearing gate family", () => {
    const loadChangedGates = (change: (gates: typeof V9_SCORE_BEARING_GATES_POLICY_V923) => void) => {
      const gates = structuredClone(V9_SCORE_BEARING_GATES_POLICY_V923);
      change(gates);
      return loadV9MethodologyPolicy(candidateClone(), gates).semanticDigest;
    };

    expect(loadChangedGates((gates) => { gates.withhold.maxScoreExclusive = 54; }))
      .not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
    expect(loadChangedGates((gates) => { gates.danger.fGatePegMultiplierFloor = 0.79; }))
      .not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
    expect(loadChangedGates((gates) => { gates.danger.dangerOnlyGrades = ["D", "F"]; }))
      .not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
    expect(loadChangedGates((gates) => { gates.control.materialBridgeHighShareThreshold = 0.24; }))
      .not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);

    for (const field of Object.keys(V9_SCORE_BEARING_GATES_POLICY_V923.evidenceExpiry) as
      (keyof typeof V9_SCORE_BEARING_GATES_POLICY_V923.evidenceExpiry)[]) {
      expect(loadChangedGates((gates) => { gates.evidenceExpiry[field] += 1; }), field)
        .not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
    }
  });

  it("pins the 9.32 mint posture ladder keys and rotates the digest when they move", () => {
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

    const bumpedUnknownRecon = candidateClone();
    bumpedUnknownRecon.semantic.control.mintPostureQuality["unbounded-reconciliation-unknown"] = 36;
    expect(loadV9MethodologyPolicy(bumpedUnknownRecon).semanticDigest).not.toBe(
      V9_CANDIDATE_POLICY_V1.semanticDigest,
    );
    const bumpedCollateral = candidateClone();
    bumpedCollateral.semantic.control.mintPostureQuality["collateral-gated"] = 51;
    expect(loadV9MethodologyPolicy(bumpedCollateral).semanticDigest).not.toBe(
      V9_CANDIDATE_POLICY_V1.semanticDigest,
    );
    const bumpedCeiling = candidateClone();
    bumpedCeiling.semantic.control.mintPostureGrading.adverseSeasonedCreditCeiling = 40;
    expect(loadV9MethodologyPolicy(bumpedCeiling).semanticDigest).not.toBe(
      V9_CANDIDATE_POLICY_V1.semanticDigest,
    );
  });

  it("lets policy-only replay change a danger gate without editing production scoring", () => {
    const gates = structuredClone(V9_SCORE_BEARING_GATES_POLICY_V923);
    gates.danger.withholdPegMultiplierFloor = 0.84;
    const policy = loadV9MethodologyPolicy(candidateClone(), gates);
    expect(getV9ScoreBearingGatesPolicy(policy).danger.withholdPegMultiplierFloor).toBe(0.84);
    expect(policy.semanticDigest).not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
  });

  it("keeps a gate policy version relabel digest-neutral", () => {
    const gates = structuredClone(V9_SCORE_BEARING_GATES_POLICY_V923);
    gates.methodologyVersion = "9.22";
    expect(loadV9MethodologyPolicy(candidateClone(), gates).semanticDigest)
      .toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
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
    relabeled.policyId = "safety-score-v9";
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
