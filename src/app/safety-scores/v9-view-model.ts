import { formatCurrency } from "@shared/lib/format";
import { gradeRange, scoreToGrade } from "@shared/lib/report-card-core";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import type { SafetyGradeSupplyMix } from "@/components/safety-grade-distribution-bar";
import type { V9ConsumerCard } from "@/lib/safety-score-v9-consumers";

export type V9SortKey = "overall" | "backing" | "exit" | "control" | "mcap";
export type GradeFilter = "all" | "A" | "B" | "C" | "D" | "F" | "NR" | "pipeline-gap";
export type PegFilter = "all" | "usd" | "fiat-non-usd" | "commodities";
export const GRADE_RANGES: Exclude<GradeFilter, "all">[] = [
  "A",
  "B",
  "C",
  "D",
  "F",
  "NR",
  "pipeline-gap",
];

const GRADE_ORDER: Exclude<GradeFilter, "all">[] = ["A", "B", "C", "D", "F", "NR", "pipeline-gap"];
const PILLAR_LABELS = {
  backing: "Backing",
  exit: "Exit",
  control: "Economic Control",
} as const;

function cardGroup(card: V9ConsumerCard): Exclude<GradeFilter, "all"> {
  if (card.ratingStatus === "pipeline-gap" || card.grade === null) return "pipeline-gap";
  return gradeRange(card.grade);
}

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
    "pipeline-gap": 0,
  };
  for (const card of cards ?? []) {
    counts[cardGroup(card)] += 1;
  }
  return counts;
}

function getSortScore(
  card: V9ConsumerCard,
  key: V9SortKey,
  mcapMap: ReadonlyMap<string, number | null>,
): number | null {
  if (key === "overall") return card.score;
  if (key === "mcap") return mcapMap.get(card.id) ?? null;
  if (card.ratingStatus !== "rated") return null;
  return card.pillars[key].score;
}

export function filterAndSortV9Cards(
  cards: readonly V9ConsumerCard[],
  {
    gradeFilter,
    pegFilter,
    pegTypeMap,
    sortKey,
    mcapMap,
  }: {
    gradeFilter: GradeFilter;
    pegFilter: PegFilter;
    pegTypeMap: ReadonlyMap<string, string>;
    sortKey: V9SortKey;
    mcapMap: ReadonlyMap<string, number | null>;
  },
): V9ConsumerCard[] {
  const gradeFiltered = gradeFilter === "all"
    ? cards
    : cards.filter((card) => cardGroup(card) === gradeFilter);
  const filtered = pegFilter === "all"
    ? gradeFiltered
    : gradeFiltered.filter((card) => pegMatchesFilter(pegTypeMap.get(card.id), pegFilter));

  return [...filtered].sort((left, right) => {
    const leftScore = getSortScore(left, sortKey, mcapMap);
    const rightScore = getSortScore(right, sortKey, mcapMap);
    if (leftScore === null) return rightScore === null ? left.id.localeCompare(right.id) : 1;
    if (rightScore === null) return -1;
    return rightScore - leftScore || left.id.localeCompare(right.id);
  });
}

function pegMatchesFilter(pegType: string | undefined, pegFilter: Exclude<PegFilter, "all">): boolean {
  if (pegFilter === "usd") return pegType === "peggedUSD";
  const isCommodity = pegType === "peggedGOLD" || pegType === "peggedSILVER";
  if (pegFilter === "commodities") return isCommodity;
  return pegType !== undefined && pegType !== "peggedUSD" && !isCommodity;
}

export function buildSafetyPegTypeMap(
  peggedAssets?: Array<{ id: string; pegType?: string }>,
): Map<string, string> {
  if (!peggedAssets) return new Map();
  return new Map(
    peggedAssets.flatMap((asset) => asset.pegType ? [[asset.id, asset.pegType]] : []),
  );
}

export function groupV9CardsByGrade(
  cards: readonly V9ConsumerCard[],
): Array<{ grade: string; cards: V9ConsumerCard[] }> {
  const groups = new Map<string, V9ConsumerCard[]>();
  for (const card of cards) {
    const grade = cardGroup(card);
    groups.set(grade, [...(groups.get(grade) ?? []), card]);
  }
  return GRADE_ORDER.flatMap((grade) => {
    const groupedCards = groups.get(grade);
    return groupedCards ? [{ grade, cards: groupedCards }] : [];
  });
}

