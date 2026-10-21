import { scoreToGrade } from "../../types/safety-score-v9-grade";
import type { V9Grade } from "../../types/safety-score-v9";
import type { SafetyScoreV9GradeHold } from "../../types/safety-score-v9-public";

/**
 * Grade hysteresis (methodology 10.26): a rated letter-grade change publishes
 * only once two consecutive publications compute the same new band. The score
 * stays raw; a retained grade names the computed band and the accepted
 * publication it was retained from. Rating-status transitions (NR,
 * pipeline-gap) are never held.
 */
export interface V9GradeHysteresisBaseline {
  publicationGenerationId: string;
  cards: readonly { id: string; grade: V9Grade | null; score: number | null }[];
}

interface V9GradeHysteresisCard {
  id: string;
  score: number | null;
  grade: V9Grade | null;
  ratingStatus: string;
  gradeHold?: SafetyScoreV9GradeHold;
}

const isLetter = (grade: V9Grade | null): grade is Exclude<V9Grade, "NR"> =>
  grade !== null && grade !== "NR";

export function resolveV9GradeHold(
  card: V9GradeHysteresisCard,
  accepted: V9GradeHysteresisBaseline["cards"][number] | undefined,
  acceptedGenerationId: string,
): SafetyScoreV9GradeHold | null {
  if (card.ratingStatus !== "rated" || card.score === null || !accepted || accepted.score === null) return null;
  const rawGrade = scoreToGrade(card.score);
  if (!isLetter(rawGrade) || !isLetter(accepted.grade) || rawGrade === accepted.grade) return null;
  // The accepted score is raw, so its band is the previous publication's
  // computed grade: two consecutive equal bands publish the change.
  if (scoreToGrade(accepted.score) === rawGrade) return null;
  return { rawGrade, heldFromGenerationId: acceptedGenerationId };
}

export function applySafetyScoreV9GradeHysteresis<
  Card extends V9GradeHysteresisCard,
  Publication extends { cards: readonly Card[] },
>(publication: Publication, baseline: V9GradeHysteresisBaseline | null): Publication {
  if (baseline === null) return publication;
  const acceptedById = new Map(baseline.cards.map((card) => [card.id, card]));
  let changed = false;
  const cards = publication.cards.map((card) => {
    const accepted = acceptedById.get(card.id);
    const hold = resolveV9GradeHold(card, accepted, baseline.publicationGenerationId);
    if (hold === null) return card;
    changed = true;
    return { ...card, grade: accepted!.grade, gradeHold: hold };
  });
  return changed ? { ...publication, cards } : publication;
}
