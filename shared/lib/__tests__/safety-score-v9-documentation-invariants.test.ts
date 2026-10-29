import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import candidatePolicyAsset from "../../data/safety-score-v9/methodology-policy-candidate-v1.json";
import type { V9MethodologyPolicy, V9QualityPillar } from "../../types/safety-score-v9";
import type { V9FactGapV3, V9FactStatusV2 } from "../../types/safety-score-v9-facts";
import {
  V9OpenEvidenceByCardSchema,
  type V9OpenEvidenceByCard,
} from "../../types/safety-score-v9-public";
import { buildStablecoinSafetyScoreV9Presentation } from "@/lib/stablecoin-safety-score-v9-presentation";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
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
const DOCUMENTATION_ONLY_SUFFIX = "documentation gaps only";

/** The same policy with the documentation class switched off (block absent). */
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
      cards: [{ asset: facts, pillars }],
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

  it("renders 'documentation gaps only' for a listed pillar and keeps unlisted pillars plain limited", () => {
    const card = publishedAnnotation(witnesses([["control", "limited", [gap.gapId]]]));
    const source = makeV9Card();
    source.pillars.control.evidenceLevel = "limited";
    const annotated = buildStablecoinSafetyScoreV9Presentation(source, card.documentationOnlyLimited);
    expect(annotated.pillars[2]!.evidenceSummary).toContain(DOCUMENTATION_ONLY_SUFFIX);

    const unlisted = buildStablecoinSafetyScoreV9Presentation(source, ["backing"]);
    expect(unlisted.pillars[2]!.evidenceSummary).not.toContain(DOCUMENTATION_ONLY_SUFFIX);
    expect(buildStablecoinSafetyScoreV9Presentation(source).pillars[2]!.evidenceSummary)
      .not.toContain(DOCUMENTATION_ONLY_SUFFIX);
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
      cards: [{ asset: facts, pillars: witnesses([["exit", "limited", []]]) }],
      openEvidence,
    });
    expect(carriers.causeGapIds).toEqual([...new Set([gap.gapId, inheritedGap.gapId])].sort());
    expect(carriers.documentationOnlyLimited.size).toBe(0);
    expect(carriers.openEvidence.byCard.every((entry) => entry.documentationOnlyLimited === undefined)).toBe(true);

    for (const invalid of [[], ["peg"], ["control", "control"]]) {
      expect(V9OpenEvidenceByCardSchema.safeParse({
        id: "alpha",
        openBucketQuestionsCarried: 0,
        inheritedOpenBucketQuestionsCarried: 0,
        openBucketObligationsCarried: 0,
        documentationObligationsCarried: 0,
        documentationOnlyLimited: invalid,
      }).success).toBe(false);
    }
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
    for (const row of withClass.assets) {
      const other = withoutClass.assets.find((candidate) => candidate.assetId === row.assetId)!;
      for (const pillar of PILLARS) {
        expect(row.scoreInput.pillars[pillar].evidenceLevel)
          .toBe(other.scoreInput.pillars[pillar].evidenceLevel);
        expect(row.scoreInput.pillars[pillar].limitedEvidenceCauses)
          .toEqual(other.scoreInput.pillars[pillar].limitedEvidenceCauses);
        expect(row.scoreInput.pillars[pillar].limitingCauseGapIds ?? [])
          .toEqual(other.scoreInput.pillars[pillar].limitingCauseGapIds ?? []);
        expect(row.scoreInput.pillars[pillar].score).toBe(other.scoreInput.pillars[pillar].score);
      }
      expect(row.trace.finalScore).toBe(other.trace.finalScore);
      expect(row.trace.finalGrade).toBe(other.trace.finalGrade);
    }
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

describe("Safety Score v9 documentation class — static sentinel", () => {
  const SCORING_MODULES = [
    "score.ts",
    "formula.ts",
    "evaluate-set.ts",
    "dependencies.ts",
    "control.ts",
    // Decision B also forecloses these scoring readers (OP-R0 S-3).
    "evaluate-asset.ts",
    "backing.ts",
    "exit.ts",
    "control-mint-grade.ts",
  ];
  const FORBIDDEN_SYMBOLS = [
    "classifyV9DocumentationGap",
    "documentationGapIds",
    "isV9DocumentationDatum",
    "documentationOnlyLimitedPillars",
    "resolveV9DocumentationControl",
    "V9Documentation",
  ];

  it("never imports the documentation classifier or reads the policy block in a scoring module", () => {
    const offenders: string[] = [];
    for (const file of SCORING_MODULES) {
      const text = readFileSync(resolve("shared/lib/safety-score-v9", file), "utf8");
      for (const symbol of FORBIDDEN_SYMBOLS) {
        if (text.includes(symbol)) offenders.push(`${file}: ${symbol}`);
      }
      for (const match of text.matchAll(/(?:from\s+|import\()\s*["']([^"']*documentation[^"']*)["']/gu)) {
        offenders.push(`${file}: imports ${match[1]}`);
      }
      if (/\bevidence\s*(?:\?\.|\.)\s*documentation\b/u.test(text)) {
        offenders.push(`${file}: reads evidence.documentation`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
