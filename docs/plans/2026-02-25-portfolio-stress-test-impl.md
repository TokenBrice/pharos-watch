# Portfolio Analyzer & Stress Test Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add portfolio risk analyzer (holdings, blended grade, upstream exposure) and interactive stress test (cascade simulation) to the report cards page.

**Architecture:** Extend the existing report cards API to include raw dimension inputs and a dependency graph. Two new client-side hooks (`usePortfolio`, `useStressTest`) manage state with localStorage persistence and URL sync. A single collapsible panel component combines both features, and the card grid below reflects simulated grades during stress tests.

**Tech Stack:** React 19, TypeScript strict, TanStack Query, Recharts, Tailwind CSS v4, shadcn/ui, Cloudflare Workers + D1.

---

### Task 1: Add `DependencyWeight` type and migrate `dependencies` field

**Files:**
- Modify: `src/lib/types.ts:66-83` (StablecoinMeta)
- Modify: `src/lib/types.ts:356-390` (ReportCard types)
- Modify: `src/lib/stablecoins.ts:1-27` (StablecoinOpts, coin helper)

**Step 1: Add the `DependencyWeight` type and update `StablecoinMeta`**

In `src/lib/types.ts`, add `DependencyWeight` before the `StablecoinMeta` interface, and change the `dependencies` field:

```typescript
export interface DependencyWeight {
  id: string;      // DefiLlama ID of upstream stablecoin
  weight: number;  // 0-1, fraction of collateral from this source
}
```

In `StablecoinMeta` (line 82), change:
```typescript
// Before:
dependencies?: string[];
// After:
dependencies?: DependencyWeight[];
```

**Step 2: Update `StablecoinOpts` in `stablecoins.ts`**

In `src/lib/stablecoins.ts:19`, change:
```typescript
// Before:
dependencies?: string[];
// After:
dependencies?: import("./types").DependencyWeight[];
```

**Step 3: Update the `coin()` helper**

In `src/lib/stablecoins.ts:22-23`, the `coin()` function passes `opts?.dependencies` through — this works without code changes since the shape flows through.

**Step 4: Run type-check to find all broken consumers**

Run: `npm run build 2>&1 | head -60`

This will surface every place that reads `dependencies` as `string[]`. Fix each one in subsequent tasks.

**Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/stablecoins.ts
git commit -m "refactor: add DependencyWeight type, change dependencies from string[] to DependencyWeight[]"
```

---

### Task 2: Migrate ~63 dependency entries to weighted format

**Files:**
- Modify: `src/lib/stablecoins.ts` (all `dependencies:` entries)

**Context:** Currently there are 63 `dependencies:` entries in `src/lib/stablecoins.ts`, all using the `string[]` format. Each needs to become `DependencyWeight[]`. Research the collateral composition of each coin to assign accurate weights.

**Step 1: Research and convert each dependency entry**

For each coin with `dependencies`, research the collateral breakdown and convert. Rules:
- Weights represent the fraction of collateral that comes from each upstream stablecoin
- Weights sum to <= 1.0 (remainder is non-stablecoin collateral like ETH, BTC)
- The `collateral` field on each coin provides hints about composition
- When the exact breakdown is unknown, use the `collateral` description to estimate
- For coins with `dependencies: []` (empty array), keep as `dependencies: []`

Examples:
```typescript
// DAI: "USDC via LitePSM" is the main stablecoin dependency
dependencies: [{ id: "2", weight: 0.85 }],  // ~85% USDC exposure through PSM

// USDe: "plus liquid stablecoins (USDC, USDT, USDtb)"
dependencies: [{ id: "1", weight: 0.15 }, { id: "2", weight: 0.15 }],  // ~30% stablecoin backing

// USDS: depends on USDC and DAI
dependencies: [{ id: "2", weight: 0.6 }, { id: "5", weight: 0.3 }],

