# Feature Status Badge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a visible "Feature Status" badge (Mature / Experimental / Testing in Prod) inline next to the h1 title on 10 feature pages, with an optional version badge for /safety-scores.

**Architecture:** Single shared `FeatureStatusBadge` component accepts `status` and optional `version` props. Each page imports it and renders it inline inside the h1 element (h1 becomes a flex container). No runtime logic — all status values are static strings baked into each page at build time.

**Tech Stack:** React 19, TypeScript strict, Tailwind CSS v4, shadcn/ui `Badge` component.

---

## Status Reference

| Page | File | Status | Version |
|---|---|---|---|
| `/stability-index` | `src/app/stability-index/page.tsx:39` | `mature` | — |
| `/safety-scores` | `src/app/safety-scores/page.tsx:42` | `mature` | `v5.4` |
| `/dependency-map` | `src/app/dependency-map/page.tsx:40` | `experimental` | — |
| `/liquidity` | `src/app/liquidity/page.tsx:42` | `mature` | — |
| `/depeg` | `src/app/depeg/page.tsx:77` | `mature` | — |
| `/blacklist` | `src/app/blacklist/page.tsx:82` | `mature` | — |
| `/portfolio` | `src/app/portfolio/page.tsx:40` | `experimental` | — |
| `/compare` | `src/app/compare/page.tsx:50` | `mature` | — |
| `/yield` | `src/app/yield/page.tsx:76` | `testing-in-prod` | — |
| `/flows` | `src/app/flows/page.tsx:42` | `testing-in-prod` | — |

---

### Task 1: Create FeatureStatusBadge component

**Files:**
- Create: `src/components/feature-status-badge.tsx`

**Step 1: Create the component**

```tsx
import { Badge } from "@/components/ui/badge";

type FeatureStatus = "mature" | "experimental" | "testing-in-prod";

const STATUS_CONFIG: Record<FeatureStatus, { label: string; className: string }> = {
  mature: {
    label: "Mature",
    className:
      "bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-400 dark:border-emerald-500/40",
  },
  experimental: {
    label: "Experimental",
    className:
      "bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-400 dark:border-amber-500/40",
  },
  "testing-in-prod": {
    label: "Testing in Prod",
    className:
      "bg-orange-500/15 text-orange-700 border-orange-500/30 dark:text-orange-400 dark:border-orange-500/40",
  },
};

interface FeatureStatusBadgeProps {
  status: FeatureStatus;
  version?: string;
}

export function FeatureStatusBadge({ status, version }: FeatureStatusBadgeProps) {
  const { label, className } = STATUS_CONFIG[status];
  return (
    <span className="inline-flex items-center gap-1.5 font-normal text-base">
      <Badge variant="outline" className={className}>
        {label}
      </Badge>
      {version && (
        <Badge
          variant="outline"
          className="bg-muted/50 text-muted-foreground border-border/60"
        >
          {version}
        </Badge>
      )}
    </span>
  );
}
```

**Step 2: Type-check**

Run: `npm run build 2>&1 | head -30`
Expected: No TypeScript errors related to the new file.

**Step 3: Commit**

```bash
git add src/components/feature-status-badge.tsx
git commit -m "feat: add FeatureStatusBadge component"
```

---

### Task 2: Update first 5 pages

**Files:**
- Modify: `src/app/stability-index/page.tsx:39`
- Modify: `src/app/safety-scores/page.tsx:42`
- Modify: `src/app/dependency-map/page.tsx:40`
- Modify: `src/app/liquidity/page.tsx:42`
- Modify: `src/app/depeg/page.tsx:77`

For each file: add the import at the top, then update the h1.

**Pattern — import to add (after existing imports):**
```tsx
import { FeatureStatusBadge } from "@/components/feature-status-badge";
```

**Pattern — h1 before:**
```tsx
<h1 className="text-4xl font-extrabold tracking-tighter">Page Title</h1>
```

**Pattern — h1 after:**
```tsx
<h1 className="text-4xl font-extrabold tracking-tighter flex items-center gap-3">
  Page Title <FeatureStatusBadge status="mature" />
</h1>
```

**Step 1: Update stability-index/page.tsx**

