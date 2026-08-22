import type {
  V9PublicationHoldReason,
} from "@shared/types/report-cards-v9";
import type {
  SafetyScoreV9Card,
  SafetyScoreV9CurrentResponse,
} from "@shared/types/safety-score-v9-public";
import { REPORT_CARD_GRADE_RANK } from "@shared/lib/report-card-core";
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
  | {
      decision: "publish";
      reasons: [];
      affectedAssetIds: string[];
    }
  | {
      decision: "hold";
      reasons: V9PublicationHoldReason[];
      affectedAssetIds: string[];
    };

/** Minimum share of candidate assets without newly binding producer-failed deterioration. */
const V9_PRODUCER_FAILURE_MINIMUM_HEALTHY_ASSET_NUMERATOR = 9;
const V9_PRODUCER_FAILURE_MINIMUM_HEALTHY_ASSET_DENOMINATOR = 10;

/**
 * The hold gate compares grades only relatively, so it reads the one grade-rank
 * ladder instead of restating it. `REPORT_CARD_GRADE_RANK` is this table shifted
 * by one (NR -1 .. A+ 10 versus NR 0 .. A+ 11) — order-isomorphic, so every
 * `<` comparison below is unchanged.
 */
const GRADE_RANK: Record<V9Grade, number> = REPORT_CARD_GRADE_RANK;

function producerFailedBindings(card: SafetyScoreV9Card) {
  if (!("scoreTrace" in card)) return [];
  if (!("boundedUncertaintyAttribution" in card.scoreTrace)) return [];
  return card.scoreTrace.boundedUncertaintyAttribution.items.filter(
    (item) => item.responsibility === "producer-failed",
  );
}

type ProducerFailedBinding = Pick<
  ReturnType<typeof producerFailedBindings>[number],
  "source" | "code" | "path"
>;

export interface SafetyScoreV9AcceptedCardBaseline {
  id: string;
  grade: V9Grade;
  score: number | null;
  producerFailedBindings: ProducerFailedBinding[];
  primaryRouteKey: string | null;
  primaryRouteCapacityUsd: number | null;
  pillarScores: {
    backing: number;
    exit: number;
    control: number;
  } | null;
}

/**
 * The publication gate only needs identity, deterioration, and delta fields
 * from the previously accepted publication. Keeping this compact projection
 * lets the full stored response be collected before the next candidate is
 * compiled inside Cloudflare's 128 MiB isolate.
 */
export interface SafetyScoreV9AcceptedPublicationBaseline {
  publicationGenerationId: string;
  publishedAtSec: number;
  policyVersion: string;
  policyId: string;
  policyDigest: string;
  evaluationBuildDigest: string;
  cards: SafetyScoreV9AcceptedCardBaseline[];
}

export function buildSafetyScoreV9AcceptedPublicationBaseline(
  publication: SafetyScoreV9CurrentResponse,
): SafetyScoreV9AcceptedPublicationBaseline {
  return {
    publicationGenerationId: publication.publicationGenerationId,
    publishedAtSec: publication.publishedAtSec,
    policyVersion: publication.policyVersion,
    policyId: publication.policy.id,
    policyDigest: publication.policy.semanticDigest,
    evaluationBuildDigest: publication.evaluationBuildDigest,
    cards: publication.cards.map((card) => {
      const breakdowns =
        "breakdowns" in card && card.breakdowns !== null
          ? card.breakdowns
          : null;
      return {
        id: card.id,
        grade: card.grade,
        score: card.score,
        producerFailedBindings: producerFailedBindings(card).map(
          (item) => ({
            source: item.source,
            code: item.code,
            path: item.path,
          }),
        ),
        primaryRouteKey:
          breakdowns?.exit.primaryRoute?.key ?? null,
        primaryRouteCapacityUsd:
          breakdowns?.exit.primaryRoute?.capacity?.executableUsd ?? null,
        pillarScores: breakdowns === null
          ? null
          : {
              backing: breakdowns.backing.publishedScore,
              exit: breakdowns.exit.publishedScore,
              control: breakdowns.control.publishedScore,
            },
      };
    }),
  };
}