// FRAX: USDC-backed
dependencies: [{ id: "2", weight: 0.9 }],
```

Use the `stablecoin-info-fetch` skill to research collateral compositions when the `collateral` field is insufficient.

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors related to `dependencies`.

**Step 3: Commit**

```bash
git add src/lib/stablecoins.ts
git commit -m "data: migrate 63 dependency entries to weighted DependencyWeight format"
```

---

### Task 3: Update `scoreDependencyRisk` for weighted dependencies

**Files:**
- Modify: `src/lib/report-cards.ts:325-368` (scoreDependencyRisk)

**Step 1: Update the function signature and logic**

The current function reads `meta.dependencies` as `string[]` and averages upstream scores equally. Update to use `DependencyWeight[]` and compute a weighted average:

```typescript
export function scoreDependencyRisk(
  meta: StablecoinMeta,
  overallScores: Map<string, number>,
): ReportCardDimension {
  if (meta.flags.governance !== "centralized-dependent") {
    return { grade: scoreToGrade(95), score: 95, detail: "Not dependent on upstream stablecoins" };
  }

  const deps = meta.dependencies;
  if (!deps || deps.length === 0) {
    return { grade: scoreToGrade(70), score: 70, detail: "CeFi-Dependent but no upstream dependencies mapped" };
  }

  // Gather upstream scores with weights
  const resolved: { id: string; weight: number; score: number }[] = [];
  for (const dep of deps) {
    const s = overallScores.get(dep.id);
    if (s !== undefined) resolved.push({ id: dep.id, weight: dep.weight, score: s });
  }

  if (resolved.length === 0) {
    return { grade: scoreToGrade(70), score: 70, detail: "CeFi-Dependent; upstream dependency scores unavailable" };
  }

  // Weighted average of upstream scores
  const totalWeight = resolved.reduce((sum, d) => sum + d.weight, 0);
  const weightedAvg = totalWeight > 0
    ? resolved.reduce((sum, d) => sum + d.score * d.weight, 0) / totalWeight
    : resolved.reduce((sum, d) => sum + d.score, 0) / resolved.length;

  let score = weightedAvg;

  // Penalty if any upstream scores below 75
  const weakDeps = resolved.filter((d) => d.score < 75);
  if (weakDeps.length > 0) {
    score -= 10;
  }

  score = Math.round(Math.max(0, Math.min(100, score)));

  const parts: string[] = [];
  parts.push(`Based on ${resolved.length} upstream dependenc${resolved.length === 1 ? "y" : "ies"}`);
  parts.push(`weighted avg upstream score: ${Math.round(weightedAvg)}`);
  if (weakDeps.length > 0) {
    parts.push(`-10 penalty: ${weakDeps.length} dependenc${weakDeps.length === 1 ? "y" : "ies"} below 75`);
  }

  return { grade: scoreToGrade(score), score, detail: parts.join(". ") };
}
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/lib/report-cards.ts
git commit -m "feat: update scoreDependencyRisk for weighted DependencyWeight format"
```

---

### Task 4: Update all remaining consumers of `dependencies`

**Files:**
- Modify: `worker/src/api/report-cards.ts:316` (card builder)
- Modify: `src/components/report-card.tsx:127-155` (dependency callout)

**Step 1: Find all broken consumers**

Run: `npx tsc --noEmit 2>&1 | grep -i depend`

Fix each one:

**Worker API handler** (`worker/src/api/report-cards.ts:316`):
Currently spreads `dependencies` into the card. The data now flows as `DependencyWeight[]`. The card's `dependencies` field in the response needs to carry the new type. Update the `ReportCard` type's `dependencies` field (already done in Task 1).

In the worker handler line 316:
```typescript
// Before:
...(meta.dependencies && meta.dependencies.length > 0 ? { dependencies: meta.dependencies } : {}),
// After (same code, but types now match DependencyWeight[]):
...(meta.dependencies && meta.dependencies.length > 0 ? { dependencies: meta.dependencies } : {}),
```
No code change needed here — the type flows through.

**Detail page dependency callout** (`src/components/report-card.tsx:127-155`):
Currently reads `card.dependencies` as `string[]` to list dependency names:
```typescript
// Before:
{card.dependencies.map((depId, i) => {
  const depMeta = TRACKED_STABLECOINS.find((s) => s.id === depId);
// After:
{card.dependencies.map((dep, i) => {
  const depMeta = TRACKED_STABLECOINS.find((s) => s.id === dep.id);
  const name = depMeta?.name ?? dep.id;
```

**Step 2: Type-check entire project**

Run: `npm run build`
Expected: PASS — no type errors.

**Step 3: Commit**

```bash
git add worker/src/api/report-cards.ts src/components/report-card.tsx
git commit -m "fix: update all dependencies consumers for DependencyWeight type"
```

---

### Task 5: Add `RawDimensionInputs` and `dependencyGraph` to API response

**Files:**
- Modify: `src/lib/types.ts:356-390` (add new types)
- Modify: `worker/src/api/report-cards.ts:275-319` (populate rawInputs)
- Modify: `worker/src/api/report-cards.ts:252-261` (add dependencyGraph to response)

**Step 1: Add types**

In `src/lib/types.ts`, add after the existing `ReportCardDimension`:

```typescript
export interface RawDimensionInputs {
  pegScore: number | null;
  activeDepeg: boolean;
  depegEventCount: number;
  lastEventAt: number | null;
  liquidityScore: number | null;
  concentrationHhi: number | null;
  bluechipGrade: BluechipGrade | null;
  chainCount: number;
  freezeEventsPerMonth: number | null;
  hasTrackedFreezeEvents: boolean;
  governanceTier: GovernanceType;
  dependencies: DependencyWeight[];
}
```

Add `rawInputs` to `ReportCard`:
```typescript
interface ReportCard {
  // ... existing fields ...
  rawInputs: RawDimensionInputs;
}
```

Add `dependencyGraph` to `ReportCardsResponse`:
```typescript
interface ReportCardsResponse {
  // ... existing fields ...
  dependencyGraph: {
    edges: { from: string; to: string }[];
  };
}
```

**Step 2: Populate `rawInputs` in the worker API handler**

In `worker/src/api/report-cards.ts`, update `computeCard()` to also return `rawInputs`. Add parameters for `pegDataById`, `dexLiqMap`, etc. The function already has access to all the raw data — extract the relevant fields:

```typescript
// Inside computeCard(), before the return statement:
const rawInputs: RawDimensionInputs = {
  pegScore: peg?.pegScore ?? null,
  activeDepeg: peg?.activeDepeg ?? false,
  depegEventCount: peg?.eventCount ?? 0,
  lastEventAt: peg?.lastEventAt ?? null,
  liquidityScore: liq?.liquidityScore ?? null,
  concentrationHhi: liq?.concentrationHhi ?? null,
  bluechipGrade: rating?.grade ?? null,
  chainCount,
  freezeEventsPerMonth,
  hasTrackedFreezeEvents,
  governanceTier: meta.flags.governance as GovernanceType,
  dependencies: meta.dependencies ?? [],
};

return {
  // ... existing fields ...
  rawInputs,
};
```

For defunct cards, add a minimal `rawInputs`:
```typescript
rawInputs: {
  pegScore: null, activeDepeg: false, depegEventCount: 0, lastEventAt: null,
  liquidityScore: null, concentrationHhi: null, bluechipGrade: null,
  chainCount: 0, freezeEventsPerMonth: null, hasTrackedFreezeEvents: false,
  governanceTier: "centralized" as GovernanceType, dependencies: [],
},
```

**Step 3: Build dependency graph in the response**

After computing all cards, build the edge list from `TRACKED_STABLECOINS`:

```typescript
const edges: { from: string; to: string }[] = [];
for (const meta of TRACKED_STABLECOINS) {
  if (meta.dependencies) {
    for (const dep of meta.dependencies) {
      edges.push({ from: dep.id, to: meta.id });
    }
  }
}

const response: ReportCardsResponse = {
  cards: allCards,
  methodology: { ... },
  dependencyGraph: { edges },
  updatedAt: stablecoinsCached.updatedAt,
};
```

**Step 4: Type-check both frontend and worker**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/types.ts worker/src/api/report-cards.ts
git commit -m "feat: add rawInputs per card and dependencyGraph to report cards API"
```

---

### Task 6: Add `computeStressedGrades` to grading engine

**Files:**
- Modify: `src/lib/report-cards.ts` (add new export)

**Step 1: Implement `computeStressedGrades`**

Add at the end of `src/lib/report-cards.ts`:

```typescript
/**
 * Recompute grades with overridden overall scores for target coins.
 * Used by the stress test to simulate upstream downgrades.
 *
 * Only the Dependency Risk dimension is affected — overriding a coin's
 * overall score changes the dependency risk of every coin that lists it
 * as an upstream dependency.
 */
export function computeStressedGrades(
  cards: ReportCard[],
  overrides: Map<string, number>,  // coin ID -> synthetic overall score
): ReportCard[] {
  // Build effective overall scores map (real scores + overrides)
  const overallScores = new Map<string, number>();
  for (const card of cards) {
    const override = overrides.get(card.id);
    if (override !== undefined) {
      overallScores.set(card.id, override);
    } else if (card.overallScore !== null) {
      overallScores.set(card.id, card.overallScore);
    }
  }

  // Find which coins are directly overridden
  const overriddenIds = new Set(overrides.keys());

  // Find which coins depend on an overridden coin
  const affectedIds = new Set<string>();
  for (const card of cards) {
    const deps = card.rawInputs.dependencies;
    if (deps.length > 0 && deps.some((d) => overriddenIds.has(d.id))) {
      affectedIds.add(card.id);
    }
  }

  return cards.map((card) => {
    // Directly overridden coin: swap its overall score and grade
    if (overriddenIds.has(card.id)) {
      const newScore = overrides.get(card.id)!;
      return {
        ...card,
        overallGrade: scoreToGrade(newScore),
        overallScore: newScore,
      };
    }

    // Affected dependent coin: recompute dependency risk + overall
    if (affectedIds.has(card.id)) {
      const meta: Pick<StablecoinMeta, "flags" | "dependencies"> = {
        flags: { ...card.rawInputs, governance: card.rawInputs.governanceTier, backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
        dependencies: card.rawInputs.dependencies,
      };
      const newDepRisk = scoreDependencyRisk(meta as StablecoinMeta, overallScores);
      const newDimensions = { ...card.dimensions, dependencyRisk: newDepRisk };
      const overall = computeOverallGrade(newDimensions);
      return {
        ...card,
        dimensions: newDimensions,
        overallGrade: overall.grade,
        overallScore: overall.score,
        ratedDimensions: overall.ratedDimensions,
      };
    }

    // Unaffected: return as-is
    return card;
  });
}
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/lib/report-cards.ts
git commit -m "feat: add computeStressedGrades for client-side stress test recomputation"
```

---

### Task 7: Create `usePortfolio` hook

**Files:**
- Create: `src/hooks/use-portfolio.ts`

**Step 1: Implement the hook**

```typescript
"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { scoreToGrade, DIMENSION_ORDER, DIMENSION_WEIGHTS, computeOverallGrade } from "@/lib/report-cards";
import type { ReportCard, DimensionKey, ReportCardGrade, DependencyWeight } from "@/lib/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = "pharos:portfolio";

/** Map symbol (lowercase) -> stablecoin meta for URL parsing */
const SYMBOL_TO_ID = new Map(
  TRACKED_STABLECOINS.map((s) => [s.symbol.toLowerCase(), s.id]),
);
const ID_TO_SYMBOL = new Map(
  TRACKED_STABLECOINS.map((s) => [s.id, s.symbol.toLowerCase()]),
);

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
  /** True when portfolio was loaded from a ?p= URL param (shared link) */
  isFromUrl: boolean;
  addCoin: (coinId: string) => void;
  removeCoin: (coinId: string) => void;
  setAmount: (coinId: string, amount: number) => void;
  clearAll: () => void;
  shareUrl: () => string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode holdings as URL param: ?p=usdc:50000,dai:5000 */
function encodePortfolioParam(holdings: PortfolioHolding[]): string {
  return holdings
    .filter((h) => h.amount > 0)
    .map((h) => `${ID_TO_SYMBOL.get(h.coinId) ?? h.coinId}:${Math.round(h.amount)}`)
    .join(",");
}

/** Parse ?p= URL param back to holdings */
function parsePortfolioParam(param: string): PortfolioHolding[] {
  if (!param) return [];
  return param
    .split(",")
    .map((entry) => {
      const [sym, amtStr] = entry.split(":");
      if (!sym || !amtStr) return null;
      const coinId = SYMBOL_TO_ID.get(sym.trim().toLowerCase());
      if (!coinId) return null;
      const amount = parseFloat(amtStr);
      if (isNaN(amount) || amount <= 0) return null;
      return { coinId, amount };
    })
    .filter((h): h is PortfolioHolding => h !== null);
}

/** Load holdings from localStorage */
function loadFromStorage(): PortfolioHolding[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as PortfolioHolding[];
  } catch {
    return [];
  }
}

/** Save holdings to localStorage */
function saveToStorage(holdings: PortfolioHolding[]): void {
  if (typeof window === "undefined") return;
  try {
    if (holdings.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(holdings));
    }
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

/** Compute upstream exposure by walking dependency weights */
function computeUpstreamExposure(
  holdings: PortfolioHolding[],
  cardMap: Map<string, ReportCard>,
): UpstreamExposure[] {
  // Accumulate USD exposure per upstream coin ID
  const exposureMap = new Map<string, number>();

  for (const { coinId, amount } of holdings) {
    const card = cardMap.get(coinId);
    const deps = card?.rawInputs.dependencies ?? [];

    if (deps.length === 0) {
      // Direct holding of a non-dependent coin — 100% attributed to itself
      exposureMap.set(coinId, (exposureMap.get(coinId) ?? 0) + amount);
    } else {
      // Walk dependencies using collateral weights
      let attributedWeight = 0;
      for (const dep of deps) {
        const usdForDep = amount * dep.weight;
        exposureMap.set(dep.id, (exposureMap.get(dep.id) ?? 0) + usdForDep);
        attributedWeight += dep.weight;
      }
      // Remainder (non-stablecoin collateral) is "other"
      if (attributedWeight < 1) {
        const other = amount * (1 - attributedWeight);
        exposureMap.set("__other__", (exposureMap.get("__other__") ?? 0) + other);
      }
    }
  }

  const totalUsd = holdings.reduce((sum, h) => sum + h.amount, 0);
  const entries: UpstreamExposure[] = [];

  for (const [id, usd] of exposureMap) {
    if (id === "__other__") {
      entries.push({ coinId: id, name: "Non-stablecoin collateral", symbol: "Other", usd, pct: totalUsd > 0 ? usd / totalUsd : 0 });
    } else {
      const meta = TRACKED_STABLECOINS.find((s) => s.id === id);
      entries.push({
        coinId: id,
        name: meta?.name ?? id,
        symbol: meta?.symbol ?? id,
        usd,
        pct: totalUsd > 0 ? usd / totalUsd : 0,
      });
    }
  }

  // Sort by exposure descending
  entries.sort((a, b) => b.usd - a.usd);
  return entries;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePortfolio(cards: ReportCard[] | undefined): PortfolioState {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Determine initial source: URL param > localStorage
  const urlParam = searchParams.get("p");
  const [isFromUrl] = useState(() => !!urlParam);
  const [holdings, setHoldings] = useState<PortfolioHolding[]>(() => {
    if (urlParam) return parsePortfolioParam(urlParam);
    return loadFromStorage();
  });

  // Persist to localStorage on change (but not when loaded from URL)
  useEffect(() => {
    if (!isFromUrl) {
      saveToStorage(holdings);
    }
  }, [holdings, isFromUrl]);

  // Build card map for lookups
  const cardMap = useMemo(
    () => new Map((cards ?? []).map((c) => [c.id, c])),
    [cards],
  );

  // Derived: total USD
  const totalUsd = useMemo(
    () => holdings.reduce((sum, h) => sum + h.amount, 0),
    [holdings],
  );

  // Derived: weighted portfolio grade
  const { portfolioGrade, portfolioScore } = useMemo(() => {
    if (holdings.length === 0 || totalUsd === 0) {
      return { portfolioGrade: "NR" as ReportCardGrade, portfolioScore: null };
    }
    let weightedSum = 0;
    let validWeight = 0;
    for (const { coinId, amount } of holdings) {
      const card = cardMap.get(coinId);
      if (card?.overallScore !== null && card?.overallScore !== undefined) {
        weightedSum += card.overallScore * amount;
        validWeight += amount;
      }
    }
    if (validWeight === 0) {
      return { portfolioGrade: "NR" as ReportCardGrade, portfolioScore: null };
    }
    const score = Math.round(weightedSum / validWeight);
    return { portfolioGrade: scoreToGrade(score), portfolioScore: score };
  }, [holdings, totalUsd, cardMap]);

  // Derived: per-dimension weighted scores (for portfolio radar)
  const dimensionScores = useMemo(() => {
    const result: Record<DimensionKey, number | null> = {
      pegStability: null, liquidity: null, safety: null,
      resilience: null, decentralization: null, dependencyRisk: null,
    };
    if (holdings.length === 0 || totalUsd === 0) return result;

    for (const key of DIMENSION_ORDER) {
      let weightedSum = 0;
      let validWeight = 0;
      for (const { coinId, amount } of holdings) {
        const card = cardMap.get(coinId);
        const dimScore = card?.dimensions[key].score;
        if (dimScore !== null && dimScore !== undefined) {
          weightedSum += dimScore * amount;
          validWeight += amount;
        }
      }
      result[key] = validWeight > 0 ? Math.round(weightedSum / validWeight) : null;
    }
    return result;
  }, [holdings, totalUsd, cardMap]);

  // Derived: upstream exposure
  const upstreamExposure = useMemo(
    () => computeUpstreamExposure(holdings, cardMap),
    [holdings, cardMap],
  );

  // Actions
  const addCoin = useCallback((coinId: string) => {
    setHoldings((prev) => {
      if (prev.some((h) => h.coinId === coinId)) return prev;
      return [...prev, { coinId, amount: 0 }];
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

  const shareUrl = useCallback(() => {
    const encoded = encodePortfolioParam(holdings);
    if (typeof window === "undefined") return "";
    const url = new URL(window.location.href);
    if (encoded) {
      url.searchParams.set("p", encoded);
    } else {
      url.searchParams.delete("p");
    }
    return url.toString();
  }, [holdings]);

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

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/hooks/use-portfolio.ts
git commit -m "feat: add usePortfolio hook with localStorage, URL sync, and upstream exposure"
```

---

### Task 8: Create `useStressTest` hook

**Files:**
- Create: `src/hooks/use-stress-test.ts`

**Step 1: Implement the hook**

```typescript
"use client";

import { useState, useMemo, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { computeStressedGrades, scoreToGrade, GRADE_THRESHOLDS } from "@/lib/report-cards";
import type { ReportCard, ReportCardGrade, ReportCardsResponse } from "@/lib/types";
import type { PortfolioHolding } from "./use-portfolio";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StressTestImpact {
  coinId: string;
  name: string;
  symbol: string;
  holdingUsd: number | null;      // null = ecosystem mode
  gradeBefore: ReportCardGrade;
  scoreBefore: number | null;
  gradeAfter: ReportCardGrade;
  scoreAfter: number | null;
  delta: number;                   // score change (negative = downgrade)
}

export interface StressTestState {
  targetCoinId: string | null;
  targetGrade: ReportCardGrade | null;
  stressedCards: ReportCard[] | null;
  impacts: StressTestImpact[];
  /** Headline stats */
  headline: {
    totalAtRisk: number;         // USD at risk (portfolio mode) or supply (ecosystem)
    totalHeld: number;           // total portfolio USD or total supply
    affectedCount: number;
    isPortfolioMode: boolean;
  } | null;
  /** Coins eligible as stress targets (have dependents) */
  targetablCoins: { id: string; name: string; symbol: string; dependentCount: number }[];
  /** Valid grade options for currently selected target */
  gradeOptions: ReportCardGrade[];
  setTarget: (coinId: string | null) => void;
  setGrade: (grade: ReportCardGrade | null) => void;
  clear: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SYMBOL_TO_ID = new Map(
  TRACKED_STABLECOINS.map((s) => [s.symbol.toLowerCase(), s.id]),
);

/** Grade to numeric score (midpoint of range) for stress override */
function gradeToScore(grade: ReportCardGrade): number {
  for (let i = 0; i < GRADE_THRESHOLDS.length; i++) {
    if (GRADE_THRESHOLDS[i].grade === grade) {
      const min = GRADE_THRESHOLDS[i].min;
      const max = i === 0 ? 100 : GRADE_THRESHOLDS[i - 1].min - 1;
      return Math.round((min + max) / 2);
    }
  }
  return 25; // F
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useStressTest(
  reportData: ReportCardsResponse | undefined,
  holdings: PortfolioHolding[],
  mcapMap?: Map<string, number>,
): StressTestState {
  const searchParams = useSearchParams();

  // Initialize from URL params if present
  const [targetCoinId, setTargetCoinId] = useState<string | null>(() => {
    const sym = searchParams.get("stress");
    if (!sym) return null;
    return SYMBOL_TO_ID.get(sym.toLowerCase()) ?? null;
  });

  const [targetGrade, setTargetGrade] = useState<ReportCardGrade | null>(() => {
    const g = searchParams.get("grade");
    if (!g) return null;
    return g as ReportCardGrade;
  });

  const cards = reportData?.cards;
  const edges = reportData?.dependencyGraph?.edges;

  // Build targetable coins list (coins that have at least one dependent)
  const targetableCoins = useMemo(() => {
    if (!edges) return [];
    const countMap = new Map<string, number>();
    for (const edge of edges) {
      countMap.set(edge.from, (countMap.get(edge.from) ?? 0) + 1);
    }
    return Array.from(countMap.entries())
      .map(([id, count]) => {
        const meta = TRACKED_STABLECOINS.find((s) => s.id === id);
        return { id, name: meta?.name ?? id, symbol: meta?.symbol ?? id, dependentCount: count };
      })
      .sort((a, b) => b.dependentCount - a.dependentCount);
  }, [edges]);

  // Valid downgrade options for the selected target
  const gradeOptions = useMemo(() => {
    if (!targetCoinId || !cards) return [];
    const card = cards.find((c) => c.id === targetCoinId);
    if (!card || card.overallGrade === "NR") return [];
    // Find grades below current
    const currentIdx = GRADE_THRESHOLDS.findIndex((t) => t.grade === card.overallGrade);
    if (currentIdx < 0) return [];
    return GRADE_THRESHOLDS.slice(currentIdx + 1).map((t) => t.grade);
  }, [targetCoinId, cards]);

  // Compute stressed grades
  const stressedCards = useMemo(() => {
    if (!targetCoinId || !targetGrade || !cards) return null;
    const overrides = new Map<string, number>();
    overrides.set(targetCoinId, gradeToScore(targetGrade));
    return computeStressedGrades(cards, overrides);
  }, [targetCoinId, targetGrade, cards]);

  // Compute impact list
  const impacts = useMemo(() => {
    if (!stressedCards || !cards) return [];
    const isPortfolioMode = holdings.length > 0;
    const holdingMap = new Map(holdings.map((h) => [h.coinId, h.amount]));
    const originalMap = new Map(cards.map((c) => [c.id, c]));

    const result: StressTestImpact[] = [];
    for (const stressed of stressedCards) {
      const original = originalMap.get(stressed.id);
      if (!original) continue;
      const scoreBefore = original.overallScore;
      const scoreAfter = stressed.overallScore;
      if (scoreBefore === scoreAfter) continue; // unaffected

      // In portfolio mode, only show held coins
      if (isPortfolioMode && !holdingMap.has(stressed.id)) continue;

      result.push({
        coinId: stressed.id,
        name: stressed.name,
        symbol: stressed.symbol,
        holdingUsd: isPortfolioMode ? (holdingMap.get(stressed.id) ?? 0) : null,
        gradeBefore: original.overallGrade,
        scoreBefore,
        gradeAfter: stressed.overallGrade,
        scoreAfter,
        delta: (scoreAfter ?? 0) - (scoreBefore ?? 0),
      });
    }

    // Sort by absolute delta descending
    result.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    return result;
  }, [stressedCards, cards, holdings]);

  // Headline stats
  const headline = useMemo(() => {
    if (impacts.length === 0 || !cards) return null;
    const isPortfolioMode = holdings.length > 0;

    if (isPortfolioMode) {
      const holdingMap = new Map(holdings.map((h) => [h.coinId, h.amount]));
      const totalHeld = holdings.reduce((s, h) => s + h.amount, 0);
      const totalAtRisk = impacts.reduce((s, i) => s + (holdingMap.get(i.coinId) ?? 0), 0);
      return { totalAtRisk, totalHeld, affectedCount: impacts.length, isPortfolioMode: true };
    } else {
      // Ecosystem mode: use market caps
      const totalAtRisk = impacts.reduce((s, i) => s + (mcapMap?.get(i.coinId) ?? 0), 0);
      const totalHeld = cards.reduce((s, c) => s + (mcapMap?.get(c.id) ?? 0), 0);
      return { totalAtRisk, totalHeld, affectedCount: impacts.length, isPortfolioMode: false };
    }
  }, [impacts, cards, holdings, mcapMap]);

  // Actions
  const setTarget = useCallback((coinId: string | null) => {
    setTargetCoinId(coinId);
    setTargetGrade(null); // reset grade when target changes
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
    headline,
    targetableCoins: targetableCoins,
    gradeOptions,
    setTarget,
    setGrade,
    clear,
  };
}
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/hooks/use-stress-test.ts
git commit -m "feat: add useStressTest hook with cascade simulation and impact calculation"
```

---

### Task 9: Build the Portfolio & Stress Test panel component

**Files:**
- Create: `src/components/portfolio-stress-panel.tsx`

**Context:** This is the largest UI component. It's a collapsible panel with two sections (holdings+analysis and stress test). Reuses `CoinSelector` from compare page and `ReportCardRadar` for the portfolio radar.

**Step 1: Build the component**

The component receives portfolio state, stress test state, report cards data, and logos. It renders:

1. **Collapsible header** — "My Portfolio & Stress Test" with toggle. When collapsed + portfolio exists, show summary.
2. **Holdings editor** — List of added coins with CoinSelector + USD amount inputs + remove buttons. "Add stablecoin" button.
3. **Portfolio analysis** — Grade badge + portfolio radar (left) + upstream exposure bar (right).
4. **Stress test controls** — Target coin dropdown + grade dropdown.
5. **Impact table** — Coin, holding/mcap, before, after, delta.

Key implementation details:
- Use `CoinSelector` from `@/components/coin-selector` for adding coins
- Use `ReportCardRadar` for portfolio radar by building a synthetic `ReportCard` from `dimensionScores`
- USD input: `<input type="text">` with `Intl.NumberFormat` formatting on blur, raw parse on focus
- Upstream exposure: horizontal bars using inline `style={{ width: \`${pct * 100}%\` }}`
- Warning when any exposure > 80%
- Stress test coin selector: small combobox or `<select>` since list is short
- Grade selector: `<select>` from `gradeOptions`
- Impact table rows colored by severity: `text-red-500` for delta, severity indicators

This component is large (~400 lines). Implement incrementally: skeleton first, then each section.

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/components/portfolio-stress-panel.tsx
git commit -m "feat: add PortfolioStressPanel component with holdings editor, exposure, and stress test"
```

---

### Task 10: Integrate panel into report cards page + simulation mode on card grid

**Files:**
- Modify: `src/app/report-cards/client.tsx`
- Modify: `src/components/report-card-mini.tsx`

**Step 1: Wire up hooks and panel in `client.tsx`**

In `src/app/report-cards/client.tsx`:

1. Import the new hooks and panel:
```typescript
import { usePortfolio } from "@/hooks/use-portfolio";
import { useStressTest } from "@/hooks/use-stress-test";
import { PortfolioStressPanel } from "@/components/portfolio-stress-panel";
```

2. Add hook calls inside `ReportCardsClient`:
```typescript
const portfolio = usePortfolio(reportData?.cards);
const stressTest = useStressTest(reportData, portfolio.holdings, mcapMap);
```

3. Render `<PortfolioStressPanel>` between the grade distribution card and the filter/sort controls.

4. When `stressTest.stressedCards` is not null, use those for the card grid instead of the original cards. Create a Set of affected card IDs for styling:
```typescript
const displayCards = stressTest.stressedCards ?? reportData?.cards ?? [];
const affectedIds = new Set(stressTest.impacts.map((i) => i.coinId));
const isSimulating = stressTest.stressedCards !== null;
```

5. Pass `isSimulated` and `originalCard` props to `ReportCardMini` for affected cards.

6. Add sticky simulation banner above the grid when `isSimulating`:
```typescript
{isSimulating && (
  <div className="sticky top-14 z-30 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 flex items-center justify-between">
    <span className="text-sm text-amber-500 font-medium">
      Viewing simulated grades
    </span>
    <button onClick={stressTest.clear} className="text-sm text-amber-500 underline hover:text-amber-400">
      Clear simulation
    </button>
  </div>
)}
```

**Step 2: Update `ReportCardMini` for simulation mode**

Add optional simulation props:

```typescript
interface ReportCardMiniProps {
  card: ReportCard;
  logo?: string;
  isSimulated?: boolean;        // true if this card was affected by stress test
  originalGrade?: ReportCardGrade;  // grade before simulation
  originalScore?: number | null;
}
```

When `isSimulated`:
- Card gets `border-dashed border-amber-500/40` styling
- Grade badge shows: `B (82) → C+ (72)` with delta
- Small "Simulated" badge in top-right corner

**Step 3: Build and type-check**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/app/report-cards/client.tsx src/components/report-card-mini.tsx
git commit -m "feat: integrate portfolio panel and simulation mode into report cards page"
```

---

### Task 11: URL sync for portfolio + stress test state

**Files:**
- Modify: `src/app/report-cards/client.tsx`
- Modify: `src/hooks/use-portfolio.ts` (if needed)
- Modify: `src/hooks/use-stress-test.ts` (if needed)

**Step 1: Sync portfolio and stress test state to URL**

When the user edits holdings or changes stress test parameters, update the URL:

```typescript
// In client.tsx, add an effect that syncs to URL:
useEffect(() => {
  const params = new URLSearchParams();

  // Portfolio
  const pParam = encodePortfolioParam(portfolio.holdings);
  if (pParam) params.set("p", pParam);

  // Stress test
  if (stressTest.targetCoinId) {
    const sym = ID_TO_SYMBOL.get(stressTest.targetCoinId);
    if (sym) params.set("stress", sym);
  }
  if (stressTest.targetGrade) {
    params.set("grade", stressTest.targetGrade);
  }

  const qs = params.toString();
  const newPath = qs ? `/report-cards/?${qs}` : "/report-cards/";
  router.replace(newPath, { scroll: false });
}, [portfolio.holdings, stressTest.targetCoinId, stressTest.targetGrade, router]);
```

**Step 2: Test URL round-trip**

1. Navigate to `/report-cards/`
2. Add USDC $50,000 and DAI $5,000 → URL should become `?p=usdc:50000,dai:5000`
3. Set stress: USDC → D → URL becomes `?p=usdc:50000,dai:5000&stress=usdc&grade=D`
4. Copy URL, open in new tab → portfolio and stress test pre-populated
5. Clear stress test → URL becomes `?p=usdc:50000,dai:5000`

**Step 3: Test share button**

The share button in the panel calls `portfolio.shareUrl()` and copies to clipboard. Verify it produces the correct URL including stress test params.

**Step 4: Commit**

```bash
git add src/app/report-cards/client.tsx src/hooks/use-portfolio.ts src/hooks/use-stress-test.ts
git commit -m "feat: URL sync for portfolio and stress test state (bookmarkable + shareable)"
```

---

### Task 12: Update about page methodology section

**Files:**
- Modify: `src/app/about/page.tsx` (or the methodology section)

**Step 1: Add portfolio and stress test methodology**

Add a subsection to the existing methodology section covering:

1. **Portfolio grade**: `sum(coinScore * coinAmount) / sum(coinAmount)` for rated coins. NR coins excluded from average.
2. **Portfolio radar**: Same weighted average per-dimension.
3. **Upstream exposure**: Walk dependencies using collateral weights. Direct CeFi = 100% to self. Worked example with $50K USDC + $5K DAI + $2K FRAX.
4. **Stress test**: Overrides target coin's overall score, recomputes Dependency Risk for dependents. Models only the dependency channel — real contagion would be worse. Worked example: USDC A- → D, DAI impact.
5. **Limitations**: Equal-weight simplification note (now replaced by actual weights), self-reported holdings, dependency channel only.

**Step 2: Commit**

```bash
git add src/app/about/page.tsx
git commit -m "docs: add portfolio analyzer and stress test methodology to about page"
```

---

### Task 13: Final integration testing and polish

**Files:**
- All modified files

**Step 1: Full build + type-check**

Run: `npm run build`
Expected: PASS — no type errors, no build warnings.

**Step 2: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 3: Manual testing checklist**

Run `npm run dev` and verify:

- [ ] `/report-cards/` loads with the collapsible panel (collapsed by default)
- [ ] Adding coins via CoinSelector works (search by name/symbol)
- [ ] USD amounts format with thousand separators on blur
- [ ] Portfolio grade updates live as amounts change
- [ ] Portfolio radar chart reflects weighted dimension averages
- [ ] Upstream exposure bar shows correct percentages with collateral weights
- [ ] Warning appears when any upstream exposure > 80%
- [ ] Stress test coin selector shows only upstream coins (with dependents)
- [ ] Grade selector shows only downgrades from current grade
- [ ] Stress test results update live (no "Run" button needed)
- [ ] Impact table shows correct before/after grades and deltas
- [ ] Card grid updates with simulated grades (dashed borders, "Simulated" badge)
- [ ] Sticky banner appears: "Viewing simulated grades — Clear simulation"
- [ ] Clearing simulation reverts all cards
- [ ] URL updates with `?p=` and `?stress=` params
- [ ] Shared URL pre-populates portfolio and stress test in new tab
- [ ] Portfolio persists in localStorage across page reloads
- [ ] Removing all coins clears localStorage
- [ ] Share button copies URL to clipboard
- [ ] Mobile responsive: single-column holdings, smaller radar, stacked exposure
- [ ] Edge case: single-coin portfolio shows that coin's grade
- [ ] Edge case: defunct coin in portfolio shows warning
- [ ] Edge case: all NR coins → portfolio grade = NR, exposure still works

**Step 4: Final commit**

```bash
git add -A
git commit -m "polish: final integration testing and UI refinements for portfolio & stress test"
```
