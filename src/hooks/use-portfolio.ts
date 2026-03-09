"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { scoreToGrade, DIMENSION_ORDER } from "@shared/lib/report-cards";
import type {
  ReportCard,
  DimensionKey,
  ReportCardGrade,
} from "@shared/types";
import {
  computeGroupedExposure,
  computeUpstreamExposure,
  categorizeCollateral,
  type UpstreamExposure,
} from "@/lib/portfolio-analysis";
import {
  encodePortfolioHoldings,
  isPortfolioHolding,
  migratePortfolioIds,
  parsePortfolioUrlParam,
  type PortfolioHolding,
} from "@/lib/portfolio-codec";

export { categorizeCollateral, computeGroupedExposure } from "@/lib/portfolio-analysis";

interface PortfolioState {
  initialized: boolean;
  holdings: PortfolioHolding[];
  totalUsd: number;
  portfolioGrade: ReportCardGrade;
  portfolioScore: number | null;
  dimensionScores: Record<DimensionKey, number | null>;
  upstreamExposure: UpstreamExposure[];
  upstreamExposureGrouped: UpstreamExposure[];
  isFromUrl: boolean;
  addCoin: (coinId: string, amount: number) => void;
  removeCoin: (coinId: string) => void;
  setAmount: (coinId: string, amount: number) => void;
  clearAll: () => void;
  shareUrl: () => string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = "pharos:portfolio";

function loadFromStorage(): PortfolioHolding[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const validated = parsed.filter(isPortfolioHolding);
    const migrated = migratePortfolioIds(validated);
    if (migrated.length !== validated.length || migrated.some((holding, index) => {
      const original = validated[index];
      return !original
        || original.coinId !== holding.coinId
        || original.amount !== holding.amount;
    })) {
      saveToStorage(migrated);
    }
    return migrated;
  } catch {
    return [];
  }
}

function saveToStorage(holdings: PortfolioHolding[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(holdings));
  } catch {
    // Storage full or unavailable — silently ignore
  }
}

function getInitialPortfolioState(): {
  holdings: PortfolioHolding[];
  isFromUrl: boolean;
  initialized: boolean;
} {
  if (typeof window === "undefined") {
    return { holdings: [], isFromUrl: false, initialized: false };
  }
  const urlParam = new URLSearchParams(window.location.search).get("p");
  if (urlParam) {
    return {
      holdings: parsePortfolioUrlParam(urlParam),
      isFromUrl: true,
      initialized: true,
    };
  }
  return {
    holdings: loadFromStorage(),
    isFromUrl: false,
    initialized: true,
  };
}

export function usePortfolio(cards: ReportCard[] | undefined): PortfolioState {
  const [bootState] = useState(getInitialPortfolioState);
  const [holdings, setHoldings] = useState<PortfolioHolding[]>(bootState.holdings);
  const [isFromUrl] = useState(bootState.isFromUrl);
  const initialized = bootState.initialized;

  // Persist to localStorage when holdings change (only if NOT from URL)
  useEffect(() => {
    if (initialized && !isFromUrl) {
      saveToStorage(holdings);
    }
  }, [holdings, isFromUrl, initialized]);

  // --- Actions ---

  const addCoin = useCallback((coinId: string, amount: number) => {
    setHoldings((prev) => {
      // Don't add duplicates
      if (prev.some((h) => h.coinId === coinId)) return prev;
      return [...prev, { coinId, amount }];
    });
  }, []);

  const removeCoin = useCallback((coinId: string) => {
    setHoldings((prev) => prev.filter((h) => h.coinId !== coinId));
  }, []);

  const setAmount = useCallback((coinId: string, amount: number) => {
    setHoldings((prev) =>
      prev.map((h) => (h.coinId === coinId ? { ...h, amount } : h)),
    );
  }, []);

  const clearAll = useCallback(() => {
    setHoldings([]);
  }, []);

  const shareUrl = useCallback((): string => {
    const encoded = encodePortfolioHoldings(holdings);
    if (typeof window === "undefined") return "";
    const url = new URL(window.location.href);
    if (encoded) {
      url.searchParams.set("p", encoded);
    } else {
      url.searchParams.delete("p");
    }
    return url.toString();
  }, [holdings]);

  // --- Derived values ---

  const totalUsd = useMemo(
    () => holdings.reduce((sum, h) => sum + h.amount, 0),
    [holdings],
  );

  // Build a card lookup for fast access
  const cardMap = useMemo(() => {
    if (!cards) return new Map<string, ReportCard>();
    const m = new Map<string, ReportCard>();
    for (const c of cards) m.set(c.id, c);
    return m;
  }, [cards]);

  // Portfolio-level overall grade: weighted average of held coins' overall scores
  const { portfolioGrade, portfolioScore } = useMemo(() => {
    if (!cards || holdings.length === 0 || totalUsd === 0) {
      return { portfolioGrade: "NR" as ReportCardGrade, portfolioScore: null };
    }

    let weightedSum = 0;
    let scoredUsd = 0;

    for (const h of holdings) {
      const card = cardMap.get(h.coinId);
      if (!card || card.overallScore === null) continue; // Exclude NR coins
      weightedSum += card.overallScore * h.amount;
      scoredUsd += h.amount;
    }

    if (scoredUsd === 0) {
      return { portfolioGrade: "NR" as ReportCardGrade, portfolioScore: null };
    }

    const score = Math.round(weightedSum / scoredUsd);
    return { portfolioGrade: scoreToGrade(score), portfolioScore: score };
  }, [cards, holdings, totalUsd, cardMap]);

  // Per-dimension weighted average scores
  const dimensionScores = useMemo((): Record<DimensionKey, number | null> => {
    const result = {} as Record<DimensionKey, number | null>;

    for (const dim of DIMENSION_ORDER) {
      if (!cards || holdings.length === 0 || totalUsd === 0) {
        result[dim] = null;
        continue;
      }

      let weightedSum = 0;
      let scoredUsd = 0;

      for (const h of holdings) {
        const card = cardMap.get(h.coinId);
        const dimScore = card?.dimensions[dim]?.score;
        if (dimScore === null || dimScore === undefined) continue;
        weightedSum += dimScore * h.amount;
        scoredUsd += h.amount;
      }

      result[dim] = scoredUsd > 0 ? Math.round(weightedSum / scoredUsd) : null;
    }

    return result;
  }, [cards, holdings, totalUsd, cardMap]);

  // Upstream exposure
  const upstreamExposure = useMemo(
    () => (cards ? computeUpstreamExposure(holdings, cards) : []),
    [holdings, cards],
  );

  const upstreamExposureGrouped = useMemo(
    () => computeGroupedExposure(upstreamExposure, totalUsd),
    [upstreamExposure, totalUsd],
  );

  return {
    initialized,
    holdings,
    totalUsd,
    portfolioGrade,
    portfolioScore,
    dimensionScores,
    upstreamExposure,
    upstreamExposureGrouped,
    isFromUrl,
    addCoin,
    removeCoin,
    setAmount,
    clearAll,
    shareUrl,
  };
}
