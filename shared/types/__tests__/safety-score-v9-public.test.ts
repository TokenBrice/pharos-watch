import { describe, expect, it } from "vitest";
import {
  SafetyScoreV9CurrentCardSchema,
  SafetyScoreV9CurrentCardBaseSchema,
  SafetyScoreV9CurrentResponseSchema,
  SafetyScoreV9ResponseSchema,
  type SafetyScoreV9CurrentCard,
} from "../safety-score-v9-public";
import { SafetyScoreV9BreakdownsSchema } from "../safety-score-v9-public-breakdowns";
import { SafetyScoreV9AccessPostureSchema } from "../safety-score-v9-public-facts";
import { evaluateV9AccessLookthrough } from "../../lib/safety-score-v9/access-lookthrough";
import { makeAccessGraph } from "../../lib/__tests__/safety-score-v9-access-lookthrough.test-support";

import { adjustedResponse, boundedResponse, breakdowns, currentResponse, deploymentResponse, partialResponse } from "./safety-score-v9-public.test-support";
import { SafetyGradesResponseSchema } from "../report-cards-v9";
import { projectV9CompactPartialEvidence } from "../safety-score-v9-causes";
import { resolveCauseGapId } from "../safety-score-v9-public-cause-gaps";
import { iterateEvidenceResponsibilityFacts } from "../safety-score-v9-public-evidence-facts";
import { resolveV9EffectiveScoringWeight } from "../safety-score-v9-public-causes";
import { makePublishedIssuanceSummary, makePublishedProcessDiagnostic } from "../../lib/__tests__/safety-score-v9-fixtures.test-support";

