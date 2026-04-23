import { formatCurrency } from "@shared/lib/format";
import {
  DIMENSION_LABELS,
  DIMENSION_ORDER,
  DIMENSION_SHORT_LABELS,
  gradeRange,
  scoreToGrade,
} from "@shared/lib/report-cards";
import { sumPegBuckets } from "@shared/lib/supply";
import type { DimensionKey, ReportCard, ReportCardGrade, StablecoinData } from "@shared/types";

export type GradeFilter = "all" | "A" | "B" | "C" | "D" | "F" | "NR";
export type SortKey =
  | "overall"
  | "coreSettlement"
  | "pegStability"
  | "liquidity"
  | "resilience"
  | "decentralization"
  | "dependencyRisk"
  | "mcap";
export type SortDirection = "asc" | "desc";

export const GRADE_RANGES: Exclude<GradeFilter, "all">[] = ["A", "B", "C", "D", "F", "NR"];

const CORE_SETTLEMENT_MIN_MCAP_USD = 25_000_000_000;
const CORE_SETTLEMENT_MIN_CHAINS = 10;
const CORE_SETTLEMENT_MIN_PEG_SCORE = 90;
const CORE_SETTLEMENT_MIN_LIQUIDITY_SCORE = 60;
const CORE_SETTLEMENT_MIN_DEPENDENCY_SCORE = 90;

export interface CoreSettlementProfile {
  id: string;
  marketCapUsd: number;
  chainCount: number;
  sortScore: number;
}

export interface SafetyInspectionFinding {
  id: string;
  symbol: string;
  name: string;
  grade: ReportCardGrade;
  score: number | null;
  marketCapUsd: number;
}

export interface SafetyInspectionRow {
  key: DimensionKey;
  label: string;
  shortLabel: string;
  averageScore: number | null;
  weightedScore: number | null;
  findingCount: number;
  findingExposureUsd: number;
  unknownCount: number;
  worstFindings: SafetyInspectionFinding[];
}

export interface SafetyInspectionBoardModel {
  rows: SafetyInspectionRow[];
  leadFinding: SafetyInspectionRow | null;
  inspectedCount: number;
  totalMarketCapUsd: number;
  findingExposureUsd: number;
}

export function buildSafetyMcapMap(
  peggedAssets?: Array<{ id: string; circulating?: Record<string, number> | null }>,
): Map<string, number> {
  if (!peggedAssets) return new Map<string, number>();
  return new Map(peggedAssets.map((asset) => [asset.id, asset.circulating ? sumPegBuckets(asset.circulating) : 0]));
}

export function buildSafetyStablecoinMap(
  peggedAssets?: Array<Pick<StablecoinData, "id" | "circulating" | "chains">>,
): Map<string, Pick<StablecoinData, "id" | "circulating" | "chains">> {
  if (!peggedAssets) return new Map();
  return new Map(peggedAssets.map((asset) => [asset.id, asset]));
}

export function getCoreSettlementProfile(
  card: ReportCard,
  stablecoin?: Pick<StablecoinData, "id" | "circulating" | "chains">,
): CoreSettlementProfile | null {
  if (card.isDefunct || !stablecoin) return null;
  const marketCapUsd = stablecoin.circulating ? sumPegBuckets(stablecoin.circulating) : 0;
  const chainCount = stablecoin.chains.length;
  const hasIssuerExit =
    card.rawInputs.redemptionBackstopScore != null &&
    card.rawInputs.redemptionModelConfidence !== "low" &&
    card.rawInputs.redemptionRouteFamily != null;
  if (marketCapUsd < CORE_SETTLEMENT_MIN_MCAP_USD) return null;
  if (chainCount < CORE_SETTLEMENT_MIN_CHAINS) return null;
  if ((card.dimensions.pegStability.score ?? 0) < CORE_SETTLEMENT_MIN_PEG_SCORE) return null;
  if ((card.dimensions.liquidity.score ?? 0) < CORE_SETTLEMENT_MIN_LIQUIDITY_SCORE) return null;
  if ((card.dimensions.dependencyRisk.score ?? 0) < CORE_SETTLEMENT_MIN_DEPENDENCY_SCORE) return null;
  if (card.rawInputs.dependencies.length > 0) return null;
  if (!hasIssuerExit) return null;

  return {
    id: card.id,
    marketCapUsd,
    chainCount,
    sortScore: 1_000_000_000_000 + marketCapUsd + (chainCount * 1_000_000),
  };
}

