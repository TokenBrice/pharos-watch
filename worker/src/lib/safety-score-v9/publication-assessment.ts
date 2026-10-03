import type {
  V9PublicationHoldReason,
} from "@shared/types/report-cards-v9";
import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import type { V9Grade } from "@shared/types/safety-score-v9";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import { REPORT_CARD_GRADE_RANK } from "@shared/lib/report-card-core";
import { z } from "zod";
import { canonicalV9RouteKey } from "@shared/lib/safety-score-v9/facts";
import {
  getDexMeasuredExecutionFreshnessMaxSec,
  isDexMeasuredExecutionObservationHistoryMature,
} from "@shared/types/measured-execution";
import type { ExitRouteObservation } from "@shared/types/exit-route";

interface MeasuredExitPublicationInput {
  clockSec: number;
  dexGenerationId: string;
  dexLiqMap: Readonly<
    Record<
      string,
      { exitRouteObservations?: readonly ExitRouteObservation[] | null }
    >
  >;
}


/** Preserve the stale measured-route guard across rating and availability transitions. */
function cardDeteriorated(candidate: SafetyScoreV9CurrentResponse["cards"][number], accepted: SafetyScoreV9AcceptedCardBaseline): boolean {
  if (accepted.grade !== null && accepted.grade !== "NR" && candidate.ratingStatus !== "rated") return true;
  if (candidate.score !== null && accepted.score !== null && candidate.score < accepted.score) return true;
  return candidate.grade !== null && accepted.grade !== null &&
    REPORT_CARD_GRADE_RANK[candidate.grade] < REPORT_CARD_GRADE_RANK[accepted.grade];
}
/** Snapshot publication time cannot refresh the measured history embedded in it. */
export function expiredMeasuredExitAssetIds(
  fixedInput: MeasuredExitPublicationInput,
  candidate: SafetyScoreV9CurrentResponse,
  acceptedPublication: SafetyScoreV9AcceptedPublicationBaseline | null = null,
): string[] {
  const acceptedById = new Map(acceptedPublication?.cards.map((card) => [card.id, card]));
  return candidate.cards.flatMap((card) => {
    const exit = card.breakdowns?.exit;
    const contributingRoutes = new Set([
      exit?.primaryRoute?.key,
      ...(exit?.diversification && exit.diversification.bonus > 0
        ? [exit.diversification.routeKey]
        : []),
    ]);
    const accepted = acceptedById.get(card.id);
    // Once a stale route leaves selection (or makes the card NR), its former
    // contribution must not disappear from the freshness gate as well.
    const previousRoutes = accepted && cardDeteriorated(card, accepted)
      ? [accepted.primaryRouteKey, accepted.diversificationRouteKey]
      : [];
    const expired = fixedInput.dexLiqMap[card.id]?.exitRouteObservations?.some((observation) => {
      const history = observation.observationHistory;
      return observation.evidenceKind === "measured-executable-depth" &&
        observation.confidence === "high" &&
        isDexMeasuredExecutionObservationHistoryMature(history) &&
        history != null &&
        fixedInput.clockSec - history.observationWindowEndedAt >
          getDexMeasuredExecutionFreshnessMaxSec(observation.adapterProfileId ?? "") &&
        (contributingRoutes.has(canonicalV9RouteKey("dex", fixedInput.dexGenerationId, observation.routeId)) ||
          (acceptedPublication?.dexGenerationId != null && previousRoutes.includes(
            canonicalV9RouteKey("dex", acceptedPublication.dexGenerationId, observation.routeId),
          )));
    });
    return expired ? [card.id] : [];
  }).sort(compareText);
}

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
        coverageRatio: z.number().finite().min(0).nullable().default(null),
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
 * Live-reserve publication requires at least 60% of configured independent
 * producers to have an admitted snapshot. Calibrated 2026-09-17 against the
 * production admission map: 173/212 (0.816) admitted; the 39 rejections are
 * structural (monthly-attestation issuers older than the two-day freshness
 * window, NAV-composition-unverified funds, undeterminable-freshness vaults),
 * so a 0.9 floor held every publication. 0.6 still trips on a wholesale
 * sync/RPC collapse while clearing the measured baseline with headroom.
 */
const V9_LIVE_RESERVE_MINIMUM_COVERAGE_RATIO = 0.6;

export interface SafetyScoreV9AcceptedCardBaseline {
  id: string;
  grade: V9Grade | null;
  score: number | null;
  primaryRouteKey: string | null;
  diversificationRouteKey: string | null;
  primaryRouteCapacityUsd: number | null;
  pillarScores: {
    backing: number | null;
    exit: number | null;
    control: number | null;
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
  dexGenerationId: string | null;
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
    dexGenerationId: publication.sourceGenerations.dex ?? null,
    cards: publication.cards.map((card) => {
      const breakdowns =
        "breakdowns" in card && card.breakdowns !== null
          ? card.breakdowns
          : null;
      return {
        id: card.id,
        grade: card.grade,
        score: card.score,
        primaryRouteKey:
          breakdowns?.exit.primaryRoute?.key ?? null,
        diversificationRouteKey:
          breakdowns?.exit.diversification?.routeKey ?? null,
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
  if (
    health.liveReserves.state === "available" &&
    health.liveReserves.coverageRatio !== null &&
    health.liveReserves.coverageRatio < V9_LIVE_RESERVE_MINIMUM_COVERAGE_RATIO
  ) {
    reasons.push({ code: "live-reserves-coverage-below-floor" });
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
  expiredMeasuredExitAssetIds?: readonly string[];
}): V9PublicationAssessment {
  const reasons = inputHealthReasons(
    V9PublicationInputHealthSchema.parse(input.inputHealth),
  );
  // This is a stale score-bearing input, not an issuer change or an asset-local
  // coverage gap. Hold even below the 10% partial-publication allowance and
  // across build changes; the global hold also protects dependent wrappers.
  const expiredMeasuredAssets = new Set(input.expiredMeasuredExitAssetIds ?? []);
  for (const assetId of expiredMeasuredAssets) {
    if (!input.candidate.cards.some((card) => card.id === assetId)) {
      throw new Error(`Expired measured-exit asset ${assetId} is absent from the candidate`);
    }
  }
  if (expiredMeasuredAssets.size > 0 && !reasons.some((reason) => reason.code === "dex-stale")) {
    reasons.push({ code: "dex-stale" });
  }
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
    if (card.ratingStatus !== "pipeline-gap" || card.score !== null || card.grade !== null) {
      throw new Error(
        `Quarantined Safety Score v9 asset ${assetId} is not a technical pipeline gap`,
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

  const producerAffectedAssetIds = quarantineAffectedAssetIds;
  const affectedAssetIds = new Set([...expiredMeasuredAssets, ...producerAffectedAssetIds]);
  if (
    affectedAssetsRequireGlobalHold(
      producerAffectedAssetIds,
      input.candidate.cards.length,
    )
  ) {
    for (const assetId of [...producerAffectedAssetIds].sort()) {
      reasons.push({
        code: "producer-failed-pipeline-gap",
        assetId,
        source: "reason",
        reasonCode: "missing-pillar-evidence",
        path: "asset-compilation",
        effect: "pipeline-gap",
      });
    }
  }

  const boundedReasons = reasons
    .sort((left, right) =>
      compareText(JSON.stringify(left), JSON.stringify(right)),
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