describe("Compact public cause contracts", () => {
  it("validates distinct obligation summaries independently of the retained witness count", () => {
    const response = boundedResponse();
    const evidence = response.cards[0]!.scoreTrace.evidenceResponsibility;
    evidence.facts.push(["bounded-mechanism-review", "backing:second-witness", 0, "unresearched", false, "U", [0]]);
    evidence.facts.push(["bounded-mechanism-review", "backing:causal-alias", null, "unresearched", false, "U", [0]]);
    evidence.totalFactCount = 3;
    expect(SafetyScoreV9CurrentResponseSchema.safeParse(response).success).toBe(true);
    const wrongSummary = structuredClone(response);
    wrongSummary.cards[0]!.scoreTrace.evidenceResponsibility.summaries[7]!.factCount = 3;
    expect(SafetyScoreV9CurrentResponseSchema.safeParse(wrongSummary).success).toBe(false);
    const wrongWitnessCount = structuredClone(response);
    wrongWitnessCount.cards[0]!.scoreTrace.evidenceResponsibility.totalFactCount = 1;
    expect(SafetyScoreV9CurrentResponseSchema.safeParse(wrongWitnessCount).success).toBe(false);
  });
  it.each([-1, 0.5, 1])("rejects out-of-range/noninteger cause references %s before resolution", (ref) => {
    const response = boundedResponse();
    const card = response.cards[0]!;
    card.scoreTrace.evidenceResponsibility.facts[0]![2] = ref;
    card.scoreTrace.evidenceResponsibility.facts[0]![6] = [ref];
    expect(SafetyScoreV9CurrentResponseSchema.safeParse(response).success).toBe(false);
    expect(() => resolveCauseGapId(response, card, ref)).toThrow(/outside/u);

    const foreign = boundedResponse();
    foreign.foreignCauseGaps = ["external:gap:mechanism"];
    foreign.cards[0]!.localCauseGaps = [];
    foreign.cards[0]!.foreignCauseGapRefs = [ref];
    expect(SafetyScoreV9CurrentResponseSchema.safeParse(foreign).success).toBe(false);
    expect(() => resolveCauseGapId(foreign, foreign.cards[0]!, 0)).toThrow(/outside/u);

    const prefix = boundedResponse();
    prefix.cards[0]!.scoreTrace.evidenceResponsibility.factPathPrefixes = ["backing:mechanism"];
    prefix.cards[0]!.scoreTrace.evidenceResponsibility.facts[0]![1] = [ref];
    expect(SafetyScoreV9CurrentResponseSchema.safeParse(prefix).success).toBe(false);
  });

  it("rejects an unreferenced publication root entry without confusing local and foreign gaps", () => {
    const response = boundedResponse();
    const card = response.cards[0]!;
    response.foreignCauseGaps = ["external:gap:mechanism"];
    card.localCauseGaps = [];
    card.foreignCauseGapRefs = [0];
    expect(SafetyScoreV9CurrentResponseSchema.parse(response).cards[0]!.ratingStatus).toBe("rated");
    response.foreignCauseGaps.push("zz:gap:unused");
    const result = SafetyScoreV9CurrentResponseSchema.safeParse(response);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.path[0])).toContain("foreignCauseGaps");
  });

  it("rejects foreign gaps selected by a card but unused by its actual causal contributions", () => {
    const response = boundedResponse();
    response.foreignCauseGaps = ["external:gap:unused"];
    response.cards[0]!.foreignCauseGapRefs = [0];
    const result = SafetyScoreV9CurrentResponseSchema.safeParse(response);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map(issue => issue.message))
      .toContain("Every card gap table entry must be referenced");
  });

  it.each(["no-viable-exit-path", "bounded-mechanism-review"] as const)(
    "uses the exact D fact rather than policy code classification for %s",
    code => {
      const response = boundedResponse();
      const card = response.cards[0]!;
      const reason = { code, path: "backing:mechanism", message: "A measured local failure is observed." };
      card.localCauseGaps = [];
      card.pillars.backing.causeGapRefs = [];
      card.pillars.backing.limitedEvidenceCauses = ["D"];
      card.pillars.backing.reasons = [reason];
      card.reasonCodes = [code];
      const evidence = card.scoreTrace.evidenceResponsibility;
      evidence.facts = [[code, reason.path, null, "measured-adverse", false, "D", []]];
      evidence.summaries = evidence.summaries.map(summary => ({
        responsibility: summary.responsibility,
        ...(summary.responsibility === "measured-adverse" ? {
          factCount: 1, criticalFactCount: 0, reasonCodes: [code],
        } : {}),
      }));
      card.scoreTrace.boundedUncertaintyAttribution.items = [];
      card.scoreTrace.adverseAttribution.items = [{
        source: "reason", path: reason.path, message: reason.message, responsibility: "measured-adverse",
      }];
      expect(SafetyScoreV9CurrentResponseSchema.parse(response).cards[0]!.grade).toBe("D");

      const wrongPath = structuredClone(response);
      wrongPath.cards[0]!.scoreTrace.evidenceResponsibility.facts[0]![1] = "backing:different-observation";
      expect(SafetyScoreV9CurrentResponseSchema.safeParse(wrongPath).success).toBe(false);
      const unproved = structuredClone(response);
      unproved.cards[0]!.scoreTrace.evidenceResponsibility.facts[0]![3] = "unresearched";
      unproved.cards[0]!.scoreTrace.evidenceResponsibility.facts[0]![5] = "U";
      expect(SafetyScoreV9CurrentResponseSchema.safeParse(unproved).success).toBe(false);
    },
  );

  function componentBoundedResponse(cause: "C" | "U", factor: boolean) {
    const response = boundedResponse();
    const card = response.cards[0]!;
    const componentKey = factor ? "reserve:bounded:assetClass" : "reserve:bounded";
    const item = card.scoreTrace.boundedUncertaintyAttribution.items[0]!;
    item.path = `backing:${componentKey}:bounded-component:cause:0`;
    item.cause = cause;
    item.responsibility = cause === "C" ? "issuer-undisclosed" : "unresearched";
    card.pillars.backing.score = 60;
    card.pillars.backing.limitedEvidenceCauses = [cause];
    card.pillars.backing.reasons = [{
      code: item.code, path: item.path, message: item.message, cause, causeGapRefs: [0],
    }];
    card.pillars.exit.score = 30;
    card.pillars.control.score = 42;
    card.breakdowns = breakdowns(60, 30, 42);
    const backing = card.breakdowns.backing;
    backing.components = [{
      key: "reserve:bounded", label: "Bounded reserve", source: "reserve-exposure",
      score: 35, cause, causeGapRefs: [0], scoringDisposition: "bounded-uncertainty",
      effectiveScoringWeight: 0.5, wholeAssetWeight: 0.5, weightedContribution: 17.5,
      observationState: "bounded-unknown",
      ...(factor ? { factors: [{
        componentKey, score: 35, cause, causeGapRefs: [0],
        scoringDisposition: "bounded-uncertainty" as const, effectiveScoringWeight: 1,
      }] } : {}),
    }, {
      key: "reserve:known", label: "Known reserve", source: "reserve-exposure",
      score: 85, effectiveScoringWeight: 0.5, wholeAssetWeight: 0.5,
      weightedContribution: 42.5, observationState: "known",
    }];
    card.weakestPillar = { pillar: "exit", score: 30 };
    card.scoreTrace.aggregation!.weakestPillar = "exit";
    card.scoreTrace.aggregation!.weakestScore = 30;
    const evidence = card.scoreTrace.evidenceResponsibility;
    evidence.factPathPrefixes = [`backing:${componentKey}:bounded-component`];
    evidence.facts = [[item.code, [0], 0, item.responsibility, false, cause, [0]]];
    evidence.summaries = evidence.summaries.map(summary => ({
      responsibility: summary.responsibility,
      ...(summary.responsibility === item.responsibility ? {
        factCount: 1, criticalFactCount: 0, reasonCodes: [item.code],
      } : {}),
    }));
    return response;
  }

  it.each([
    ["C", false], ["U", false], ["C", true], ["U", true],
  ] as const)("accepts charged %s bounded backing attribution at component/factor scope (%s)", (cause, factor) => {
    const card = SafetyScoreV9CurrentResponseSchema.parse(componentBoundedResponse(cause, factor)).cards[0]!;
    expect(card.grade).toBe("D");
    expect(card.pillars.backing.score).toBe(60);
    expect([...iterateEvidenceResponsibilityFacts(card.scoreTrace.evidenceResponsibility)][0]![1])
      .toBe(card.scoreTrace.boundedUncertaintyAttribution.items[0]!.path);
  });

  it.each([false, true])("accepts a U gap within a C-dominant charged component (%s)", factor => {
    const response = componentBoundedResponse("U", factor);
    const card = response.cards[0]!;
    card.localCauseGaps.push("other");
    const row = card.breakdowns!.backing.components[0]!;
    const contribution = factor ? row.factors![0]! : row;
    contribution.cause = "C";
    contribution.causeGapRefs = [0, 1];
    const evidence = card.scoreTrace.evidenceResponsibility;
    evidence.totalFactCount = 2;
    evidence.facts.push(["bounded-mechanism-review", [0], 1, "issuer-undisclosed", false, "C", [1]]);
    evidence.summaries = evidence.summaries.map(summary => summary.responsibility === "issuer-undisclosed"
      ? { responsibility: summary.responsibility, factCount: 1, criticalFactCount: 0, reasonCodes: ["bounded-mechanism-review"] }
      : summary);
    expect(SafetyScoreV9CurrentResponseSchema.parse(response).cards[0]!.grade).toBe("D");
  });

  it.each([false, true])("rejects forged or uncharged bounded component attribution (%s)", factor => {
    const original = componentBoundedResponse("U", factor);
    const mutations: Array<(card: SafetyScoreV9CurrentCard) => void> = [
      card => {
        const item = card.scoreTrace.boundedUncertaintyAttribution.items[0]!;
        item.path = "backing:reserve:other:bounded-component:cause:0";
        card.pillars.backing.reasons[0]!.path = item.path;
      },
      card => {
        const row = card.breakdowns!.backing.components[0]!;
        if (factor) row.factors![0]!.effectiveScoringWeight = 0;
        else {
          row.effectiveScoringWeight = 0;
          row.weightedContribution = 0;
          Object.assign(card.breakdowns!.backing.components[1]!, {
            score: 60, effectiveScoringWeight: 1, weightedContribution: 60,
          });
        }
      },
      ...(factor ? [(card: SafetyScoreV9CurrentCard) => {
        const row = card.breakdowns!.backing.components[0]!;
        row.effectiveScoringWeight = 0;
        row.weightedContribution = 0;
        Object.assign(card.breakdowns!.backing.components[1]!, {
          score: 60, effectiveScoringWeight: 1, weightedContribution: 60,
        });
      }] : []),
      card => {
        card.localCauseGaps.push("other");
        const row = card.breakdowns!.backing.components[0]!;
        (factor ? row.factors![0]! : row).causeGapRefs = [1];
      },
      card => {
        card.scoreTrace.boundedUncertaintyAttribution.items[0]!.message = "Unpublished attribution.";
      },
      card => {
        card.scoreTrace.evidenceResponsibility.facts[0]![5] = "C";
        card.scoreTrace.evidenceResponsibility.facts[0]![3] = "issuer-undisclosed";
      },
      card => {
        const row = card.breakdowns!.backing.components[0]!;
        (factor ? row.factors![0]! : row).score = 50;
        if (!factor) {
          row.weightedContribution = 25;
          Object.assign(card.breakdowns!.backing.components[1]!, { score: 70, weightedContribution: 35 });
        }
      },
      ...(["A", "B"] as const).map(cause => (card: SafetyScoreV9CurrentCard) => {
        const row = card.breakdowns!.backing.components[0]!;
        Object.assign(factor ? row.factors![0]! : row, {
          cause, score: null, effectiveScoringWeight: 0,
          scoringDisposition: cause === "A" ? "excluded-pipeline" : "excluded-uncurated",
        });
        if (!factor) {
          row.weightedContribution = 0;
          Object.assign(card.breakdowns!.backing.components[1]!, {
            score: 60, effectiveScoringWeight: 1, weightedContribution: 60,
          });
        }
      }),
    ];
    for (const mutate of mutations) {
      const invalid = structuredClone(original);
      mutate(invalid.cards[0]!);
      const parsed = SafetyScoreV9CurrentResponseSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.issues.map(issue => issue.path))
        .toContainEqual(["cards", 0, "scoreTrace", "boundedUncertaintyAttribution", "items"]);
    }
  });

  it("resolves one parent identity across independent card and root renumbering", () => {
    const response = { foreignCauseGaps: ["parent:gap:mechanism"] };
    const parent = { id: "parent", localCauseGaps: ["mechanism"], foreignCauseGapRefs: [] };
    const child = { id: "child", localCauseGaps: ["before", "self"], foreignCauseGapRefs: [0] };
    expect(resolveCauseGapId(response, parent, 0)).toBe("parent:gap:mechanism");
    expect(resolveCauseGapId(response, child, 2)).toBe("parent:gap:mechanism");
    const renumbered = { foreignCauseGaps: ["a:gap:other", "parent:gap:mechanism"] };
    const remapped = { ...child, localCauseGaps: ["before", "new", "self"], foreignCauseGapRefs: [1] };
    expect(resolveCauseGapId(renumbered, remapped, 3)).toBe("parent:gap:mechanism");
    expect(resolveCauseGapId(renumbered, remapped, 2)).toBe("child:gap:self");
  });

  it("round-trips readable tuples and derived causal paths without turning null source identity into zero", () => {
    const response = boundedResponse();
    const evidence = response.cards[0]!.scoreTrace.evidenceResponsibility;
    evidence.factPathPrefixes = ["backing:mechanism"];
    evidence.facts[0]![1] = [0];
    evidence.facts[0]![2] = null;
    const decoded = SafetyScoreV9CurrentResponseSchema.parse(JSON.parse(JSON.stringify(response)));
    expect([...iterateEvidenceResponsibilityFacts(decoded.cards[0]!.scoreTrace.evidenceResponsibility)]).toEqual([[
      "bounded-mechanism-review", "backing:mechanism:cause:0", null, "unresearched", false, "U", [0],
    ]]);
    expect(resolveCauseGapId(decoded, decoded.cards[0]!, 0)).toBe("asset:gap:mechanism");
  });

  it("round-trips disposition defaults while preserving null scores, null shares and pipeline-gap grade", () => {
    const response = partialResponse(["backing", "exit"]);
    const card = response.cards[0]!;
    delete card.pillars.control.aggregationDisposition;
    delete card.breakdowns!.control.aggregationDisposition;
    const control = card.breakdowns!.control.components[0]!;
    delete control.effectiveScoringWeight;
    for (const component of card.breakdowns!.backing.components) delete component.effectiveScoringWeight;
    for (const group of card.breakdowns!.backing.groups) delete group.effectiveScoringWeight;
    for (const component of card.breakdowns!.exit.primaryRoute!.components) delete component.effectiveScoringWeight;
    card.breakdowns!.backing.components[0]!.wholeAssetWeight = null;
    const decoded = SafetyScoreV9CurrentResponseSchema.parse(JSON.parse(JSON.stringify(response))).cards[0]!;
    expect(decoded.ratingStatus).toBe("pipeline-gap");
    expect(decoded.score).toBeNull();
    expect(decoded.grade).toBeNull();
    expect(decoded.breakdowns!.backing.components[0]!.score).toBeNull();
    expect(decoded.breakdowns!.backing.components[0]!.wholeAssetWeight).toBeNull();
    expect(resolveV9EffectiveScoringWeight(decoded.breakdowns!.backing.components[0]!)).toBe(0);
    expect(resolveV9EffectiveScoringWeight(decoded.breakdowns!.control.components[0]!)).toBe(1);
    expect(decoded.breakdowns!.control.components[0]!.score).toBe(95.2);
  });
});

