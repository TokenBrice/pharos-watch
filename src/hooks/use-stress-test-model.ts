import { computeStressedGrades, GRADE_THRESHOLDS } from "@shared/lib/report-cards";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { isKnownCoinId } from "@shared/lib/validate-coin-id";
import type { ReportCard, ReportCardGrade, ReportCardsResponse } from "@shared/types";
import { decodeStablecoinUrlToken } from "@/lib/stablecoin-url-codec";
import { parseEnumSearchParam, parseStablecoinIdSearchParam } from "@/lib/url-storage-codecs";

export interface StressTestImpact {
  coinId: string;
  name: string;
  symbol: string;
  gradeBefore: ReportCardGrade;
  scoreBefore: number | null;
  gradeAfter: ReportCardGrade;
  scoreAfter: number | null;
  delta: number;
}

export interface SystemicRisk {
  coinId: string;
  name: string;
  symbol: string;
  affectedCount: number;
  supplyAtRisk: number;
  dependentSupplyAtRisk: number;
}

export interface StressTargetableCoin {
  id: string;
  name: string;
  symbol: string;
  dependentCount: number;
}

const ID_TO_META = new Map<string, { name: string; symbol: string }>();
const REPORT_CARD_GRADE_VALUES = GRADE_THRESHOLDS.map((threshold) => threshold.grade) as readonly ReportCardGrade[];

for (const coin of ACTIVE_STABLECOINS) {
  ID_TO_META.set(coin.id, { name: coin.name, symbol: coin.symbol });
}

function gradeToStressScore(grade: ReportCardGrade): number {
  if (grade === "NR") return 0;

  const idx = GRADE_THRESHOLDS.findIndex((threshold) => threshold.grade === grade);
  if (idx < 0) return 0;

  const min = GRADE_THRESHOLDS[idx].min;
  const max = idx === 0 ? 100 : GRADE_THRESHOLDS[idx - 1].min - 1;

  return Math.round((min + max) / 2);
}

export function getDowngradeOptions(currentGrade: ReportCardGrade): ReportCardGrade[] {
  if (currentGrade === "NR") return [];

  const gradeList = GRADE_THRESHOLDS.map((threshold) => threshold.grade);
  const idx = gradeList.indexOf(currentGrade);
  if (idx < 0 || idx >= gradeList.length - 1) return [];

  return gradeList.slice(idx + 1);
}

export function parseStressSelectionFromSearch(
  search: string,
): { coinId: string | null; grade: ReportCardGrade | null } {
  const coinId = parseStablecoinIdSearchParam(search, "stress", {
    decode: decodeStablecoinUrlToken,
    isKnownCoinId,
  });
  if (!coinId) {
    return { coinId: null, grade: null };
  }

  return {
    coinId,
    grade: parseEnumSearchParam(search, "grade", REPORT_CARD_GRADE_VALUES, {
      normalize: (value) => value.toUpperCase(),
    }),
  };
}

export function buildReportCardMap(reportData: ReportCardsResponse | undefined): Map<string, ReportCard> {
  if (!reportData) return new Map();
  const cardMap = new Map<string, ReportCard>();
  for (const card of reportData.cards) cardMap.set(card.id, card);
  return cardMap;
}

export function buildTargetableCoins(reportData: ReportCardsResponse | undefined): StressTargetableCoin[] {
  if (!reportData) return [];

  const counts = new Map<string, number>();
  for (const edge of reportData.dependencyGraph.edges) {
    counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1);
  }

  const result: StressTargetableCoin[] = [];
  for (const [id, count] of counts) {
    const meta = ID_TO_META.get(id);
    if (meta) {
      result.push({ id, name: meta.name, symbol: meta.symbol, dependentCount: count });
    }
  }

  result.sort((a, b) => b.dependentCount - a.dependentCount);
  return result;
}

