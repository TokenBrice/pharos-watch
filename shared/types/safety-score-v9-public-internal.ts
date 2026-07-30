import {
  C_MINUS_MIN_SCORE,
  DANGER_PEG_MULTIPLIER_FLOOR,
  numbersAgree,
  roundAttributionValue,
  SCORE_TOLERANCE,
  V9_BOUNDED_ATTRIBUTION_REASON_CODE_SET,
} from "./safety-score-v9-public-facts";
import { V9ReasonCodeSchema, type V9ReasonCode } from "./safety-score-v9";

interface V9CardCap {
  kind: string;
  limit: number;
  source: string;
  reason: string;
  binding: boolean;
}

interface V9CardPillar {
  score: number | null;
  reasons: readonly { code: V9ReasonCode; path: string | null; message: string }[];
}

interface V9SerialDependency {
  upstreamAssetId: string;
  score: number | null;
  blocked: boolean;
}

interface V9WrapperParentLimit {
  parentScore: number;
  limit: number;
  factsComplete: boolean;
  fallbackDiscount: number;
  localRiskDiscount: number;
  form: string;
  missingFacts: readonly { factClass: string; disposition: string }[];
  adjustments: readonly { factKey: string; discountPoints: number }[];
}

interface V9ScoreAdjustment {
  capRelief: { source: string; kind: string; toLimit: number };
  publishedScoreBefore: number;
}

interface V9ScoreTraceBase {
  stages: {
    weightedPillarMean: number | null;
    pegMultiplier: number | null;
    preCapScore: number | null;
    publishedScore: number | null;
  };
  wrapperParentLimit: V9WrapperParentLimit | null;
  aggregation: {
    weakestPillar: string;
    weakestScore: number;
    weightedPillarMean: number;
  } | null;
  adverseAttribution: {
    items: readonly { source: string; path: string; message: string }[];
  };
  boundedUncertaintyAttribution: {
    items: readonly {
      source: string;
      code: V9ReasonCode;
      path: string;
      message: string;
      responsibility: string;
    }[];
  };
  evidenceResponsibility: {
    summaries: readonly {
      responsibility: string;
      factCount: number;
      criticalFactCount: number;
      reasonCodes: readonly V9ReasonCode[];
    }[];
  };
}

type V9CardScoreTrace =
  | V9ScoreTraceBase
  | (V9ScoreTraceBase & { scoreAdjustments: readonly V9ScoreAdjustment[] });

interface SafetyScoreV9CardRefinementInput {
  score: number | null;
  grade: string;
  qualityScore: number | null;
  pegMultiplier: number | null;
  pegAdjustedScore: number | null;
  pillars: { backing: V9CardPillar; exit: V9CardPillar; control: V9CardPillar };
  weakestPillar: { pillar: string; score: number } | null;
  caps: readonly V9CardCap[];
  bindingCap: V9CardCap | null;
  dependencies: { serial: readonly V9SerialDependency[]; cycleBlocked: boolean };
  scoreTrace?: V9CardScoreTrace;
}

interface V9CardWithDependencies {
  dependencies: { serial: readonly V9SerialDependency[] };
}

export function attributedSerialParent(
  card: V9CardWithDependencies,
  path: string,
  message: string,
): V9SerialDependency | null {
  const parent = [...card.dependencies.serial]
    .sort((left, right) => right.upstreamAssetId.length - left.upstreamAssetId.length)
    .find((dependency) => {
      const pathPrefix = `parent:${dependency.upstreamAssetId}:`;
      const messagePrefix = `Required parent ${dependency.upstreamAssetId}: `;
      return path.startsWith(pathPrefix) && message.startsWith(messagePrefix);
    });
  return parent ?? null;
}

