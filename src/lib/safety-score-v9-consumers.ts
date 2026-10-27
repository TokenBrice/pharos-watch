import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";
import { ReportCardsV9CurrentResponseSchema } from "@shared/types/report-cards-v9";
import { ReportCardsV9TableReaderResponseSchema, type ReportCardsV9TableResponse, type ReportCardsV9TableCard } from "@shared/types/report-cards-v9-projections";
import { projectV9TableCard } from "@shared/lib/report-cards-v9-projections";
import type {
  SafetyScorePublicationIdentity,
  SafetyScoreV9Card,
  SafetyScoreV9CurrentCard,
  V9Grade,
  V9QualityPillar,
} from "@shared/types";
import { getV9GradeRiskBucket, type V9GradeRiskBucket } from "@shared/lib/safety-grade-buckets";
import type { PublishedMintComponent } from "@/lib/mint-authority-display";
import type { SafetyScoreV9IssuanceSummary } from "@shared/types/safety-score-v9-public-breakdowns";
import type { PortfolioHolding } from "@/lib/portfolio-codec";

export type V9ConsumerResponse = ReportCardsV9CurrentResponse;
export type V9ConsumerCard = SafetyScoreV9CurrentCard;
export type V9TableConsumerCard = ReportCardsV9TableCard;
export type V9ConsumerIdentity = V9ConsumerResponse["safetyScoreIdentity"];

/** The usable population for every three-pillar radar count and aggregate. */
export function hasCompleteV9RadarPillars(card: Pick<ReportCardsV9TableCard, "ratingStatus" | "pillars">): boolean {
  return card.ratingStatus === "rated"
    && Number.isFinite(card.pillars.backing.score)
    && Number.isFinite(card.pillars.exit.score)
    && Number.isFinite(card.pillars.control.score);
}

export const V9_PILLAR_KEYS: readonly V9QualityPillar[] = ["backing", "exit", "control"];

/**
 * A rated card can be drawn on the pillar radar with its measured pillars
 * only; a missing pillar stays an "Unknown" axis, never an imputed point.
 */
export function hasPlottableV9RadarPillars(card: Pick<ReportCardsV9TableCard, "ratingStatus" | "pillars">): boolean {
  return card.ratingStatus === "rated"
    && V9_PILLAR_KEYS.filter((key) => Number.isFinite(card.pillars[key].score)).length >= 2;
}

/** The score's assumption for a pillar it could not measure: cause and priced score. */
export interface V9PricedUnknown {
  cause: "C" | "U";
  score: number;
}

/** Table cards project the assumption onto the pillar; full cards keep it in the score trace. */
export interface V9PricedUnknownSource {
  pillars: Record<V9QualityPillar, { score: number | null; pricedUnknown?: V9PricedUnknown }>;
  scoreTrace?: {
    aggregation: { pricedUnknownPillars?: readonly { pillar: V9QualityPillar; cause: "C" | "U"; score: number }[] } | null;
  };
}

export function readV9PricedUnknown(card: V9PricedUnknownSource, pillar: V9QualityPillar): V9PricedUnknown | null {
  if (card.scoreTrace !== undefined) {
    const priced = card.scoreTrace.aggregation?.pricedUnknownPillars?.find((item) => item.pillar === pillar);
    return priced === undefined ? null : { cause: priced.cause, score: priced.score };
  }
  return card.pillars[pillar].pricedUnknown ?? null;
}

export type V9ConsumerUnavailableReason =
  | "invalid-v9-response"
  | "identity-mismatch"
  | "card-unavailable"
  | "portfolio-card-unavailable"
  | "portfolio-card-not-rated"
  | "portfolio-empty"
  | "v9-publication-held"
  | "v9-stress-mapping-unapproved"
  | "v9-bluechip-floor-unreviewed";

export type V9ConsumerResult<T> =
  | { status: "available"; identity: V9ConsumerIdentity; value: T }
  | { status: "unavailable"; reason: V9ConsumerUnavailableReason };

function canonicalIdentity(identity: SafetyScorePublicationIdentity): string {
  if (identity.model !== "v9") return "not-v9";
  return [
    identity.model,
    identity.schemaVersion,
    identity.methodologyVersion,
    identity.policyId,
    identity.policyDigest,
    identity.evaluationBuildDigest,
    identity.baseInputGenerationId,
    identity.publicationGenerationId,
  ].join("\u0000");
}

export function safetyScoreV9IdentitiesMatch(
  left: SafetyScorePublicationIdentity | null | undefined,
  right: SafetyScorePublicationIdentity | null | undefined,
): left is V9ConsumerIdentity {
  return left?.model === "v9" && right?.model === "v9" && canonicalIdentity(left) === canonicalIdentity(right);
}

