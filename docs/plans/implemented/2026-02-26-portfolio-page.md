# Portfolio Page Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a standalone `/portfolio` page with a holdings editor, portfolio risk analysis (radar + upstream exposure), stress test simulation, and a grade card grid filtered to held coins.

**Architecture:** Restore the deleted `use-portfolio.ts` hook verbatim and adapt `portfolio-panel.tsx` into a flat client page (`src/app/portfolio/client.tsx`) that always shows content expanded. The stress test and grade card grid reuse existing components unchanged. URL state coexists: `?p=` for holdings, `?stress=`/`?grade=` for stress test.

**Tech Stack:** Next.js 16 static export, React 19, TypeScript strict, TanStack Query, Tailwind v4, shadcn/ui Cards, Lucide icons, existing hooks (`useReportCards`, `useStablecoins`, `useLogos`, `useStressTest`), existing components (`StressTestPanel`, `ReportCardMini`, `ReportCardRadar`, `GradeBadge`, `StablecoinLogo`, `CoinSelector`).

---

## Task 1: Restore `use-portfolio.ts` hook

**Files:**
- Create: `src/hooks/use-portfolio.ts`

This is a straight restore from the deleted commit. No changes needed.

**Step 1: Create the file**

```typescript
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
```

**Step 2: Type-check**

```bash
npm run build 2>&1 | grep -E "error|warning" | head -20
```

Expected: no errors related to `use-portfolio.ts`.

**Step 3: Commit**

```bash
git add src/hooks/use-portfolio.ts
git commit -m "feat(portfolio): restore use-portfolio hook"
```

---

## Task 2: Create `src/app/portfolio/` route files

**Files:**
- Create: `src/app/portfolio/page.tsx`
- Create: `src/app/portfolio/client.tsx`

**Step 1: Create `page.tsx`**

```tsx
import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { PortfolioClient } from "./client";

const description =
  "Build your stablecoin portfolio, see your weighted safety grade, upstream collateral exposure, and simulate how a major stablecoin failure would affect your holdings.";

export const metadata: Metadata = {
  title: "Portfolio — Personal Stablecoin Risk View",
  description,
  alternates: { canonical: "/portfolio/" },
  openGraph: {
    title: "Portfolio — Personal Stablecoin Risk View",
    description,
    url: "/portfolio/",
  },
};

export default function PortfolioPage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Portfolio" path="/portfolio/" />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Portfolio</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter">Portfolio</h1>
        <p className="text-sm text-muted-foreground">
          Track your stablecoin holdings and assess your personal risk exposure.
        </p>
      </div>
      <Suspense>
        <PortfolioClient />
      </Suspense>
    </div>
  );
}
```

**Step 2: Create `client.tsx`**

This is the heart of the page. It composes the holdings editor, analysis panels, stress test, and grade card grid.

```tsx
"use client";

import { useEffect, useMemo, useRef, useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CoinSelector } from "@/components/coin-selector";
import { ReportCardRadar } from "@/components/radar-chart";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { GradeBadge } from "@/components/grade-badge";
import { StressTestPanel } from "@/components/stress-test-panel";
import { ReportCardMini } from "@/components/report-card-mini";
import { useReportCards } from "@/hooks/use-report-cards";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { useStressTest } from "@/hooks/use-stress-test";
import { usePortfolio } from "@/hooks/use-portfolio";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "@/lib/stablecoins";
import { DEAD_STABLECOINS } from "@/lib/dead-stablecoins";
import { DIMENSION_ORDER, scoreToGrade } from "@/lib/report-cards";
import { sumPegBuckets } from "@/lib/supply";
import type { ReportCard } from "@/lib/types";
import { AlertTriangle, Share2, Trash2, Wallet, X } from "lucide-react";
import { trackEvent } from "@/lib/analytics";

// ---------------------------------------------------------------------------
// Coin options (built once at module level)
// ---------------------------------------------------------------------------

const deadIds = new Set(
  DEAD_STABLECOINS.filter((d) => d.llamaId).map((d) => d.llamaId!),
);

const coinOptions = TRACKED_STABLECOINS
  .filter((s) => !deadIds.has(s.id))
  .map((s) => ({ id: s.id, name: s.name, symbol: s.symbol }));

// ---------------------------------------------------------------------------
// USD formatters
// ---------------------------------------------------------------------------

const usdFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

const usdFormatterCompact = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

function formatUsd(value: number): string {
  return `$${usdFormatter.format(value)}`;
}

function parseUsdInput(raw: string): number {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const num = parseFloat(cleaned);
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

// ---------------------------------------------------------------------------
// HoldingRow
// ---------------------------------------------------------------------------

function HoldingRow({
  coinId,
  amount,
  logos,
  onSetAmount,
  onRemove,
}: {
  coinId: string;
  amount: number;
  logos?: Record<string, string>;
  onSetAmount: (coinId: string, amount: number) => void;
  onRemove: (coinId: string) => void;
}) {
  const meta = TRACKED_META_BY_ID.get(coinId);
  const [editing, setEditing] = useState(false);
  const [rawValue, setRawValue] = useState(usdFormatterCompact.format(amount));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) {
      setRawValue(amount > 0 ? usdFormatterCompact.format(amount) : "");
    }
  }, [amount, editing]);

  const handleFocus = useCallback(() => {
    setEditing(true);
    setRawValue(amount > 0 ? String(amount) : "");
  }, [amount]);

  const handleBlur = useCallback(() => {
    setEditing(false);
    const parsed = parseUsdInput(rawValue);
    onSetAmount(coinId, parsed);
    setRawValue(parsed > 0 ? usdFormatterCompact.format(parsed) : "");
  }, [rawValue, coinId, onSetAmount]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setRawValue(e.target.value);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") inputRef.current?.blur();
  }, []);

  if (!meta) return null;

  return (
    <div className="flex items-center gap-3 py-2">
      <StablecoinLogo src={logos?.[coinId]} name={meta.name} size={24} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{meta.name}</div>
        <div className="text-xs text-muted-foreground">{meta.symbol}</div>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">
            $
          </span>
          <input
            ref={inputRef}
            type="text"
            inputMode="decimal"
            value={rawValue}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="0"
            className="w-28 rounded-md border bg-transparent pl-5 pr-2 py-1.5 text-sm text-right outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Amount in USD for ${meta.name}`}
          />
        </div>
        <button
          onClick={() => onRemove(coinId)}
          className="text-muted-foreground hover:text-destructive transition-colors p-1 rounded focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={`Remove ${meta.name}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExposureBar
