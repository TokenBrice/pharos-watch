import {
  C_MINUS_MIN_SCORE,
  DANGER_PEG_MULTIPLIER_FLOOR,
  numbersAgree,
  roundAttributionValue,
  SCORE_TOLERANCE,
} from "./safety-score-v9-public-facts";
import { V9ReasonCodeSchema } from "./safety-score-v9";
import type { SafetyScoreV9CardRefinementInput, SafetyScoreV9CardWithDependencies } from "./safety-score-v9-public-shapes";
import type { SafetyScoreV9SerialDependencyInput } from "./safety-score-v9-public-shapes";
import { V9_PILLAR_WEIGHTS } from "./safety-score-v9-grade";
import { iterateEvidenceResponsibilityFacts } from "./safety-score-v9-public-evidence-facts";
import { resolveV9EffectiveScoringWeight } from "./safety-score-v9-public-causes";
import type { SafetyScoreV9BackingBreakdown } from "./safety-score-v9-public-breakdowns";

type BoundedAttributionItem = SafetyScoreV9CardRefinementInput["scoreTrace"]["boundedUncertaintyAttribution"]["items"][number];
type BoundedBackingContribution = Pick<SafetyScoreV9BackingBreakdown["components"][number],
  "score" | "cause" | "causeGapRefs" | "scoringDisposition" | "effectiveScoringWeight">;

function matchesBoundedBackingComponent(card: SafetyScoreV9CardRefinementInput, item: BoundedAttributionItem): boolean {
  const backing = card.breakdowns?.backing;
  if (backing === undefined || backing.aggregationDisposition === "excluded-a-b" ||
      card.pillars.backing.aggregationDisposition === "excluded-a-b" ||
      card.pillars.backing.score === null || backing.aggregationWeight <= 0 ||
      !card.pillars.backing.reasons.some(reason =>
        reason.code === item.code && reason.path === item.path && reason.message === item.message &&
        reason.cause === item.cause && item.causeGapRefs.every(ref => reason.causeGapRefs?.includes(ref)))) {
    return false;
  }
  let matchesCausalFact = false;
  for (const fact of iterateEvidenceResponsibilityFacts(card.scoreTrace.evidenceResponsibility)) {
    if (fact[0] === item.code && fact[1] === item.path && fact[3] === item.responsibility &&
        fact[5] === item.cause && item.causeGapRefs.every(ref => fact[6].includes(ref))) {
      matchesCausalFact = true;
      break;
    }
  }
  if (!matchesCausalFact) return false;
  const matchesContribution = (key: string, contribution: BoundedBackingContribution): boolean =>
    contribution.score !== null && contribution.score < C_MINUS_MIN_SCORE &&
    contribution.scoringDisposition === "bounded-uncertainty" && (contribution.cause === "C" || contribution.cause === "U") &&
    resolveV9EffectiveScoringWeight(contribution) > 0 &&
    item.causeGapRefs.every(ref => contribution.causeGapRefs?.includes(ref)) &&
    item.causeGapRefs.some(ref => item.path === `backing:${key}:bounded-component:cause:${ref}`);
  return backing.components.some(component =>
    component.score !== null && resolveV9EffectiveScoringWeight(component) > 0 &&
    component.scoringDisposition !== "excluded-pipeline" && component.scoringDisposition !== "excluded-uncurated" &&
    component.scoringDisposition !== "not-applicable" &&
    (matchesContribution(component.key, component) ||
      (component.factors?.some(factor => matchesContribution(factor.componentKey, factor)) ?? false)));
}