export function resolveV9ConsumerResponse(
  input: unknown,
  expectedIdentity: V9ConsumerIdentity,
): V9ConsumerResult<V9ConsumerResponse> {
  const parsed = ReportCardsV9CurrentResponseSchema.safeParse(input);
  if (!parsed.success) return { status: "unavailable", reason: "invalid-v9-response" };
  if (!safetyScoreV9IdentitiesMatch(parsed.data.safetyScoreIdentity, expectedIdentity)) {
    return { status: "unavailable", reason: "identity-mismatch" };
  }
  return { status: "available", identity: parsed.data.safetyScoreIdentity, value: parsed.data };
}

function resolveV9TableConsumerResponse(
  input: unknown,
  expectedIdentity: V9ConsumerIdentity,
): V9ConsumerResult<ReportCardsV9TableResponse | V9ConsumerResponse> {
  if (input !== null && typeof input === "object" && "projection" in input && input.projection === "table") {
    const parsed = ReportCardsV9TableReaderResponseSchema.safeParse(input);
    if (!parsed.success) return { status: "unavailable", reason: "invalid-v9-response" };
    if (!safetyScoreV9IdentitiesMatch(parsed.data.safetyScoreIdentity, expectedIdentity)) {
      return { status: "unavailable", reason: "identity-mismatch" };
    }
    return { status: "available", identity: parsed.data.safetyScoreIdentity, value: parsed.data };
  }
  return resolveV9ConsumerResponse(input, expectedIdentity);
}

// Re-exported so existing imports of `V9GradeRiskBucket` / `getV9GradeRiskBucket`
// from this module keep compiling unchanged; the shared bucket rule now lives
// in @shared/lib/safety-grade-buckets (also consumed by the worker's
// flight-to-quality classification).
export { getV9GradeRiskBucket, type V9GradeRiskBucket };

export interface V9SafetyTableRow {
  id: string;
  score: number | null;
  grade: V9Grade | null;
  ratingStatus: ReportCardsV9TableCard["ratingStatus"];
  partialEvidence: ReportCardsV9TableCard["partialEvidence"];
  riskBucket: V9GradeRiskBucket | null;
  pillars: ReportCardsV9TableCard["pillars"];
  evidence: ReportCardsV9TableCard["evidence"];
  weakestPillar: ReportCardsV9TableCard["weakestPillar"];
  bindingCapReason: NonNullable<ReportCardsV9TableCard["bindingCap"]>["reason"] | null;
  accessPosture: ReportCardsV9TableCard["accessPosture"];
  freezeStatus: V9FreezeStatus;
  /**
   * Published Economic Control mint component. Safety 9.1 made this the single
   * source for the public mint score and band, so the cross-coin projection
   * carries it. `breakdowns` is nullable on older publications, so an absent
   * component projects as a not-rated mint cell rather than failing the row.
   */
  mint: PublishedMintComponent | null;
}

/** Read the mint component off a card's control breakdown, null-safe. */
export function readV9CardMintComponent(card: SafetyScoreV9Card | ReportCardsV9TableCard): PublishedMintComponent | null {
  if ("mint" in card) return card.mint;
  const breakdowns = "breakdowns" in card ? card.breakdowns : null;
  const component = breakdowns?.control?.components.find((entry) => entry.kind === "mint");
  return component && component.score !== null ? { score: component.score, posture: component.posture } : null;
}

/** Diagnostics remain readable when the mint score is NR; absence grants no process evidence. */
export function readV9CardIssuanceSummary(card: SafetyScoreV9Card): SafetyScoreV9IssuanceSummary | null {
  return card.breakdowns?.control.issuanceSummary ?? null;
}

export function buildV9SafetyTableRows(
  input: unknown,
  expectedIdentity: V9ConsumerIdentity,
  riskFilter: V9GradeRiskBucket | "all" = "all",
): V9ConsumerResult<V9SafetyTableRow[]> {
  const response = resolveV9TableConsumerResponse(input, expectedIdentity);
  if (response.status === "unavailable") return response;
  const rows = response.value.cards
    .map((card) => "mint" in card ? card : projectV9TableCard(card))
    .map((card) => ({
      id: card.id,
      score: card.score,
      grade: card.grade,
      ratingStatus: card.ratingStatus,
      partialEvidence: card.partialEvidence,
      riskBucket: card.grade === null ? null : getV9GradeRiskBucket(card.grade),
      pillars: card.pillars,
      evidence: card.evidence,
      weakestPillar: card.weakestPillar,
      bindingCapReason: card.bindingCap?.reason ?? null,
      accessPosture: card.accessPosture,
      freezeStatus: mapV9FreezeStatus(card),
      mint: readV9CardMintComponent(card),
    }))
    .filter((row) => riskFilter === "all" || row.riskBucket === riskFilter)
    .sort((left, right) => {
      if (left.score === null) return right.score === null ? left.id.localeCompare(right.id) : 1;
      if (right.score === null) return -1;
      return right.score - left.score || left.id.localeCompare(right.id);
    });
  return { status: "available", identity: response.identity, value: rows };
}