describe("SafetyScoreV9ResponseSchema", () => {
  it("admits independent feasible backup credit above the primary route-local component ceiling", () => {
    const response = currentResponse();
    const exit = response.cards[0]!.breakdowns!.exit;
    const primary = exit.primaryRoute!;
    primary.score = 90;
    primary.supportedComponentCeiling = 90;
    for (const component of primary.components) {
      component.score = 90;
      component.weightedContribution = 90 * resolveV9EffectiveScoringWeight(component);
    }
    exit.diversification = { routeKey: "dex:backup", routeLabel: "Independent backup", bonus: 2 };
    exit.alternatives = [{
      key: "dex:backup", label: "Independent backup", routeFamily: "dex-amm", score: 80,
      routeId: "backup", lane: "dex",
      included: true, exclusionReason: null, confidenceFactor: 1,
      confidenceDimensions: structuredClone(primary.confidenceDimensions), capacityEvidenceTier: "live-direct",
      rawSameNotionalCostBps: 0,
      capacity: { executableUsd: 1_000_000, requestedNotionalUsd: 1_000_000, completionRatio: 1 },
    }];
    const parsed = SafetyScoreV9CurrentResponseSchema.parse(response).cards[0]!.breakdowns!.exit;
    expect(parsed.primaryRoute!.confidenceFactor).toBe(1);
    expect(parsed.primaryRoute!.supportedComponentCeiling).toBe(90);
    expect(parsed.evaluatedScore).toBe(92);
  });
  it("accepts reconciled nonzero loss across two holder exposures", () => {
    const parsed = SafetyScoreV9CurrentResponseSchema.parse(deploymentResponse()).cards[0]!;
    expect(parsed.pegAdjustedScore).toBe(90);
    expect(parsed.scoreTrace.deploymentRisk.totalAdjustmentPoints).toBe(2);
    expect(parsed.scoreTrace.deploymentRisk.adjustments.map((item) => [item.exposureKey, item.exposureShare]))
      .toEqual([["a", 0.5], ["b", 0.5]]);
  });

  it("rejects increasing scores and independently inconsistent modeled or applied losses", () => {
    for (const mutation of [{ scoreAfter: 93 }, { modeledLossPoints: 2 }, { adjustmentPoints: 2 }]) {
      const invalid = deploymentResponse();
      Object.assign(invalid.cards[0]!.scoreTrace.deploymentRisk.adjustments[0]!, mutation);
      const result = SafetyScoreV9CurrentResponseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path))
          .toContainEqual(["cards", 0, "scoreTrace", "deploymentRisk", "adjustments", 0, "adjustmentPoints"]);
      }
    }
  });

  it("rejects exposure above nominal share and overlapping holder partitions independently", () => {
    for (const overlapping of [false, true]) {
      const invalid = deploymentResponse();
      const adjustment = invalid.cards[0]!.scoreTrace.deploymentRisk.adjustments[0]!;
      if (overlapping) {
        adjustment.nominalExposureShare = 0.6;
        adjustment.exposureShare = 0.6;
      } else {
        adjustment.nominalExposureShare = 0.4;
      }
      const result = SafetyScoreV9CurrentResponseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual(
          ["cards", 0, "scoreTrace", "deploymentRisk", "adjustments", ...(overlapping ? [] : [0, "adjustmentPoints"])],
        );
      }
    }
  });

  it("requires deployment totals to equal attributed losses even when stages agree", () => {
    const invalid = deploymentResponse();
    const trace = invalid.cards[0]!.scoreTrace;
    trace.deploymentRisk.totalAdjustmentPoints = 1;
    Object.assign(trace.stages, { deploymentAdjustmentPoints: 1, deploymentAdjustedScore: 91, preCapScore: 91 });
    invalid.cards[0]!.pegAdjustedScore = 91;
    const result = SafetyScoreV9CurrentResponseSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path))
        .toContainEqual(["cards", 0, "scoreTrace", "deploymentRisk", "totalAdjustmentPoints"]);
    }
  });

  it("accepts aggregation tolerance endpoints and rejects values just outside both bounds", () => {
    for (const [score, accepted] of [[89.9998, true], [89.99979, false], [92.0002, true], [92.00021, false]] as const) {
      const trace = currentResponse().cards[0]!.scoreTrace;
      trace.aggregation!.score = score;
      Object.assign(trace.stages, {
        aggregatedQualityScore: score, baseAssetScore: score, deploymentAdjustedScore: score, preCapScore: score,
      });
      const result = SafetyScoreV9CurrentCardBaseSchema.shape.scoreTrace.safeParse(trace);
      expect(result.success, `aggregation score ${score}`).toBe(accepted);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["aggregation", "score"]);
      }
    }
  });

  it("rejects old envelopes and proofless legacy trace bytes on the current publication reader", () => {
    expect(SafetyScoreV9CurrentResponseSchema.safeParse({ ...currentResponse(), schemaVersion: 5 }).success).toBe(false);
    expect(SafetyScoreV9CurrentResponseSchema.safeParse({ ...currentResponse(), schemaVersion: 6 }).success).toBe(false);
    const current = currentResponse();
    const legacy = { ...current, cards: [{ ...current.cards[0], scoreTrace: { ...current.cards[0]!.scoreTrace, schemaVersion: 3 } }] };
    expect(SafetyScoreV9CurrentResponseSchema.safeParse(legacy).success).toBe(false);
    const { ratingStatus: _status, ...withoutStatus } = currentResponse().cards[0]!;
    expect(SafetyScoreV9CurrentResponseSchema.safeParse({ ...currentResponse(), cards: [withoutStatus] }).success).toBe(false);
    const { partialEvidence: _partial, ...withoutPartial } = currentResponse().cards[0]!;
    expect(SafetyScoreV9CurrentResponseSchema.safeParse({ ...currentResponse(), cards: [withoutPartial] }).success).toBe(false);
  });

  it("requires the self-describing score trace on every current V9 card", () => {

    const { scoreTrace: _scoreTrace, ...cardWithoutTrace } = currentResponse().cards[0]!;
    const missingTrace = { ...currentResponse(), cards: [cardWithoutTrace] };
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(missingTrace)).toThrow();

    const inconsistentTrace = currentResponse();
    const scoreTrace = inconsistentTrace.cards[0]!.scoreTrace!;
    scoreTrace.stages.preCapScore = 91;
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(inconsistentTrace)).toThrow(
      /explicit preCapScore must match/,
    );
  });

  it("rejects component breakdowns that do not reconcile their public scores", () => {
    const invalidBacking = currentResponse();
    invalidBacking.cards[0]!.breakdowns!.backing.components[0]!.weightedContribution = 89;
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(invalidBacking)).toThrow(
      /backing weighted contribution|backing components must reconcile/,
    );

    const invalidExit = currentResponse();
    invalidExit.cards[0]!.breakdowns!.exit.primaryRoute!.components[0]!.weightedContribution = 1;
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(invalidExit)).toThrow(
      /exit weighted contribution|primary-route score must reconcile/,
    );

    const invalidControl = currentResponse();
    invalidControl.cards[0]!.breakdowns!.control.components[0]!.binding = false;
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(invalidControl)).toThrow(
      /binding controls, or the neutral empty set, must reconcile/,
    );
  });

  it("accepts a neutral control breakdown without a manufactured binding component", () => {
    const neutral = breakdowns(90, 92, 95);
    neutral.control.components = [];

    expect(SafetyScoreV9BreakdownsSchema.parse(neutral).control).toMatchObject({
      evaluatedScore: 95,
      components: [],
    });
  });

  it("preserves bounded C/U D-grade attribution without claiming measured adversity", () => {
    const card = SafetyScoreV9CurrentResponseSchema.parse(boundedResponse()).cards[0]!;
    expect(card.grade).toBe("D");
    expect(card.scoreTrace.boundedUncertaintyAttribution.items[0]!.cause).toBe("U");
    expect(card.scoreTrace.adverseAttribution.items).toEqual([]);
  });

  it.each([
    { name: "unownedBoundedTrace", error: /bounded-uncertainty attribution must reconcile/, mutate: (card: ReturnType<typeof boundedResponse>["cards"][number]) => {
      card.scoreTrace.evidenceResponsibility.totalFactCount = 0;
      card.scoreTrace.evidenceResponsibility.summaries[0] = {
        responsibility: "integration-missing",
        factCount: 0,
        criticalFactCount: 0,
        reasonCodes: [],
      };
    } },
    { name: "unboundedCode", error: /policy-bounded reason code/, mutate: (card: ReturnType<typeof boundedResponse>["cards"][number]) => {
      card.scoreTrace.boundedUncertaintyAttribution.items[0]!.code =
        "missing-access-review";
    } },
    { name: "forgedParent", error: /binding low minimum serial parent/, mutate: (card: ReturnType<typeof boundedResponse>["cards"][number]) => {
      card.scoreTrace.boundedUncertaintyAttribution.items = [{
        source: "parent-score",
        code: "bounded-mechanism-review",
        path: "parent:ghost:backing:mechanism",
        message: "Required parent ghost: A bounded backing review remains unresolved.",
        responsibility: "integration-missing",
        cause: "U",
        causeGapRefs: [0],
      }];
    } },
    { name: "forgedPeg", error: /match the measured danger multiplier/, mutate: (card: ReturnType<typeof boundedResponse>["cards"][number]) => {
      card.scoreTrace.adverseAttribution.items = [{
        source: "peg-performance",
        path: "peg:historical-performance",
        message: "Measured peg multiplier is 0.1.",
        responsibility: "measured-adverse",
      }];
    } },
    { name: "impossibleTrackRecord", error: /cannot authorize measured-adverse attribution/, mutate: (card: ReturnType<typeof boundedResponse>["cards"][number]) => {
      card.scoreTrace.adverseAttribution.items = [{
        source: "track-record",
        path: "track-record:<6m",
        message: "Track record is short.",
        responsibility: "measured-adverse",
      }];
    } },
    { name: "contradictoryReason", error: /cannot also be declared as bounded uncertainty/, mutate: (card: ReturnType<typeof boundedResponse>["cards"][number]) => {
      card.scoreTrace.adverseAttribution.items = [{
        source: "reason",
        path: "backing:mechanism",
        message: "A bounded backing review remains unresolved.",
        responsibility: "measured-adverse",
      }];
    } },
    { name: "unownedMeasuredReason", error: /must reconcile to a measured-adverse evidence reason code/, mutate: (card: ReturnType<typeof boundedResponse>["cards"][number]) => {
      card.scoreTrace.adverseAttribution.items = [{
        source: "reason",
        path: "backing:mechanism",
        message: "A bounded backing review remains unresolved.",
        responsibility: "measured-adverse",
      }];
      card.scoreTrace.boundedUncertaintyAttribution.items = [];
    } },
    { name: "forgedMeasuredSummary", mutate: (card: SafetyScoreV9CurrentCard) => {
      card.scoreTrace.adverseAttribution.items = [{
        source: "reason",
        path: "backing:mechanism",
        message: "A bounded backing review remains unresolved.",
        responsibility: "measured-adverse",
      }];
      card.scoreTrace.boundedUncertaintyAttribution.items = [];
      card.scoreTrace.evidenceResponsibility.summaries[0] = {
        responsibility: "integration-missing",
        factCount: 0,
        criticalFactCount: 0,
        reasonCodes: [],
      };
      card.scoreTrace.evidenceResponsibility.summaries[2] = {
        responsibility: "measured-adverse",
        factCount: 1,
        criticalFactCount: 0,
        reasonCodes: ["bounded-mechanism-review"],
      };
    } },
    { name: "unattributedD", error: /D card requires causal measured-adverse or bounded-uncertainty attribution/, mutate: (card: ReturnType<typeof boundedResponse>["cards"][number]) => {
      card.scoreTrace.boundedUncertaintyAttribution.items = [];
    } },
    { name: "unattributedDanger", error: /F card requires causal measured-adverse attribution/, mutate: (card: ReturnType<typeof boundedResponse>["cards"][number]) => {
      card.score = 35;
      card.grade = "F";
      card.scoreTrace.stages.publishedScore = 35;
    } },
    { name: "forgedGrade", error: /numeric score and grade band must agree/, mutate: (card: ReturnType<typeof boundedResponse>["cards"][number]) => {
      card.grade = "C-";
    } },
    { name: "ratedCritical", error: /cannot retain critical unresolved facts/, mutate: (card: ReturnType<typeof boundedResponse>["cards"][number]) => {
      card.scoreTrace.evidenceResponsibility.summaries[0]!.criticalFactCount = 1;
    } },
  ])("rejects $name attribution", ({ mutate }) => {
    const invalid = boundedResponse();
    mutate(invalid.cards[0]!);
    expect(SafetyScoreV9CurrentResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it("requires attribution to a binding minimum serial parent, including ties and cycles", () => {
    const higherParent = boundedResponse().cards[0]!;
    higherParent.foreignCauseGapRefs = [0, 1];
    higherParent.score = 40;
    higherParent.grade = "D";
    higherParent.caps = [{
      kind: "parent",
      limit: 40,
      source: "parent",
      reason: "A child cannot rate above its required parent.",
      binding: true,
    }];
    higherParent.bindingCap = higherParent.caps[0]!;
    higherParent.dependencies.serial = [
      { upstreamAssetId: "higher", score: 45, blocked: false, ratingStatus: "rated", partialEvidence: null, causeGapRefs: [1], limitedEvidenceCauses: ["D"] },
      { upstreamAssetId: "lower", score: 40, blocked: false, ratingStatus: "rated", partialEvidence: null, causeGapRefs: [2], limitedEvidenceCauses: ["D"] },
    ];
    higherParent.scoreTrace.stages.publishedScore = 40;
    higherParent.scoreTrace.adverseAttribution.items = [{
      source: "parent-score",
      path: "parent:higher:structural:centralized-mint:high",
      message: "Required parent higher: Economically effective minting is unbounded.",
      responsibility: "measured-adverse",
    }];
    higherParent.scoreTrace.boundedUncertaintyAttribution.items = [];
    expect(() => SafetyScoreV9CurrentCardSchema.parse(higherParent)).toThrow(
      /binding low minimum serial parent/,
    );

    const tiedParent = structuredClone(higherParent);
    tiedParent.dependencies.serial[0]!.score = 40;
    expect(SafetyScoreV9CurrentCardSchema.parse(tiedParent).grade).toBe("D");

    const cycleBlockedParent = structuredClone(tiedParent);
    cycleBlockedParent.dependencies.cycleBlocked = true;
    expect(() => SafetyScoreV9CurrentCardSchema.parse(cycleBlockedParent)).toThrow(
      /binding parent cap must reconcile/,
    );

  });

  it("reconciles every score adjustment to its ordinary score and relieved card cap", () => {
    const valid = adjustedResponse();
    expect(SafetyScoreV9CurrentResponseSchema.parse(valid).cards[0]?.score).toBe(94);

    const missingCap = adjustedResponse();
    missingCap.cards[0]!.caps = missingCap.cards[0]!.caps.filter(
      (cap) => cap.source !== "structural",
    );
    missingCap.cards[0]!.bindingCap = null;
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(missingCap)).toThrow(
      /cap relief must match exactly one current card cap/,
    );

    const impossibleOrdinaryScore = adjustedResponse();
    impossibleOrdinaryScore.cards[0]!.scoreTrace.scoreAdjustments[0]!.publishedScoreBefore = 95;
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(impossibleOrdinaryScore)).toThrow(
      /permitted rounding headroom/,
    );

    const fictionalRelief = adjustedResponse();
    fictionalRelief.cards[0]!.scoreTrace.scoreAdjustments[0]!.capRelief.kind =
      "signal:unsafe-backing:low";
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(fictionalRelief)).toThrow(
      /cap relief must match exactly one current card cap/,
    );
  });

  it.each([
    ["lifecycle", "candidate"],
    ["policyVersion", "candidate-v1"],
  ])("rejects legacy %s independently on current V9", (field, value) => {
    const invalid = { ...currentResponse(), [field]: value };
    const result = SafetyScoreV9ResponseSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual([field]);
    }
  });

  it("covers all eight included/excluded pillar masks with disjoint technical availability", () => {
    const pillars = ["backing", "control", "exit"] as const;
    for (let mask = 0; mask < 8; mask++) {
      const excluded = pillars.filter((_pillar, index) => (mask & (1 << index)) !== 0);
      const parsed = SafetyScoreV9CurrentResponseSchema.parse(partialResponse(excluded));
      const card = parsed.cards[0]!;
      const pipeline = excluded.length >= 2;
      expect(card.ratingStatus).toBe(pipeline ? "pipeline-gap" : "rated");
      expect(card.grade === null).toBe(pipeline);
      expect(card.grade).not.toBe("NR");
      expect(parsed.completeness.notRatedCount).toBe(0);
      expect(parsed.completeness.pipelineGapCount).toBe(pipeline ? 1 : 0);
      for (const pillar of excluded) {
        expect(card.pillars[pillar].score).toBeNull();
        expect(card.breakdowns![pillar].aggregationWeight).toBe(0);
      }
      if (pipeline) {
        expect(card.scoreTrace.aggregation).toBeNull();
        expect(card.bindingCap).toBeNull();
        expect(card.nrReasons).toEqual([]);
        expect(Object.values(card.scoreTrace.stages)).toEqual(Array(8).fill(null));
        const falseNR = { ...parsed, cards: [{ ...card, grade: "NR", ratingStatus: "not-rated" }] };
        expect(SafetyScoreV9CurrentResponseSchema.safeParse(falseNR).success).toBe(false);
      } else {
        const aggregate = card.scoreTrace.aggregation!;
        const included = pillars.filter((pillar) => !excluded.includes(pillar));
        const originalWeights = { backing: 0.4, exit: 0.35, control: 0.25 };
        const denominator = included.reduce((sum, pillar) => sum + originalWeights[pillar], 0);
        for (const pillar of included) expect(aggregate.effectiveScoringWeights[pillar]).toBeCloseTo(originalWeights[pillar] / denominator);
        expect(aggregate.supportCeiling).toBeCloseTo(included.reduce((sum, pillar) => sum + card.pillars[pillar].score! * aggregate.effectiveScoringWeights[pillar], 0));
      }
    }
  });

  it("keeps pipeline-gap distinct from NR on the current free grades surface", () => {
    const card = SafetyScoreV9CurrentResponseSchema.parse(partialResponse(["backing", "control"])).cards[0]!;
    const response = { schemaVersion: 1, model: "v9", methodologyVersion: "10.01", asOfSec: 100, updatedAt: 101,
      publicationStatus: "current", grades: [{ id: card.id, score: card.score, grade: card.grade,
        ratingStatus: card.ratingStatus, partialEvidence: projectV9CompactPartialEvidence(card.partialEvidence) }] };
    expect(SafetyGradesResponseSchema.parse(response).grades[0]!.grade).toBeNull();
    expect(SafetyGradesResponseSchema.safeParse({ ...response, grades: [{ ...response.grades[0], grade: "NR" }] }).success).toBe(false);
    expect(SafetyGradesResponseSchema.safeParse({ ...response, grades: [{ ...response.grades[0], score: 0 }] }).success).toBe(false);
  });

  it("requires binding-cap and access-unknown summaries to be exact", () => {
    const invalidCap = currentResponse();
    Object.assign(invalidCap.cards[0], { bindingCap: null });
    expect(() => SafetyScoreV9ResponseSchema.parse(invalidCap)).toThrow(/binding cap must match/);

    const invalidAccess = currentResponse();
    Object.assign(invalidAccess.cards[0].accessPosture, { governance: "unknown", unknownFields: [] });
    expect(() => SafetyScoreV9ResponseSchema.parse(invalidAccess)).toThrow(/unknown fields must exactly match/);
  });
});

