"use client";

import { useState, useMemo, useCallback } from "react";
import { computeStressedGrades, GRADE_THRESHOLDS } from "@shared/lib/report-cards";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { isKnownCoinId } from "@shared/lib/validate-coin-id";
import type {
  ReportCard,
  ReportCardGrade,
  ReportCardsResponse,
} from "@shared/types";
import { decodeStablecoinUrlToken } from "@/lib/stablecoin-url-codec";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StressTestImpact {
  coinId: string;
  name: string;
  symbol: string;
  gradeBefore: ReportCardGrade;
  scoreBefore: number | null;
  gradeAfter: ReportCardGrade;
  scoreAfter: number | null;
  delta: number; // score change (negative = downgrade)
}

interface SystemicRisk {
  coinId: string;
  name: string;
  symbol: string;
  affectedCount: number;
  supplyAtRisk: number;
}

export interface StressTestState {
  targetCoinId: string | null;
  targetGrade: ReportCardGrade | null;
  stressedCards: ReportCard[] | null;
  impacts: StressTestImpact[];
  /** All coin IDs whose score changed — used for card grid highlighting */
  allAffectedIds: Set<string>;
  headline: {
    totalAtRisk: number;
    totalSupply: number;
    affectedCount: number;
  } | null;
  systemicRisks: SystemicRisk[];
  targetableCoins: { id: string; name: string; symbol: string; dependentCount: number }[];
  gradeOptions: ReportCardGrade[];
  setTarget: (coinId: string | null) => void;
  setGrade: (grade: ReportCardGrade | null) => void;
  clear: () => void;
}

// ---------------------------------------------------------------------------
// Lookup maps (built once at module level)
// ---------------------------------------------------------------------------

const idToMeta = new Map<string, { name: string; symbol: string }>();