export function buildStressedCards(
  reportData: ReportCardsResponse | undefined,
  targetCoinId: string | null,
  targetGrade: ReportCardGrade | null,
): ReportCard[] | null {
  if (!targetCoinId || !targetGrade || !reportData) return null;

  const overrides = new Map<string, number>();
  overrides.set(targetCoinId, gradeToStressScore(targetGrade));

  return computeStressedGrades(reportData.cards, overrides);
}

export function buildAffectedIds(
  reportData: ReportCardsResponse | undefined,
  stressedCards: readonly ReportCard[] | null,
): Set<string> {
  if (!stressedCards || !reportData) return new Set();

  const ids = new Set<string>();
  for (let i = 0; i < reportData.cards.length; i++) {
    const original = reportData.cards[i];
    const stressed = stressedCards[i];
    if (original.overallScore !== stressed.overallScore) {
      ids.add(original.id);
    }
  }
  return ids;
}

export function buildStressImpacts(
  reportData: ReportCardsResponse | undefined,
  stressedCards: readonly ReportCard[] | null,
): StressTestImpact[] {
  if (!stressedCards || !reportData) return [];

  const result: StressTestImpact[] = [];

  for (let i = 0; i < reportData.cards.length; i++) {
    const original = reportData.cards[i];
    const stressed = stressedCards[i];
    const scoreBefore = original.overallScore;
    const scoreAfter = stressed.overallScore;
    if (scoreBefore === scoreAfter) continue;
    if (scoreBefore === null && scoreAfter === null) continue;

    const meta = ID_TO_META.get(original.id);
    result.push({
      coinId: original.id,
      name: meta?.name ?? original.name,
      symbol: meta?.symbol ?? original.symbol,
      gradeBefore: original.overallGrade,
      scoreBefore,
      gradeAfter: stressed.overallGrade,
      scoreAfter,
      delta: (scoreAfter ?? 0) - (scoreBefore ?? 0),
    });
  }

  result.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return result;
}

export function buildStressHeadline(
  impacts: readonly StressTestImpact[],
  allAffectedIds: ReadonlySet<string>,
  mcapMap?: Map<string, number>,
): { totalAtRisk: number; totalSupply: number; affectedCount: number } {
  const impactedIds = new Set(impacts.map((impact) => impact.coinId));
  let totalAtRisk = 0;
  let totalSupply = 0;

  if (mcapMap) {
    for (const [id, mcap] of mcapMap) {
      totalSupply += mcap;
      if (impactedIds.has(id)) {
        totalAtRisk += mcap;
      }
    }
  }

  return { totalAtRisk, totalSupply, affectedCount: allAffectedIds.size };
}

export function buildSystemicRisks(
  reportData: ReportCardsResponse | undefined,
  mcapMap: Map<string, number> | undefined,
  targetableCoins: readonly StressTargetableCoin[],
): SystemicRisk[] {
  if (!reportData || !mcapMap) return [];

  const results: SystemicRisk[] = [];
  for (const coin of targetableCoins) {
    const overrides = new Map<string, number>();
    overrides.set(coin.id, gradeToStressScore("D"));

    const stressed = computeStressedGrades(reportData.cards, overrides);
    let affectedCount = 0;
    let supplyAtRisk = 0;
    let dependentSupplyAtRisk = 0;

    for (let i = 0; i < reportData.cards.length; i++) {
      if (reportData.cards[i].overallScore !== stressed[i].overallScore) {
        affectedCount++;
        const mcap = mcapMap.get(reportData.cards[i].id) ?? 0;
        supplyAtRisk += mcap;
        if (reportData.cards[i].id !== coin.id) {
          dependentSupplyAtRisk += mcap;
        }
      }
    }

    if (affectedCount > 0) {
      results.push({
        coinId: coin.id,
        name: coin.name,
        symbol: coin.symbol,
        affectedCount,
        supplyAtRisk,
        dependentSupplyAtRisk,
      });
    }
  }

  results.sort((a, b) => b.dependentSupplyAtRisk - a.dependentSupplyAtRisk);
  return results.slice(0, 5);
}
