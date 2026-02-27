# Risk Lab Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the portfolio analyzer from the Risk Lab, simplify contagion to ecosystem-only, and add a Systemic Risk Scoreboard showing the top failure scenarios.

**Architecture:** Delete portfolio hook + component, strip portfolio coupling from stress test hook + panel, add a memoized systemic risk computation to the hook, render it as a scoreboard in the panel. The ContagionGraph (D3 dependency map) stays untouched.

**Tech Stack:** React 19, Next.js 16, TypeScript strict, Tailwind CSS v4, shadcn/ui

---

### Task 1: Delete portfolio files

**Files:**
- Delete: `src/components/portfolio-panel.tsx`
- Delete: `src/hooks/use-portfolio.ts`

**Note:** `src/components/coin-selector.tsx` is also used by `src/app/compare/client.tsx` — do NOT delete it.

**Step 1: Delete the two files**

```bash
rm src/components/portfolio-panel.tsx src/hooks/use-portfolio.ts
```

**Step 2: Verify no remaining imports**

```bash
grep -r "portfolio-panel\|use-portfolio" src/ --include="*.ts" --include="*.tsx"
```

Expected: hits in `stress-test-panel.tsx` and `risk-lab/client.tsx` only (those are modified in later tasks). No other files should import these.

**Step 3: Commit**

```bash
git add -u
git commit -m "refactor(risk-lab): delete portfolio panel and hook"
```

---

### Task 2: Strip portfolio from the stress test hook

**Files:**
- Modify: `src/hooks/use-stress-test.ts`

This is the core decoupling. The hook currently takes `holdings: PortfolioHolding[]` and branches on `isPortfolioMode`. We remove all of that.

**Step 1: Update the hook signature and remove portfolio imports/logic**

Remove the `PortfolioHolding` import (line 12). Change the function signature from:

```ts
export function useStressTest(
  reportData: ReportCardsResponse | undefined,
  holdings: PortfolioHolding[],
  mcapMap?: Map<string, number>,
): StressTestState {
```

to:

```ts
export function useStressTest(
  reportData: ReportCardsResponse | undefined,
  mcapMap?: Map<string, number>,
): StressTestState {
```

**Step 2: Remove `holdingMap` memo** (lines 151–155)

Delete the entire `holdingMap` useMemo block.

**Step 3: Simplify `StressTestImpact` type**

Remove `holdingUsd` field:

```ts
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
```

**Step 4: Simplify `impacts` memo**

Remove the `isPortfolioMode` check and the `holdingMap.has()` filter. Remove `holdingUsd` from the pushed objects. The memo should just iterate all cards, compare original vs stressed, and include all that changed:

```ts
const impacts = useMemo((): StressTestImpact[] => {
  if (!stressedCards || !reportData) return [];

  const result: StressTestImpact[] = [];

  for (let i = 0; i < reportData.cards.length; i++) {
    const original = reportData.cards[i];
    const stressed = stressedCards[i];

    const scoreBefore = original.overallScore;
    const scoreAfter = stressed.overallScore;
    if (scoreBefore === scoreAfter) continue;
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

  result.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return result;
}, [stressedCards, reportData]);
```

**Step 5: Simplify `headline` memo**

Remove the `isPortfolioMode` branch entirely. Always compute ecosystem mode:

```ts
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

  return {
    totalAtRisk,
    totalSupply,
    affectedCount: allAffectedIds.size,
  };
}, [stressedCards, reportData, impacts, allAffectedIds, mcapMap]);
```

**Step 6: Simplify `StressTestState` type**

Update the headline type and remove `isPortfolioMode`:

```ts
export interface StressTestState {
  targetCoinId: string | null;
  targetGrade: ReportCardGrade | null;
  stressedCards: ReportCard[] | null;
  impacts: StressTestImpact[];
  allAffectedIds: Set<string>;
  headline: {
    totalAtRisk: number;
    totalSupply: number;
    affectedCount: number;
  } | null;
  targetableCoins: { id: string; name: string; symbol: string; dependentCount: number }[];
  gradeOptions: ReportCardGrade[];
  systemicRisks: SystemicRisk[];
  setTarget: (coinId: string | null) => void;
  setGrade: (grade: ReportCardGrade | null) => void;
  clear: () => void;
}
```

**Step 7: Add `SystemicRisk` type and `systemicRisks` memo**

Add the type at the top of the types section:

```ts
export interface SystemicRisk {
  coinId: string;
  name: string;
  symbol: string;
  affectedCount: number;
  supplyAtRisk: number;
}
```

Add the memo inside the hook, after the `headline` memo:

```ts
// --- Systemic risk scoreboard: top 5 most damaging single-coin failures ---
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
```

Add `systemicRisks` to the return object.

**Step 8: Run type-check**

```bash
npm run build
```

Expected: type errors in `stress-test-panel.tsx` and `risk-lab/client.tsx` (fixed in next tasks). The hook itself should be internally consistent.

**Step 9: Commit**

```bash
git add src/hooks/use-stress-test.ts
git commit -m "refactor(risk-lab): decouple stress test hook from portfolio, add systemic risk scoreboard"
```

---

### Task 3: Rewrite the stress test panel

**Files:**
- Modify: `src/components/stress-test-panel.tsx`

**Step 1: Rewrite the component**

Replace the entire component. Key changes from the current version:
- Remove `portfolio` prop — props become `{ stressTest, cards, logos, mcapMap }`
- Remove collapsible behavior — panel is always visible (no `isOpen` state, no chevrons)
- Remove `portfolioStressHeadline` memo entirely
- Add Systemic Risk Scoreboard section above manual controls
- Headline always shows ecosystem stats: "X coins affected. $Y supply at risk."
- Impact table: "Mkt Cap" column always (using `mcapMap` prop), not "Holding"
- Remove all `PortfolioState` imports

