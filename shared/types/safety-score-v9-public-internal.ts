import { issue } from "./safety-schema-primitives";
import type { z } from "zod";
import {
  C_MINUS_MIN_SCORE,
  DANGER_PEG_MULTIPLIER_FLOOR,
  numbersAgree,
  roundAttributionValue,
  SCORE_TOLERANCE,
} from "./safety-score-v9-public-facts";
import type { SafetyScoreV9CardRefinementInput, SafetyScoreV9CardWithDependencies } from "./safety-score-v9-public-shapes";
import type { SafetyScoreV9SerialDependencyInput } from "./safety-score-v9-public-shapes";
import { scoreToGrade, V9_PILLAR_WEIGHTS } from "./safety-score-v9-grade";
import { iterateEvidenceResponsibilityFacts, refineEvidenceFactPathPrefixes } from "./safety-score-v9-public-evidence-facts";
import { resolveV9EffectiveScoringWeight } from "./safety-score-v9-public-causes";
import type { SafetyScoreV9BackingBreakdown } from "./safety-score-v9-public-breakdowns";
import type { V9QualityPillar } from "./safety-score-v9";
import type { SafetyScoreV9HistoricalScoreTraceSchema } from "./safety-score-v9-public-trace";
const EVIDENCE_FACT_PATH = ["scoreTrace", "evidenceResponsibility"] as const;

type BoundedAttributionItem = SafetyScoreV9CardRefinementInput["scoreTrace"]["boundedUncertaintyAttribution"]["items"][number];
type BoundedBackingContribution = Pick<SafetyScoreV9BackingBreakdown["components"][number],
  "score" | "cause" | "causeGapRefs" | "scoringDisposition" | "effectiveScoringWeight">;
type HistoricalScoreAdjustment = z.output<typeof SafetyScoreV9HistoricalScoreTraceSchema>["scoreAdjustments"][number];

