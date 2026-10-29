import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import candidatePolicyAsset from "@shared/data/safety-score-v9/methodology-policy-candidate-v1.json";
import {
  CompiledV9AssetInputSchema,
  V9_REASON_CODES,
  V9UnresolvedFactSchema,
  type V9DocumentationPolicy,
  type V9MethodologyPolicy,
} from "@shared/types/safety-score-v9";
import {
  V9_CANDIDATE_POLICY_V1,
  assertV9ReasonCodesRegistered,
  assertV9UnresolvedFactsMatchPolicy,
  assertV9ValidatedPolicyEnvelope,
  loadV9MethodologyPolicy,
  resolveV9ReasonTreatment,
  unknownQuality,
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
  it.each(["transfer", "freezeExposure", "primaryExit", "governance"] as const)(
    "requires every canonical %s access value once without changing valid policy identity",
    (field) => {
      const duplicate = candidateClone();
      const values = duplicate.semantic.accessPostureVocabulary[field];
      values[0] = values[values.length - 1]!;
      expect(() => loadV9MethodologyPolicy(duplicate)).toThrow();
      const incomplete = candidateClone();
      incomplete.semantic.accessPostureVocabulary[field].pop();
      expect(() => loadV9MethodologyPolicy(incomplete)).toThrow();
      const reordered = candidateClone();
      reordered.semantic.accessPostureVocabulary[field].reverse();
      expect(loadV9MethodologyPolicy(reordered).semanticDigest).toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
    },
  );
  it("requires and semantically binds the fractional native-inventory dust limit", () => {
    expect(V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.nativeInventoryUnmatchedDustShareMax).toBe(1e-5);
    const changed = candidateClone();
    changed.semantic.materiality.nativeInventoryUnmatchedDustShareMax = 2e-5;
    const loaded = loadV9MethodologyPolicy(changed);
    expect(loaded.policy.semantic.materiality.nativeInventoryUnmatchedDustShareMax).toBe(2e-5);
    expect(loaded.semanticDigest).not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
    for (const invalid of [-1e-5, 1.00001, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const policy = candidateClone();
      const raw = { ...policy, semantic: { ...policy.semantic, materiality: {
        ...policy.semantic.materiality, nativeInventoryUnmatchedDustShareMax: invalid,
      } } };
      expect(() => loadV9MethodologyPolicy(raw)).toThrow();
    }
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

  it("validates and digests the published residual de-minimis share independently", () => {
    const changed = candidateClone();
    changed.semantic.backing.reserve.publishedResidualDeMinimisMaxShare = 0.1;
    expect(loadV9MethodologyPolicy(changed).semanticDigest).not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
    expect(changed.semantic.backing.structural.materialExposureShare)
      .toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.backing.structural.materialExposureShare);
    for (const invalid of [-0.001, 1.001, Number.NaN, Number.POSITIVE_INFINITY]) {
      const policy = candidateClone();
      policy.semantic.backing.reserve.publishedResidualDeMinimisMaxShare = invalid;
      expect(() => loadV9MethodologyPolicy(policy)).toThrow();
    }
  });

  it("validates and digests the halted-chain stall budget", () => {
    const changed = candidateClone();
    changed.semantic.materiality.haltedChainMinStallSec += 1;
    expect(loadV9MethodologyPolicy(changed).semanticDigest).not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
    for (const invalid of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const policy = candidateClone();
      policy.semantic.materiality.haltedChainMinStallSec = invalid;
      expect(() => loadV9MethodologyPolicy(policy)).toThrow();
    }
  });

  it("walks every registered reason/cause with no hidden removed ceiling or missing-data NR", () => {
    for (const reason of V9_CANDIDATE_POLICY_V1.policy.reasonRegistry) {
      for (const cause of ["A", "B", "C", "U"] satisfies V9EvidenceCause[]) {
        const treatment = resolveV9ReasonTreatment(V9_CANDIDATE_POLICY_V1, reason.code, cause);
        expect(treatment.critical, `${reason.code}:${cause}`).toBe(false);
        expect(treatment.treatment, `${reason.code}:${cause}`).not.toBe("NR");
        if (cause === "A" || cause === "B") {
          expect(treatment.treatment).toBe("diagnostic");
          expect(treatment.scoringDisposition).toBe(cause === "A" ? "excluded-pipeline" : "excluded-uncurated");
        }
      }
    }
  });

  it("validates each moved score-bearing gate in its owning semantic domain", () => {
    const invalidEvidenceExpiry = candidateClone();
    invalidEvidenceExpiry.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec = 0;
    expect(() => loadV9MethodologyPolicy(invalidEvidenceExpiry)).toThrow();

    const invalidBridgeThreshold = candidateClone();
    invalidBridgeThreshold.semantic.control.materialBridgeHighShareThreshold = 1.01;
    expect(() => loadV9MethodologyPolicy(invalidBridgeThreshold)).toThrow();
  });

  it.each([
    { minUnavoidableDelaySec: 0, admissibleVotingPower: ["lock-escrowed"] },
    { minUnavoidableDelaySec: 172800.5, admissibleVotingPower: ["lock-escrowed"] },
    { minUnavoidableDelaySec: 172800, admissibleVotingPower: ["live-balance"] },
    { minUnavoidableDelaySec: 172800, admissibleVotingPower: [] },
    { minUnavoidableDelaySec: 172800, admissibleVotingPower: ["lock-escrowed"], bypass: true },
  ])("rejects inadmissible governed issuance policy %j", (governedIssuance) => {
    const policy = candidateClone();
    expect(() => loadV9MethodologyPolicy({
      ...policy,
      semantic: { ...policy.semantic, control: { ...policy.semantic.control, governedIssuance: { ...policy.semantic.control.governedIssuance, ...governedIssuance } } },
    })).toThrow();
  });

  it.each([
    { minVetoWindowSec: 0 }, { minVetoWindowSec: -1 }, { minVetoWindowSec: 1209600.5 },
    { maxVetoQuorumBps: 0 }, { maxVetoQuorumBps: 10001 }, { maxVetoQuorumBps: 200.5 },
    { admissibleVotingPower: [] }, { admissibleVotingPower: ["live-balance"] }, { admissibleVotingPower: ["unknown"] },
    { admissibleOverride: [] }, { admissibleOverride: ["unknown"] }, { admissibleOverride: ["majority"] },
    { restructureMinEquityMultiple: 0 }, { restructureMinEquityMultiple: -1 }, { restructureMinEquityMultiple: 1.5 },
    { bypass: true },
  ])("rejects inadmissible minority veto policy %j", (change) => {
    const policy = candidateClone();
    const governed = policy.semantic.control.governedIssuance;
    expect(() => loadV9MethodologyPolicy({
      ...policy,
      semantic: { ...policy.semantic, control: { ...policy.semantic.control, governedIssuance: {
        ...governed, minorityVeto: { ...governed.minorityVeto, ...change },
      } } },
    })).toThrow();
  });

  it.each([
    { minRateChangeDelaySec: -1 }, { minRateChangeDelaySec: 172800.5 },
    { admissibleRateChangeRules: [] }, { admissibleRateChangeRules: ["unrestricted"] },
    { admissibleRateChangeRules: ["unknown"] }, { bypass: true },
  ])("rejects inadmissible monetary-policy gates %j", (change) => {
    const policy = candidateClone();
    const veto = policy.semantic.control.governedIssuance.minorityVeto;
    expect(() => loadV9MethodologyPolicy({
      ...policy,
      semantic: { ...policy.semantic, control: { ...policy.semantic.control, governedIssuance: {
        ...policy.semantic.control.governedIssuance,
        minorityVeto: { ...veto, monetaryPolicy: { ...veto.monetaryPolicy, ...change } },
      } } },
    })).toThrow();
  });

  const semanticMutations: [string, (policy: V9MethodologyPolicy) => void][] = [
    ["unknown Backing research", (policy) => { policy.semantic.unknownQuality.backing.U = 51; }],
    ["holder loss recovery", (policy) => { policy.semantic.formula.realizedHolderLoss.recoveryDays += 1; }],
    ["bridge materiality", (policy) => { policy.semantic.control.materialBridgeHighShareThreshold = 0.24; }],
    ["authority economic bound", (policy) => { policy.semantic.control.authorityLadder.economicBoundCredit = 11; }],
    ["governed issuance delay", (policy) => { policy.semantic.control.governedIssuance.minUnavoidableDelaySec += 1; }],
    ["governed issuance voting power", (policy) => { policy.semantic.control.governedIssuance.admissibleVotingPower = ["lock-escrowed"]; }],
    ["authority quorum", (policy) => { policy.semantic.control.authorityLadder.quorum = 66; }],
    ["veto window", (policy) => { policy.semantic.control.governedIssuance.minorityVeto.minVetoWindowSec += 1; }],
    ["veto quorum", (policy) => { policy.semantic.control.governedIssuance.minorityVeto.maxVetoQuorumBps += 1; }],
    ["veto voting power", (policy) => { policy.semantic.control.governedIssuance.minorityVeto.admissibleVotingPower = ["holding-period-weighted"]; }],
    ["veto override", (policy) => { policy.semantic.control.governedIssuance.minorityVeto.admissibleOverride = ["none"]; }],
    ["monetary-policy delay", (policy) => { policy.semantic.control.governedIssuance.minorityVeto.monetaryPolicy.minRateChangeDelaySec += 1; }],
    ["restructure equity margin", (policy) => { policy.semantic.control.governedIssuance.minorityVeto.restructureMinEquityMultiple += 1; }],
    ["bounded liquid age", (policy) => { policy.semantic.backing.reserve.boundedFacts.currentLiquidFractionMaxAgeSec += 1; }],
    ["bounded observed maturity quality", (policy) => { policy.semantic.backing.reserve.boundedFacts.observedMaturityQualityLevel = "weak"; }],
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

  it("keeps cause-keyed Backing and Control pricing but makes unknown Exit cause-neutral", () => {
    expect(V9_CANDIDATE_POLICY_V1.policy.semantic.unknownQuality).toEqual({
      backing: { C: 35, U: 50 },
      exit: { C: 50, U: 50 },
      control: { C: 50, U: 60 },
    });
    for (const pillar of ["backing", "exit", "control"] as const) {
      const invalid = candidateClone();
      invalid.semantic.unknownQuality[pillar].U = Number.NaN;
      expect(() => loadV9MethodologyPolicy(invalid)).toThrow();
    }
  });

  it.each(["backing", "exit", "control"] as const)(
    "prices an unknown %s factor consistently even when its status includes an adverse gap",
    (pillar) => {
      const quality = V9_CANDIDATE_POLICY_V1.policy.semantic.unknownQuality[pillar];
      expect(unknownQuality(pillar, "C")).toBe(quality.C);
      for (const cause of ["A", "B", "U", "D", null, undefined] as const) {
        expect(unknownQuality(pillar, cause)).toBe(quality.U);
      }
    },
  );

  it("admits a missing pillar without inventing critical unresolved evidence", () => {
    const unresolved = [{
      code: "missing-pillar-evidence" as const, reason: "No usable pillar evidence.",
      cause: "U" as const, critical: false, responsibility: "unresearched" as const,
    }];
    const schema = CompiledV9AssetInputSchema.shape.pillars.shape.backing;
    for (const facts of [[], unresolved]) {
      expect(schema.parse({ score: null, evidenceLevel: "insufficient", evidence: [], unresolved: facts }).score).toBeNull();
      expect(() => assertV9UnresolvedFactsMatchPolicy(V9_CANDIDATE_POLICY_V1, facts)).not.toThrow();
    }
    expect(() => schema.parse({ score: 80, evidenceLevel: "strong", evidence: [], unresolved: [] }))
      .toThrow(/at least one evidence reference/);
  });

  it("requires the active measured-compromise rung independently of unknown controller quality", () => {
    const policy = candidateClone();
    const ladder = policy.semantic.control.authorityLadder as Partial<typeof policy.semantic.control.authorityLadder>;
    delete ladder.compromised;
    expect(() => loadV9MethodologyPolicy(policy)).toThrow();
    expect(V9_CANDIDATE_POLICY_V1.policy.semantic.control.authorityLadder.compromised)
      .toBeLessThan(V9_CANDIDATE_POLICY_V1.policy.semantic.unknownQuality.control.C);
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
    reordered.semantic.control.governedIssuance.admissibleVotingPower.reverse();
    reordered.semantic.control.governedIssuance.minorityVeto.admissibleVotingPower.reverse();
    reordered.semantic.control.governedIssuance.minorityVeto.admissibleOverride.reverse();

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
    changed.semantic.backing.archetypes["shared-reserve"].allowCompleteLiveParentMechanismBypass = true;
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
    // Deliberately invalid: the schema pins the first ceiling band at 0 months.
    (trackBands.semantic.formula.trackRecordCeilings[0] as { minMonthsInclusive: number }).minMonthsInclusive = 1;
    expect(() => loadV9MethodologyPolicy(trackBands)).toThrow();

    const extraAgeTier = candidateClone();
    // Deliberately invalid: the schema admits exactly one ceiling band.
    (extraAgeTier.semantic.formula.trackRecordCeilings as unknown[]).push({
      minMonthsInclusive: 24,
      maxMonthsExclusive: 36,
      limit: 86,
      kind: "track-record:<36m",
      reason: "Removed age tier.",
    });
    expect(() => loadV9MethodologyPolicy(extraAgeTier)).toThrow();

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
      critical: false, treatment: "pillar",
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

  it("keeps exactly the five whole-score ceiling families", () => {
    expect(new Set(V9_CANDIDATE_POLICY_V1.policy.semantic.formula.capTiePriority)).toEqual(
      new Set(["active-depeg", "parent", "track-record", "realized-holder-loss", "speculative-credit"]),
    );
  });
});

describe("v10.05 operational governance policy", () => {
  it.each([
    "maxAnnualOperationalRatePpm", "maxKeeperProportionalRewardPpm",
    "maxKeeperFixedRewardSupplyPpm", "minKeeperRepeatSec",
  ] as const)("digests every mutable H screen %s", (field) => {
    const changed = candidateClone();
    changed.semantic.control.governedIssuance.operationalFlow[field]++;
    expect(loadV9MethodologyPolicy(changed).semanticDigest).not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
    const missing = candidateClone();
    const flow = missing.semantic.control.governedIssuance.operationalFlow as Partial<typeof missing.semantic.control.governedIssuance.operationalFlow>;
    delete flow[field];
    expect(() => loadV9MethodologyPolicy(missing)).toThrow();
  });

  it("pins operational evidence units without duplicate policy keys", () => {
    expect(V9_CANDIDATE_POLICY_V1.policy.releaseVersion).toBe(SAFETY_SCORE_METHODOLOGY_VERSION);
    for (const field of ["annualWindowSec", "keeperWindowSec", "requiresLifetimeBudget"] as const) {
      const changed = candidateClone();
      const flow = changed.semantic.control.governedIssuance.operationalFlow;
      Object.assign(flow, { [field]: field === "requiresLifetimeBudget" ? true : flow[field] + 1 });
      expect(() => loadV9MethodologyPolicy(changed)).toThrow();
    }
    const duplicate = candidateClone();
    Object.assign(duplicate.semantic.control.governedIssuance.operationalFlow, { maxAggregateKeeperRepeatRewardSupplyPpmPer86400Sec: 1000 });
    expect(() => loadV9MethodologyPolicy(duplicate)).toThrow();
  });

  it("accepts the annual-window exposure anchor equality and rejects one second above it", () => {
    const changed = candidateClone();
    const governed = changed.semantic.control.governedIssuance;
    governed.minUnavoidableDelaySec = governed.operationalFlow.annualWindowSec;
    expect(loadV9MethodologyPolicy(changed).policy.semantic.control.governedIssuance.minUnavoidableDelaySec)
      .toBe(governed.operationalFlow.annualWindowSec);
    governed.minUnavoidableDelaySec++;
    expect(() => loadV9MethodologyPolicy(changed)).toThrow();
  });

  it("canonicalizes doctrine lists but rejects any weakening or duplicate", () => {
    const reordered = candidateClone();
    const doctrine = reordered.semantic.control.governedIssuance.votingControl;
    doctrine.affiliatedKinds.reverse();
    doctrine.admissiblePrivilegedVoteCreation.reverse();
    doctrine.admissibleForcedDelegation.reverse();
    expect(loadV9MethodologyPolicy(reordered).semanticDigest).toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
    for (const field of Object.keys(doctrine)) {
      const missing = candidateClone();
      const altered = missing.semantic.control.governedIssuance.votingControl as Record<string, unknown>;
      delete altered[field];
      expect(() => loadV9MethodologyPolicy(missing)).toThrow();
    }
    for (const change of [
      { affiliatedKinds: ["issuer", "council"] }, { affiliatedKinds: ["issuer", "council", "team", "team"] },
      { admissiblePrivilegedVoteCreation: ["none", "independent"] }, { admissibleForcedDelegation: ["none"] },
      { maxAffiliatedUnilateralRouteCount: 1 }, { unknownBeneficialAffiliation: "deny" },
      { ownLockedVotesAboveThreshold: "deny" }, { otherHolderKeyVotesAboveThreshold: "admit" },
    ]) {
      const changed = candidateClone();
      Object.assign(changed.semantic.control.governedIssuance.votingControl, change);
      expect(() => loadV9MethodologyPolicy(changed)).toThrow();
    }
  });
});

function documentationFixture(): V9DocumentationPolicy {
  return {
    reasonOrder: [
      "no-scoring-path",
      "unknown-scores-as-no-credit",
      "unscored-diagnostic",
      "coverage-label",
      "immaterial-deployment",
      "reserve-dust",
    ],
    reasons: [
      {
        reason: "no-scoring-path",
        publicLabel: "Custody question outside the scoring path",
        retention: "stale-documentation",
        threshold: null,
      },
      {
        reason: "unknown-scores-as-no-credit",
        publicLabel: "Mint control credit already withheld",
        retention: "recompute-per-capture",
        threshold: null,
      },
      {
        reason: "unscored-diagnostic",
        publicLabel: "Diagnostic datum, not scored",
        retention: "recompute-per-capture",
        threshold: null,
      },
      {
        reason: "coverage-label",
        publicLabel: "DEX coverage label only",
        retention: "recompute-per-capture",
        threshold: null,
      },
      {
        reason: "immaterial-deployment",
        publicLabel: "Deployment share below the immaterial bar",
        retention: "recompute-per-capture",
        threshold: { kind: "known-share-pct", sharePctKey: "documentationImmaterialSharePct" },
      },
      {
        reason: "reserve-dust",
        publicLabel: "Reserve exposure below the dust bar",
        retention: "recompute-per-capture",
        threshold: { kind: "reserve-book-share", sharePctKey: "reserveDustBookSharePct" },
      },
    ],
    documentationImmaterialSharePct: 1,
    maxAttributableScorePoints: 0.1,
    reserveDustBookSharePct: 0.01,
    reserveDustResidualMaxBookSharePct: 0.1,
    retainExpiredScopedQuestions: true,
  };
}

function policyWithDocumentation(documentation: unknown): unknown {
  const policy = structuredClone(candidatePolicyAsset) as unknown as Record<string, unknown>;
  const semantic = policy.semantic as Record<string, unknown>;
  return {
    ...policy,
    semantic: {
      ...semantic,
      evidence: { ...(semantic.evidence as Record<string, unknown>), documentation },
    },
  };
}

describe("documentation-class policy", () => {
  it("stays optional for the counting train and binds an authored block into the digest", () => {
    expect(V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.documentation).toBeUndefined();
    const loaded = loadV9MethodologyPolicy(policyWithDocumentation(documentationFixture()));
    expect(loaded.policy.semantic.evidence.documentation).toEqual(documentationFixture());
    expect(loaded.semanticDigest).not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
  });

  it.each([
    ["precedence", (documentation: V9DocumentationPolicy) => {
      documentation.reasonOrder.reverse();
      documentation.reasons.reverse();
    }],
    ["public label", (documentation: V9DocumentationPolicy) => { documentation.reasons[0]!.publicLabel = "Renamed"; }],
    ["retention", (documentation: V9DocumentationPolicy) => { documentation.reasons[1]!.retention = "stale-documentation"; }],
    ["retention switch", (documentation: V9DocumentationPolicy) => {
      documentation.retainExpiredScopedQuestions = false;
      documentation.reasons[0]!.retention = "recompute-per-capture";
    }],
    ["immaterial share bar", (documentation: V9DocumentationPolicy) => { documentation.documentationImmaterialSharePct = 0.5; }],
    ["attributable points", (documentation: V9DocumentationPolicy) => { documentation.maxAttributableScorePoints = 0.2; }],
    ["reserve dust share", (documentation: V9DocumentationPolicy) => { documentation.reserveDustBookSharePct = 0.005; }],
    ["residual bar", (documentation: V9DocumentationPolicy) => { documentation.reserveDustResidualMaxBookSharePct = 0.2; }],
  ] as [string, (documentation: V9DocumentationPolicy) => void][])(
    "changes the semantic digest when the %s changes",
    (_name, change) => {
      const documentation = documentationFixture();
      change(documentation);
      const loaded = loadV9MethodologyPolicy(policyWithDocumentation(documentation));
      expect(loaded.semanticDigest).not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
      expect(loadV9MethodologyPolicy(policyWithDocumentation(documentationFixture())).semanticDigest)
        .not.toBe(loaded.semanticDigest);
    },
  );

  it("requires the exact reason vocabulary in precedence order", () => {
    const missing = documentationFixture();
    missing.reasons.pop();
    expect(() => loadV9MethodologyPolicy(policyWithDocumentation(missing))).toThrow(/cover the vocabulary/);

    const duplicated = documentationFixture();
    duplicated.reasons[5] = { ...duplicated.reasons[4]! };
    expect(() => loadV9MethodologyPolicy(policyWithDocumentation(duplicated))).toThrow(/cover the vocabulary/);

    const repeatedPrecedence = documentationFixture();
    repeatedPrecedence.reasonOrder[5] = repeatedPrecedence.reasonOrder[0]!;
    expect(() => loadV9MethodologyPolicy(policyWithDocumentation(repeatedPrecedence)))
      .toThrow(/precedence must list every reason/);

    const misordered = documentationFixture();
    [misordered.reasonOrder[0], misordered.reasonOrder[1]] =
      [misordered.reasonOrder[1]!, misordered.reasonOrder[0]!];
    expect(() => loadV9MethodologyPolicy(policyWithDocumentation(misordered))).toThrow(/listed in reasonOrder/);
  });

  it("fails closed on retention, threshold and bar incoherence", () => {
    const orphanRetention = documentationFixture();
    orphanRetention.retainExpiredScopedQuestions = false;
    expect(() => loadV9MethodologyPolicy(policyWithDocumentation(orphanRetention)))
      .toThrow(/retainExpiredScopedQuestions/);

    const missingThreshold = documentationFixture();
    missingThreshold.reasons[4]!.threshold = null;
    expect(() => loadV9MethodologyPolicy(policyWithDocumentation(missingThreshold)))
      .toThrow(/requires a declared share threshold/);

    const predicateThreshold = documentationFixture();
    predicateThreshold.reasons[0]!.threshold = {
      kind: "known-share-pct",
      sharePctKey: "documentationImmaterialSharePct",
    };
    expect(() => loadV9MethodologyPolicy(policyWithDocumentation(predicateThreshold)))
      .toThrow(/bounded by its predicate/);

    const mismatchedKey = documentationFixture();
    mismatchedKey.reasons[5]!.threshold = {
      kind: "known-share-pct",
      sharePctKey: "reserveDustBookSharePct",
    };
    expect(() => loadV9MethodologyPolicy(policyWithDocumentation(mismatchedKey)))
      .toThrow(/known-share-pct thresholds read documentationImmaterialSharePct/);

    const mergedBelowRow = documentationFixture();
    mergedBelowRow.reserveDustBookSharePct = documentationFixture().reserveDustResidualMaxBookSharePct;
    expect(() => loadV9MethodologyPolicy(policyWithDocumentation(mergedBelowRow)))
      .toThrow(/residual bar must exceed the per-row dust share/);

    const materialDocumentation = documentationFixture();
    materialDocumentation.documentationImmaterialSharePct =
      V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct;
    expect(() => loadV9MethodologyPolicy(policyWithDocumentation(materialDocumentation)))
      .toThrow(/strictly below the deployment materiality threshold/);
  });

  it("accepts values one step inside every configured bar", () => {
    const inside = documentationFixture();
    inside.documentationImmaterialSharePct =
      V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct - 0.01;
    inside.reserveDustBookSharePct = 0.0999;
    inside.maxAttributableScorePoints = 1;
    const loaded = loadV9MethodologyPolicy(policyWithDocumentation(inside));
    expect(loaded.policy.semantic.evidence.documentation?.reserveDustBookSharePct).toBe(0.0999);
  });

  it.each([
    "documentationImmaterialSharePct",
    "maxAttributableScorePoints",
    "reserveDustBookSharePct",
    "reserveDustResidualMaxBookSharePct",
  ] as const)("rejects non-positive or non-finite %s", (field) => {
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const documentation = documentationFixture();
      (documentation as unknown as Record<string, unknown>)[field] = invalid;
      expect(() => loadV9MethodologyPolicy(policyWithDocumentation(documentation))).toThrow();
    }
  });

  it("rejects a declared point bound above one point and open or extended blocks", () => {
    const excessiveBound = documentationFixture();
    excessiveBound.maxAttributableScorePoints = 1.01;
    expect(() => loadV9MethodologyPolicy(policyWithDocumentation(excessiveBound))).toThrow();

    const missingSwitch = documentationFixture() as Partial<V9DocumentationPolicy>;
    delete missingSwitch.retainExpiredScopedQuestions;
    expect(() => loadV9MethodologyPolicy(policyWithDocumentation(missingSwitch))).toThrow();

    const smuggledScoringKey = { ...documentationFixture(), scoringThreshold: 1 };
    expect(() => loadV9MethodologyPolicy(policyWithDocumentation(smuggledScoringKey))).toThrow();
  });
});