The new props interface:

```ts
interface StressTestPanelProps {
  stressTest: StressTestState;
  cards: ReportCard[] | undefined;
  mcapMap: Map<string, number>;
  logos?: Record<string, string>;
}
```

The Systemic Risk Scoreboard renders above the manual controls. Each row shows:
- Coin symbol
- "→ X coins, $Y at risk"
- A button that calls `stressTest.setTarget(coinId)` then `stressTest.setGrade("D")`

Use `formatCurrency` from `@/lib/format` for supply numbers (consistent with the rest of the app).

The impact table "Mkt Cap" column uses `mcapMap.get(impact.coinId)` for each row.

**Step 2: Run type-check**

```bash
npm run build
```

Expected: type errors only in `risk-lab/client.tsx` (fixed in next task).

**Step 3: Commit**

```bash
git add src/components/stress-test-panel.tsx
git commit -m "refactor(risk-lab): rewrite stress test panel without portfolio, add scoreboard"
```

---

### Task 4: Update the Risk Lab client page

**Files:**
- Modify: `src/app/risk-lab/client.tsx`

**Step 1: Remove portfolio imports and usage**

Remove these imports:
- `import { usePortfolio } from "@/hooks/use-portfolio";`
- `import { PortfolioPanel } from "@/components/portfolio-panel";`

Remove:
- `const portfolio = usePortfolio(reportData?.cards);` (line 93)

Update the `useStressTest` call from:
```ts
const stressTest = useStressTest(reportData, portfolio.holdings, mcapMap);
```
to:
```ts
const stressTest = useStressTest(reportData, mcapMap);
```

**Step 2: Remove portfolio URL sync**

In the `useEffect` that syncs URL params (lines 98–127), remove the entire portfolio block (lines 102–113 — the `?p=` param handling). Keep only stress test params:

```ts
useEffect(() => {
  const params = new URLSearchParams();

  if (stressTest.targetCoinId) {
    const meta = TRACKED_STABLECOINS.find((s) => s.id === stressTest.targetCoinId);
    if (meta) params.set("stress", meta.symbol.toLowerCase());
  }
  if (stressTest.targetGrade) {
    params.set("grade", stressTest.targetGrade);
  }

  const qs = params.toString();
  const newPath = qs ? `/risk-lab/?${qs}` : "/risk-lab/";
  router.replace(newPath, { scroll: false });
}, [stressTest.targetCoinId, stressTest.targetGrade, router]);
```

**Step 3: Replace the 2-column layout with single-column**

Replace the 2-column grid (lines 241–254):

```tsx
<div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
  <PortfolioPanel ... />
  <StressTestPanel ... />
</div>
```

with:

```tsx
<StressTestPanel
  stressTest={stressTest}
  cards={reportData?.cards}
  mcapMap={mcapMap}
  logos={logos}
/>
```

**Step 4: Run type-check and dev server**

```bash
npm run build
```

Expected: clean build, no type errors.

**Step 5: Commit**

```bash
git add src/app/risk-lab/client.tsx
git commit -m "refactor(risk-lab): remove portfolio from client page"
```

---

### Task 5: Update metadata and nav description

**Files:**
- Modify: `src/app/risk-lab/page.tsx`
- Modify: `src/lib/nav-config.ts`

**Step 1: Update page metadata**

In `page.tsx`, update the description to remove "portfolio risk analysis":

```ts
const reportCardsDescription =
  "Transparent stablecoin safety grades and contagion simulation. Five dimensions combined into a single letter grade — plus simulate what happens when a major stablecoin fails.";
```

Update the subtitle `<p>` tag similarly:

```tsx
<p className="text-sm text-muted-foreground">
  Safety grades and contagion simulation for every tracked stablecoin.
</p>
```

**Step 2: Update nav description**

In `nav-config.ts`, change the risk-lab entry description:

```ts
{ href: "/risk-lab", label: "Risk Lab", icon: FlaskConical, description: "Safety grades and contagion simulation" },
```

**Step 3: Run build**

```bash
npm run build
```

Expected: clean build.

**Step 4: Commit**

```bash
git add src/app/risk-lab/page.tsx src/lib/nav-config.ts
git commit -m "refactor(risk-lab): update metadata and nav description"
```

---

### Task 6: Final verification

**Step 1: Full build + type-check**

```bash
npm run build
```

Expected: clean build, zero errors.

**Step 2: Visual check**

```bash
npm run dev
```

Open `http://localhost:3000/risk-lab/` and verify:
- No portfolio panel visible
- Contagion panel is always visible (not collapsed)
- Systemic Risk Scoreboard shows top scenarios with supply-at-risk numbers
- Clicking a scoreboard row triggers the simulation (cards highlight, impact table shows)
- Manual simulation still works (select coin + grade dropdowns)
- Grade distribution bar still works
- Filter/sort controls still work
- Dependency Map (D3 graph) still renders below
- Simulation banner still appears when active
- Old URL with `?p=usdc:50000` loads without errors (param ignored)
- `?stress=usdc&grade=D` still works

**Step 3: Check no leftover portfolio references**

```bash
grep -r "portfolio\|Portfolio\|STORAGE_KEY.*pharos:portfolio" src/ --include="*.ts" --include="*.tsx"
```

Expected: zero matches (except maybe generic comments — should be none since we deleted the files).

**Step 4: Commit any fixes if needed, then done**
