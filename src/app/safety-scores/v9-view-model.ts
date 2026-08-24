import { formatCurrency } from "@shared/lib/format";
import { gradeRange, scoreToGrade } from "@shared/lib/report-card-core";
import { getCirculatingRaw } from "@shared/lib/supply";
import { isCanonicalStablecoinId } from "@shared/lib/stablecoin-id";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { V9ConsumerCard } from "@/lib/safety-score-v9-consumers";

export type V9SortKey = "overall" | "backing" | "exit" | "control" | "mcap";
export type GradeFilter = "all" | "A" | "B" | "C" | "D" | "F" | "NR";
export type PegFilter = "all" | "usd" | "fiat-non-usd" | "commodities";
export const GRADE_RANGES: Exclude<GradeFilter, "all">[] = [
  "A",
  "B",
  "C",
  "D",
  "F",
  "NR",
];

const GRADE_ORDER: Exclude<GradeFilter, "all">[] = ["A", "B", "C", "D", "F", "NR"];
const PILLAR_LABELS = {
  backing: "Backing",
  exit: "Exit",
  control: "Economic Control",
} as const;

export type SafetyScoreCoinQueryStatus = "empty" | "valid" | "unknown" | "malformed";

export interface SafetyScoreCoinQueryState {
  raw: string | null;
  id: string | null;
  status: SafetyScoreCoinQueryStatus;
}

/**
 * Parse the stable-ID deep link without treating a ticker as an identifier.
 * The registry check lets the route give a useful answer for a well-formed
 * but unknown ID while keeping symbols such as `USDT` out of the URL contract.
 */
export function parseSafetyScoreCoinQuery(search: string): SafetyScoreCoinQueryState {
  const raw = new URLSearchParams(search).get("coin");
  if (raw === null || raw.trim() === "") {
    return { raw, id: null, status: "empty" };
  }

  const id = raw.trim();
  if (!isCanonicalStablecoinId(id)) {
    return { raw, id: null, status: "malformed" };
  }
  if (!CLIENT_TRACKED_META_BY_ID.has(id)) {
    return { raw, id, status: "unknown" };
  }
  return { raw, id, status: "valid" };
}

export function buildSafetyScoreCoinCardId(id: string): string {
  return `safety-score-card-${id}`;
}

/** Search the live V9 card set by the stablecoin's display name or symbol. */
export function searchV9CardsByCoin(
  cards: readonly V9ConsumerCard[],
  query: string,
): V9ConsumerCard[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];

  return cards
    .filter((card) => {
      const meta = CLIENT_TRACKED_META_BY_ID.get(card.id);
      if (!meta) return false;
      return meta.name.toLocaleLowerCase().includes(normalized) ||
        meta.symbol.toLocaleLowerCase().includes(normalized);
    })
    .sort((left, right) => {
      const leftMeta = CLIENT_TRACKED_META_BY_ID.get(left.id);
      const rightMeta = CLIENT_TRACKED_META_BY_ID.get(right.id);
      return (leftMeta?.name ?? left.id).localeCompare(rightMeta?.name ?? right.id) ||
        left.id.localeCompare(right.id);
    });
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
  };
  for (const card of cards ?? []) {
    counts[gradeRange(card.grade)] += 1;
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
    pegFilter,
    pegTypeMap,
    sortKey,
    mcapMap,
  }: {
    gradeFilter: GradeFilter;
    pegFilter: PegFilter;
    pegTypeMap: ReadonlyMap<string, string>;
    sortKey: V9SortKey;
    mcapMap: ReadonlyMap<string, number>;
  },
): V9ConsumerCard[] {
  const gradeFiltered = gradeFilter === "all"
    ? cards
    : cards.filter((card) => gradeRange(card.grade) === gradeFilter);
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

export function pegMatchesFilter(pegType: string | undefined, pegFilter: Exclude<PegFilter, "all">): boolean {
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

export function buildSafetyMcapMap(
  peggedAssets?: Array<{
    id: string;
    circulating?: Record<string, number> | null;
  }>,
): Map<string, number> {
  if (!peggedAssets) return new Map();
  return new Map(
    peggedAssets.map((asset) => [asset.id, getCirculatingRaw(asset)]),
  );
}
