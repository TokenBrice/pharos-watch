import { describe, expect, it } from "vitest";
import {
  SafetyScoreV9CurrentCardSchema,
  SafetyScoreV9CurrentCardBaseSchema,
  SafetyScoreV9CurrentResponseSchema,
  SafetyScoreV9BreakdownsSchema,
  SafetyScoreV9ResponseSchema,
} from "../safety-score-v9-public";

import { adjustedResponse, boundedResponse, breakdowns, currentResponse, deploymentResponse } from "./safety-score-v9-public.test-support";

describe("SafetyScoreV9ResponseSchema", () => {
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

  it("accepts stored snapshots that predate the sixth responsibility owner", () => {
    const legacy = currentResponse();
    const trace = legacy.cards[0]!.scoreTrace!;
    delete trace.evidenceResponsibility.facts;
    trace.evidenceResponsibility.summaries.pop();
    const parsed = SafetyScoreV9CurrentResponseSchema.parse(legacy);
    expect(parsed.cards[0]?.scoreTrace.evidenceResponsibility.facts).toBeUndefined();
    expect(parsed.cards[0]?.scoreTrace.evidenceResponsibility.summaries).toHaveLength(5);

    // Per-fact paths (9.19) and the sixth owner (9.4) arrived separately, so a
    // stored publication can carry `facts` and still predate the owner. Reading
    // that shape is what the 9.4 release initially got wrong.
    const factsWithLegacyOwners = currentResponse();
    factsWithLegacyOwners.cards[0]!.scoreTrace!.evidenceResponsibility.summaries.pop();
    const parsedWithFacts = SafetyScoreV9CurrentResponseSchema.parse(factsWithLegacyOwners);
    expect(parsedWithFacts.cards[0]?.scoreTrace.evidenceResponsibility.facts).toBeDefined();
    expect(parsedWithFacts.cards[0]?.scoreTrace.evidenceResponsibility.summaries).toHaveLength(5);

    // A non-canonical owner set is still refused: dropping an interior owner is
    // corruption, not an older writer.
    const nonCanonical = currentResponse();
    nonCanonical.cards[0]!.scoreTrace!.evidenceResponsibility.summaries.splice(1, 1);
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(nonCanonical)).toThrow(
      /must preserve a supported canonical owner order/,
    );
  });

  it("requires the self-describing score trace on every current V9 card", () => {
    const parsed = SafetyScoreV9CurrentResponseSchema.parse(currentResponse());
    expect(parsed.schemaVersion).toBe(5);
    expect(parsed.cards[0]?.scoreTrace.aggregation?.method).toBe("smooth-bounded-headroom");
    expect(parsed.cards[0]?.scoreTrace.legacyAliases.pegAdjustedScore).toBe(
      "post-deployment-pre-cap-score",
    );
    expect(SafetyScoreV9ResponseSchema.parse(parsed).schemaVersion).toBe(5);

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

  it("accepts bounded D attribution and expired-publication ownership", () => {
    const bounded = boundedResponse();
    expect(SafetyScoreV9CurrentResponseSchema.parse(bounded).cards[0]?.grade).toBe("D");

    const expiredPublication = structuredClone(bounded);
    expiredPublication.cards[0]!.scoreTrace.boundedUncertaintyAttribution.items[0]!.responsibility =
      "published-evidence-expired";
    expiredPublication.cards[0]!.scoreTrace.evidenceResponsibility.summaries[0] = {
      responsibility: "integration-missing",
      factCount: 0,
      criticalFactCount: 0,
      reasonCodes: [],
    };
    expiredPublication.cards[0]!.scoreTrace.evidenceResponsibility.summaries[5] = {
      responsibility: "published-evidence-expired",
      factCount: 1,
      criticalFactCount: 0,
      reasonCodes: ["bounded-mechanism-review"],
    };
    const parsedExpiredPublication = SafetyScoreV9CurrentResponseSchema.parse(expiredPublication);
    expect(parsedExpiredPublication.cards[0]?.scoreTrace.boundedUncertaintyAttribution.items[0]?.responsibility)
      .toBe("published-evidence-expired");

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
    { name: "reclassifiedBoundedReason", error: /requires a non-bounded policy reason code/, mutate: (card: ReturnType<typeof boundedResponse>["cards"][number]) => {
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
  ])("rejects $name attribution", ({ mutate, error }) => {
    const invalid = boundedResponse();
    mutate(invalid.cards[0]!);
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(invalid)).toThrow(error);
  });

  it("requires attribution to a binding minimum serial parent, including ties and cycles", () => {
    const higherParent = boundedResponse().cards[0]!;
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
      { upstreamAssetId: "higher", score: 45, blocked: false },
      { upstreamAssetId: "lower", score: 40, blocked: false },
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

  it("requires null scores to agree with NR membership and reasons", () => {
    const invalid = currentResponse();
    Object.assign(invalid.cards[0], { score: null });
    expect(() => SafetyScoreV9ResponseSchema.parse(invalid)).toThrow(/NR grade and null score must agree/);
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
