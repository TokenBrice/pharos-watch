import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";
import { ReportCardsV9CurrentResponseSchema } from "@shared/types/report-cards-v9";
import type {
  SafetyScorePublicationIdentity,
  SafetyScoreV9Card,
  SafetyScoreV9CurrentCard,
  V9Grade,
} from "@shared/types";
import { getV9GradeRiskBucket, type V9GradeRiskBucket } from "@shared/lib/safety-grade-buckets";
import type { PublishedMintComponent } from "@/lib/mint-authority-display";
import type { PortfolioHolding } from "@/lib/portfolio-codec";

export type V9ConsumerResponse = ReportCardsV9CurrentResponse;
export type V9ConsumerCard = SafetyScoreV9CurrentCard;
export type V9ConsumerIdentity = V9ConsumerResponse["safetyScoreIdentity"];

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

function selectV9Card(
  input: unknown,
  expectedIdentity: V9ConsumerIdentity,
  cardId: string,
): V9ConsumerResult<V9ConsumerCard> {
  const response = resolveV9ConsumerResponse(input, expectedIdentity);
  if (response.status === "unavailable") return response;
  const card = response.value.cards.find((candidate) => candidate.id === cardId);
  return card
    ? { status: "available", identity: response.identity, value: card }
    : { status: "unavailable", reason: "card-unavailable" };
}

// Re-exported so existing imports of `V9GradeRiskBucket` / `getV9GradeRiskBucket`
// from this module keep compiling unchanged; the shared bucket rule now lives
// in @shared/lib/safety-grade-buckets (also consumed by the worker's
// flight-to-quality classification).
export { getV9GradeRiskBucket, type V9GradeRiskBucket };