function bindingKey(
  item: ProducerFailedBinding,
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
  accepted: SafetyScoreV9AcceptedCardBaseline,
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
  accepted: SafetyScoreV9AcceptedPublicationBaseline,
): boolean {
  return (
    candidate.policyVersion === accepted.policyVersion &&
    candidate.policy.id === accepted.policyId &&
    candidate.policy.semanticDigest === accepted.policyDigest &&
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

function affectedAssetsRequireGlobalHold(
  affectedAssetIds: ReadonlySet<string>,
  totalAssetCount: number,
): boolean {
  if (affectedAssetIds.size === 0) return false;
  if (totalAssetCount <= 0 || affectedAssetIds.size > totalAssetCount) {
    return true;
  }
  return (
    (totalAssetCount - affectedAssetIds.size) *
      V9_PRODUCER_FAILURE_MINIMUM_HEALTHY_ASSET_DENOMINATOR <
    totalAssetCount *
      V9_PRODUCER_FAILURE_MINIMUM_HEALTHY_ASSET_NUMERATOR
  );
}

export function assessV9Publication(input: {
  inputHealth: V9PublicationInputHealth;
  candidate: SafetyScoreV9CurrentResponse;
  acceptedPublication: SafetyScoreV9AcceptedPublicationBaseline | null;
  coverageFloors: readonly V9PublicationCoverageFloor[];
  quarantinedAssetIds?: readonly string[];
  quarantineAffectedAssetIds?: readonly string[];
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

  const directQuarantines = new Set(
    input.quarantinedAssetIds ?? [],
  );
  for (const assetId of directQuarantines) {
    const card = input.candidate.cards.find(
      (candidate) => candidate.id === assetId,
    );
    if (!card) {
      throw new Error(
        `Quarantined Safety Score v9 asset ${assetId} is absent from the candidate`,
      );
    }
    if (card.grade !== "NR" || card.score !== null) {
      throw new Error(
        `Quarantined Safety Score v9 asset ${assetId} is not current NR`,
      );
    }
  }
  const quarantineAffectedAssetIds = new Set(
    input.quarantineAffectedAssetIds ?? directQuarantines,
  );
  for (const assetId of quarantineAffectedAssetIds) {
    if (
      !input.candidate.cards.some(
        (candidate) => candidate.id === assetId,
      )
    ) {
      throw new Error(
        `Quarantine-affected Safety Score v9 asset ${assetId} is absent from the candidate`,
      );
    }
  }
  for (const assetId of directQuarantines) {
    if (!quarantineAffectedAssetIds.has(assetId)) {
      throw new Error(
        `Quarantine-affected assets omit direct quarantine ${assetId}`,
      );
    }
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
        accepted.producerFailedBindings.map((binding) =>
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
  const affectedAssetIds = new Set([
    ...quarantineAffectedAssetIds,
    ...producerFailureReasons.map((reason) => reason.assetId),
  ]);
  if (
    affectedAssetsRequireGlobalHold(
      affectedAssetIds,
      input.candidate.cards.length,
    )
  ) {
    const reasonByAssetId = new Map(
      producerFailureReasons.map((reason) => [
        reason.assetId,
        reason,
      ]),
    );
    for (const assetId of [...affectedAssetIds].sort()) {
      const existing = reasonByAssetId.get(assetId);
      if (existing) {
        reasons.push(existing);
        continue;
      }
      const parentBinding = producerFailedBindings(
        input.candidate.cards.find((card) => card.id === assetId)!,
      ).find(
        (binding) =>
          binding.source === "parent-score" &&
          [...directQuarantines].some((quarantinedId) =>
            binding.path.includes(`parent:${quarantinedId}:`),
          ),
      );
      reasons.push({
        code: "producer-failed-nr",
        assetId,
        source: parentBinding?.source ?? "reason",
        reasonCode:
          parentBinding?.code ?? "missing-pillar-evidence",
        path: parentBinding?.path ?? "asset-compilation",
        effect: "not-rated",
      });
    }
  }

  const boundedReasons = reasons
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    )
    .slice(0, 24);
  return boundedReasons.length === 0
    ? {
        decision: "publish",
        reasons: [],
        affectedAssetIds: [...affectedAssetIds].sort(),
      }
    : {
        decision: "hold",
        reasons: boundedReasons,
        affectedAssetIds: [...affectedAssetIds].sort(),
      };
}
