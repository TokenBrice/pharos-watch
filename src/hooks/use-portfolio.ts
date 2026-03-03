"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { scoreToGrade, DIMENSION_ORDER } from "@/lib/report-cards";
import type {
  ReportCard,
  DimensionKey,
  ReportCardGrade,
  DependencyWeight,
  ReserveSlice,
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
  isCollateral: boolean; // true = non-stablecoin collateral (ETH, T-bills, etc.)
}

export interface PortfolioState {
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

// ---------------------------------------------------------------------------
// Lookup maps (built once at module level)
// ---------------------------------------------------------------------------

const symbolToId = new Map<string, string>();
const idToSymbol = new Map<string, string>();
const idToMeta = new Map<string, {
  name: string;
  symbol: string;
  backing: string;
  reserves?: ReserveSlice[];
}>();

for (const coin of TRACKED_STABLECOINS) {
  const lower = coin.symbol.toLowerCase();
  symbolToId.set(lower, coin.id);
  idToSymbol.set(coin.id, lower);
  idToMeta.set(coin.id, {
    name: coin.name,
    symbol: coin.symbol,
    backing: coin.flags.backing,
    reserves: coin.reserves,
  });
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
// Helpers for reserve-based collateral breakdown
// ---------------------------------------------------------------------------

const STABLECOIN_SLICE_KEYWORDS = ["usdc", "usdt", "dai", "usds", "busd", "frax", "stablecoin", "stable"];

function isStablecoinSlice(name: string): boolean {
  const lower = name.toLowerCase();
  return STABLECOIN_SLICE_KEYWORDS.some((kw) => lower.includes(kw));
}

function collateralKey(name: string): string {
  return `__collateral_${name.toLowerCase().replace(/[^a-z0-9]/g, "_")}__`;
}

function backingFallback(backing: string): { name: string; symbol: string } {
  if (backing === "algorithmic") return { name: "Algorithmic Mechanism", symbol: "ALGO" };
  if (backing === "crypto-backed") return { name: "Crypto Collateral", symbol: "CRYPTO" };
  return { name: "Real-World Assets (RWA)", symbol: "RWA" };
}

// ---------------------------------------------------------------------------
// Collateral category lookup
// ---------------------------------------------------------------------------

const COLLATERAL_CATEGORIES: Array<{ pattern: RegExp; label: string }> = [
  // Most specific first
  {
    pattern: /treasury|treasuries|t-bill|tbill|buidl|usyc|ustb|openeden|repo|money.market|wm.*m0|m0.*wm|ishares.*treasury|government.money.market|government.securities/i,
    label: "U.S. Treasury Bills",
  },
  {
    pattern: /\beur\b|euro.*deposit|euro.*cash|euro.*bond|eu.*gov|european.*asset|european.*bank|societe.generale|arion.bank|lhv.bank|swissquote|flowbank/i,
    label: "EUR / European Assets",
  },
  {
    pattern: /\bcash\b|cash.deposit|bank.deposit|bank.*deposit|cash.equivalent|fiat.usd|bny.mellon|usd.*bank|segregated.*cash|cash.*custody|cash.in.bankrupt/i,
    label: "USD Cash Deposits",
  },
  {
    pattern: /delta.hedged|spot.crypto|perpetual|\bperp\b|basis.trad|short.futures|short.perp|funding.trad/i,
    label: "Delta-Neutral Positions",
  },
  {
    pattern: /\bbtc(?!-margined)\b|bitcoin|wbtc|cbbtc|tbtc|fbtc|solvbtc|kbtc|ubtc/i,
    label: "Bitcoin (BTC)",
  },
  {
    pattern: /\bweth\b|wsteth|steth|lseth|\breth\b|liquid.*stak.*eth|eth.*liquid|\beth\b/i,
    label: "ETH / Liquid Staking",
  },
  {
    pattern: /silver/i,
    label: "Physical Silver",
  },
  {
    pattern: /\bgold\b|lbma|gold.bullion|pamp.*gold|tokenized.*gold/i,
    label: "Physical Gold",
  },
  {
    pattern: /morpho|aave|euler|pendle|curve.*lp|yearn|lp.token|lending.position|vault.share|fraxlend|compound/i,
    label: "DeFi Collateral",
  },
  {
    pattern: /\bsol\b|\bbnb\b|\bavax\b|\bdot\b|\bsui\b|\bxtz\b|\bhype\b|\bsnx\b/i,
    label: "Other Crypto",
  },
];

export function categorizeCollateral(name: string): string {
  for (const { pattern, label } of COLLATERAL_CATEGORIES) {
    if (pattern.test(name)) return label;
  }
  return "Other RWA";
}

// Coin IDs that belong to the "Major Centralized Stablecoins" group:
// fiat majors (USDT, USDC, USDS, PYUSD, FDUSD, USDP) +
// institutional RWA products used as backing (BUIDL, M, USDtb, USDY, USYC, TBILL)
const MAJOR_CENTRALIZED_IDS = new Set([
  "1",   // USDT — Tether
  "2",   // USDC — Circle
  "11",  // USDP — Paxos
  "119", // FDUSD — First Digital
  "120", // PYUSD — PayPal
  "129", // USDY — Ondo
  "173", // BUIDL — BlackRock
  "209", // USDS — Sky
  "213", // M — M0 Protocol
  "221", // USDtb — Ethena
  "237", // USYC — Hashnote
  "257", // TBILL — OpenEden
]);

export function computeGroupedExposure(
  raw: UpstreamExposure[],
  totalUsd: number,
): UpstreamExposure[] {
  // Stablecoin deps: group majors together, pass the rest through individually
  let majorUsd = 0;
  const stablecoinEntries: UpstreamExposure[] = [];
  for (const entry of raw) {
    if (entry.isCollateral) continue;
    if (MAJOR_CENTRALIZED_IDS.has(entry.coinId)) {
      majorUsd += entry.usd;
    } else {
      stablecoinEntries.push(entry);
    }
  }
  if (majorUsd > 0) {
    stablecoinEntries.unshift({
      coinId: "__group_major_centralized__",
      name: "Major Centralized Stablecoins",
      symbol: "",
      usd: majorUsd,
      pct: totalUsd > 0 ? (majorUsd / totalUsd) * 100 : 0,
      isCollateral: false,
    });
  }

  // Collateral entries: collapse by category
  const categoryMap = new Map<string, { usd: number }>();
  for (const entry of raw) {
    if (entry.isCollateral) {
      const category = categorizeCollateral(entry.name);
      const existing = categoryMap.get(category);
      if (existing) {
        existing.usd += entry.usd;
      } else {
        categoryMap.set(category, { usd: entry.usd });
      }
    }
  }

  const collateralEntries: UpstreamExposure[] = Array.from(categoryMap.entries()).map(
    ([category, { usd }]) => ({
      coinId: `__category_${category.toLowerCase().replace(/[^a-z0-9]/g, "_")}__`,
      name: category,
      symbol: category,
      usd,
      pct: totalUsd > 0 ? (usd / totalUsd) * 100 : 0,
      isCollateral: true,
    }),
  );

  collateralEntries.sort((a, b) => b.usd - a.usd);
  return [...stablecoinEntries, ...collateralEntries];
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

  // Stablecoin upstream exposure: keyed by tracked coin id
  const stablecoinUsd = new Map<string, number>();
  // Collateral exposure: keyed by slug (same name = same bucket across coins)
  const collateralUsd = new Map<string, { name: string; symbol: string; usd: number }>();

  function addCollateral(name: string, symbol: string, usd: number): void {
    if (usd < 0.01) return;
    const key = collateralKey(name);
    const existing = collateralUsd.get(key);
    if (existing) {
      existing.usd += usd;
    } else {
      collateralUsd.set(key, { name, symbol, usd });
    }
  }

  function applyReservesToRemainder(
    reserves: ReserveSlice[],
    remainderUsd: number,
    backing: string,
  ): void {
    const nonStable = reserves.filter((r) => !isStablecoinSlice(r.name));
    if (nonStable.length === 0) {
      const { name, symbol } = backingFallback(backing);
      addCollateral(name, symbol, remainderUsd);
      return;
    }
    const totalPct = nonStable.reduce((s, r) => s + r.pct, 0);
    for (const slice of nonStable) {
      addCollateral(slice.name, slice.name, remainderUsd * (slice.pct / totalPct));
    }
  }

  for (const holding of holdings) {
    const card = cardMap.get(holding.coinId);
    const deps: DependencyWeight[] = card?.rawInputs?.dependencies ?? [];
    const meta = idToMeta.get(holding.coinId);
    const backing = meta?.backing ?? "rwa-backed";
    const reserves = meta?.reserves;

    if (deps.length === 0) {
      // No stablecoin dependencies — look through to collateral
      if (reserves && reserves.length > 0) {
        const totalPct = reserves.reduce((s, r) => s + r.pct, 0);
        for (const slice of reserves) {
          addCollateral(slice.name, slice.name, holding.amount * (slice.pct / totalPct));
        }
      } else {
        const { name, symbol } = backingFallback(backing);
        addCollateral(name, symbol, holding.amount);
      }
      continue;
    }

    // Has stablecoin dependencies
    let allocatedWeight = 0;
    for (const dep of deps) {
      const depUsd = holding.amount * dep.weight;
      if (idToMeta.has(dep.id)) {
        stablecoinUsd.set(dep.id, (stablecoinUsd.get(dep.id) ?? 0) + depUsd);
      }
      // Untracked deps count toward allocatedWeight but go into remainder
      allocatedWeight += dep.weight;
    }

    const remainder = 1 - allocatedWeight;
    if (remainder > 0.001) {
      const remainderUsd = holding.amount * remainder;
      if (reserves && reserves.length > 0) {
        applyReservesToRemainder(reserves, remainderUsd, backing);
      } else {
        const { name, symbol } = backingFallback(backing);
        addCollateral(name, symbol, remainderUsd);
      }
    }
  }

  const totalUsd = holdings.reduce((s, h) => s + h.amount, 0);
  const result: UpstreamExposure[] = [];

  for (const [coinId, usd] of stablecoinUsd) {
    const meta = idToMeta.get(coinId);
    if (!meta) continue;
    result.push({
      coinId,
      name: meta.name,
      symbol: meta.symbol,
      usd,
      pct: totalUsd > 0 ? (usd / totalUsd) * 100 : 0,
      isCollateral: false,
    });
  }

  for (const [key, { name, symbol, usd }] of collateralUsd) {
    result.push({
      coinId: key,
      name,
      symbol,
      usd,
      pct: totalUsd > 0 ? (usd / totalUsd) * 100 : 0,
      isCollateral: true,
    });
  }

  // Stablecoin entries first (most actionable risk), then collateral; descending USD within each group
  result.sort((a, b) => {
    if (a.isCollateral !== b.isCollateral) return a.isCollateral ? 1 : -1;
    return b.usd - a.usd;
  });

  return result;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePortfolio(cards: ReportCard[] | undefined): PortfolioState {
  // Start empty, then hydrate from URL or localStorage after mount.
  const [holdings, setHoldings] = useState<PortfolioHolding[]>([]);
  const [isFromUrl, setIsFromUrl] = useState(false);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const urlParam = new URLSearchParams(window.location.search).get("p");
    if (urlParam) {
      setIsFromUrl(true);
      setHoldings(parseUrlParam(urlParam));
    } else {
      setIsFromUrl(false);
      setHoldings(loadFromStorage());
    }
    setInitialized(true);
  }, []);

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
