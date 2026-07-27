import type {
  V9PublicationHoldReason,
} from "@shared/types/report-cards-v9";
import type {
  SafetyScoreV9Card,
  SafetyScoreV9CurrentResponse,
} from "@shared/types/safety-score-v9-public";
import type { V9Grade } from "@shared/types/safety-score-v9";
import { z } from "zod";

export interface V9PublicationCoverageFloor {
  id: string;
  status: "pass" | "fail";
  observed: number | null;
  required: string;
  detail: string;
}

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

/** Minimum share of candidate assets without newly binding producer-failed deterioration. */
const V9_PRODUCER_FAILURE_MINIMUM_HEALTHY_ASSET_SHARE = 0.9;

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
  candidate: SafetyScoreV9CurrentResponse,
  accepted: SafetyScoreV9CurrentResponse,
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

function producerFailuresRequireGlobalHold(
  reasons: readonly Extract<
    V9PublicationHoldReason,
    { code: "producer-failed-downgrade" | "producer-failed-nr" }
  >[],
  totalAssetCount: number,
): boolean {
  const affectedAssetIds = [...new Set(reasons.map((reason) => reason.assetId))];
  if (affectedAssetIds.length === 0) return false;
  if (totalAssetCount <= 0 || affectedAssetIds.length > totalAssetCount) {
    return true;
  }
  const healthyAssetShare =
    (totalAssetCount - affectedAssetIds.length) / totalAssetCount;
  return (
    healthyAssetShare <
    V9_PRODUCER_FAILURE_MINIMUM_HEALTHY_ASSET_SHARE
  );
}

export function assessV9Publication(input: {
  inputHealth: V9PublicationInputHealth;
  candidate: SafetyScoreV9CurrentResponse;
  acceptedPublication: SafetyScoreV9CurrentResponse | null;
  coverageFloors: readonly V9PublicationCoverageFloor[];
}): V9PublicationAssessment {
  const reasons = inputHealthReasons(
    V9PublicationInputHealthSchema.parse(input.inputHealth),
  );
  const producerFailureReasons: Extract<
    V9PublicationHoldReason,
    { code: "producer-failed-downgrade" | "producer-failed-nr" }
  >[] = [];
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
    input.acceptedPublication !== null &&
    scoringIdentityMatches(
      input.candidate,
      input.acceptedPublication,
    )
  ) {
    const acceptedById = new Map(
      input.acceptedPublication.cards.map((card) => [card.id, card]),
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
        producerFailureReasons.push({
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
  if (
    producerFailuresRequireGlobalHold(
      producerFailureReasons,
      input.candidate.cards.length,
    )
  ) {
    reasons.push(...producerFailureReasons);
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