export function attributedSerialParent(
  card: SafetyScoreV9CardWithDependencies,
  path: string,
  message: string,
): SafetyScoreV9SerialDependencyInput | null {
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
    // A wrapper parent limit is the exact MEASUREMENT: parent score minus the
    // summed local-risk discount plus documented credit, verified to the point
    // in SafetyScoreV9WrapperParentLimitSchema. A published cap limit is that
    // measurement quantized into the published score space, floored so a
    // ceiling can never be raised by rounding. The two therefore agree up to
    // one quantization step, not exactly: a 5.45-point discount off a parent of
    // 55 measures 49.55 and publishes a ceiling of 49.
    const capAgreesWithWrapperLimit = (capLimit: number, measuredLimit: number): boolean =>
      numbersAgree(capLimit, measuredLimit) ||
      (capLimit <= measuredLimit + SCORE_TOLERANCE && measuredLimit - capLimit < 1);

    if (
      wrapperParentLimit !== null &&
      (
        rawParentScore === null ||
        !numbersAgree(wrapperParentLimit.parentScore, rawParentScore) ||
        parentCaps.length !== 1 ||
        parentCaps[0]!.kind !== "parent" ||
        !capAgreesWithWrapperLimit(parentCaps[0]!.limit, wrapperParentLimit.limit)
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
        !capAgreesWithWrapperLimit(
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
    if (scoreTrace.aggregation !== null) {
      const aggregation = scoreTrace.aggregation;
      const included = (["backing", "exit", "control"] as const).filter((pillar) => card.pillars[pillar].aggregationDisposition !== "excluded-a-b").sort();
      const weightSum = included.reduce((sum, pillar) => sum + V9_PILLAR_WEIGHTS[pillar], 0);
      const mean = included.reduce((sum, pillar) => sum + (card.pillars[pillar].score ?? 0) * aggregation.effectiveScoringWeights[pillar], 0);
      if (JSON.stringify(included) !== JSON.stringify(aggregation.includedPillars) ||
          included.some((pillar) => card.pillars[pillar].score === null ||
            Math.abs(aggregation.effectiveScoringWeights[pillar] - V9_PILLAR_WEIGHTS[pillar] / weightSum) > 1e-9) ||
          !numbersAgree(mean, aggregation.supportCeiling)) {
        ctx.addIssue({ code: "custom", path: ["scoreTrace", "aggregation"], message: "Aggregation must use the included pillars and renormalized policy weights only" });
      }
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
        let hasMeasuredReasonFact = false;
        for (const fact of iterateEvidenceResponsibilityFacts(scoreTrace.evidenceResponsibility)) {
          if (fact[1] === item.path && fact[3] === "measured-adverse" && fact[5] === "D" &&
              matchingReasonCodes.includes(fact[0])) {
            hasMeasuredReasonFact = true;
            break;
          }
        }
        if (!hasMeasuredReasonFact) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "adverseAttribution", "items"],
            message: "V9 measured-adverse reason attribution requires its exact D evidence fact",
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
          (measuredSummary.factCount ?? 0) === 0 ||
          !matchingReasonCodes.some((code) =>
            measuredSummary.reasonCodes?.includes(code),
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
    // An unrated card deliberately withholds the binding assertion: its score
    // does not exist, so no ceiling can be said to have constrained it. Checks
    // that reconcile attribution against `bindingCap` therefore fall back to the
    // declared candidate list when the card is NR. The attribution still has to
    // name a real ceiling — it just cannot be required to name a binding one.
    const reconcilableCaps =
      card.score === null ? card.caps : card.bindingCap === null ? [] : [card.bindingCap];
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
        const matchesReasonCap = reconcilableCaps.some(
          (cap) =>
            cap.source === "evidence" &&
            cap.kind === `reason:${item.code}` &&
            cap.reason === item.message,
        );
        if (!matchesPillarReason && !matchesReasonCap && !matchesBoundedBackingComponent(card, item)) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "boundedUncertaintyAttribution", "items"],
            message: "V9 direct bounded attribution must match a low pillar reason, charged backing component, or binding reason cap",
          });
        }
      } else if (item.source === "parent-score") {
        const parent = attributedSerialParent(card, item.path, item.message);
        if (
          !reconcilableCaps.some((cap) => cap.source === "parent") ||
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
        (summary) => (summary.criticalFactCount ?? 0) > 0,
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