export function refineCard(
  card: SafetyScoreV9CardRefinementInput,
  ctx: { addIssue: (issue: { code: "custom"; path?: PropertyKey[]; message: string }) => void },
): void {
  const scoreTrace = card.scoreTrace;
  if (scoreTrace !== undefined) {
    const stages = scoreTrace.stages;
    const serialParents = card.dependencies.serial;
    const serialParentsResolved =
      serialParents.length > 0 &&
      !card.dependencies.cycleBlocked &&
      serialParents.every((dependency) => !dependency.blocked && dependency.score !== null);
    const rawParentScore = serialParentsResolved
      ? Math.min(...serialParents.map((dependency) => dependency.score!))
      : null;
    const wrapperParentLimit = scoreTrace.wrapperParentLimit;
    const parentCaps = card.caps.filter((cap) => cap.source === "parent");
    if (
      wrapperParentLimit !== null &&
      (
        rawParentScore === null ||
        !numbersAgree(wrapperParentLimit.parentScore, rawParentScore) ||
        parentCaps.length !== 1 ||
        parentCaps[0]!.kind !== "parent" ||
        !numbersAgree(parentCaps[0]!.limit, wrapperParentLimit.limit)
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["scoreTrace", "wrapperParentLimit"],
        message: "V9 wrapper parent limit must reconcile to the resolved minimum serial parent and parent cap",
      });
    }
    if (
      card.bindingCap?.source === "parent" &&
      (
        card.bindingCap.kind !== "parent" ||
        rawParentScore === null ||
        !numbersAgree(
          card.bindingCap.limit,
          wrapperParentLimit?.limit ?? rawParentScore,
        )
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["bindingCap"],
        message: "V9 binding parent cap must reconcile to the resolved minimum serial parent",
      });
    }
    for (const [field, legacy, explicit] of [
      ["weightedPillarMean", card.qualityScore, stages.weightedPillarMean],
      ["pegMultiplier", card.pegMultiplier, stages.pegMultiplier],
      ["preCapScore", card.pegAdjustedScore, stages.preCapScore],
      ["publishedScore", card.score, stages.publishedScore],
    ] as const) {
      if (!numbersAgree(legacy, explicit)) {
        ctx.addIssue({
          code: "custom",
          path: ["scoreTrace", "stages", field],
          message: `V9 explicit ${field} must match its retained card field`,
        });
      }
    }
    if ("scoreAdjustments" in scoreTrace) {
      for (const [index, adjustment] of scoreTrace.scoreAdjustments.entries()) {
        const relievedCaps = card.caps.filter(
          (cap) =>
            cap.source === adjustment.capRelief.source &&
            cap.kind === adjustment.capRelief.kind,
        );
        if (
          relievedCaps.length !== 1 ||
          !numbersAgree(relievedCaps[0]!.limit, adjustment.capRelief.toLimit)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "scoreAdjustments", index, "capRelief"],
            message: "V9 score adjustment cap relief must match exactly one current card cap",
          });
        }
        const unchangedCaps = card.caps.filter(
          (cap) =>
            cap.source !== adjustment.capRelief.source ||
            cap.kind !== adjustment.capRelief.kind,
        );
        if (
          unchangedCaps.some(
            (cap) => adjustment.publishedScoreBefore > cap.limit + SCORE_TOLERANCE,
          )
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "scoreAdjustments", index, "publishedScoreBefore"],
            message: "V9 ordinary published score cannot exceed an unchanged card cap",
          });
        }
      }
    }
    if (
      scoreTrace.aggregation !== null &&
      (
        card.weakestPillar === null ||
        scoreTrace.aggregation.weakestPillar !== card.weakestPillar.pillar ||
        !numbersAgree(scoreTrace.aggregation.weakestScore, card.weakestPillar.score) ||
        !numbersAgree(scoreTrace.aggregation.weightedPillarMean, card.qualityScore)
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["scoreTrace", "aggregation"],
        message: "V9 aggregation trace must match the card's pillar summary",
      });
    }
    for (const item of scoreTrace.adverseAttribution.items) {
      if (
        item.source === "active-depeg" &&
        (card.bindingCap?.source !== "active-depeg" || item.path !== "peg:active-depeg")
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["scoreTrace", "adverseAttribution", "items"],
          message: "V9 active-depeg attribution requires its canonical path and a binding active-depeg cap",
        });
      }
      if (item.source === "parent-score") {
        const parent = attributedSerialParent(card, item.path, item.message);
        if (
          card.bindingCap?.source !== "parent" ||
          parent === null ||
          parent.blocked ||
          parent.score === null ||
          parent.score >= C_MINUS_MIN_SCORE ||
          rawParentScore === null ||
          !numbersAgree(parent.score, rawParentScore)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "adverseAttribution", "items"],
            message: "V9 parent attribution requires the binding low minimum serial parent",
          });
        }
      }
      if (item.source === "peg-performance") {
        const pegMultiplier = stages.pegMultiplier;
        const expectedMessage =
          pegMultiplier === null
            ? null
            : `Measured peg multiplier is ${roundAttributionValue(pegMultiplier, 6)}.`;
        if (
          pegMultiplier === null ||
          pegMultiplier >= DANGER_PEG_MULTIPLIER_FLOOR ||
          item.path !== "peg:historical-performance" ||
          item.message !== expectedMessage
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "adverseAttribution", "items"],
            message: "V9 peg-performance attribution must match the measured danger multiplier",
          });
        }
      }
      if (item.source === "pillar-score") {
        const match = /^pillar:(backing|exit|control):/.exec(item.path);
        const pillarScore =
          match === null
            ? null
            : card.pillars[match[1] as "backing" | "exit" | "control"].score;
        if (
          match === null ||
          pillarScore === null ||
          ((card.grade === "D" || card.grade === "F") &&
            pillarScore >= C_MINUS_MIN_SCORE)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "adverseAttribution", "items"],
            message: "V9 pillar attribution must name a score-bearing causal pillar",
          });
        }
      }
      if (item.source === "reason") {
        const matchingPillarReasonCodes = Object.values(card.pillars).flatMap(
          (pillar) =>
            pillar.score !== null && pillar.score < C_MINUS_MIN_SCORE
              ? pillar.reasons
                  .filter(
                    (reason) =>
                      reason.path === item.path &&
                      reason.message === item.message,
                  )
                  .map((reason) => reason.code)
              : [],
        );
        const bindingReasonCode =
          card.bindingCap?.source === "evidence" &&
          card.bindingCap.kind.startsWith("reason:") &&
          card.bindingCap.reason === item.message
            ? V9ReasonCodeSchema.safeParse(
                card.bindingCap.kind.slice("reason:".length),
              )
            : null;
        const matchingReasonCodes = [
          ...new Set([
            ...matchingPillarReasonCodes,
            ...(bindingReasonCode?.success ? [bindingReasonCode.data] : []),
          ]),
        ];
        if (matchingReasonCodes.length === 0) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "adverseAttribution", "items"],
            message: "V9 reason attribution must match a low pillar reason or binding evidence cap",
          });
        }
        if (
          matchingReasonCodes.length > 0 &&
          matchingReasonCodes.every((code) =>
            V9_BOUNDED_ATTRIBUTION_REASON_CODE_SET.has(code),
          )
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "adverseAttribution", "items"],
            message: "V9 measured-adverse reason attribution requires a non-bounded policy reason code",
          });
        }
        const conflictsWithBoundedAttribution =
          scoreTrace.boundedUncertaintyAttribution.items.some(
            (candidate) =>
              candidate.path === item.path &&
              candidate.message === item.message,
          );
        if (conflictsWithBoundedAttribution) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "adverseAttribution", "items"],
            message: "V9 measured-adverse reason attribution cannot also be declared as bounded uncertainty",
          });
        }
        const measuredSummary =
          scoreTrace.evidenceResponsibility.summaries.find(
            (summary) => summary.responsibility === "measured-adverse",
          );
        if (
          measuredSummary === undefined ||
          measuredSummary.factCount === 0 ||
          !matchingReasonCodes.some((code) =>
            measuredSummary.reasonCodes.includes(code),
          )
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "adverseAttribution", "items"],
            message: "V9 reason attribution must reconcile to a measured-adverse evidence reason code",
          });
        }
      }
      if (
        item.source === "structural-signal" &&
        !/^structural:[a-z0-9-]+:(low|moderate|high|critical)$/.test(item.path) &&
        !/^scenario-(cap|pillar):/.test(item.path)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["scoreTrace", "adverseAttribution", "items"],
          message: "V9 structural attribution requires a canonical structural or scenario path",
        });
      }
      if (item.source === "track-record") {
        ctx.addIssue({
          code: "custom",
          path: ["scoreTrace", "adverseAttribution", "items"],
          message: "V9 track-record ceilings cannot authorize measured-adverse attribution",
        });
      }
      if (item.source === "wrapper-local") {
        const limit = scoreTrace.wrapperParentLimit;
        const adjustment = limit?.adjustments.find(
          (candidate) =>
            item.path === `wrapper-local:${candidate.factKey}` &&
            candidate.discountPoints > 0,
        );
        const expectedMessage =
          adjustment === undefined
            ? null
            : `Reviewed wrapper-local ${adjustment.factKey} risk contributes ` +
              `${adjustment.discountPoints} discount points.`;
        if (
          card.bindingCap?.source !== "parent" ||
          limit === null ||
          (!limit.factsComplete &&
            limit.localRiskDiscount < limit.fallbackDiscount) ||
          adjustment === undefined ||
          item.message !== expectedMessage
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "adverseAttribution", "items"],
            message: "V9 wrapper adverse attribution must reconcile to a binding reviewed local-risk discount",
          });
        }
      }
    }
    for (const item of scoreTrace.boundedUncertaintyAttribution.items) {
      if (item.source === "reason") {
        const matchesPillarReason = Object.values(card.pillars).some((pillar) =>
          pillar.score !== null &&
          pillar.score < C_MINUS_MIN_SCORE &&
          pillar.reasons.some(
            (reason) =>
              reason.code === item.code &&
              reason.path === item.path &&
              reason.message === item.message,
          ),
        );
        const matchesBindingReasonCap =
          card.bindingCap?.source === "evidence" &&
          card.bindingCap.kind === `reason:${item.code}` &&
          card.bindingCap.reason === item.message;
        if (!matchesPillarReason && !matchesBindingReasonCap) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "boundedUncertaintyAttribution", "items"],
            message: "V9 direct bounded attribution must match a low pillar reason or binding reason cap",
          });
        }
      } else if (item.source === "parent-score") {
        const parent = attributedSerialParent(card, item.path, item.message);
        if (
          card.bindingCap?.source !== "parent" ||
          parent === null ||
          parent.blocked ||
          parent.score === null ||
          parent.score >= C_MINUS_MIN_SCORE ||
          rawParentScore === null ||
          !numbersAgree(parent.score, rawParentScore)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "boundedUncertaintyAttribution", "items"],
            message: "V9 parent bounded attribution requires the binding low minimum serial parent",
          });
        }
      } else {
        const limit = scoreTrace.wrapperParentLimit;
        const missingFact = limit?.missingFacts.find(
          (candidate) =>
            item.path === `wrapper-local:${candidate.factClass}` &&
            item.responsibility === candidate.disposition,
        );
        const expectedMessage =
          missingFact === undefined || limit === null
            ? null
            : `Wrapper-local ${missingFact.factClass} is ${missingFact.disposition}; ` +
              `the ${limit.form} fallback discount bounds the unresolved local layer.`;
        if (
          item.code !== "bounded-mechanism-review" ||
          card.bindingCap?.source !== "parent" ||
          limit === null ||
          limit.factsComplete ||
          limit.fallbackDiscount <= limit.localRiskDiscount ||
          missingFact === undefined ||
          item.message !== expectedMessage
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "boundedUncertaintyAttribution", "items"],
            message: "V9 wrapper bounded attribution must reconcile to a binding fallback discount",
          });
        }
      }
    }
    if (
      card.score !== null &&
      scoreTrace.evidenceResponsibility.summaries.some(
        (summary) => summary.criticalFactCount > 0,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["scoreTrace", "evidenceResponsibility"],
        message: "A rated V9 card cannot retain critical unresolved facts",
      });
    }
    if (
      card.grade === "D" &&
      scoreTrace.adverseAttribution.items.length === 0 &&
      scoreTrace.boundedUncertaintyAttribution.items.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["scoreTrace", "boundedUncertaintyAttribution"],
        message: "A V9 D card requires causal measured-adverse or bounded-uncertainty attribution",
      });
    }
    if (card.grade === "F" && scoreTrace.adverseAttribution.items.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["scoreTrace", "adverseAttribution"],
        message: "A V9 F card requires causal measured-adverse attribution",
      });
    }
  }
}
