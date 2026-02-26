"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { scoreToGrade, DIMENSION_ORDER } from "@/lib/report-cards";
import type {
  ReportCard,
  DimensionKey,
  ReportCardGrade,
  DependencyWeight,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PortfolioHolding {
  coinId: string;
  amount: number; // USD
}

export interface UpstreamExposure {
  coinId: string;
  name: string;
  symbol: string;
  usd: number;
  pct: number;
}

export interface PortfolioState {
  holdings: PortfolioHolding[];
  totalUsd: number;
  portfolioGrade: ReportCardGrade;
  portfolioScore: number | null;
  dimensionScores: Record<DimensionKey, number | null>;
  upstreamExposure: UpstreamExposure[];
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

// ---------------------------------------------------------------------------
// Lookup maps (built once at module level)
// ---------------------------------------------------------------------------

const symbolToId = new Map<string, string>();
const idToSymbol = new Map<string, string>();
const idToMeta = new Map<string, { name: string; symbol: string }>();

for (const coin of TRACKED_STABLECOINS) {
  const lower = coin.symbol.toLowerCase();
  symbolToId.set(lower, coin.id);
  idToSymbol.set(coin.id, lower);
  idToMeta.set(coin.id, { name: coin.name, symbol: coin.symbol });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseUrlParam(param: string): PortfolioHolding[] {
  if (!param) return [];
  const holdings: PortfolioHolding[] = [];
  for (const part of param.split(",")) {
    const [sym, amtStr] = part.split(":");
    if (!sym || !amtStr) continue;
    const coinId = symbolToId.get(sym.toLowerCase());
    const amount = Number(amtStr);
    if (coinId && Number.isFinite(amount) && amount > 0) {
      holdings.push({ coinId, amount });
    }
  }
  return holdings;
}

function encodeHoldings(holdings: PortfolioHolding[]): string {
  return holdings
    .map((h) => {
      const sym = idToSymbol.get(h.coinId);
      return sym ? `${sym}:${h.amount}` : null;
    })
    .filter(Boolean)
    .join(",");
}

function loadFromStorage(): PortfolioHolding[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (h): h is PortfolioHolding =>
        typeof h === "object" &&
        h !== null &&
        typeof (h as PortfolioHolding).coinId === "string" &&
        typeof (h as PortfolioHolding).amount === "number" &&
        (h as PortfolioHolding).amount > 0,
    );
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

// ---------------------------------------------------------------------------
// Upstream exposure walker
// ---------------------------------------------------------------------------

function computeUpstreamExposure(
  holdings: PortfolioHolding[],
  cards: ReportCard[],
): UpstreamExposure[] {
  const cardMap = new Map<string, ReportCard>();
  for (const c of cards) cardMap.set(c.id, c);

  const exposureUsd = new Map<string, number>();
  let otherUsd = 0;

  for (const holding of holdings) {
    const card = cardMap.get(holding.coinId);
    const deps: DependencyWeight[] = card?.rawInputs?.dependencies ?? [];

    if (deps.length === 0) {
      exposureUsd.set(
        holding.coinId,
        (exposureUsd.get(holding.coinId) ?? 0) + holding.amount,
      );
      continue;
    }

    let allocatedWeight = 0;
    for (const dep of deps) {
      const depUsd = holding.amount * dep.weight;
      if (idToMeta.has(dep.id)) {
        exposureUsd.set(dep.id, (exposureUsd.get(dep.id) ?? 0) + depUsd);
      } else {
        otherUsd += depUsd;
      }
      allocatedWeight += dep.weight;
    }

    const remainder = 1 - allocatedWeight;
    if (remainder > 0.001) {
      otherUsd += holding.amount * remainder;
    }
  }

  const totalUsd = holdings.reduce((s, h) => s + h.amount, 0);
  const result: UpstreamExposure[] = [];

  for (const [coinId, usd] of exposureUsd) {
    const meta = idToMeta.get(coinId);
    if (!meta) continue;
    result.push({
      coinId,
      name: meta.name,
      symbol: meta.symbol,
      usd,
      pct: totalUsd > 0 ? (usd / totalUsd) * 100 : 0,
    });
  }

  if (otherUsd > 0.01) {
    result.push({
      coinId: "__other__",
      name: "Other",
      symbol: "OTHER",
      usd: otherUsd,
      pct: totalUsd > 0 ? (otherUsd / totalUsd) * 100 : 0,
    });
  }

  result.sort((a, b) => b.usd - a.usd);
  return result;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePortfolio(cards: ReportCard[] | undefined): PortfolioState {
  const searchParams = useSearchParams();
  const urlParam = searchParams.get("p");

  const isFromUrl = urlParam !== null && urlParam.length > 0;

  const [holdings, setHoldings] = useState<PortfolioHolding[]>(() => {
    if (isFromUrl) return parseUrlParam(urlParam);
    return loadFromStorage();
  });

  useEffect(() => {
    if (isFromUrl) {
      setHoldings(parseUrlParam(urlParam));
    }
  }, [isFromUrl, urlParam]);

  useEffect(() => {
    if (!isFromUrl) {
      saveToStorage(holdings);
    }
  }, [holdings, isFromUrl]);

  const addCoin = useCallback((coinId: string, amount: number) => {
    setHoldings((prev) => {
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
    const encoded = encodeHoldings(holdings);
    if (typeof window === "undefined") return "";
    const url = new URL(window.location.href);
    if (encoded) {
      url.searchParams.set("p", encoded);
    } else {
      url.searchParams.delete("p");
    }
    return url.toString();
  }, [holdings]);

  const totalUsd = useMemo(
    () => holdings.reduce((sum, h) => sum + h.amount, 0),
    [holdings],
  );

  const cardMap = useMemo(() => {
    if (!cards) return new Map<string, ReportCard>();
    const m = new Map<string, ReportCard>();
    for (const c of cards) m.set(c.id, c);
    return m;
  }, [cards]);

  const { portfolioGrade, portfolioScore } = useMemo(() => {
    if (!cards || holdings.length === 0 || totalUsd === 0) {
      return { portfolioGrade: "NR" as ReportCardGrade, portfolioScore: null };
    }

    let weightedSum = 0;
    let scoredUsd = 0;

    for (const h of holdings) {
      const card = cardMap.get(h.coinId);
      if (!card || card.overallScore === null) continue;
      weightedSum += card.overallScore * h.amount;
      scoredUsd += h.amount;
    }

    if (scoredUsd === 0) {
      return { portfolioGrade: "NR" as ReportCardGrade, portfolioScore: null };
    }

    const score = Math.round(weightedSum / scoredUsd);
    return { portfolioGrade: scoreToGrade(score), portfolioScore: score };
  }, [cards, holdings, totalUsd, cardMap]);

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

  const upstreamExposure = useMemo(
    () => (cards ? computeUpstreamExposure(holdings, cards) : []),
    [holdings, cards],
  );

  return {
    holdings,
    totalUsd,
    portfolioGrade,
    portfolioScore,
    dimensionScores,
    upstreamExposure,
    isFromUrl,
    addCoin,
    removeCoin,
    setAmount,
    clearAll,
    shareUrl,
  };
}