export function buildV9SafetyTableMap(
  input: unknown,
  expectedIdentity: V9ConsumerIdentity,
): V9ConsumerResult<Record<string, V9SafetyTableRow>> {
  const rows = buildV9SafetyTableRows(input, expectedIdentity);
  return rows.status === "available"
    ? {
        status: "available",
        identity: rows.identity,
        value: Object.fromEntries(rows.value.map((row) => [row.id, row])),
      }
    : rows;
}

export type V9FreezeStatus = "not-observed" | "possible" | "upstream" | "direct" | "unknown";

function mapV9FreezeStatus(card: Pick<ReportCardsV9TableCard, "accessPosture">): V9FreezeStatus {
  switch (card.accessPosture.freezeExposure) {
    case "none-known":
      return "not-observed";
    case "direct":
    case "upstream":
    case "possible":
      return card.accessPosture.freezeExposure;
    case "unknown":
      return "unknown";
  }
}

export interface V9PortfolioProjection {
  aggregateLabel: "weighted-safety-aggregate" | "known-only-weighted-safety-aggregate";
  score: number | null;
  assetGrade: null;
  pillars: Record<"backing" | "exit" | "control", number | null>;
  partialEvidence: boolean;
  coverageUsd: { total: number; score: number; pillars: Record<"backing" | "exit" | "control", number> };
  dependencyExposure: Array<{
    upstreamAssetId: string;
    dependentAssetId: string;
    kind: "serial" | "basket";
    materiality: V9ConsumerResponse["dependencyGraph"]["edges"][number]["materiality"];
    /** Null when a basket share is unknown: unmeasured exposure is unavailable, never $0. */
    exposureUsd: number | null;
  }>;
}

export function buildV9PortfolioProjection(
  input: unknown,
  expectedIdentity: V9ConsumerIdentity,
  holdings: readonly PortfolioHolding[],
): V9ConsumerResult<V9PortfolioProjection> {
  const response = resolveV9TableConsumerResponse(input, expectedIdentity);
  if (response.status === "unavailable") return response;
  if (response.value.publicationHealth.status === "held") {
    return { status: "unavailable", reason: "v9-publication-held" };
  }
  const positiveHoldings = holdings.filter((holding) => holding.amount > 0);
  if (positiveHoldings.length === 0) return { status: "unavailable", reason: "portfolio-empty" };

  const cardById = new Map(response.value.cards.map((card) => [card.id, card]));
  let weightedScore = 0;
  const weightedPillars = { backing: 0, exit: 0, control: 0 };
  let scoredUsd = 0;
  let partialEvidence = false;
  const pillarUsd = { backing: 0, exit: 0, control: 0 };
  let totalUsd = 0;

  for (const holding of positiveHoldings) {
    const card = cardById.get(holding.coinId);
    if (!card) return { status: "unavailable", reason: "portfolio-card-unavailable" };
    totalUsd += holding.amount;
    partialEvidence ||= card.partialEvidence !== null || card.ratingStatus !== "rated";
    if (card.ratingStatus === "not-rated") return { status: "unavailable", reason: "portfolio-card-not-rated" };
    if (card.ratingStatus === "pipeline-gap" || card.score === null) continue;
    scoredUsd += holding.amount;
    weightedScore += card.score * holding.amount;
    for (const pillar of ["backing", "exit", "control"] as const) {
      const value = card.pillars[pillar];
      // aggregationDisposition is optional and defaults to "included".
      if (value.aggregationDisposition === "excluded-a-b" || value.score === null) continue;
      weightedPillars[pillar] += value.score * holding.amount;
      pillarUsd[pillar] += holding.amount;
    }
  }

  const amountByCardId = new Map(positiveHoldings.map((holding) => [holding.coinId, holding.amount]));
  const dependencyExposure = response.value.dependencyGraph.edges.flatMap((edge) => {
    const dependentAmount = amountByCardId.get(edge.to);
    if (dependentAmount === undefined) return [];
    return [{
      upstreamAssetId: edge.from,
      dependentAssetId: edge.to,
      kind: edge.kind,
      materiality: edge.materiality,
      exposureUsd: edge.kind !== "basket" ? dependentAmount : edge.weight === null ? null : dependentAmount * edge.weight,
    }];
  });

  return {
    status: "available",
    identity: response.identity,
    value: {
      aggregateLabel: partialEvidence ? "known-only-weighted-safety-aggregate" : "weighted-safety-aggregate",
      score: scoredUsd > 0 ? Math.round(weightedScore / scoredUsd) : null,
      assetGrade: null,
      partialEvidence,
      coverageUsd: { total: totalUsd, score: scoredUsd, pillars: pillarUsd },
      pillars: {
        backing: pillarUsd.backing > 0 ? Math.round(weightedPillars.backing / pillarUsd.backing) : null,
        exit: pillarUsd.exit > 0 ? Math.round(weightedPillars.exit / pillarUsd.exit) : null,
        control: pillarUsd.control > 0 ? Math.round(weightedPillars.control / pillarUsd.control) : null,
      },
      dependencyExposure,
    },
  };
}