export function buildCoreSettlementProfiles(
  cards: ReportCard[] | undefined,
  stablecoinMap: Map<string, Pick<StablecoinData, "id" | "circulating" | "chains">>,
): Map<string, CoreSettlementProfile> {
  const profiles = new Map<string, CoreSettlementProfile>();
  for (const card of cards ?? []) {
    const profile = getCoreSettlementProfile(card, stablecoinMap.get(card.id));
    if (profile) profiles.set(card.id, profile);
  }
  return profiles;
}

export function getSortScore(
  card: ReportCard,
  key: SortKey,
  mcapMap: Map<string, number>,
  coreSettlementProfiles: Map<string, CoreSettlementProfile> = new Map(),
): number | null {
  if (key === "overall") return card.overallScore;
  if (key === "coreSettlement") return coreSettlementProfiles.get(card.id)?.sortScore ?? card.overallScore;
  if (key === "mcap") return mcapMap.get(card.id) ?? 0;
  return card.dimensions[key].score;
}

export function buildSafetyGradeCounts(
  cards: ReportCard[] | undefined,
): Record<Exclude<GradeFilter, "all">, number> {
  const counts: Record<Exclude<GradeFilter, "all">, number> = { A: 0, B: 0, C: 0, D: 0, F: 0, NR: 0 };
  if (!cards) return counts;
  for (const card of cards) {
    if (card.isDefunct) continue;
    const grade = gradeRange(card.overallGrade) as Exclude<GradeFilter, "all">;
    counts[grade] += 1;
  }
  return counts;
}

export function filterAndSortReportCards(
  cards: ReportCard[],
  {
    gradeFilter,
    sortKey,
    sortDirection = "desc",
    mcapMap,
    coreSettlementProfiles = new Map(),
  }: {
    gradeFilter: GradeFilter;
    sortKey: SortKey;
    sortDirection?: SortDirection;
    mcapMap: Map<string, number>;
    coreSettlementProfiles?: Map<string, CoreSettlementProfile>;
  },
): ReportCard[] {
  let filtered = cards.filter((card) => !card.isDefunct);

  if (gradeFilter !== "all") {
    filtered = filtered.filter((card) => gradeRange(card.overallGrade) === gradeFilter);
  }

  return [...filtered].sort((a, b) => {
    const aScore = getSortScore(a, sortKey, mcapMap, coreSettlementProfiles);
    const bScore = getSortScore(b, sortKey, mcapMap, coreSettlementProfiles);
    if (aScore === null && bScore === null) return 0;
    if (aScore === null) return 1;
    if (bScore === null) return -1;
    return sortDirection === "asc" ? aScore - bScore : bScore - aScore;
  });
}

export function groupReportCardsByGrade(cards: ReportCard[]): Array<{ grade: string; cards: ReportCard[] }> {
  const groups = new Map<string, ReportCard[]>();
  for (const card of cards) {
    const grade = gradeRange(card.overallGrade);
    const existing = groups.get(grade);
    if (existing) {
      existing.push(card);
    } else {
      groups.set(grade, [card]);
    }
  }
  return GRADE_RANGES.filter((grade) => groups.has(grade)).map((grade) => ({
    grade,
    cards: groups.get(grade) ?? [],
  }));
}

export function buildSafetyHeadlineStats(cards: ReportCard[], mcapMap: Map<string, number>): Array<{
  label: string;
  value: string;
  detail: string;
}> {
  const activeCards = cards.filter((card) => !card.isDefunct && card.overallScore != null);
  if (activeCards.length === 0) return [];

  const avgScore = Math.round(
    activeCards.reduce((sum, card) => sum + (card.overallScore ?? 0), 0) / activeCards.length,
  );
  const totalSupply = activeCards.reduce((sum, card) => sum + (mcapMap.get(card.id) ?? 0), 0);
  const abSupply = activeCards
    .filter((card) => {
      const grade = gradeRange(card.overallGrade);
      return grade === "A" || grade === "B";
    })
    .reduce((sum, card) => sum + (mcapMap.get(card.id) ?? 0), 0);
  const abPct = totalSupply > 0 ? Math.round((abSupply / totalSupply) * 100) : 0;

  const weakest = DIMENSION_ORDER
    .map((key) => {
      const scores = activeCards
        .map((card) => card.dimensions[key].score)
        .filter((score): score is number => score != null);
      return {
        key,
        avg: scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
      };
    })
    .filter((entry): entry is { key: DimensionKey; avg: number } => entry.avg != null)
    .reduce<{ key: DimensionKey; avg: number } | null>((lowest, next) => {
      if (!lowest) return next;
      return lowest.avg < next.avg ? lowest : next;
    }, null);

  return [
    { label: "Ecosystem avg.", value: String(avgScore), detail: scoreToGrade(avgScore) },
    { label: "Supply in A/B", value: `${abPct}%`, detail: formatCurrency(abSupply) },
    {
      label: "Weakest dimension",
      value: weakest ? DIMENSION_SHORT_LABELS[weakest.key] : "NR",
      detail: weakest ? `avg ${Math.round(weakest.avg)}` : "no scored dimensions",
    },
  ];
}

