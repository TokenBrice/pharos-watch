import type {
  V9PublicationHoldReason,
} from "@shared/types/report-cards-v9";
import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import { V9GradeSchema } from "@shared/types/safety-score-v9";
import { NonNegativeFiniteSchema, ScoreSchema, Sha256Schema, UnixSecondsSchema } from "@shared/types/safety-schema-primitives";
import { compareCodeUnits } from "@shared/lib/compare";
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


import { isUngradedTokenizedFundCard } from "@shared/types/safety-score-v9-public-attribution";

/** Preserve the stale measured-route guard across rating and availability transitions. */
function cardDeteriorated(candidate: SafetyScoreV9CurrentResponse["cards"][number], accepted: SafetyScoreV9AcceptedCardBaseline): boolean {
  if (isUngradedTokenizedFundCard(candidate)) return false;
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
  return expiredMeasuredExitAssetIdsFromRoutes(projectExpiredMeasuredExitRoutes(fixedInput), candidate, acceptedPublication);
}

/** Keep route identities, not captured curves, after compilation releases its input. */
export function projectExpiredMeasuredExitRoutes(fixedInput: MeasuredExitPublicationInput) {
  // Every embedded measured window, so a retained expiry witness can see fresh same-route evidence.
  const windowsByAssetId = new Map(Object.entries(fixedInput.dexLiqMap).map(([assetId, row]) => [assetId,
    new Map((row.exitRouteObservations ?? []).flatMap((observation) => observation.observationHistory == null ? [] : [[
      observation.routeId,
      {
        observationWindowEndedAt: observation.observationHistory.observationWindowEndedAt,
        freshnessMaxSec: getDexMeasuredExecutionFreshnessMaxSec(),
      },
    ] as const])),
  ]));
  return {
    clockSec: fixedInput.clockSec,
    dexGenerationId: fixedInput.dexGenerationId,
    windowsByAssetId,
    byAssetId: new Map(Object.entries(fixedInput.dexLiqMap).map(([assetId, row]) => [assetId,
      (row.exitRouteObservations ?? []).filter((observation) => {
        const history = observation.observationHistory;
        return observation.evidenceKind === "measured-executable-depth" &&
          observation.confidence === "high" &&
          isDexMeasuredExecutionObservationHistoryMature(history) &&
          history != null && fixedInput.clockSec - history.observationWindowEndedAt >
            getDexMeasuredExecutionFreshnessMaxSec();
      }).map((observation) => observation.routeId),
    ])),
  };
}
export type SafetyScoreV9ExpiredMeasuredExitRoutes = ReturnType<typeof projectExpiredMeasuredExitRoutes>;

/**
 * Asset-local measured-route expiry (10.35). Each detected asset carries one
 * witness per expired route with its original window end and budget. Witnesses
 * survive quarantine stubs, which have no route identity, and clear only when the
 * same route has a newer embedded window inside its budget; an absent row or a
 * newer outer snapshot never clears one.
 */
export interface SafetyScoreV9InternalExitRouteSummary {
  primaryRouteKey: string | null;
  diversificationRouteKey: string | null;
  diversificationBonus: number;
}

export function resolveMeasuredExitExpiry(
  routes: SafetyScoreV9ExpiredMeasuredExitRoutes,
  candidate: Pick<SafetyScoreV9CurrentResponse, "cards">,
  acceptedPublication: SafetyScoreV9AcceptedPublicationBaseline | null = null,
  internalExitRoutesByAssetId: Readonly<Record<string, SafetyScoreV9InternalExitRouteSummary>> = {},
): { assetIds: string[]; witnessesByAssetId: Record<string, SafetyScoreV9DexExpiryWitness[]> } {
  const acceptedById = new Map(acceptedPublication?.cards.map((card) => [card.id, card]));
  const witnessesByAssetId: Record<string, SafetyScoreV9DexExpiryWitness[]> = {};
  for (const card of [...candidate.cards].sort((left, right) => compareText(left.id, right.id))) {
    const windows = routes.windowsByAssetId.get(card.id);
    const retained = (acceptedPublication?.dexExpiryByAssetId?.[card.id] ?? []).filter((witness) => {
      const latest = windows?.get(witness.routeId);
      return latest === undefined || latest.observationWindowEndedAt <= witness.observationWindowEndedAt ||
        routes.clockSec - latest.observationWindowEndedAt > witness.freshnessMaxSec;
    });
    const detected = expiredContributingRouteIds(
      routes,
      card,
      acceptedById.get(card.id),
      acceptedPublication,
      internalExitRoutesByAssetId[card.id],
    )
      .filter((routeId) => !retained.some((witness) => witness.routeId === routeId))
      .map((routeId) => ({ routeId, dexGenerationId: routes.dexGenerationId, ...windows!.get(routeId)! }));
    const witnesses = [...retained, ...detected].sort((left, right) => compareText(left.routeId, right.routeId));
    if (witnesses.length > 0) witnessesByAssetId[card.id] = witnesses;
  }
  return { assetIds: Object.keys(witnessesByAssetId), witnessesByAssetId };
}