for (const coin of ACTIVE_STABLECOINS) {
  idToMeta.set(coin.id, { name: coin.name, symbol: coin.symbol });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a target grade to a numeric score (midpoint of grade range).
 * For example: D has range 50-59, midpoint = 55.
 * F has range 0-49, midpoint = 25.
 * A+ has range 97-100, midpoint = 99 (capped at 100).
 */
function gradeToScore(grade: ReportCardGrade): number {
  if (grade === "NR") return 0;

  const idx = GRADE_THRESHOLDS.findIndex((t) => t.grade === grade);
  if (idx < 0) return 0;

  const min = GRADE_THRESHOLDS[idx].min;
  // The max of this grade range is one below the min of the next-higher grade,
  // or 100 for the top grade (A+).
  const max = idx === 0 ? 100 : GRADE_THRESHOLDS[idx - 1].min - 1;

  return Math.round((min + max) / 2);
}

/**
 * Get the list of letter grades strictly below the given grade, down to F.
 * NR is excluded. Returns empty if grade is F or NR.
 */
function getDowngradeOptions(currentGrade: ReportCardGrade): ReportCardGrade[] {
  if (currentGrade === "NR") return [];

  const gradeList = GRADE_THRESHOLDS.map((t) => t.grade);
  const idx = gradeList.indexOf(currentGrade);
  if (idx < 0 || idx >= gradeList.length - 1) return []; // F or not found

  // Grades below: everything after current index (lower grades)
  return gradeList.slice(idx + 1);
}

export function parseStressSelectionFromSearch(
  search: string,
): { coinId: string | null; grade: ReportCardGrade | null } {
  const searchParams = new URLSearchParams(search);
  const stressParam = searchParams.get("stress");
  if (!stressParam) {
    return { coinId: null, grade: null };
  }

  const rawCoinId = decodeStablecoinUrlToken(stressParam);
  const coinId = rawCoinId && isKnownCoinId(rawCoinId) ? rawCoinId : null;
  if (!coinId) {
    return { coinId: null, grade: null };
  }

  const gradeParam = searchParams.get("grade");
  if (!gradeParam) {
    return { coinId, grade: null };
  }

  const normalizedGrade = gradeParam.toUpperCase();
  const validGrade = GRADE_THRESHOLDS.find((t) => t.grade === normalizedGrade);
  return { coinId, grade: validGrade?.grade ?? null };
}

function parseInitialStressSelection(): { coinId: string | null; grade: ReportCardGrade | null } {
  if (typeof window === "undefined") {
    return { coinId: null, grade: null };
  }

  return parseStressSelectionFromSearch(window.location.search);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useStressTest(
  reportData: ReportCardsResponse | undefined,
  mcapMap?: Map<string, number>,
): StressTestState {
  const [targetCoinId, setTargetCoinId] = useState<string | null>(() => parseInitialStressSelection().coinId);
  const [targetGrade, setTargetGrade] = useState<ReportCardGrade | null>(() => parseInitialStressSelection().grade);

  // --- Card lookup ---
  const cardMap = useMemo(() => {
    if (!reportData) return new Map<string, ReportCard>();
    const m = new Map<string, ReportCard>();
    for (const c of reportData.cards) m.set(c.id, c);
    return m;
  }, [reportData]);

  // --- Targetable coins: coins that appear as upstream (from) in dependency edges ---
  const targetableCoins = useMemo(() => {
    if (!reportData) return [];

    const counts = new Map<string, number>();
    for (const edge of reportData.dependencyGraph.edges) {
      counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1);
    }

    const result: { id: string; name: string; symbol: string; dependentCount: number }[] = [];
    for (const [id, count] of counts) {
      const meta = idToMeta.get(id);
      if (meta) {
        result.push({ id, name: meta.name, symbol: meta.symbol, dependentCount: count });
      }
    }

    result.sort((a, b) => b.dependentCount - a.dependentCount);
    return result;
  }, [reportData]);

  // --- Grade options: grades strictly below target coin's current grade ---
  const gradeOptions = useMemo((): ReportCardGrade[] => {
    if (!targetCoinId) return [];
    const card = cardMap.get(targetCoinId);
    if (!card) return [];
    return getDowngradeOptions(card.overallGrade);
  }, [targetCoinId, cardMap]);

  // --- Stressed cards: recompute when target + grade are set ---
  const stressedCards = useMemo((): ReportCard[] | null => {
    if (!targetCoinId || !targetGrade || !reportData) return null;

    const overrides = new Map<string, number>();
    overrides.set(targetCoinId, gradeToScore(targetGrade));

    return computeStressedGrades(reportData.cards, overrides);
  }, [targetCoinId, targetGrade, reportData]);

  // --- All affected coin IDs — for card grid highlighting ---
  const allAffectedIds = useMemo((): Set<string> => {
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
  }, [stressedCards, reportData]);

  // --- Impacts: compare stressed vs original ---
  const impacts = useMemo((): StressTestImpact[] => {
    if (!stressedCards || !reportData) return [];

    const result: StressTestImpact[] = [];

    for (let i = 0; i < reportData.cards.length; i++) {
      const original = reportData.cards[i];
      const stressed = stressedCards[i];

      // Skip if scores didn't change
      const scoreBefore = original.overallScore;
      const scoreAfter = stressed.overallScore;
      if (scoreBefore === scoreAfter) continue;
      // Both null means no change
      if (scoreBefore === null && scoreAfter === null) continue;

      const delta = (scoreAfter ?? 0) - (scoreBefore ?? 0);

      const meta = idToMeta.get(original.id);
      result.push({
        coinId: original.id,
        name: meta?.name ?? original.name,
        symbol: meta?.symbol ?? original.symbol,
        gradeBefore: original.overallGrade,
        scoreBefore,
        gradeAfter: stressed.overallGrade,
        scoreAfter,
        delta,
      });
    }

    // Sort by absolute delta descending (biggest impact first)
    result.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    return result;
  }, [stressedCards, reportData]);

  // --- Headline stats ---
  const headline = useMemo(() => {
    if (!stressedCards || !reportData) return null;

    const impactedIds = new Set(impacts.map((i) => i.coinId));
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
  }, [stressedCards, reportData, impacts, allAffectedIds, mcapMap]);

  // --- Systemic risks: which coins would cause the most downstream damage ---
  const systemicRisks = useMemo((): SystemicRisk[] => {
    if (!reportData || !mcapMap) return [];

    const results: SystemicRisk[] = [];
    for (const coin of targetableCoins) {
      const overrides = new Map<string, number>();
      overrides.set(coin.id, gradeToScore("D"));

      const stressed = computeStressedGrades(reportData.cards, overrides);
      let affectedCount = 0;
      let supplyAtRisk = 0;

      for (let i = 0; i < reportData.cards.length; i++) {
        if (reportData.cards[i].overallScore !== stressed[i].overallScore) {
          affectedCount++;
          supplyAtRisk += mcapMap.get(reportData.cards[i].id) ?? 0;
        }
      }

      if (affectedCount > 0) {
        results.push({
          coinId: coin.id,
          name: coin.name,
          symbol: coin.symbol,
          affectedCount,
          supplyAtRisk,
        });
      }
    }

    results.sort((a, b) => b.supplyAtRisk - a.supplyAtRisk);
    return results.slice(0, 5);
  }, [reportData, mcapMap, targetableCoins]);

  // --- Actions ---

  const setTarget = useCallback((coinId: string | null) => {
    setTargetCoinId(coinId);
    // Reset grade when target changes (grade options change)
    setTargetGrade(null);
  }, []);

  const setGrade = useCallback((grade: ReportCardGrade | null) => {
    setTargetGrade(grade);
  }, []);

  const clear = useCallback(() => {
    setTargetCoinId(null);
    setTargetGrade(null);
  }, []);

  return {
    targetCoinId,
    targetGrade,
    stressedCards,
    impacts,
    allAffectedIds,
    headline,
    systemicRisks,
    targetableCoins,
    gradeOptions,
    setTarget,
    setGrade,
    clear,
  };
}
