# Homepage Feature Summary Cards — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Report Cards and Stability Index summary cards to the homepage bottom grid, matching the existing card style.

**Architecture:** Two new client components (`ReportCardsSummary`, `StabilityIndexSummary`) follow the exact pattern of existing summary cards. The homepage grid changes from 2-column to 3-column on `lg` breakpoints. PSI border colors are added to the existing `psi-colors.ts` constants.

**Tech Stack:** React 19, TypeScript, Tailwind v4, shadcn Card, lucide-react icons, existing hooks (`useReportCards`, `useStabilityIndex`).

**Design doc:** `docs/plans/2026-02-26-homepage-feature-cards-design.md`

---

### Task 1: Add PSI border color constants

**Files:**
- Modify: `src/lib/psi-colors.ts`

**Step 1: Add border-l class map**

Add this after `PSI_BAND_CLASSES`:

```ts
/** Static Tailwind border-l color classes for each PSI condition band. */
export const PSI_BORDER_CLASSES: Record<string, string> = {
  BEDROCK: "border-l-green-500",
  STEADY: "border-l-teal-500",
  TREMOR: "border-l-yellow-500",
  FRACTURE: "border-l-orange-500",
  CRISIS: "border-l-red-500",
  MELTDOWN: "border-l-red-800",
};
```

**Step 2: Verify types**

Run: `npm run build`
Expected: No type errors.

**Step 3: Commit**

```bash
git add src/lib/psi-colors.ts
git commit -m "feat: add PSI border color constants"
```

---

### Task 2: Create ReportCardsSummary component

**Files:**
- Create: `src/components/report-cards-summary.tsx`

**Step 1: Write the component**

```tsx
"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useReportCards } from "@/hooks/use-report-cards";

export function ReportCardsSummary() {
  const { data, isLoading } = useReportCards();

  const stats = useMemo(() => {
    if (!data?.cards) return null;
    const graded = data.cards.filter((c) => c.overallGrade !== "NR" && !c.isDefunct);
    const topGrades = graded.filter((c) => c.overallGrade === "A+" || c.overallGrade === "A");
    const lowGrades = graded.filter((c) => c.overallGrade === "D" || c.overallGrade === "F");
    return { total: graded.length, top: topGrades.length, low: lowGrades.length };
  }, [data]);

  if (isLoading) {
    return (
      <Card className="rounded-2xl border-l-[3px] border-l-amber-500">
        <CardHeader>
          <Skeleton className="h-4 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-2xl border-l-[3px] border-l-amber-500">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="flex items-center justify-between">
          <span className="flex items-center gap-1.5"><ClipboardCheck className="h-4 w-4" />Report Cards</span>
          <Link
            href="/report-cards"
            className="text-xs font-normal text-muted-foreground hover:text-foreground transition-colors"
          >
            View grades &rarr;
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <p className="text-2xl font-bold font-mono">{stats?.total ?? 0}</p>
            <p className="text-xs text-muted-foreground">coins graded</p>
          </div>
          <div>
            <p className="text-2xl font-bold font-mono text-emerald-500">{stats?.top ?? 0}</p>
            <p className="text-xs text-muted-foreground">A or A+ grade</p>
          </div>
          <div>
            <p className="text-2xl font-bold font-mono text-red-500">{stats?.low ?? 0}</p>
            <p className="text-xs text-muted-foreground">D or F grade</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
```

**Step 2: Verify types**

Run: `npm run build`
Expected: No type errors.

**Step 3: Commit**

```bash
git add src/components/report-cards-summary.tsx
git commit -m "feat: add ReportCardsSummary homepage component"
```

---

### Task 3: Create StabilityIndexSummary component

**Files:**
- Create: `src/components/stability-index-summary.tsx`

The component needs to compute "days in current band" from the history array. History is sorted newest-first. Count consecutive points from the start that share the same band as current.

**Step 1: Write the component**

```tsx
"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useStabilityIndex } from "@/hooks/use-stability-index";
import { PsiLighthouse } from "@/components/stability-index";
import { PSI_BAND_CLASSES, PSI_HEX_COLORS, PSI_BORDER_CLASSES } from "@/lib/psi-colors";

export function StabilityIndexSummary() {
  const { data, isLoading } = useStabilityIndex();

  const stats = useMemo(() => {
    if (!data?.current) return null;
    const { score, band } = data.current;
    // History is newest-first; count consecutive days matching current band
    let daysInBand = 1; // today counts
    for (const point of data.history) {
      if (point.band === band) daysInBand++;
      else break;
    }
    return { score, band, daysInBand };
  }, [data]);

  const borderClass = stats ? (PSI_BORDER_CLASSES[stats.band] ?? "border-l-zinc-500") : "border-l-zinc-500";
  const textClass = stats ? (PSI_BAND_CLASSES[stats.band] ?? "text-foreground") : "text-foreground";
  const hexColor = stats ? (PSI_HEX_COLORS[stats.band] ?? "#888") : "#888";

  if (isLoading) {
    return (
      <Card className="rounded-2xl border-l-[3px] border-l-zinc-500">
        <CardHeader>
          <Skeleton className="h-4 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!stats) return null;

  return (
    <Card className={`rounded-2xl border-l-[3px] ${borderClass}`}>
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <PsiLighthouse band={stats.band} color={hexColor} size={18} />
            Stability Index
          </span>
          <Link
            href="/stability-index"
            className="text-xs font-normal text-muted-foreground hover:text-foreground transition-colors"
          >
            View history &rarr;
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <p className={`text-2xl font-bold font-mono ${textClass}`}>{stats.score.toFixed(1)}</p>
            <p className="text-xs text-muted-foreground">current score</p>
          </div>
          <div>
            <p className={`text-2xl font-bold font-mono uppercase ${textClass}`}>{stats.band}</p>
            <p className="text-xs text-muted-foreground">condition band</p>
          </div>
          <div>
            <p className="text-2xl font-bold font-mono">{stats.daysInBand}</p>
            <p className="text-xs text-muted-foreground">{stats.daysInBand === 1 ? "day" : "days"} in band</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
```

**Step 2: Verify types**

Run: `npm run build`
Expected: No type errors.

**Step 3: Commit**

```bash
git add src/components/stability-index-summary.tsx
git commit -m "feat: add StabilityIndexSummary homepage component"
```

---

### Task 4: Wire into homepage grid

**Files:**
- Modify: `src/components/homepage-client.tsx`

**Step 1: Add imports**

Add at the top of `homepage-client.tsx` after existing imports:

```ts
import { ReportCardsSummary } from "@/components/report-cards-summary";
import { StabilityIndexSummary } from "@/components/stability-index-summary";
```

**Step 2: Update grid to 3 columns and add new cards**

Change the grid div (around line 95) from:

```tsx
<div className="grid grid-cols-2 gap-3 sm:gap-5">
  <PegTrackerSummary />
  <LiquiditySummary />
  <BlacklistSummary />
  <CemeterySummary />
</div>
```

To:

```tsx
<div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-5">
  <PegTrackerSummary />
  <LiquiditySummary />
  <ReportCardsSummary />
  <BlacklistSummary />
  <CemeterySummary />
  <StabilityIndexSummary />
</div>
```

**Step 3: Build and verify**

Run: `npm run build`
Expected: Clean build, no type errors.

**Step 4: Visual check**

Run: `npm run dev`
Verify: Homepage shows 6 cards in a 3x2 grid on large screens, 2-column on smaller.

**Step 5: Commit**

```bash
git add src/components/homepage-client.tsx
git commit -m "feat: add report cards & PSI summary to homepage grid"
```
