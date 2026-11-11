import { describe, expect, it } from "vitest";
import candidatePolicyAsset from "../../data/safety-score-v9/methodology-policy-candidate-v1.json";
import type { V9MethodologyPolicy, V9QualityPillar } from "../../types/safety-score-v9";
import type { V9FactGapV3, V9AssetFactsV3, V9DeploymentControlFactV2, V9FactStatusV2 } from "../../types/safety-score-v9-facts";
import {
  V9OpenEvidenceByCardSchema,
  V9OpenEvidenceSchema,
  type V9OpenEvidence,
  type V9OpenEvidenceByCard,
} from "../../types/safety-score-v9-open-evidence";
import {
  documentationGapIds,
  type V9DocumentationAssetFacts,
  type V9DocumentationPillarWitness,
} from "../safety-score-v9/documentation";
import { createV9FactStatus, requiredV9Applicability } from "../safety-score-v9/evidence";
import { evaluateV9FactSet, type V9EvaluatedSet } from "../safety-score-v9/evaluate-set";
import { countV9OpenEvidence } from "../safety-score-v9/open-questions";
import { loadV9MethodologyPolicy, V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import {
  buildV9DocumentationCarriers,
  collectV9DocumentationGapIds,
  type V9DocumentationCarrierCard,
} from "../safety-score-v9/public";
import { createV9FactGapV3 } from "../safety-score-v9/reasons";
import { scoreV9EvaluatedAsset, type V9ProductionScoreTrace } from "../safety-score-v9/score";
import {
  compileNativeV3FactSet,
  compileV9FactSetV3,
  coreFixture,
  stableJsonStringifyV1,
} from "./safety-score-v9-facts.fixture-support";
import { makeV9Pillar, makeV9ProductionScoreInput } from "./safety-score-v9-score.test-support";

const PILLARS = ["backing", "exit", "control"] as const;

function policyWithoutDocumentationClass() {
  const raw = structuredClone(candidatePolicyAsset) as unknown as V9MethodologyPolicy;
  delete raw.semantic.evidence.documentation;
  return loadV9MethodologyPolicy(raw);
}

function custodyGap() {
  return createV9FactGapV3({
    gapId: "alpha:gap:economic-control:mint:keyCustody",
    reasonCode: "unresolved-control-identity",
    ownerDomain: "control",
    policyRuleId: "control.mint.review",
    observationState: "bounded-unknown",
    responsibility: "unresearched",
    path: { kind: "local-component", componentKey: "economic-control:mint" },
    causeScope: {
      pillar: "control",
      componentKey: "economic-control:mint",
      factorKey: "keyCustody",
      routeKey: null,
      exposureId: null,
      requiredDatum: "economic-control:mint",
    },
    message: "Fixture custody question has no scoring reader.",
  });
}

/** The writable part of a compiled fact set used to author a variant before sealing. */
interface MutableFactSetCore {
  assets: Array<{
    assetId: string;
    gaps: V9FactGapV3[];
    economicControlReview: { mint: { status: V9FactStatusV2; [key: string]: unknown }; [key: string]: unknown };
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/** Alpha with one mint-aggregate gap whose cause scope is custody (3a: no scoring reader). */
function fixtureWithDocumentationWitness() {
  const base = compileNativeV3FactSet(coreFixture());
  // Compiled fact sets are sealed; author the variant before the final compile.
  const { v9FactSetDigest: _digest, ...core } = JSON.parse(JSON.stringify(base)) as MutableFactSetCore;
  const alpha = core.assets.find((asset) => asset.assetId === "alpha")!;
  const gap = custodyGap();
  alpha.gaps.push(gap);
  alpha.economicControlReview.mint.status = createV9FactStatus({
    applicability: requiredV9Applicability("control.mint.review"),
    observationState: "bounded-unknown",
    evidenceRefIds: ["evidence:base"],
    gapIds: [gap.gapId],
  });
  const compiled = compileV9FactSetV3(core);
  return {
    compiled,
    asset: compiled.assets.find((asset) => asset.assetId === "alpha") as V9DocumentationAssetFacts,
    gap,
  };
}

/**
 * Everything a documentation carrier must never touch: pillar witnesses, the
 * scoring trace and dependent inputs. Policy identity is excluded by design —
 * removing the policy block moves the semantic digest, never a score.
 */
function evaluatedProjection(result: Readonly<V9EvaluatedSet>) {
  return result.assets.map((asset) => ({
    assetId: asset.assetId,
    pillars: PILLARS.map((pillar) => asset.scoreInput.pillars[pillar]),
    trace: scoringProjection(asset.trace),
    dependencyInputs: asset.dependencyInputs,
  }));
}

function scoringProjection(trace: V9ProductionScoreTrace) {
  const { policyId: _policyId, policyDigest: _policyDigest, ...rest } = trace;
  return rest;
}

describe("Safety Score v9 documentation class — fail-closed card annotation", () => {
  const { compiled, asset, gap } = fixtureWithDocumentationWitness();
  const nonDocumentationGap = createV9FactGapV3({
    gapId: "alpha:gap:bridge-materiality",
    reasonCode: "missing-bridge-routes",
    ownerDomain: "control",
    policyRuleId: "bridge.materiality",
    observationState: "missing",
    responsibility: "unresearched",
    path: { kind: "local-component", componentKey: "bridge-materiality:alpha" },
    message: "Fixture bridge-materiality question stays required.",
  });
  const unresolvedId = "gamma:gap:no-such-gap";
  const inheritedGap = createV9FactGapV3({
    gapId: "beta:gap:inherited-custody",
    reasonCode: "unresolved-control-identity",
    ownerDomain: "control",
    policyRuleId: "control.beta.review",
    observationState: "bounded-unknown",
    responsibility: "unresearched",
    path: { kind: "local-component", componentKey: "control:beta" },
    causeScope: {
      pillar: "control",
      componentKey: "control:beta",
      factorKey: "keyCustody",
      routeKey: null,
      exposureId: null,
      requiredDatum: "control.beta.review",
    },
    message: "Fixture inherited custody question has no scoring reader.",
  });
  const facts: V9DocumentationAssetFacts = {
    ...asset,
    gaps: [...asset.gaps, nonDocumentationGap],
  };
  const betaFacts: V9DocumentationAssetFacts = {
    ...(compiled.assets.find((row) => row.assetId === "beta") as V9DocumentationAssetFacts),
    gaps: [...compiled.assets.find((row) => row.assetId === "beta")!.gaps, inheritedGap],
  };
  const gapIds = collectV9DocumentationGapIds(V9_CANDIDATE_POLICY_V1, [facts, betaFacts]);
  const openEvidence = countV9OpenEvidence({
    assets: [...compiled.assets, betaFacts],
    evaluated: evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets,
    isDocumentationGap: (candidate) => gapIds.get(candidate.gapId)?.reason ?? null,
  });

  function witnesses(
    entries: ReadonlyArray<readonly [V9QualityPillar, V9DocumentationPillarWitness["evidenceLevel"], readonly string[]]>,
  ): V9DocumentationPillarWitness[] {
    return entries.map(([pillar, evidenceLevel, limitingCauseGapIds]) => ({
      pillar, evidenceLevel, limitingCauseGapIds,
    }));
  }

  /** The published card annotation DOC-3 derives from the unchanged witnesses. */
  function publishedAnnotation(pillars: readonly V9DocumentationPillarWitness[]): V9OpenEvidenceByCard {
    const carriers = buildV9DocumentationCarriers({
      envelope: V9_CANDIDATE_POLICY_V1,
      gapIds,
      cards: [{ assetId: facts.assetId, localDocumentationGapIds: new Set(collectV9DocumentationGapIds(V9_CANDIDATE_POLICY_V1, [facts]).keys()), pillars }],
      openEvidence,
    });
    return carriers.openEvidence.byCard.find((entry) => entry.id === facts.assetId)!;
  }

  it("classifies the fixture witness as documentation and not the bridge-materiality gap", () => {
    expect(gapIds.get(gap.gapId)?.reason).toBe("no-scoring-path");
    expect(gapIds.has(nonDocumentationGap.gapId)).toBe(false);
    expect(gapIds.get(inheritedGap.gapId)?.reason).toBe("no-scoring-path");
    expect(compiled.assets.find((row) => row.assetId === "alpha")!.gaps.some((row) => row.gapId === gap.gapId)).toBe(true);
  });

  it("lists a limited pillar whose every local witness is documentation", () => {
    const card = publishedAnnotation(witnesses([["control", "limited", [gap.gapId]]]));
    expect(card.documentationOnlyLimited).toEqual(["control"]);
    expect(V9OpenEvidenceByCardSchema.parse(card)).toEqual(card);
  });

  it("lists a limited pillar whose every witness is documentation inherited via foreignCauseGaps", () => {
    const card = publishedAnnotation(witnesses([["exit", "limited", [inheritedGap.gapId]]]));
    expect(card.documentationOnlyLimited).toEqual(["exit"]);
  });

  it("never lists a pillar with one non-documentation witness", () => {
    expect(publishedAnnotation(witnesses([
      ["control", "limited", [gap.gapId, nonDocumentationGap.gapId]],
    ])).documentationOnlyLimited).toBeUndefined();
  });

  it("never lists the arcusdc-galaxy Exit shape: limited with an empty limitingCauseGapIds list", () => {
    expect(publishedAnnotation(witnesses([["exit", "limited", []]])).documentationOnlyLimited).toBeUndefined();
  });

  it("never falls back to causeGapIds when limitingCauseGapIds is absent", () => {
    const limitedOnlyByCauses: V9DocumentationPillarWitness = {
      ...makeV9Pillar(70, {
        evidenceLevel: "limited",
        limitedEvidenceCauses: ["U"],
        causeGapIds: [gap.gapId],
      }),
      pillar: "control",
    };
    expect(publishedAnnotation([limitedOnlyByCauses]).documentationOnlyLimited).toBeUndefined();
  });

  it("never lists a witness that resolves to no local or foreign gap", () => {
    expect(publishedAnnotation(witnesses([["backing", "limited", [unresolvedId]]]))
      .documentationOnlyLimited).toBeUndefined();
  });

  it("never lists a mix of documentation and unresolved ids", () => {
    expect(publishedAnnotation(witnesses([
      ["control", "limited", [gap.gapId, unresolvedId]],
    ])).documentationOnlyLimited).toBeUndefined();
  });

  it("never lists a non-limited pillar", () => {
    for (const evidenceLevel of ["strong", "adequate", "insufficient"] as const) {
      expect(publishedAnnotation(witnesses([["control", evidenceLevel, [gap.gapId]]]))
        .documentationOnlyLimited).toBeUndefined();
    }
  });

  it("publishes only resolvable documentation ids and no empty annotation", () => {
    const carriers = buildV9DocumentationCarriers({
      envelope: V9_CANDIDATE_POLICY_V1,
      gapIds,
      cards: [{ assetId: facts.assetId, localDocumentationGapIds: new Set(collectV9DocumentationGapIds(V9_CANDIDATE_POLICY_V1, [facts]).keys()), pillars: witnesses([["exit", "limited", []]]) }],
      openEvidence,
    });
    expect(carriers.causeGapIds).toEqual([...new Set([gap.gapId, inheritedGap.gapId])].sort());
    expect(carriers.documentationOnlyLimited.size).toBe(0);
    expect(carriers.openEvidence.byCard.every((entry) => entry.documentationOnlyLimited === undefined)).toBe(true);
  });
});

describe("Safety Score v9 documentation class — scoring invariants", () => {
  const on = V9_CANDIDATE_POLICY_V1;
  const off = policyWithoutDocumentationClass();

  it("keeps the class real in the on run and absent in the off run", () => {
    const { asset, gap } = fixtureWithDocumentationWitness();
    expect(documentationGapIds(on, asset).get(gap.gapId)?.reason).toBe("no-scoring-path");
    expect(documentationGapIds(off, asset).size).toBe(0);
  });

  it("leaves evidence level, causes, witnesses, dependents, scores and grades byte-identical", () => {
    const { compiled, asset, gap } = fixtureWithDocumentationWitness();
    const withClass = evaluateV9FactSet(compiled, on);
    const withoutClass = evaluateV9FactSet(compiled, off);

    expect(evaluatedProjection(withClass)).toEqual(evaluatedProjection(withoutClass));
    expect(stableJsonStringifyV1(evaluatedProjection(withClass)))
      .toBe(stableJsonStringifyV1(evaluatedProjection(withoutClass)));

    // The comparison is not vacuous: the witness is published and limited in both runs.
    const control = withClass.assets.find((row) => row.assetId === "alpha")!.scoreInput.pillars.control;
    expect(control.limitingCauseGapIds).toContain(gap.gapId);
    expect(control.limitedEvidenceCauses.length).toBeGreaterThan(0);
    expect(control.evidenceLevel).toBe("limited");
    expect(documentationGapIds(on, asset).get(gap.gapId)?.reason).toBe("no-scoring-path");
  });

  it("keeps dependents' propagated cause and boundedUnknown byte-identical", () => {
    const { compiled } = fixtureWithDocumentationWitness();
    const withClass = evaluateV9FactSet(compiled, on);
    const withoutClass = evaluateV9FactSet(compiled, off);

    const dependents = (result: Readonly<V9EvaluatedSet>) => result.assets
      .map((row) => ({ assetId: row.assetId, dependencyInputs: row.dependencyInputs }))
      .sort((left, right) => left.assetId.localeCompare(right.assetId));
    expect(stableJsonStringifyV1(dependents(withClass))).toBe(stableJsonStringifyV1(dependents(withoutClass)));

    const alpha = withClass.assets.find((row) => row.assetId === "alpha")!;
    const roleInputs = alpha.dependencyInputs.roleInputs ?? [];
    expect(alpha.dependencyInputs.basket.length).toBeGreaterThan(0);
    expect(roleInputs.length).toBeGreaterThan(0);
    expect(roleInputs.every((row) => typeof row.boundedUnknown === "boolean")).toBe(true);
  });

  it("keeps the premium decision byte-identical when the only limited witness is documentation", () => {
    const raw = structuredClone(candidatePolicyAsset) as unknown as V9MethodologyPolicy;
    raw.semantic.formula.assetPremiums = [{
      assetId: "premium-fixture",
      kind: "market-anchor-longevity",
      label: "Fixture premium",
      points: 12,
      maximumPublishedScore: 87,
      minimumTrackRecordMonths: 120,
      requiredMarketRank: 1,
      minimumExitScore: 70,
      requiredEvidenceLevel: "adequate",
    }];
    const premiumOn = loadV9MethodologyPolicy(raw);
    delete raw.semantic.evidence.documentation;
    const premiumOff = loadV9MethodologyPolicy(raw);

    const { gap } = fixtureWithDocumentationWitness();
    const eligible = (overrides: Parameters<typeof makeV9ProductionScoreInput>[0]) => makeV9ProductionScoreInput({
      assetId: "premium-fixture",
      marketRank: 1,
      trackRecordMonths: 120,
      pillars: {
        backing: makeV9Pillar(80, { evidenceLevel: "adequate" }),
        exit: makeV9Pillar(80, { evidenceLevel: "adequate" }),
        control: makeV9Pillar(80, {
          evidenceLevel: "limited",
          limitedEvidenceCauses: ["U"],
          limitingCauseGapIds: [gap.gapId],
        }),
      },
      ...overrides,
    });

    const on = scoreV9EvaluatedAsset(eligible({}), premiumOn);
    const off = scoreV9EvaluatedAsset(eligible({}), premiumOff);
    expect(stableJsonStringifyV1(scoringProjection(on))).toBe(stableJsonStringifyV1(scoringProjection(off)));
    expect(on.scoreAdjustments).toEqual([]);
    expect(on.finalScore).toBe(off.finalScore);
    expect(on.finalGrade).toBe(off.finalGrade);

    // Control: the same fixture with an adequate witness set stays premium-eligible.
    const granted = (policy: typeof premiumOn) => scoreV9EvaluatedAsset(eligible({
      pillars: {
        backing: makeV9Pillar(80, { evidenceLevel: "adequate" }),
        exit: makeV9Pillar(80, { evidenceLevel: "adequate" }),
        control: makeV9Pillar(80, { evidenceLevel: "adequate" }),
      },
    }), policy);
    const grantedOn = granted(premiumOn);
    const grantedOff = granted(premiumOff);
    expect(grantedOn.scoreAdjustments).toEqual([
      expect.objectContaining({ source: "asset-premium", label: "Fixture premium" }),
    ]);
    expect(stableJsonStringifyV1(scoringProjection(grantedOn)))
      .toBe(stableJsonStringifyV1(scoringProjection(grantedOff)));
    expect(grantedOn.finalScore).toBe(grantedOff.finalScore);
    expect(grantedOn.finalGrade).toBe(grantedOff.finalGrade);
  });
});

describe("Safety Score v9 documentation carriers — whole-block publication", () => {
  const compiled = compileNativeV3FactSet(coreFixture());
  const baseFacts = compiled.assets.find((entry) => entry.assetId === "alpha") as V9AssetFactsV3;
  const baseControl = baseFacts.controls[0]!;

  function datum(assetId: string, controlKey: string, factorKey: string): V9FactGapV3 {
    const componentKey = `control:${controlKey}`;
    return createV9FactGapV3({
      gapId: `${assetId}:gap:${componentKey}:${factorKey}`,
      reasonCode: "unresolved-control-identity",
      ownerDomain: "control",
      policyRuleId: `${assetId}:${componentKey}:${factorKey}`,
      observationState: "missing",
      path: { kind: "local-component", componentKey },
      message: "Fixture documentation datum.",
      causeProof: { cause: "U", reason: "not-yet-researched", evidenceRefIds: [] },
      responsibility: "unresearched",
      causeScope: {
        pillar: "control", componentKey, factorKey, routeKey: null, exposureId: null, requiredDatum: componentKey,
      },
    });
  }

  function control(controlKey: string, materialSupplyShare: number | null): V9DeploymentControlFactV2 {
    return {
      ...baseControl,
      controlKey,
      deploymentKey: "ethereum",
      scope: "deployment",
      controlKind: "bridge",
      economicLossScope: "deployment",
      claimImpairment: "bounded",
      materialSupplyShare,
    };
  }

  function assetFacts(assetId: string, controls: V9DeploymentControlFactV2[], gaps: V9FactGapV3[]): V9DocumentationAssetFacts {
    return {
      assetId,
      archetype: baseFacts.archetype,
      controlStatus: baseFacts.controlStatus,
      controls,
      gaps,
      supply: baseFacts.supply,
      economicControlReview: baseFacts.economicControlReview,
      reserveExposures: [],
      exitRoutes: [],
    };
  }

  function witness(
    pillar: V9DocumentationPillarWitness["pillar"],
    evidenceLevel: V9DocumentationPillarWitness["evidenceLevel"],
    limitingCauseGapIds?: readonly string[],
  ): V9DocumentationPillarWitness {
    return { pillar, evidenceLevel, ...(limitingCauseGapIds === undefined ? {} : { limitingCauseGapIds }) };
  }

  function evidence(byCard: V9OpenEvidence["byCard"]): V9OpenEvidence {
    const questions = byCard.reduce((sum, entry) => sum + entry.openBucketQuestionsCarried, 0);
    return {
      semantics: "open-question-v1",
      totals: { questions, open: questions, issuer: 0, documentation: 0, obligations: questions },
      owners: questions === 0 ? [] : [{ responsibility: "unresearched", questions, obligations: questions }],
      reasons: [],
      documentation: { questions: 0, datums: 0, facts: 0, reasons: [] },
      issuer: { questions: 0, assets: 0, oldestReviewedAtSec: null, newestReviewedAtSec: null },
      byCard,
    };
  }

  function card(id: string, openQuestions: number): V9OpenEvidence["byCard"][number] {
    return {
      id,
      openBucketQuestionsCarried: openQuestions,
      inheritedOpenBucketQuestionsCarried: 0,
      openBucketObligationsCarried: openQuestions,
      documentationObligationsCarried: 0,
    };
  }

  const smallDatum = datum("alpha", "bridge-meta:small", "incidentState");
  const largeDatum = datum("alpha", "bridge-meta:large", "incidentState");
  const alpha = assetFacts("alpha", [
    control("bridge-meta:small", 0.005),
    control("bridge-meta:large", 0.02),
  ], [smallDatum, largeDatum]);
  const betaDatum = datum("beta", "bridge-meta:small", "incidentState");
  const beta = assetFacts("beta", [control("bridge-meta:small", 0.005)], [betaDatum]);
  const gamma = assetFacts("gamma", [], []);

  function classifiedCard(asset: V9DocumentationAssetFacts) {
    return {
      assetId: asset.assetId,
      localDocumentationGapIds: new Set(collectV9DocumentationGapIds(V9_CANDIDATE_POLICY_V1, [asset]).keys()),
    };
  }

  it("annotates only documentation-only limited pillars and leaves the rest of the block untouched", () => {
    const gapIds = collectV9DocumentationGapIds(V9_CANDIDATE_POLICY_V1, [alpha, beta]);
    expect([...gapIds.keys()].sort()).toEqual([smallDatum.gapId, betaDatum.gapId].sort());

    const block = evidence([card("alpha", 1), card("beta", 1), card("gamma", 0)]);
    const cards: V9DocumentationCarrierCard[] = [
      {
        ...classifiedCard(alpha),
        pillars: [
          witness("backing", "strong", [smallDatum.gapId]),
          witness("control", "limited", [smallDatum.gapId]),
          witness("exit", "limited", []),
        ],
      },
      { ...classifiedCard(beta), pillars: [witness("control", "limited", [betaDatum.gapId])] },
      { ...classifiedCard(gamma), pillars: [witness("backing", "limited", [])] },
    ];
    const carriers = buildV9DocumentationCarriers({ envelope: V9_CANDIDATE_POLICY_V1, gapIds, cards, openEvidence: block });

    expect(carriers.documentationOnlyLimited.get("alpha")).toEqual(["control"]);
    expect(carriers.documentationOnlyLimited.get("beta")).toEqual(["control"]);
    expect(carriers.documentationOnlyLimited.has("gamma")).toBe(false);
    expect(carriers.causeGapIds).toEqual([smallDatum.gapId, betaDatum.gapId].sort());
    expect(carriers.openEvidence.byCard).toEqual([
      { ...block.byCard[0]!, documentationOnlyLimited: ["control"] },
      { ...block.byCard[1]!, documentationOnlyLimited: ["control"] },
      block.byCard[2],
    ]);
    expect(V9OpenEvidenceSchema.safeParse(carriers.openEvidence).success).toBe(true);
    // The source block is never mutated.
    expect(block.byCard[0]!.documentationOnlyLimited).toBeUndefined();
  });

  it("publishes only the union it was given and still resolves local witnesses on the card", () => {
    const localOnly = buildV9DocumentationCarriers({
      envelope: V9_CANDIDATE_POLICY_V1,
      gapIds: new Map(),
      cards: [{ ...classifiedCard(alpha), pillars: [witness("control", "limited", [smallDatum.gapId])] }],
      openEvidence: evidence([card("alpha", 1)]),
    });
    expect(localOnly.causeGapIds).toEqual([]);
    expect(localOnly.documentationOnlyLimited.get("alpha")).toEqual(["control"]);

    const undocumented = buildV9DocumentationCarriers({
      envelope: V9_CANDIDATE_POLICY_V1,
      gapIds: new Map(),
      cards: [{ ...classifiedCard(alpha), pillars: [witness("control", "limited", [largeDatum.gapId])] }],
      openEvidence: evidence([card("alpha", 1)]),
    });
    expect(undocumented.documentationOnlyLimited.size).toBe(0);

    const absent = buildV9DocumentationCarriers({
      envelope: V9_CANDIDATE_POLICY_V1,
      gapIds: collectV9DocumentationGapIds(V9_CANDIDATE_POLICY_V1, [alpha]),
      cards: [{ ...classifiedCard(alpha), pillars: [witness("control", "limited", [smallDatum.gapId])] }],
      openEvidence: evidence([]),
    });
    expect(absent.documentationOnlyLimited.get("alpha")).toEqual(["control"]);
    expect(absent.openEvidence.byCard).toEqual([]);
  });
});