function isInspectionFinding(grade: ReportCardGrade): boolean {
  const range = gradeRange(grade);
  return range === "D" || range === "F";
}

export function buildSafetyInspectionBoard(
  cards: ReportCard[] | undefined,
  mcapMap: Map<string, number>,
): SafetyInspectionBoardModel {
  const activeCards = (cards ?? []).filter((card) => !card.isDefunct);
  const totalMarketCapUsd = activeCards.reduce((sum, card) => sum + (mcapMap.get(card.id) ?? 0), 0);
  const findingExposureUsd = activeCards.reduce((sum, card) => {
    const hasFinding = DIMENSION_ORDER.some((key) => isInspectionFinding(card.dimensions[key].grade));
    return hasFinding ? sum + (mcapMap.get(card.id) ?? 0) : sum;
  }, 0);

  const rows = DIMENSION_ORDER.map((key): SafetyInspectionRow => {
    const scored = activeCards
      .map((card) => card.dimensions[key].score)
      .filter((score): score is number => score != null);
    const averageScore = scored.length > 0
      ? Math.round(scored.reduce((sum, score) => sum + score, 0) / scored.length)
      : null;

    let weightedNumerator = 0;
    let weightedDenominator = 0;
    let findingExposureUsd = 0;
    let findingCount = 0;
    let unknownCount = 0;

    const findings: SafetyInspectionFinding[] = [];

    for (const card of activeCards) {
      const dimension = card.dimensions[key];
      const marketCapUsd = mcapMap.get(card.id) ?? 0;
      if (dimension.score != null && marketCapUsd > 0) {
        weightedNumerator += dimension.score * marketCapUsd;
        weightedDenominator += marketCapUsd;
      }
      if (dimension.score == null) {
        unknownCount += 1;
      }
      if (isInspectionFinding(dimension.grade)) {
        findingCount += 1;
        findingExposureUsd += marketCapUsd;
        findings.push({
          id: card.id,
          symbol: card.symbol,
          name: card.name,
          grade: dimension.grade,
          score: dimension.score,
          marketCapUsd,
        });
      }
    }

    const weightedScore = weightedDenominator > 0
      ? Math.round(weightedNumerator / weightedDenominator)
      : null;

    return {
      key,
      label: DIMENSION_LABELS[key],
      shortLabel: DIMENSION_SHORT_LABELS[key],
      averageScore,
      weightedScore,
      findingCount,
      findingExposureUsd,
      unknownCount,
      worstFindings: findings
        .sort((a, b) => {
          if (a.score == null && b.score == null) return b.marketCapUsd - a.marketCapUsd;
          if (a.score == null) return 1;
          if (b.score == null) return -1;
          if (a.score !== b.score) return a.score - b.score;
          return b.marketCapUsd - a.marketCapUsd;
        })
        .slice(0, 3),
    };
  });

  const leadFinding = rows.reduce<SafetyInspectionRow | null>((lowest, row) => {
    const rowScore = row.weightedScore ?? row.averageScore;
    if (rowScore == null) return lowest;
    if (!lowest) return row;
    const lowestScore = lowest.weightedScore ?? lowest.averageScore;
    if (lowestScore == null) return row;
    return rowScore < lowestScore ? row : lowest;
  }, null);

  return {
    rows,
    leadFinding,
    inspectedCount: activeCards.length,
    totalMarketCapUsd,
    findingExposureUsd,
  };
}