export interface V9SafetyTableRow {
  id: string;
  score: number | null;
  grade: V9Grade;
  riskBucket: V9GradeRiskBucket;
  pillars: SafetyScoreV9Card["pillars"];
  accessPosture: SafetyScoreV9Card["accessPosture"];
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
export function readV9CardMintComponent(card: SafetyScoreV9Card): PublishedMintComponent | null {
  const breakdowns = "breakdowns" in card ? card.breakdowns : null;
  const component = breakdowns?.control?.components.find((entry) => entry.kind === "mint");
  return component ? { score: component.score, posture: component.posture } : null;
}

export function buildV9SafetyTableRows(
  input: unknown,
  expectedIdentity: V9ConsumerIdentity,
  riskFilter: V9GradeRiskBucket | "all" = "all",
): V9ConsumerResult<V9SafetyTableRow[]> {
  const response = resolveV9ConsumerResponse(input, expectedIdentity);
  if (response.status === "unavailable") return response;
  const rows = response.value.cards
    .map((card) => ({
      id: card.id,
      score: card.score,
      grade: card.grade,
      riskBucket: getV9GradeRiskBucket(card.grade),
      pillars: card.pillars,
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

export interface V9DependencyProjection {
  edges: V9ConsumerResponse["dependencyGraph"]["edges"];
  nodeGrades: Record<string, V9Grade>;
}

export function buildV9DependencyProjection(
  input: unknown,
  expectedIdentity: V9ConsumerIdentity,
): V9ConsumerResult<V9DependencyProjection> {
  const response = resolveV9ConsumerResponse(input, expectedIdentity);
  if (response.status === "unavailable") return response;
  return {
    status: "available",
    identity: response.identity,
    value: {
      edges: response.value.dependencyGraph.edges,
      nodeGrades: Object.fromEntries(response.value.cards.map((card) => [card.id, card.grade])),
    },
  };
}

export type V9FreezeStatus = "not-observed" | "possible" | "upstream" | "direct" | "unknown";
export type V9ResolvedBlacklistStatus = boolean | "possible" | "inherited" | null;

export interface V9AccessCoverageProjection {
  cardId: string;
  score: number | null;
  evidence: SafetyScoreV9Card["evidence"];
  accessPosture: SafetyScoreV9Card["accessPosture"];
  freezeStatus: V9FreezeStatus;
  dependencyCount: number;
  liveReserveFresh: null;
  provenance: "v9-access-posture";
}

function mapV9FreezeStatus(card: SafetyScoreV9Card): V9FreezeStatus {
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

export function getV9ResolvedBlacklistStatus(
  card: Pick<SafetyScoreV9Card, "accessPosture"> | null | undefined,
): V9ResolvedBlacklistStatus {
  switch (card?.accessPosture?.freezeExposure) {
    case "direct":
      return true;
    case "upstream":
      return "inherited";
    case "possible":
      return "possible";
    case "none-known":
      return false;
    case "unknown":
    case undefined:
      return null;
  }
}

export function buildV9AccessCoverageProjection(
  input: unknown,
  expectedIdentity: V9ConsumerIdentity,
  cardId: string,
): V9ConsumerResult<V9AccessCoverageProjection> {
  const selected = selectV9Card(input, expectedIdentity, cardId);
  if (selected.status === "unavailable") return selected;
  const card = selected.value;
  return {
    status: "available",
    identity: selected.identity,
    value: {
      cardId,
      score: card.score,
      evidence: card.evidence,
      accessPosture: card.accessPosture,
      freezeStatus: mapV9FreezeStatus(card),
      dependencyCount: card.dependencies.serial.length + card.dependencies.basket.length,
      liveReserveFresh: null,
      provenance: "v9-access-posture",
    },
  };
}

export interface RegistryFreezeFallback {
  status: boolean | "possible" | "inherited" | null;
  provenance: "registry-fallback";
  countsAsV9Evidence: false;
}

export function buildRegistryFreezeFallback(
  status: RegistryFreezeFallback["status"],
): RegistryFreezeFallback {
  return { status, provenance: "registry-fallback", countsAsV9Evidence: false };
}

export interface V9PortfolioProjection {
  aggregateLabel: "weighted-safety-aggregate";
  score: number;
  assetGrade: null;
  pillars: Record<"backing" | "exit" | "control", number>;
  dependencyExposure: Array<{
    upstreamAssetId: string;
    dependentAssetId: string;
    kind: "serial" | "basket";
    materiality: V9ConsumerResponse["dependencyGraph"]["edges"][number]["materiality"];
    exposureUsd: number;
  }>;
}

export function buildV9PortfolioProjection(
  input: unknown,
  expectedIdentity: V9ConsumerIdentity,
  holdings: readonly PortfolioHolding[],
): V9ConsumerResult<V9PortfolioProjection> {
  const response = resolveV9ConsumerResponse(input, expectedIdentity);
  if (response.status === "unavailable") return response;
  if (response.value.publicationHealth.status === "held") {
    return { status: "unavailable", reason: "v9-publication-held" };
  }
  const positiveHoldings = holdings.filter((holding) => holding.amount > 0);
  if (positiveHoldings.length === 0) return { status: "unavailable", reason: "portfolio-empty" };

  const cardById = new Map(response.value.cards.map((card) => [card.id, card]));
  let weightedScore = 0;
  const weightedPillars = { backing: 0, exit: 0, control: 0 };
  let totalUsd = 0;

  for (const holding of positiveHoldings) {
    const card = cardById.get(holding.coinId);
    if (!card) return { status: "unavailable", reason: "portfolio-card-unavailable" };
    if (
      card.score === null ||
      card.grade === "NR" ||
      card.pillars.backing.score === null ||
      card.pillars.exit.score === null ||
      card.pillars.control.score === null
    ) {
      return { status: "unavailable", reason: "portfolio-card-not-rated" };
    }
    totalUsd += holding.amount;
    weightedScore += card.score * holding.amount;
    weightedPillars.backing += card.pillars.backing.score * holding.amount;
    weightedPillars.exit += card.pillars.exit.score * holding.amount;
    weightedPillars.control += card.pillars.control.score * holding.amount;
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
      exposureUsd: edge.kind === "basket" ? dependentAmount * (edge.weight ?? 0) : dependentAmount,
    }];
  });

  return {
    status: "available",
    identity: response.identity,
    value: {
      aggregateLabel: "weighted-safety-aggregate",
      score: Math.round(weightedScore / totalUsd),
      assetGrade: null,
      pillars: {
        backing: Math.round(weightedPillars.backing / totalUsd),
        exit: Math.round(weightedPillars.exit / totalUsd),
        control: Math.round(weightedPillars.control / totalUsd),
      },
      dependencyExposure,
    },
  };
}

export function getV9StressAvailability(
  input: unknown,
  expectedIdentity: V9ConsumerIdentity,
): V9ConsumerResult<never> {
  const response = resolveV9ConsumerResponse(input, expectedIdentity);
  if (response.status === "unavailable") return response;
  return { status: "unavailable", reason: "v9-stress-mapping-unapproved" };
}

export function getV9BluechipFloorAvailability(
  input: unknown,
  expectedIdentity: V9ConsumerIdentity,
): V9ConsumerResult<never> {
  const response = resolveV9ConsumerResponse(input, expectedIdentity);
  if (response.status === "unavailable") return response;
  return { status: "unavailable", reason: "v9-bluechip-floor-unreviewed" };
}