function ratedV9Cards(cards: readonly V9ConsumerCard[]): Array<V9ConsumerCard & { score: number }> {
  return cards.filter((card): card is V9ConsumerCard & { score: number } => card.ratingStatus === "rated" && card.score !== null);
}

/**
 * Observed supply per rated grade family, the denominator shared with the A/B
 * headline. Rated cards only: NR and Pipeline-gap supply never enter it, and a
 * rated card without an observed supply is excluded (`ratedCount - observedCount`
 * discloses it), never added as zero. Null when nothing is rated.
 */
export function buildV9SupplyMix(
  cards: readonly V9ConsumerCard[],
  mcapMap: ReadonlyMap<string, number | null>,
): SafetyGradeSupplyMix | null {
  const ratedCards = ratedV9Cards(cards);
  if (ratedCards.length === 0) return null;

  const supplyByGrade: SafetyGradeSupplyMix["supplyByGrade"] = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  let totalSupply = 0;
  let observedCount = 0;
  for (const card of ratedCards) {
    const supply = mcapMap.get(card.id);
    const grade = cardGroup(card);
    if (supply == null || grade === "NR" || grade === "pipeline-gap") continue;
    supplyByGrade[grade] += supply;
    totalSupply += supply;
    observedCount += 1;
  }
  return { supplyByGrade, totalSupply, observedCount, ratedCount: ratedCards.length };
}

export interface V9PillarAverage {
  pillar: keyof typeof PILLAR_LABELS;
  label: string;
  /** Rounded mean over the rated cards that score this pillar. */
  average: number;
  /** Rated cards contributing a score to this pillar (partial ratings may exclude one). */
  scoredCount: number;
  /** Lowest rounded average; ties all carry the flag so equal figures read alike. */
  isLowest: boolean;
}

/** Ecosystem mean of each pillar across rated cards, in methodology order. */
export function buildV9PillarAverages(cards: readonly V9ConsumerCard[]): V9PillarAverage[] {
  const ratedCards = ratedV9Cards(cards);
  const averages = (["backing", "exit", "control"] as const).flatMap((pillar) => {
    const scores = ratedCards.flatMap((card) => {
      const score = card.pillars[pillar].score;
      return score === null ? [] : [score];
    });
    if (scores.length === 0) return [];
    return [{
      pillar,
      label: PILLAR_LABELS[pillar],
      average: Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length),
      scoredCount: scores.length,
    }];
  });
  const lowest = Math.min(...averages.map((entry) => entry.average));
  return averages.map((entry) => ({ ...entry, isLowest: entry.average === lowest }));
}

/** `[ecosystem average, supply in A/B]`; empty when nothing is rated. */
export function buildV9HeadlineStats(
  cards: readonly V9ConsumerCard[],
  mcapMap: ReadonlyMap<string, number | null>,
): Array<{ label: string; value: string; detail: string }> {
  const ratedCards = ratedV9Cards(cards);
  const supplyMix = buildV9SupplyMix(cards, mcapMap);
  if (!supplyMix) return [];

  const averageScore = Math.round(
    ratedCards.reduce((sum, card) => sum + card.score, 0) / ratedCards.length,
  );
  const { supplyByGrade, totalSupply, observedCount, ratedCount } = supplyMix;
  const unavailableCount = ratedCount - observedCount;
  const abSupply = supplyByGrade.A + supplyByGrade.B;
  const abPercent = totalSupply > 0 ? Math.round((abSupply / totalSupply) * 100) : null;

  return [
    {
      label: "Ecosystem avg.",
      value: String(averageScore),
      detail: scoreToGrade(averageScore),
    },
    {
      label: unavailableCount > 0 && observedCount > 0 ? "Known supply in A/B" : "Supply in A/B",
      value: abPercent === null ? "Unavailable" : `${abPercent}%`,
      detail: observedCount === 0
        ? "Supply unavailable"
        : `${formatCurrency(abSupply)}${unavailableCount > 0 ? ` · ${observedCount}/${ratedCount} rated assets observed` : ""}`,
    },
  ];
}

export function buildSafetyMcapMap(
  peggedAssets?: Array<{
    id: string;
    circulating?: Record<string, number> | null;
  }>,
): Map<string, number | null> {
  if (!peggedAssets) return new Map();
  return new Map(
    peggedAssets.map((asset) => [asset.id, getCirculatingRawOrNull(asset)]),
  );
}
