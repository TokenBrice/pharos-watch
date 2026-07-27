import type {
  V9PublicationHoldReason,
} from "@shared/types/report-cards-v9";
import type {
  SafetyScoreV9Card,
  SafetyScoreV9Response,
} from "@shared/types/safety-score-v9-public";
import type { V9Grade } from "@shared/types/safety-score-v9";
import { z } from "zod";
import type {
  SafetyScoreV9CoverageFloor,
  SafetyScoreV9ShadowEnvelope,
} from "./safety-score-v9-shadow";

export const V9PublicationInputHealthSchema = z
  .object({
    dex: z
      .object({
        state: z.enum(["current", "stale", "unavailable"]),
        generationId: z.string().min(1).nullable(),
        updatedAtSec: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    redemption: z
      .object({
        state: z.enum(["current", "stale", "unavailable", "not-applicable"]),
        generationId: z.string().min(1).nullable(),
        updatedAtSec: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    liveReserves: z
      .object({
        state: z.enum(["available", "unavailable"]),
      })
      .strict(),
  })
  .strict();

export type V9PublicationInputHealth = z.infer<
  typeof V9PublicationInputHealthSchema
>;

export type V9PublicationAssessment =
  | { decision: "publish"; reasons: [] }
  | { decision: "hold"; reasons: V9PublicationHoldReason[] };

const GRADE_RANK: Record<V9Grade, number> = {
  "A+": 11,
  A: 10,
  "A-": 9,
  "B+": 8,
  B: 7,
  "B-": 6,
  "C+": 5,
  C: 4,
  "C-": 3,
  D: 2,
  F: 1,
  NR: 0,
};

function producerFailedBindings(card: SafetyScoreV9Card) {
  if (!("scoreTrace" in card)) return [];
  if (!("boundedUncertaintyAttribution" in card.scoreTrace)) return [];
  return card.scoreTrace.boundedUncertaintyAttribution.items.filter(
    (item) => item.responsibility === "producer-failed",
  );
}

function bindingKey(
  item: ReturnType<typeof producerFailedBindings>[number],
  effect: Extract<
    V9PublicationHoldReason,
    { code: "producer-failed-downgrade" | "producer-failed-nr" }
  >["effect"],
): string {
  return [
    item.source,
    item.code,
    item.path,
    effect,
  ].join("\u0000");
}

function cardDeteriorated(
  candidate: SafetyScoreV9Card,
  accepted: SafetyScoreV9Card,
): boolean {
  if (accepted.grade !== "NR" && candidate.grade === "NR") return true;
  if (
    accepted.score !== null &&
    candidate.score !== null &&
    candidate.score < accepted.score
  ) {
    return true;
  }
  return GRADE_RANK[candidate.grade] < GRADE_RANK[accepted.grade];
}

function scoringIdentityMatches(
  candidate: SafetyScoreV9Response,
  accepted: SafetyScoreV9Response,
): boolean {
  return (
    candidate.policyVersion === accepted.policyVersion &&
    candidate.policy.id === accepted.policy.id &&
    candidate.policy.semanticDigest === accepted.policy.semanticDigest &&
    candidate.evaluationBuildDigest === accepted.evaluationBuildDigest
  );
}

function inputHealthReasons(
  health: V9PublicationInputHealth,
): V9PublicationHoldReason[] {
  const reasons: V9PublicationHoldReason[] = [];
  if (health.dex.state === "stale") reasons.push({ code: "dex-stale" });
  if (health.dex.state === "unavailable") {
    reasons.push({ code: "dex-unavailable" });
  }
  if (health.redemption.state === "stale") {
    reasons.push({ code: "redemption-stale" });
  }
  if (health.redemption.state === "unavailable") {
    reasons.push({ code: "redemption-unavailable" });
  }
  if (health.liveReserves.state === "unavailable") {
    reasons.push({ code: "live-reserves-unavailable" });
  }
  return reasons;
}

export function assessV9Publication(input: {
  inputHealth: V9PublicationInputHealth;
  candidate: SafetyScoreV9Response;
  acceptedEnvelope: SafetyScoreV9ShadowEnvelope | null;
  coverageFloors: readonly SafetyScoreV9CoverageFloor[];
}): V9PublicationAssessment {
  const reasons = inputHealthReasons(
    V9PublicationInputHealthSchema.parse(input.inputHealth),
  );
  const failedFloorIds = input.coverageFloors
    .filter((floor) => floor.status === "fail")
    .map((floor) => floor.id)
    .sort();
  if (failedFloorIds.length > 0) {
    reasons.push({
      code: "coverage-floor-failed",
      floorIds: failedFloorIds,
    });
  }

  if (
    input.acceptedEnvelope !== null &&
    scoringIdentityMatches(
      input.candidate,
      input.acceptedEnvelope.candidate,
    )
  ) {
    const acceptedById = new Map(
      input.acceptedEnvelope.candidate.cards.map((card) => [card.id, card]),
    );
    for (const candidate of input.candidate.cards) {
      const accepted = acceptedById.get(candidate.id);
      if (!accepted || !cardDeteriorated(candidate, accepted)) continue;
      const acceptedEffect =
        accepted.grade === "NR"
          ? "not-rated"
          : "score-or-grade-downgrade";
      const acceptedBindings = new Set(
        producerFailedBindings(accepted).map((binding) =>
          bindingKey(binding, acceptedEffect),
        ),
      );
      const effect =
        accepted.grade !== "NR" && candidate.grade === "NR"
          ? "not-rated"
          : "score-or-grade-downgrade";
      for (const binding of producerFailedBindings(candidate)) {
        if (acceptedBindings.has(bindingKey(binding, effect))) continue;
        reasons.push({
          code:
            effect === "not-rated"
              ? "producer-failed-nr"
              : "producer-failed-downgrade",
          assetId: candidate.id,
          source: binding.source,
          reasonCode: binding.code,
          path: binding.path,
          effect,
        });
      }
    }
  }

  const boundedReasons = reasons
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    )
    .slice(0, 24);
  return boundedReasons.length === 0
    ? { decision: "publish", reasons: [] }
    : { decision: "hold", reasons: boundedReasons };
}