export function expiredMeasuredExitAssetIdsFromRoutes(
  routes: SafetyScoreV9ExpiredMeasuredExitRoutes,
  candidate: SafetyScoreV9CurrentResponse,
  acceptedPublication: SafetyScoreV9AcceptedPublicationBaseline | null = null,
  internalExitRoutesByAssetId: Readonly<Record<string, SafetyScoreV9InternalExitRouteSummary>> = {},
): string[] {
  return resolveMeasuredExitExpiry(routes, candidate, acceptedPublication, internalExitRoutesByAssetId).assetIds;
}

function expiredContributingRouteIds(
  routes: SafetyScoreV9ExpiredMeasuredExitRoutes,
  card: SafetyScoreV9CurrentResponse["cards"][number],
  accepted: SafetyScoreV9AcceptedCardBaseline | undefined,
  acceptedPublication: SafetyScoreV9AcceptedPublicationBaseline | null,
  internalExitRoutes?: SafetyScoreV9InternalExitRouteSummary,
): string[] {
  const exit = card.breakdowns?.exit;
  const ungradedFundExit = exit == null && isUngradedTokenizedFundCard(card) ? internalExitRoutes : undefined;
  const primaryRouteKey = exit?.primaryRoute?.key ?? ungradedFundExit?.primaryRouteKey ?? undefined;
  const diversificationRouteKey =
    exit?.diversification && exit.diversification.bonus > 0
      ? exit.diversification.routeKey
      : ungradedFundExit && ungradedFundExit.diversificationBonus > 0 && ungradedFundExit.diversificationRouteKey !== null
        ? ungradedFundExit.diversificationRouteKey
        : undefined;
  const contributingRoutes = new Set([
    primaryRouteKey,
    ...(diversificationRouteKey ? [diversificationRouteKey] : []),
  ]);
  // Once a stale route leaves selection (or makes the card NR), its former
  // contribution must not disappear from the freshness gate as well.
  const previousRoutes = accepted && cardDeteriorated(card, accepted)
    ? [accepted.primaryRouteKey, accepted.diversificationRouteKey]
    : [];
  return (routes.byAssetId.get(card.id) ?? []).filter((routeId) =>
      contributingRoutes.has(canonicalV9RouteKey("dex", routes.dexGenerationId, routeId)) ||
        (acceptedPublication?.dexGenerationId != null && previousRoutes.includes(
          canonicalV9RouteKey("dex", acceptedPublication.dexGenerationId, routeId),
        )),
  );
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

const AcceptedCardBaselineSchema = z.strictObject({
  id: z.string().min(1), grade: V9GradeSchema.nullable(), score: ScoreSchema.nullable(),
  primaryRouteKey: z.string().min(1).nullable(), diversificationRouteKey: z.string().min(1).nullable(),
  primaryRouteCapacityUsd: NonNegativeFiniteSchema.nullable(),
  pillarScores: z.strictObject({
    backing: ScoreSchema.nullable(), exit: ScoreSchema.nullable(), control: ScoreSchema.nullable(),
  }).nullable(),
});
export type SafetyScoreV9AcceptedCardBaseline = z.infer<typeof AcceptedCardBaselineSchema>;

const DexExpiryWitnessSchema = z.strictObject({
  routeId: z.string().min(1), dexGenerationId: z.string().min(1),
  observationWindowEndedAt: UnixSecondsSchema, freshnessMaxSec: z.number().int().positive(),
});
export type SafetyScoreV9DexExpiryWitness = z.infer<typeof DexExpiryWitnessSchema>;

const VerifiedEmptyExitWitnessSchema = z.strictObject({
  verifiedAtSec: UnixSecondsSchema,
  dexGenerationId: z.string().min(1),
  publicationGenerationId: z.string().min(1),
});
export type SafetyScoreV9VerifiedEmptyExitWitness = z.infer<typeof VerifiedEmptyExitWitnessSchema>;

const DEFAULT_VERIFIED_EMPTY_EXIT_CARRY_MAX_AGE_SEC = 172_800;

export interface BuildAcceptedBaselineVerifiedEmptyOptions {
  priorVerifiedEmptyExitByAssetId?: Readonly<Record<string, SafetyScoreV9VerifiedEmptyExitWitness>>;
  observedAtByAssetId?: Readonly<Record<string, number>>;
  verifiedEmptyCarryMaxAgeSec?: number;
  /** Pre-projection Exit state for ungraded tokenized funds whose public card withholds Exit scores and breakdowns. */
  internalExitStateByAssetId?: Readonly<Record<string, "verified-empty" | "positive-route">>;
}

/**
 * The publication gate only needs identity, deterioration, and delta fields
 * from the previously accepted publication. Keeping this compact projection
 * lets the full stored response be collected before the next candidate is
 * compiled inside Cloudflare's 128 MiB isolate.
 */
export const AcceptedPublicationBaselineSchema = z.strictObject({
  publicationGenerationId: z.string().min(1), publishedAtSec: UnixSecondsSchema,
  policyVersion: z.string().min(1), policyId: z.string().min(1), policyDigest: Sha256Schema,
  evaluationBuildDigest: Sha256Schema, dexGenerationId: z.string().min(1).nullable(),
  cards: z.array(AcceptedCardBaselineSchema),
  // 10.35: unresolved measured-route expiry, keyed by the quarantined asset.
  dexExpiryByAssetId: z.record(z.string().min(1), z.array(DexExpiryWitnessSchema).min(1)).optional(),
  // 10.50: bounded verified-empty Exit witness, keyed by sorted asset ID.
  verifiedEmptyExitByAssetId: z.record(z.string().min(1), VerifiedEmptyExitWitnessSchema).optional(),
}).superRefine((value, ctx) => {
  if (value.cards.some((card, index) => index > 0 && compareCodeUnits(value.cards[index - 1]!.id, card.id) >= 0)) {
    ctx.addIssue({ code: "custom", path: ["cards"], message: "Baseline card IDs must be unique and sorted" });
  }
  const cardsById = new Map(value.cards.map((card) => [card.id, card]));
  for (const [assetId, witnesses] of Object.entries(value.dexExpiryByAssetId ?? {})) {
    const card = cardsById.get(assetId);
    if (card === undefined || card.score !== null || card.grade !== null) {
      ctx.addIssue({ code: "custom", path: ["dexExpiryByAssetId", assetId], message: "Expiry witnesses must name a published null-score stub" });
    }
    if (witnesses.some((witness, index) => witness.observationWindowEndedAt > value.publishedAtSec ||
      (index > 0 && compareCodeUnits(witnesses[index - 1]!.routeId, witness.routeId) >= 0))) {
      ctx.addIssue({ code: "custom", path: ["dexExpiryByAssetId", assetId], message: "Expiry witnesses must be route-sorted, unique and not postdate publication" });
    }
  }
  const verifiedEmptyEntries = Object.entries(value.verifiedEmptyExitByAssetId ?? {});
  for (let index = 0; index < verifiedEmptyEntries.length; index++) {
    const [assetId, witness] = verifiedEmptyEntries[index]!;
    if (index > 0 && compareCodeUnits(verifiedEmptyEntries[index - 1]![0], assetId) >= 0) {
      ctx.addIssue({ code: "custom", path: ["verifiedEmptyExitByAssetId", assetId], message: "Verified-empty Exit witnesses must be sorted by asset ID" });
    }
    if (!cardsById.has(assetId)) {
      ctx.addIssue({ code: "custom", path: ["verifiedEmptyExitByAssetId", assetId], message: "Verified-empty Exit witness must name a published card" });
    }
    if (witness.verifiedAtSec > value.publishedAtSec) {
      ctx.addIssue({ code: "custom", path: ["verifiedEmptyExitByAssetId", assetId, "verifiedAtSec"], message: "Verified-empty Exit witness must not postdate publication" });
    }
  }
});
export type SafetyScoreV9AcceptedPublicationBaseline = z.infer<typeof AcceptedPublicationBaselineSchema>;

function isCardVerifiedEmptyExit(card: SafetyScoreV9CurrentResponse["cards"][number]): boolean {
  const breakdowns = "breakdowns" in card && card.breakdowns !== null ? card.breakdowns : null;
  const disposition = card.pillars.exit.aggregationDisposition ?? "included";
  return (
    card.ratingStatus === "rated" &&
    card.pillars.exit.score === 0 &&
    disposition === "included" &&
    (breakdowns === null || breakdowns.exit.primaryRoute === null) &&
    card.pillars.exit.reasons.some((reason) => reason.code === "no-viable-exit-path" && reason.cause === "D")
  );
}

function hasCardPositiveExitRoute(card: SafetyScoreV9CurrentResponse["cards"][number]): boolean {
  const breakdowns = "breakdowns" in card && card.breakdowns !== null ? card.breakdowns : null;
  if (breakdowns !== null) {
    if (breakdowns.exit.primaryRoute !== null) return true;
    if (breakdowns.exit.alternatives.some((route) =>
      route.included || (route.capacity !== null && route.capacity !== undefined && route.capacity.executableUsd > 0),
    )) {
      return true;
    }
  }
  return (
    card.pillars.exit.score !== null &&
    card.pillars.exit.score > 0 &&
    !card.pillars.exit.reasons.some(
      (reason) => reason.code === "missing-same-notional-route" || reason.code === "missing-runtime-route-evidence",
    )
  );
}

export function buildSafetyScoreV9AcceptedPublicationBaseline(
  publication: SafetyScoreV9CurrentResponse,
  dexExpiryByAssetId: Readonly<Record<string, SafetyScoreV9DexExpiryWitness[]>> = {},
  verifiedEmptyOptions: BuildAcceptedBaselineVerifiedEmptyOptions = {},
): SafetyScoreV9AcceptedPublicationBaseline {
  const witnessEntries = Object.entries(dexExpiryByAssetId).sort(([left], [right]) => compareCodeUnits(left, right));
  const carryMaxAgeSec = verifiedEmptyOptions.verifiedEmptyCarryMaxAgeSec ?? DEFAULT_VERIFIED_EMPTY_EXIT_CARRY_MAX_AGE_SEC;
  const observedAtByAssetId = verifiedEmptyOptions.observedAtByAssetId;
  const priorVerifiedEmpty = verifiedEmptyOptions.priorVerifiedEmptyExitByAssetId;
  const internalExitStateByAssetId = verifiedEmptyOptions.internalExitStateByAssetId;
  const verifiedEmptyEntries: Array<[string, SafetyScoreV9VerifiedEmptyExitWitness]> = [];
  for (const card of publication.cards) {
    const ungradedFund = isUngradedTokenizedFundCard(card);
    const verifiedEmpty = ungradedFund
      ? internalExitStateByAssetId?.[card.id] === "verified-empty"
      : isCardVerifiedEmptyExit(card);
    if (verifiedEmpty) {
      const observedAt = observedAtByAssetId?.[card.id];
      const verifiedAtSec =
        observedAt !== undefined && Number.isInteger(observedAt) && observedAt > 0 && observedAt <= publication.publishedAtSec
          ? observedAt
          : publication.asOfSec;
      verifiedEmptyEntries.push([
        card.id,
        {
          verifiedAtSec,
          dexGenerationId: publication.sourceGenerations.dex ?? publication.publicationGenerationId,
          publicationGenerationId: publication.publicationGenerationId,
        },
      ]);
      continue;
    }
    const positiveExitRoute = ungradedFund
      ? internalExitStateByAssetId?.[card.id] === "positive-route"
      : hasCardPositiveExitRoute(card);
    if (!positiveExitRoute) {
      const prior = priorVerifiedEmpty?.[card.id];
      if (
        prior !== undefined &&
        prior.verifiedAtSec <= publication.asOfSec &&
        publication.asOfSec - prior.verifiedAtSec <= carryMaxAgeSec &&
        prior.verifiedAtSec <= publication.publishedAtSec
      ) {
        verifiedEmptyEntries.push([card.id, prior]);
      }
    }
  }
  verifiedEmptyEntries.sort(([left], [right]) => compareCodeUnits(left, right));
  return {
    ...(witnessEntries.length === 0 ? {} : { dexExpiryByAssetId: Object.fromEntries(witnessEntries) }),
    ...(verifiedEmptyEntries.length === 0 ? {} : { verifiedEmptyExitByAssetId: Object.fromEntries(verifiedEmptyEntries) }),
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
  // 10.35: expired embedded measured history is asset-local. Every detected
  // asset must already be a quarantined stub; its dependents join the affected
  // census, so the 90% closure and coverage floors still hold the cohort.
  // Whole-source DEX failure stays a global hold through input health.
  const expiredMeasuredAssets = new Set(input.expiredMeasuredExitAssetIds ?? []);
  for (const assetId of expiredMeasuredAssets) {
    if (!input.candidate.cards.some((card) => card.id === assetId)) {
      throw new Error(`Expired measured-exit asset ${assetId} is absent from the candidate`);
    }
    if (!(input.quarantinedAssetIds ?? []).includes(assetId)) {
      throw new Error(`Expired measured-exit asset ${assetId} is not quarantined`);
    }
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