describe("public reserve-access look-through", () => {
  it("distinguishes historical absence, explicit null, priced partial coverage and true zero", () => {
    const posture = currentResponse().cards[0]!.accessPosture;
    expect(SafetyScoreV9AccessPostureSchema.parse(posture).freezeLookthrough).toBeUndefined();
    expect(SafetyScoreV9AccessPostureSchema.parse({ ...posture, freezeLookthrough: null }).freezeLookthrough).toBeNull();
    const graph = makeAccessGraph();
    graph.edges = graph.edges.filter((edge) => edge.toNodeKey !== "clean");
    graph.partitions.find((p) => p.partitionKey === "root")!.complete = false;
    const partial = evaluateV9AccessLookthrough(graph);
    expect(SafetyScoreV9AccessPostureSchema.parse({ ...posture, freezeLookthrough: partial }).freezeLookthrough!.unresolvedCoverageShare).toBeCloseTo(0.3);
    graph.authorities = [];
    graph.nodes.find((node) => node.nodeKey === "token")!.noCurrentReach = true;
    graph.edges.push(makeAccessGraph().edges.find((edge) => edge.toNodeKey === "clean")!);
    graph.partitions.find((p) => p.partitionKey === "root")!.complete = true;
    const zero = evaluateV9AccessLookthrough(graph);
    expect(SafetyScoreV9AccessPostureSchema.parse({ ...posture, freezeLookthrough: zero }).freezeLookthrough!.knownAdverseReachShare).toBe(0);
  });
  it("rejects unreconciled fractions and false numeric completeness", () => {
    const posture = currentResponse().cards[0]!.accessPosture;
    const summary = evaluateV9AccessLookthrough(makeAccessGraph());
    expect(SafetyScoreV9AccessPostureSchema.safeParse({ ...posture, freezeLookthrough: { ...summary, unresolvedCoverageShare: 0.2 } }).success).toBe(false);
    expect(SafetyScoreV9AccessPostureSchema.safeParse({ ...posture, freezeLookthrough: { ...summary, knownAdverseReachShare: null, reviewedNoCurrentReachShare: null, unresolvedCoverageShare: null } }).success).toBe(false);
  });
});

