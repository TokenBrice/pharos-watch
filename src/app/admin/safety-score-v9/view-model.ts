import type { SafetyScoreV9AdminResponse } from "@shared/types/safety-score-v9-admin";
import type { SafetyScoreV9Card, SafetyScoreV9Response } from "@shared/types/safety-score-v9-public";
import type { V9Grade } from "@shared/types/safety-score-v9";

type AvailableResponse = Extract<SafetyScoreV9AdminResponse, { status: "available" }>;
type DiffCard = AvailableResponse["diff"]["cards"][number];
type ShadowAttempt = AvailableResponse["history"][number]["attempts"][number];

export interface SafetyScoreV9AssetRow {
  card: SafetyScoreV9Card;
  diff: DiffCard | null;
}

export interface SafetyScoreV9WorkspaceModel {
  candidate: SafetyScoreV9Response;
  currentAttempt: ShadowAttempt | null;
  blockers: string[];
  failedCoverageFloors: AvailableResponse["envelope"]["coverage"]["coverageFloors"];
  gradeCounts: Array<{ grade: V9Grade; count: number }>;
  assetRows: SafetyScoreV9AssetRow[];
  reviewRows: DiffCard[];
  pendingReviewCount: number;
  history: AvailableResponse["history"];
  qualifyingDayCount: number;
  isNoGo: true;
}

const GRADE_ORDER: readonly V9Grade[] = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F", "NR"];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function humanizeToken(value: string): string {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function findCurrentAttempt(response: AvailableResponse): ShadowAttempt | null {
  const publicationGenerationId = response.envelope.candidate.publicationGenerationId;
  return (
    response.history
      .flatMap((day) => day.attempts)
      .filter((attempt) => attempt.identity?.publicationGenerationId === publicationGenerationId)
      .sort((left, right) => right.recordedAtSec - left.recordedAtSec)[0] ?? null
  );
}

export function buildSafetyScoreV9WorkspaceModel(response: AvailableResponse): SafetyScoreV9WorkspaceModel {
  const { candidate } = response.envelope;
  const currentAttempt = findCurrentAttempt(response);
  const failedCoverageFloors = response.envelope.coverage.coverageFloors.filter((floor) => floor.status === "fail");
  const blockerSet = new Set<string>();

  for (const blocker of response.envelope.coverage.unresolvedReleaseBlockers) blockerSet.add(blocker);
  for (const blocker of currentAttempt?.qualification?.blockers ?? []) {
    if (blocker === "coverage-floor-failed" && failedCoverageFloors.length > 0) continue;
    blockerSet.add(humanizeToken(blocker));
  }
  for (const floor of failedCoverageFloors) blockerSet.add(`${floor.id}: ${floor.detail}`);
  for (const id of response.envelope.coverage.compilerExceptions) blockerSet.add(`Compiler exception: ${id}`);
  for (const id of response.envelope.coverage.futureDatedEvidenceIds) blockerSet.add(`Future-dated evidence: ${id}`);
  for (const id of response.envelope.coverage.unresolvedCriticalMovementIds) {
    blockerSet.add(`Unresolved critical movement: ${id}`);
  }
  if (response.envelope.coverage.publicationRegression) blockerSet.add("Candidate publication regression detected");
  if (currentAttempt === null) blockerSet.add("Current shadow generation has no matching recorded attempt");
  const movementReviewByKey = new Map(
    response.movementReviews.map((review) => [review.reviewKey, review] as const),
  );
  const resolvedDiffCards = response.diff.cards.map((card): DiffCard => {
    const review = card.review.key === null ? null : movementReviewByKey.get(card.review.key) ?? null;
    if (review === null) return card;
    return {
      ...card,
      review: {
        ...card.review,
        status: "classified",
        disposition: review.disposition,
      },
    };
  });
  const pendingReviewCount = resolvedDiffCards.filter(
    (card) => card.review.status === "pending",
  ).length;
  if (pendingReviewCount > 0) {
    blockerSet.add(`${pendingReviewCount} material movement reviews remain pending`);
  }

  const gradeCounts = GRADE_ORDER.map((grade) => ({
    grade,
    count: candidate.cards.filter((card) => card.grade === grade).length,
  })).filter(({ count }) => count > 0);

  const diffById = new Map(resolvedDiffCards.map((card) => [card.id, card] as const));
  const assetRows = candidate.cards
    .map((card) => ({ card, diff: diffById.get(card.id) ?? null }))
    .sort((left, right) => {
      if (left.diff?.flags.requiresReview !== right.diff?.flags.requiresReview) {
        return left.diff?.flags.requiresReview ? -1 : 1;
      }
      const delta = (right.diff?.absoluteScoreDelta ?? -1) - (left.diff?.absoluteScoreDelta ?? -1);
      if (delta !== 0) return delta;
      const score = (right.card.score ?? -1) - (left.card.score ?? -1);
      return score !== 0 ? score : compareText(left.card.id, right.card.id);
    });

  const reviewRows = resolvedDiffCards
    .filter((card) => card.flags.requiresReview)
    .sort((left, right) => {
      if (left.review.status !== right.review.status) return left.review.status === "pending" ? -1 : 1;
      return (right.supplyWeightedImpact ?? -1) - (left.supplyWeightedImpact ?? -1) || compareText(left.id, right.id);
    });

  return {
    candidate,
    currentAttempt,
    blockers: [...blockerSet].sort(compareText),
    failedCoverageFloors,
    gradeCounts,
    assetRows,
    reviewRows,
    pendingReviewCount,
    history: [...response.history].sort((left, right) => compareText(right.utcDay, left.utcDay)),
    qualifyingDayCount: response.history.filter((day) => day.projection.qualifies).length,
    isNoGo: true,
  };
}

export function filterSafetyScoreV9AssetRows(
  rows: readonly SafetyScoreV9AssetRow[],
  filters: { query: string; grade: V9Grade | "all"; reviewOnly: boolean },
): SafetyScoreV9AssetRow[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return rows.filter(({ card, diff }) => {
    if (filters.grade !== "all" && card.grade !== filters.grade) return false;
    if (filters.reviewOnly && !diff?.flags.requiresReview) return false;
    if (!query) return true;
    return card.id.toLocaleLowerCase().includes(query) || card.reasonCodes.some((reason) => reason.includes(query));
  });
}

export function formatSafetyScoreV9Timestamp(timestampSec: number): string {
  return new Date(timestampSec * 1_000).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

export function formatSafetyScoreV9Score(score: number | null): string {
  return score === null ? "NR" : score.toFixed(1);
}

export function formatSafetyScoreV9Delta(delta: number | null): string {
  if (delta === null) return "—";
  return `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`;
}

export function titleCaseSafetyScoreV9Token(value: string): string {
  return humanizeToken(value);
}
