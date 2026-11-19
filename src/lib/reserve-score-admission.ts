import type {
  ReserveAdmissionBlocker,
  ReserveAdmissionClientSummary,
} from "@/lib/stablecoin-detail-reserve-admission-client";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";

/**
 * The whole-reserve component the evaluator emits when it admits no reserve
 * composition (`boundedReserveForStatus` in `shared/lib/safety-score-v9/backing.ts`).
 * An unclassified tail inside an admitted composition carries a suffixed key.
 */
export const V9_UNADMITTED_RESERVE_COMPONENT_KEY = "reserve:unclassified-residual";

const DAY_SEC = 86_400;

const BLOCKER_CLAUSES: Record<Exclude<ReserveAdmissionBlocker, "unverified">, string> = {
  "scope-missing": "states no review scope",
  "selected-slices": "covers selected slices only",
  "classification-only": "only classifies reserve categories",
  "dependency-relationships": "only records dependency relationships",
  undated: "has no composition date",
};

export function isV9ReserveCompositionUnadmitted(
  card: Pick<SafetyScoreV9CurrentCard, "breakdowns"> | null | undefined,
): boolean {
  return card?.breakdowns?.backing.components.some(
    (component) => component.key === V9_UNADMITTED_RESERVE_COMPONENT_KEY,
  ) ?? false;
}

function joinClauses(clauses: readonly string[]): string {
  return clauses.length < 2 ? (clauses[0] ?? "") : `${clauses.slice(0, -1).join(", ")} and ${clauses.at(-1)}`;
}

/**
 * Why the published card scores the whole reserve without the reviewed
 * composition, or null when the card admitted a composition or no review is on
 * file. The card decides; the clauses only name the requirements the review
 * misses, the age one at the card's own scoring clock.
 */
export function describeReserveScoreAdmission(
  summary: ReserveAdmissionClientSummary | null | undefined,
  card: Pick<SafetyScoreV9CurrentCard, "breakdowns"> | null | undefined,
  scoringClockSec: number | null | undefined,
): string | null {
  if (!summary || !isV9ReserveCompositionUnadmitted(card)) return null;
  const clauses = summary.blockers.map((blocker) => blocker === "unverified"
    ? `has ${(summary.confidenceLabel ?? "unverified").toLowerCase()} confidence`
    : BLOCKER_CLAUSES[blocker]);
  if (scoringClockSec != null && summary.compositionAtSec != null &&
    scoringClockSec - summary.compositionAtSec > summary.maxAgeSec) {
    const ageDays = Math.floor((scoringClockSec - summary.compositionAtSec) / DAY_SEC);
    clauses.push(`is dated ${summary.compositionAsOf}, ${ageDays} days before scoring`);
  }
  const lead = "The score treats the whole reserve as unknown";
  return clauses.length === 0
    ? `${lead}: this review did not pass its reserve admission checks.`
    : `${lead}. It admits only a verified full-composition review dated within ${Math.floor(summary.maxAgeSec / DAY_SEC)} days; this one ${joinClauses(clauses)}.`;
}