function matchesBoundedBackingComponent(card: SafetyScoreV9CardRefinementInput, item: BoundedAttributionItem): boolean {
  const backing = card.breakdowns?.backing;
  if (backing === undefined || (backing.aggregationDisposition ?? "included") !== "included" ||
      (card.pillars.backing.aggregationDisposition ?? "included") !== "included" ||
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
    contribution.score !== null &&
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
  ctx: Pick<z.RefinementCtx, "addIssue">,
): void {
  const scoreTrace = card.scoreTrace;
  // Causal D/F proofs belong to the computed band; a 10.26 grade hold may
  // retain a different published letter beside the raw score.
  const rawGrade = card.score === null ? card.grade : scoreToGrade(card.score);
  if (scoreTrace !== undefined) {
    if (!refineEvidenceFactPathPrefixes(scoreTrace.evidenceResponsibility, ctx, EVIDENCE_FACT_PATH)) return;
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
    // Parent measurements may retain a fractional legacy discount in archived
    // cards; current form-only ceilings are already floored at their source.
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
      issue(ctx, ["scoreTrace", "wrapperParentLimit"], "V9 wrapper parent limit must reconcile to the resolved minimum serial parent and parent cap");
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
      issue(ctx, ["bindingCap"], "V9 binding parent cap must reconcile to the resolved minimum serial parent");
    }
    for (const [field, legacy, explicit] of [
      ["weightedPillarMean", card.qualityScore, stages.weightedPillarMean],
      ["pegMultiplier", card.pegMultiplier, stages.pegMultiplier],
      ["preCapScore", card.pegAdjustedScore, stages.preCapScore],
      ["publishedScore", card.score, stages.publishedScore],
    ] as const) {
      if (!numbersAgree(legacy, explicit)) {
        issue(ctx, ["scoreTrace", "stages", field], `V9 explicit ${field} must match its retained card field`);
      }
    }
    if ("scoreAdjustments" in scoreTrace) {
      for (const [index, adjustment] of scoreTrace.scoreAdjustments.entries()) {
        // Both arrays are schema-admitted; iteration exposes their common live shape.
        const relief = (adjustment as Partial<HistoricalScoreAdjustment>).capRelief;
        if (relief !== undefined) {
          const relievedCaps = card.caps.filter(cap => cap.source === relief.source && cap.kind === relief.kind);
          if (relievedCaps.length !== 1 || !numbersAgree(relievedCaps[0]!.limit, relief.toLimit)) {
            issue(ctx, ["scoreTrace", "scoreAdjustments", index, "capRelief"], "V9 score adjustment cap relief must match exactly one current card cap");
          }
        }
        const unchangedCaps = relief === undefined ? card.caps
          : card.caps.filter(cap => cap.source !== relief.source || cap.kind !== relief.kind);
        if (
          unchangedCaps.some(
            (cap) => adjustment.publishedScoreBefore > cap.limit + SCORE_TOLERANCE,
          )
        ) {
          issue(ctx, ["scoreTrace", "scoreAdjustments", index, "publishedScoreBefore"], "V9 ordinary published score cannot exceed an unchanged card cap");
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
      issue(ctx, ["scoreTrace", "aggregation"], "V9 aggregation trace must match the card's pillar summary");
    }
    if (scoreTrace.aggregation !== null) {
      const aggregation = scoreTrace.aggregation;
      const included = (["backing", "exit", "control"] as const).filter((pillar) => (card.pillars[pillar].aggregationDisposition ?? "included") === "included").sort();
      const pricedUnknowns = aggregation.pricedUnknownPillars;
      const scoringPillars: readonly V9QualityPillar[] = pricedUnknowns === undefined ? included : ["backing", "exit", "control"];
      const weightSum = scoringPillars.reduce<number>((sum, pillar) => sum + V9_PILLAR_WEIGHTS[pillar], 0);
      const price = (pillar: V9QualityPillar): number | null =>
        pricedUnknowns?.find((item) => item.pillar === pillar)?.score ?? card.pillars[pillar].score;
      const mean = scoringPillars.reduce<number>((sum, pillar) => sum + (price(pillar) ?? 0) * aggregation.effectiveScoringWeights[pillar], 0);
      if (JSON.stringify(included) !== JSON.stringify(aggregation.includedPillars) ||
          scoringPillars.some((pillar) => price(pillar) === null ||
            Math.abs(aggregation.effectiveScoringWeights[pillar] - V9_PILLAR_WEIGHTS[pillar] / weightSum) > 1e-9) ||
          aggregation.excludedPillars.some((pillar) => pricedUnknowns === undefined
            ? aggregation.effectiveScoringWeights[pillar] !== 0
            : card.pillars[pillar].score !== null || !pricedUnknowns.some((item) => item.pillar === pillar)) ||
          !numbersAgree(mean, aggregation.supportCeiling)) {
        ctx.addIssue({ code: "custom", path: ["scoreTrace", "aggregation"], message: "Aggregation must reconcile usable evidence, explicitly priced unknowns and policy weights" });
      }
    }
    for (const item of scoreTrace.adverseAttribution.items) {
      if (
        item.source === "active-depeg" &&
        (card.bindingCap?.source !== "active-depeg" || item.path !== "peg:active-depeg")
      ) {
        issue(ctx, ["scoreTrace", "adverseAttribution", "items"], "V9 active-depeg attribution requires its canonical path and a binding active-depeg cap");
      }
      if (item.source === "parent-score") {
        const parent = attributedSerialParent(card, item.path, item.message);
        if (
          card.bindingCap?.source !== "parent" ||
          parent === null ||
          parent.blocked ||
          parent.score === null ||
          rawParentScore === null ||
          !numbersAgree(parent.score, rawParentScore)
        ) {
          issue(ctx, ["scoreTrace", "adverseAttribution", "items"], "V9 parent attribution requires the binding minimum serial parent");
        }
      }
      if (item.source === "peg-performance") {
        const pegMultiplier = stages.pegMultiplier;
        // A six-decimal value represents a half-open rounding interval. Its
        // lower edge must intersect raw values strictly below the policy floor;
        // equality at the upper-exclusive floor + half-step is not adversity.
        const expectedMessage =
          pegMultiplier === null
            ? null
            : `Measured peg multiplier is ${roundAttributionValue(pegMultiplier, 6)}.`;
        if (
          pegMultiplier === null ||
          pegMultiplier >= DANGER_PEG_MULTIPLIER_FLOOR + 0.5 / 1_000_000 ||
          item.path !== "peg:historical-performance" ||
          item.message !== expectedMessage
        ) {
          issue(ctx, ["scoreTrace", "adverseAttribution", "items"], "V9 peg-performance attribution must match the measured danger multiplier");
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
          ((rawGrade === "D" || rawGrade === "F") &&
            pillarScore >= C_MINUS_MIN_SCORE)
        ) {
          issue(ctx, ["scoreTrace", "adverseAttribution", "items"], "V9 pillar attribution must name a score-bearing causal pillar");
        }
      }
      if (item.source === "reason") {
        const matchingReasonCodes = Object.values(card.pillars).flatMap(
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
        if (matchingReasonCodes.length === 0) {
          issue(ctx, ["scoreTrace", "adverseAttribution", "items"], "V9 reason attribution must match a low pillar reason");
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
          issue(ctx, ["scoreTrace", "adverseAttribution", "items"], "V9 measured-adverse reason attribution requires its exact D evidence fact");
        }
        const conflictsWithBoundedAttribution =
          scoreTrace.boundedUncertaintyAttribution.items.some(
            (candidate) =>
              candidate.path === item.path &&
              candidate.message === item.message,
          );
        if (conflictsWithBoundedAttribution) {
          issue(ctx, ["scoreTrace", "adverseAttribution", "items"], "V9 measured-adverse reason attribution cannot also be declared as bounded uncertainty");
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
          issue(ctx, ["scoreTrace", "adverseAttribution", "items"], "V9 reason attribution must reconcile to a measured-adverse evidence reason code");
        }
      }
      if (
        item.source === "structural-signal" &&
        !/^structural:[a-z0-9-]+:(low|moderate|high|critical)$/.test(item.path) &&
        !/^scenario-(cap|pillar):/.test(item.path)
      ) {
        issue(ctx, ["scoreTrace", "adverseAttribution", "items"], "V9 structural attribution requires a canonical structural or scenario path");
      }
      if (item.source === "realized-holder-loss" &&
          (card.bindingCap?.source !== "realized-holder-loss" || !item.path.startsWith("incident:"))) {
        issue(ctx, ["scoreTrace", "adverseAttribution", "items"], "Holder-loss attribution requires its incident witness and binding loss cap");
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
        const matchesPillarReason = !/:bounded-component:cause:\d+$/u.test(item.path) &&
          Object.entries(card.pillars).some(([key, pillar]) =>
          pillar.score !== null &&
          (pillar.aggregationDisposition ?? "included") === "included" &&
          (scoreTrace.aggregation?.effectiveScoringWeights[key as keyof typeof card.pillars] ?? 0) > 0 &&
          pillar.reasons.some(
            (reason) =>
              reason.code === item.code &&
              reason.path === item.path &&
              reason.message === item.message,
          ),
        );
        let matchesOwnedFact = false;
        for (const fact of iterateEvidenceResponsibilityFacts(scoreTrace.evidenceResponsibility)) {
          if (fact[0] === item.code && fact[1] === item.path && fact[3] === item.responsibility &&
              fact[5] === item.cause && item.causeGapRefs.every(ref => fact[6].includes(ref))) {
            matchesOwnedFact = true;
            break;
          }
        }
        if (!(matchesPillarReason && matchesOwnedFact) && !matchesBoundedBackingComponent(card, item)) {
          issue(ctx, ["scoreTrace", "boundedUncertaintyAttribution", "items"], "Direct bounded attribution must match an included pillar reason or charged backing component");
        }
      } else if (item.source === "parent-score") {
        const parent = attributedSerialParent(card, item.path, item.message);
        if (
          !reconcilableCaps.some((cap) => cap.source === "parent") ||
          parent === null ||
          parent.blocked ||
          parent.score === null ||
          rawParentScore === null ||
          !numbersAgree(parent.score, rawParentScore)
        ) {
          issue(ctx, ["scoreTrace", "boundedUncertaintyAttribution", "items"], "V9 parent bounded attribution requires the binding minimum serial parent");
        }
      }
    }
    if (
      card.score !== null &&
      scoreTrace.evidenceResponsibility.summaries.some(
        (summary) => (summary.criticalFactCount ?? 0) > 0,
      )
    ) {
      issue(ctx, ["scoreTrace", "evidenceResponsibility"], "A rated V9 card cannot retain critical unresolved facts");
    }
  }
}
