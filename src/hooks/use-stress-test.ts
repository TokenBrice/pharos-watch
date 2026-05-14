"use client";

import { useState, useMemo, useCallback } from "react";
import type {
  ReportCard,
  ReportCardGrade,
  ReportCardsResponse,
} from "@shared/types";
import {
  buildAffectedIds,
  buildReportCardMap,
  buildStressHeadline,
  buildStressImpacts,
  buildStressedCards,
  buildSystemicRisks,
  buildTargetableCoins,
  getDowngradeOptions,
  parseStressSelectionFromSearch,
  type StressTargetableCoin,
  type StressTestImpact,
  type SystemicRisk,
} from "./use-stress-test-model";

export { parseStressSelectionFromSearch } from "./use-stress-test-model";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  targetableCoins: StressTargetableCoin[];
  gradeOptions: ReportCardGrade[];
  setTarget: (coinId: string | null) => void;
  setGrade: (grade: ReportCardGrade | null) => void;
  clear: () => void;
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
  const cardMap = useMemo(() => buildReportCardMap(reportData), [reportData]);

  // --- Targetable coins: coins that appear as upstream (from) in dependency edges ---
  const targetableCoins = useMemo(() => buildTargetableCoins(reportData), [reportData]);

  // --- Grade options: grades strictly below target coin's current grade ---
  const gradeOptions = useMemo((): ReportCardGrade[] => {
    if (!targetCoinId) return [];
    const card = cardMap.get(targetCoinId);
    if (!card) return [];
    return getDowngradeOptions(card.overallGrade);
  }, [targetCoinId, cardMap]);

  // --- Stressed cards: recompute when target + grade are set ---
  const stressedCards = useMemo(
    (): ReportCard[] | null => buildStressedCards(reportData, targetCoinId, targetGrade),
    [targetCoinId, targetGrade, reportData],
  );

  // --- All affected coin IDs — for card grid highlighting ---
  const allAffectedIds = useMemo((): Set<string> => buildAffectedIds(reportData, stressedCards), [stressedCards, reportData]);

  // --- Impacts: compare stressed vs original ---
  const impacts = useMemo(
    (): StressTestImpact[] => buildStressImpacts(reportData, stressedCards),
    [stressedCards, reportData],
  );

  // --- Headline stats ---
  const headline = useMemo(() => {
    if (!stressedCards || !reportData) return null;

    return buildStressHeadline(impacts, allAffectedIds, mcapMap);
  }, [stressedCards, reportData, impacts, allAffectedIds, mcapMap]);

  // --- Systemic risks: which coins would cause the most downstream damage ---
  const systemicRisks = useMemo(
    (): SystemicRisk[] => buildSystemicRisks(reportData, mcapMap, targetableCoins),
    [reportData, mcapMap, targetableCoins],
  );

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
