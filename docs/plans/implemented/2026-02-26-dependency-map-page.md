# Dependency Map Page Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move the `ContagionGraph` component from Risk Lab into its own `/dependency-map` page with a nav entry under "Risk".

**Architecture:** Create a new Next.js page (`src/app/dependency-map/`) with a thin server shell and a client component that fetches the same three hooks already used in Risk Lab. Remove the graph from the Risk Lab client and replace it with a cross-link. Add a nav item using the `Network` lucide icon.

**Tech Stack:** Next.js 16 (static export), React 19, TypeScript strict, TanStack Query (hooks already exist), lucide-react, shadcn/ui.

---

### Task 1: Add Dependency Map nav entry

**Files:**
- Modify: `src/lib/nav-config.ts`

**Step 1: Add the import and nav item**

Open `src/lib/nav-config.ts`. Add `Network` to the lucide-react import, then add a new nav item after Portfolio under the "Risk" group:

```ts
import {
  LayoutDashboard,
  Droplets,
  ShieldBan,
  Skull,
  Info,
  FlaskConical,
  ArrowLeftRight,
  Newspaper,
  Wallet,
  Network,          // ← add this
  createLucideIcon,
} from "lucide-react";
```

In `NAV_GROUPS`, under the "Risk" group, after the Portfolio item:

```ts
{ href: "/dependency-map", label: "Dependency Map", icon: Network, description: "Stablecoin collateral dependency graph" },
```

**Step 2: Verify the build still type-checks**

```bash
npm run build 2>&1 | tail -20
```

Expected: no TypeScript errors.

**Step 3: Commit**

```bash
git add src/lib/nav-config.ts
git commit -m "feat(nav): add Dependency Map entry under Risk group"
```

---

### Task 2: Create the Dependency Map page shell

**Files:**
- Create: `src/app/dependency-map/page.tsx`

**Step 1: Write the page file**

```tsx
import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { DependencyMapClient } from "./client";

const description =
  "Interactive graph of collateral dependencies between the top 50 stablecoins by market cap. Node size reflects market cap; lines show collateral links.";

export const metadata: Metadata = {
  title: "Dependency Map — Stablecoin Collateral Graph",
  description,
  alternates: { canonical: "/dependency-map/" },
  openGraph: {
    title: "Dependency Map — Stablecoin Collateral Graph",
    description,
    url: "/dependency-map/",
  },
};

export default function DependencyMapPage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Dependency Map" path="/dependency-map/" />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Dependency Map</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter">Dependency Map</h1>
        <p className="text-sm text-muted-foreground max-w-2xl">
          Collateral dependencies between the top 50 stablecoins by market cap. Node size reflects market cap;
          lines show how one stablecoin relies on another as collateral. Drag nodes to explore. Click to view details.
        </p>
      </div>
      <Suspense>
        <DependencyMapClient />
      </Suspense>
    </div>
  );
}
```

**Step 2: Verify the file exists**

```bash
ls src/app/dependency-map/
```

Expected: `page.tsx`

---

### Task 3: Create the Dependency Map client component

**Files:**
- Create: `src/app/dependency-map/client.tsx`

**Step 1: Write the client file**

```tsx
"use client";

import { useMemo } from "react";
import { useReportCards } from "@/hooks/use-report-cards";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { ContagionGraph } from "@/components/contagion-graph";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { sumPegBuckets } from "@/lib/supply";

export function DependencyMapClient() {
  const { data: reportData, isLoading } = useReportCards();
  const { data: stablecoinsData } = useStablecoins();
  const { data: logos } = useLogos();

  const mcapMap = useMemo(() => {
    if (!stablecoinsData?.peggedAssets) return new Map<string, number>();
    return new Map(
      stablecoinsData.peggedAssets.map((a) => [
        a.id,
        a.circulating ? sumPegBuckets(a.circulating) : 0,
      ]),
    );
  }, [stablecoinsData]);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="pt-4 pb-4">
          <Skeleton className="h-[520px] w-full rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  if (!reportData?.cards) return null;

  return (
    <ContagionGraph
      cards={reportData.cards}
      mcapMap={mcapMap}
      logos={logos}
    />
  );
}
```

**Step 2: Type-check**

```bash
npm run build 2>&1 | tail -20
```

Expected: clean build, `dependency-map` route appears in output.

**Step 3: Commit**

```bash
git add src/app/dependency-map/
git commit -m "feat(dependency-map): add standalone page with ContagionGraph"
```

---

### Task 4: Remove ContagionGraph from Risk Lab, add cross-link

**Files:**
- Modify: `src/app/risk-lab/client.tsx`

**Step 1: Remove the ContagionGraph block**

Find and delete this block in `ReportCardsClient` (around line 232–239):

```tsx
      {/* Dependency map */}
      {reportData?.cards && (
        <ContagionGraph
          cards={reportData.cards}
          mcapMap={mcapMap}
          logos={logos}
        />
      )}
```

**Step 2: Remove the ContagionGraph import**

Delete this line near the top:

```ts
import { ContagionGraph } from "@/components/contagion-graph";
```

**Step 3: Add a cross-link where the graph was**

In the same location (between `<StressTestPanel>` and the filter controls `<div className="flex flex-wrap...">`), add:

```tsx
      {/* Link to standalone dependency map */}
      <div className="flex items-center justify-end">
        <a
          href="/dependency-map"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
        >
          Explore the full dependency map →
        </a>
      </div>
```

**Step 4: Type-check**

```bash
npm run build 2>&1 | tail -20
```

Expected: clean build, no unused-import errors.

**Step 5: Commit**

```bash
git add src/app/risk-lab/client.tsx
git commit -m "refactor(risk-lab): remove ContagionGraph, add link to /dependency-map"
```

---

### Task 5: Final verification

**Step 1: Full build**

```bash
npm run build 2>&1 | tail -30
```

Expected: clean build with both `/risk-lab` and `/dependency-map` in static export output.

**Step 2: Dev server smoke test**

```bash
npm run dev
```

Visit:
- `http://localhost:3000/dependency-map` — page renders, graph loads, nodes are draggable, clicking navigates to stablecoin detail
- `http://localhost:3000/risk-lab` — no graph, cross-link "Explore the full dependency map →" is visible
- Sidebar under Risk shows "Dependency Map" with Network icon

**Step 3: Commit design doc**

```bash
git add docs/plans/
git commit -m "docs: add dependency-map page design and implementation plan"
```