// ---------------------------------------------------------------------------

function ExposureBar({
  name,
  symbol,
  usd,
  pct,
  isWarning,
}: {
  name: string;
  symbol: string;
  usd: number;
  pct: number;
  isWarning: boolean;
}) {
  const widthPct = Math.min(100, Math.round(pct));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="truncate font-medium">
          {name}{" "}
          <span className="text-muted-foreground">({symbol})</span>
          {isWarning && (
            <AlertTriangle className="inline h-3 w-3 ml-1 text-amber-500" />
          )}
        </span>
        <span className="text-muted-foreground ml-2 shrink-0">
          {formatUsd(usd)} ({pct.toFixed(1)}%)
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={
            isWarning
              ? "h-full rounded-full bg-amber-500/70"
              : "h-full rounded-full bg-blue-500/50"
          }
          style={{ width: `${widthPct}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PortfolioClient
// ---------------------------------------------------------------------------

export function PortfolioClient() {
  const { data: reportData, isLoading: isLoadingCards } = useReportCards();
  const { data: stablecoinsData } = useStablecoins();
  const { data: logos } = useLogos();
  const [toast, setToast] = useState<string | null>(null);

  const mcapMap = useMemo(() => {
    if (!stablecoinsData?.peggedAssets) return new Map<string, number>();
    return new Map(
      stablecoinsData.peggedAssets.map((a) => [
        a.id,
        a.circulating ? sumPegBuckets(a.circulating) : 0,
      ]),
    );
  }, [stablecoinsData]);

  const portfolio = usePortfolio(reportData?.cards);
  const stressTest = useStressTest(reportData, mcapMap);

  // URL sync: keep query string in sync with portfolio + stress test state
  const router = useRouter();

  useEffect(() => {
    const params = new URLSearchParams();

    const encoded = portfolio.holdings
      .map((h) => {
        const meta = TRACKED_META_BY_ID.get(h.coinId);
        return meta ? `${meta.symbol.toLowerCase()}:${h.amount}` : null;
      })
      .filter(Boolean)
      .join(",");
    if (encoded) params.set("p", encoded);

    if (stressTest.targetCoinId) {
      const meta = TRACKED_STABLECOINS.find((s) => s.id === stressTest.targetCoinId);
      if (meta) params.set("stress", meta.symbol.toLowerCase());
    }
    if (stressTest.targetGrade) {
      params.set("grade", stressTest.targetGrade);
    }

    const qs = params.toString();
    const newPath = qs ? `/portfolio/?${qs}` : "/portfolio/";
    router.replace(newPath, { scroll: false });
  }, [portfolio.holdings, stressTest.targetCoinId, stressTest.targetGrade, router]);

  // Build portfolio radar card
  const portfolioRadarCard = useMemo((): ReportCard | null => {
    if (portfolio.holdings.length === 0 || portfolio.portfolioScore === null) return null;
    return {
      id: "__portfolio__",
      name: "Portfolio",
      symbol: "PORT",
      overallGrade: portfolio.portfolioGrade,
      overallScore: portfolio.portfolioScore,
      dimensions: Object.fromEntries(
        DIMENSION_ORDER.map((key) => [
          key,
          {
            grade: scoreToGrade(portfolio.dimensionScores[key]),
            score: portfolio.dimensionScores[key],
            detail: "",
          },
        ]),
      ) as ReportCard["dimensions"],
      ratedDimensions: DIMENSION_ORDER.filter(
        (k) => portfolio.dimensionScores[k] !== null,
      ).length,
      isDefunct: false,
      rawInputs: {
        pegScore: null,
        activeDepeg: false,
        depegEventCount: 0,
        lastEventAt: null,
        liquidityScore: null,
        concentrationHhi: null,
        bluechipGrade: null,
        canBeBlacklisted: false,
        chainRisk: "ethereum",
        collateralQuality: "native",
        custodyModel: "onchain",
        governanceTier: "centralized",
        dependencies: [],
      },
    };
  }, [
    portfolio.holdings.length,
    portfolio.portfolioGrade,
    portfolio.portfolioScore,
    portfolio.dimensionScores,
  ]);

  // Grade cards filtered to held coins only (simulated when stress test active)
  const displayCards = stressTest.stressedCards ?? reportData?.cards ?? [];
  const affectedIds = stressTest.allAffectedIds;
  const originalCardMap = useMemo(
    () => new Map(reportData?.cards?.map((c) => [c.id, c]) ?? []),
    [reportData?.cards],
  );
  const isSimulating = stressTest.stressedCards !== null;

  const heldCardIds = useMemo(
    () => new Set(portfolio.holdings.map((h) => h.coinId)),
    [portfolio.holdings],
  );

  const heldCards = useMemo(
    () => displayCards.filter((c) => heldCardIds.has(c.id)),
    [displayCards, heldCardIds],
  );

  const disabledIds = useMemo(
    () => new Set(portfolio.holdings.map((h) => h.coinId)),
    [portfolio.holdings],
  );

  const handleShare = useCallback(async () => {
    const url = portfolio.shareUrl();
    if (!url) return;
    trackEvent("portfolio_shared", { coin_count: portfolio.holdings.length });
    try {
      await navigator.clipboard.writeText(url);
      setToast("Link copied to clipboard");
      setTimeout(() => setToast(null), 2500);
    } catch {
      window.prompt("Copy this link:", url);
    }
  }, [portfolio]);

  const handleClear = useCallback(() => {
    trackEvent("portfolio_cleared", { coin_count: portfolio.holdings.length });
    portfolio.clearAll();
  }, [portfolio]);

  if (isLoadingCards) {
    return (
      <div className="space-y-6">
        <Card>
          <CardContent className="pt-4 pb-4 space-y-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Holdings editor */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-2">
              <Wallet className="h-5 w-5 text-violet-500 shrink-0" />
              <CardTitle className="text-lg">My Holdings</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              {toast && (
                <span className="text-xs text-muted-foreground animate-in fade-in duration-300">
                  {toast}
                </span>
              )}
              {portfolio.holdings.length > 0 && (
                <>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={handleShare}
                    className="text-muted-foreground"
                  >
                    <Share2 className="h-3 w-3" />
                    Share
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={handleClear}
                    className="text-muted-foreground"
                  >
                    <Trash2 className="h-3 w-3" />
                    Clear
                  </Button>
                </>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          {portfolio.holdings.map((h) => (
            <HoldingRow
              key={h.coinId}
              coinId={h.coinId}
              amount={h.amount}
              logos={logos}
              onSetAmount={portfolio.setAmount}
              onRemove={(coinId) => {
                trackEvent("portfolio_coin_removed", { coin_id: coinId });
                portfolio.removeCoin(coinId);
              }}
            />
          ))}
          <CoinSelector
            coins={coinOptions}
            selected={null}
            logos={logos}
            disabledIds={disabledIds}
            onSelect={(coin) => {
              trackEvent("portfolio_coin_added", { coin_id: coin.id });
              portfolio.addCoin(coin.id, 0);
            }}
            onRemove={() => {}}
          />
        </CardContent>
      </Card>

      {/* Portfolio summary: grade + radar + upstream exposure */}
      {portfolio.holdings.length > 0 && reportData?.cards && (
        <Card>
          <CardContent className="pt-6 space-y-6">
            {/* Overall grade */}
            <div className="flex items-center gap-4">
              <GradeBadge
                grade={portfolio.portfolioGrade}
                score={portfolio.portfolioScore}
                size="lg"
              />
              <div>
                <div className="text-sm text-muted-foreground">Portfolio Total</div>
                <div className="text-lg font-semibold">{formatUsd(portfolio.totalUsd)}</div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Radar */}
              {portfolioRadarCard && (
                <div>
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                    Portfolio Radar
                  </h3>
                  <ReportCardRadar card={portfolioRadarCard} size={260} labels="short" />
                </div>
              )}

              {/* Upstream exposure */}
              {portfolio.upstreamExposure.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                    Upstream Exposure
                  </h3>
                  <div className="space-y-3">
                    {portfolio.upstreamExposure.map((exp) => (
                      <ExposureBar
                        key={exp.coinId}
                        name={exp.name}
                        symbol={exp.symbol}
                        usd={exp.usd}
                        pct={exp.pct}
                        isWarning={exp.pct > 80}
                      />
                    ))}
                  </div>
                  {portfolio.upstreamExposure.some((e) => e.pct > 80) && (
                    <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-2 text-xs text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      <span>
                        High concentration: a single upstream stablecoin accounts for over 80% of
                        your portfolio exposure.
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stress test */}
      <StressTestPanel
        stressTest={stressTest}
        cards={reportData?.cards}
        mcapMap={mcapMap}
        logos={logos}
      />

      {/* Grade cards for held coins only */}
      {portfolio.holdings.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Holdings Safety Grades
          </h2>

          {isSimulating && (
            <div className="sticky top-14 z-30 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 flex items-center justify-between">
              <span className="text-sm text-amber-500 font-medium">
                Viewing simulated grades
              </span>
              <button
                onClick={stressTest.clear}
                className="text-sm text-amber-500 underline underline-offset-2 hover:text-amber-400"
              >
                Clear simulation
              </button>
            </div>
          )}

          {heldCards.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Grade data not yet available for your holdings.
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {heldCards.map((card) => (
                <ReportCardMini
                  key={card.id}
                  card={card}
                  logo={logos?.[card.id]}
                  isSimulated={affectedIds.has(card.id)}
                  isSimulating={isSimulating}
                  originalGrade={originalCardMap.get(card.id)?.overallGrade}
                  originalScore={originalCardMap.get(card.id)?.overallScore}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

**Step 3: Type-check**

```bash
npm run build 2>&1 | grep -E "error" | head -20
```

Expected: no new errors. If `Button size="xs"` doesn't exist, check `src/components/ui/button.tsx` and use the correct size variant (likely `size="sm"` or inspect what the existing stress test panel uses).

**Step 4: Commit**

```bash
git add src/app/portfolio/page.tsx src/app/portfolio/client.tsx
git commit -m "feat(portfolio): add standalone portfolio page"
```

---

## Task 3: Add Portfolio to nav config

**Files:**
- Modify: `src/lib/nav-config.ts`

**Step 1: Add the Wallet import and nav entry**

In `src/lib/nav-config.ts`, add `Wallet` to the lucide imports and insert the portfolio item in the "Risk" group (after "Risk Lab"):

```typescript
import {
  LayoutDashboard,
  Droplets,
  ShieldBan,
  Skull,
  Info,
  FlaskConical,
  ArrowLeftRight,
  Newspaper,
  Wallet,          // ← add this
  createLucideIcon,
} from "lucide-react";
```

Then in `NAV_GROUPS`, the "Risk" group becomes:

```typescript
{
  label: "Risk",
  items: [
    { href: "/stability-index", label: "Stability Index", icon: LighthouseIcon, description: "Pharos Stability Index" },
    { href: "/risk-lab", label: "Risk Lab", icon: FlaskConical, description: "Safety grades and contagion simulation" },
    { href: "/portfolio", label: "Portfolio", icon: Wallet, description: "Personal stablecoin risk view" },
  ],
},
```

**Step 2: Type-check and verify nav renders**

```bash
npm run build 2>&1 | grep -E "error" | head -20
```

Then run `npm run dev` and visually confirm the Portfolio link appears in the sidebar under "Risk" and in the mobile hamburger menu.

**Step 3: Commit**

```bash
git add src/lib/nav-config.ts
git commit -m "feat(portfolio): add Portfolio to nav menu under Risk"
```

---

## Task 4: Verify end-to-end

**Step 1: Dev server smoke test**

```bash
npm run dev
```

Open `http://localhost:3000/portfolio` and check:
- [ ] Holdings editor renders with coin selector
- [ ] Add 2 coins (e.g. USDC + DAI) with amounts
- [ ] Portfolio grade badge and radar appear below
- [ ] Upstream exposure bars appear
- [ ] Stress test panel is present and functional
- [ ] Grade cards for held coins appear at the bottom
- [ ] URL updates with `?p=usdc:1000,dai:500` after adding holdings
- [ ] Share button copies URL to clipboard
- [ ] Clear button empties the holdings
- [ ] Portfolio link in sidebar is highlighted when on `/portfolio`

**Step 2: Full build**

```bash
npm run build
```

Expected: build succeeds, no TypeScript errors.

**Step 3: Final commit if anything was adjusted**

```bash
git add -p
git commit -m "fix(portfolio): address build issues"
```