describe("v10.05 public compiled process boundary", () => {
  it("retains neutral measurements, rejects inconsistent diagnostic samples, and preserves absent legacy evidence", () => {
    const value = breakdowns();
    value.control.components[0]!.posture = "unbounded-operationally-governed";
    value.control.issuanceSummary = makePublishedIssuanceSummary({ maxAnnualInterestGrowthPpm: 500001 }, [
      makePublishedProcessDiagnostic({ code: "operational-screen-failed", gate: "H2", controlRef: null, pathId: null,
        classId: null, memberRef: null, field: "maxAnnualInterestGrowthPpm", evidenceRefIds: ["process-proof"] }),
    ]);
    const parsed = SafetyScoreV9BreakdownsSchema.parse(value);
    expect(parsed.control.issuanceSummary?.process).toMatchObject({
      coverage: "complete", minOperationalExerciseDelaySec: 0, maxAnnualInterestGrowthPpm: 500001,
    });
    value.control.issuanceSummary.diagnostics[0]!.exemplars[0]!.evidenceRefCount = 0;
    expect(SafetyScoreV9BreakdownsSchema.safeParse(value).success).toBe(false);
    const legacy = SafetyScoreV9BreakdownsSchema.parse(breakdowns());
    expect(legacy.control.issuanceSummary).toBeUndefined();
  });
});
