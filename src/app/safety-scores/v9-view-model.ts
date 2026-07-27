import { formatCurrency } from "@shared/lib/format";
import { gradeRange, scoreToGrade } from "@shared/lib/report-cards";
import type { V9ConsumerCard } from "@/lib/safety-score-v9-consumers";
import type { GradeFilter } from "./view-model";

export type V9SortKey = "overall" | "backing" | "exit" | "control" | "mcap";

const GRADE_ORDER: Exclude<GradeFilter, "all">[] = ["A", "B", "C", "D", "F", "NR"];
const PILLAR_LABELS = {
  backing: "Backing",
  exit: "Exit",
  control: "Economic Control",
} as const;

export function buildV9GradeCounts(
  cards: readonly V9ConsumerCard[] | undefined,
): Record<Exclude<GradeFilter, "all">, number> {
  const counts: Record<Exclude<GradeFilter, "all">, number> = {
    A: 0,
    B: 0,
    C: 0,
    D: 0,
    F: 0,
    NR: 0,
  };
  for (const card of cards ?? []) {
    counts[gradeRange(card.grade) as Exclude<GradeFilter, "all">] += 1;
  }
  return counts;
}

function getSortScore(
  card: V9ConsumerCard,
  key: V9SortKey,
  mcapMap: ReadonlyMap<string, number>,
): number | null {
  if (key === "overall") return card.score;
  if (key === "mcap") return mcapMap.get(card.id) ?? 0;
  return card.pillars[key].score;
}

export function filterAndSortV9Cards(
  cards: readonly V9ConsumerCard[],
  {
    gradeFilter,
    sortKey,
    mcapMap,
  }: {
    gradeFilter: GradeFilter;
    sortKey: V9SortKey;
    mcapMap: ReadonlyMap<string, number>;
  },
): V9ConsumerCard[] {
  const filtered = gradeFilter === "all"
    ? cards
    : cards.filter((card) => gradeRange(card.grade) === gradeFilter);

  return [...filtered].sort((left, right) => {
    const leftScore = getSortScore(left, sortKey, mcapMap);
    const rightScore = getSortScore(right, sortKey, mcapMap);
    if (leftScore === null) return rightScore === null ? left.id.localeCompare(right.id) : 1;
    if (rightScore === null) return -1;
    return rightScore - leftScore || left.id.localeCompare(right.id);
  });
}

export function groupV9CardsByGrade(
  cards: readonly V9ConsumerCard[],
): Array<{ grade: string; cards: V9ConsumerCard[] }> {
  const groups = new Map<string, V9ConsumerCard[]>();
  for (const card of cards) {
    const grade = gradeRange(card.grade);
    groups.set(grade, [...(groups.get(grade) ?? []), card]);
  }
  return GRADE_ORDER.flatMap((grade) => {
    const groupedCards = groups.get(grade);
    return groupedCards ? [{ grade, cards: groupedCards }] : [];
  });
}

export function buildV9HeadlineStats(
  cards: readonly V9ConsumerCard[],
  mcapMap: ReadonlyMap<string, number>,
): Array<{ label: string; value: string; detail: string }> {
  const ratedCards = cards.filter((card) => card.score !== null);
  if (ratedCards.length === 0) return [];

  const averageScore = Math.round(
    ratedCards.reduce((sum, card) => sum + (card.score ?? 0), 0) / ratedCards.length,
  );
  const totalSupply = ratedCards.reduce((sum, card) => sum + (mcapMap.get(card.id) ?? 0), 0);
  const abSupply = ratedCards
    .filter((card) => {
      const grade = gradeRange(card.grade);
      return grade === "A" || grade === "B";
    })
    .reduce((sum, card) => sum + (mcapMap.get(card.id) ?? 0), 0);
  const abPercent = totalSupply > 0 ? Math.round((abSupply / totalSupply) * 100) : 0;

  const weakestPillar = (["backing", "exit", "control"] as const)
    .map((pillar) => {
      const scores = ratedCards.flatMap((card) => {
        const score = card.pillars[pillar].score;
        return score === null ? [] : [score];
      });
      return {
        pillar,
        average: scores.length > 0
          ? scores.reduce((sum, score) => sum + score, 0) / scores.length
          : null,
      };
    })
    .filter((entry): entry is { pillar: keyof typeof PILLAR_LABELS; average: number } => entry.average !== null)
    .sort((left, right) => left.average - right.average)[0];

  return [
    {
      label: "Ecosystem avg.",
      value: String(averageScore),
      detail: scoreToGrade(averageScore),
    },
    {
      label: "Supply in A/B",
      value: `${abPercent}%`,
      detail: formatCurrency(abSupply),
    },
    {
      label: "Weakest pillar",
      value: weakestPillar ? PILLAR_LABELS[weakestPillar.pillar] : "NR",
      detail: weakestPillar ? `avg ${Math.round(weakestPillar.average)}` : "no rated pillars",
    },
  ];
}