h1 line 39 becomes:
```tsx
<h1 className="text-4xl font-extrabold tracking-tighter flex items-center gap-3">Pharos Stability Index <FeatureStatusBadge status="mature" /></h1>
```

**Step 2: Update safety-scores/page.tsx**

h1 line 42 becomes (note: version prop):
```tsx
<h1 className="text-4xl font-extrabold tracking-tighter flex items-center gap-3">Safety Scores <FeatureStatusBadge status="mature" version="v5.4" /></h1>
```

**Step 3: Update dependency-map/page.tsx**

h1 line 40 becomes:
```tsx
<h1 className="text-4xl font-extrabold tracking-tighter flex items-center gap-3">Dependency Map <FeatureStatusBadge status="experimental" /></h1>
```

**Step 4: Update liquidity/page.tsx**

h1 line 42 becomes:
```tsx
<h1 className="text-4xl font-extrabold tracking-tighter flex items-center gap-3">DEX Liquidity <FeatureStatusBadge status="mature" /></h1>
```

**Step 5: Update depeg/page.tsx**

h1 line 77 becomes:
```tsx
<h1 className="text-4xl font-extrabold tracking-tighter flex items-center gap-3">Depeg Tracker <FeatureStatusBadge status="mature" /></h1>
```

**Step 6: Type-check**

Run: `npm run build 2>&1 | head -30`
Expected: No errors.

**Step 7: Commit**

```bash
git add src/app/stability-index/page.tsx src/app/safety-scores/page.tsx src/app/dependency-map/page.tsx src/app/liquidity/page.tsx src/app/depeg/page.tsx
git commit -m "feat: add feature status badges to stability-index, safety-scores, dependency-map, liquidity, depeg"
```

---

### Task 3: Update remaining 5 pages

**Files:**
- Modify: `src/app/blacklist/page.tsx:82`
- Modify: `src/app/portfolio/page.tsx:40`
- Modify: `src/app/compare/page.tsx:50`
- Modify: `src/app/yield/page.tsx:76`
- Modify: `src/app/flows/page.tsx:42`

Same import + h1 pattern as Task 2.

**Step 1: Update blacklist/page.tsx**

h1 line 82 becomes:
```tsx
<h1 className="text-4xl font-extrabold tracking-tighter flex items-center gap-3">Blacklist Tracker <FeatureStatusBadge status="mature" /></h1>
```

**Step 2: Update portfolio/page.tsx**

h1 line 40 becomes:
```tsx
<h1 className="text-4xl font-extrabold tracking-tighter flex items-center gap-3">Portfolio <FeatureStatusBadge status="experimental" /></h1>
```

**Step 3: Update compare/page.tsx**

h1 line 50 becomes:
```tsx
<h1 className="text-4xl font-extrabold tracking-tighter flex items-center gap-3">Compare Stablecoins <FeatureStatusBadge status="mature" /></h1>
```

**Step 4: Update yield/page.tsx**

h1 line 76 becomes:
```tsx
<h1 className="text-4xl font-extrabold tracking-tighter flex items-center gap-3">Yield Intelligence <FeatureStatusBadge status="testing-in-prod" /></h1>
```

**Step 5: Update flows/page.tsx**

h1 line 42 becomes:
```tsx
<h1 className="text-4xl font-extrabold tracking-tighter flex items-center gap-3">Mint/Burn Flows <FeatureStatusBadge status="testing-in-prod" /></h1>
```

**Step 6: Type-check**

Run: `npm run build 2>&1 | head -30`
Expected: No errors.

**Step 7: Commit**

```bash
git add src/app/blacklist/page.tsx src/app/portfolio/page.tsx src/app/compare/page.tsx src/app/yield/page.tsx src/app/flows/page.tsx
git commit -m "feat: add feature status badges to blacklist, portfolio, compare, yield, flows"
```

---

### Task 4: Full build verification

**Step 1: Run full build**

```bash
npm run build 2>&1 | tail -20
```
Expected: Successful build, no TypeScript errors, no missing module errors.

**Step 2: Run lint**

```bash
npm run lint 2>&1 | tail -20
```
Expected: No new lint errors.

**Step 3: Run tests**

```bash
npm test 2>&1 | tail -10
```
Expected: All existing tests pass.
