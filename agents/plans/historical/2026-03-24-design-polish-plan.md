# Pharos Design Polish & Refinement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address all high-impact design issues from the Pharos audit — chart tooltip consistency, detail page SSR, homepage information hierarchy, feature page differentiation, methodology interactive teaching — plus two uniqueness-amplifying additions (PSI regime bar and confidence typography) and a normalization pass.

**Architecture:** Eight independent workstreams: (A) Chart tooltip system, (B) Detail page SSR skeleton, (C) Homepage restructure, (D) Feature page accents, (E) Methodology interactive explorer, (F) Normalization pass, (G) PSI Regime Context Bar, (H) Confidence Typography. Each workstream can be developed and merged independently.

**Tech Stack:** Next.js 16, React 19, TypeScript strict, Tailwind CSS v4, Recharts, shadcn/ui, OKLCh design tokens.

---

## Workstream A: Unified Chart Tooltip System

**Problem:** Every chart has its own tooltip implementation (6+ custom tooltips) with inconsistent styling. Default Recharts tooltips lack design-system shadows, padding, and don't match `pharos-card-shell` styling.

**Approach:** Create a single `PharosChartTooltip` shell component that all chart tooltips compose into. Migrate existing custom tooltips to use this shell. Keep `RECHARTS_TOOLTIP_STYLES` as the fallback for charts using Recharts' default rendering.

### Task A1: Create PharosChartTooltip shell component

**Files:**
- Create: `src/components/pharos-chart-tooltip.tsx`
- Modify: `src/lib/chart-colors.ts` (export tooltip class constants)
- Test: Visual verification via `npm run dev`

- [ ] **Step 1: Create the tooltip shell component**

```tsx
// src/components/pharos-chart-tooltip.tsx
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PharosChartTooltipProps {
  active?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * Shared visual shell for all Recharts custom tooltips.
 * Matches pharos-card-shell elevation, radius, and backdrop styling.
 */
export function PharosChartTooltip({ active, children, className }: PharosChartTooltipProps) {
  if (!active) return null;
  return (
    <div
      className={cn(
        "rounded-xl border border-border/70 bg-card/95 px-3.5 py-3 backdrop-blur-sm",
        "text-sm",
        className,
      )}
      style={{ boxShadow: "var(--elevation-rest)" }}
    >
      {children}
    </div>
  );
}

/** Label line inside a PharosChartTooltip (e.g., the date header). */
export function TooltipLabel({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-xs font-medium text-foreground">{children}</p>;
}

/** Single row inside a PharosChartTooltip: color dot + label + value. */
export function TooltipRow({
  color,
  label,
  value,
  bold,
}: {
  color?: string;
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {color && (
          <span
            className="inline-block size-2 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
        )}
        {label}
      </span>
      <span className={cn("font-mono tabular-nums text-foreground", bold && "font-semibold")}>
        {value}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No errors related to the new file.

- [ ] **Step 3: Commit**

```bash
git add src/components/pharos-chart-tooltip.tsx
git commit -m "feat: add PharosChartTooltip shell for consistent chart tooltip styling"
```

### Task A2: Migrate BlacklistTooltip to PharosChartTooltip shell

**Files:**
- Modify: `src/components/blacklist-chart.tsx:223-269`

- [ ] **Step 1: Read current BlacklistTooltip implementation**

Read `src/components/blacklist-chart.tsx` lines 220-270 for the current inline styling.

- [ ] **Step 2: Refactor to use PharosChartTooltip**

Replace the BlacklistTooltip's inline `style={{ backgroundColor, border, borderRadius, fontFamily }}` div with the shell component. **Important:** Keep the existing zero-value filter (`payload.filter(p => p.value > 0)`) — the current tooltip only shows stablecoins with actual events. Also use inline types for the tooltip props (matching the existing pattern in this file) or add `import type { TooltipProps } from "recharts"`.

```tsx
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";

function BlacklistTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ dataKey: string; value: number; color: string }>; label?: string }) {
  const nonZero = payload?.filter((p) => p.value > 0);
  if (!active || !nonZero?.length) return null;
  const total = nonZero.reduce((sum, entry) => sum + entry.value, 0);
  return (
    <PharosChartTooltip active={active}>
      <TooltipLabel>{label}</TooltipLabel>
      <div className="space-y-1">
        {nonZero.map((entry) => (
          <TooltipRow
            key={entry.dataKey}
            color={entry.color}
            label={String(entry.dataKey)}
            value={formatCurrency(entry.value, 0)}
          />
        ))}
        {nonZero.length > 1 && (
          <TooltipRow label="Total" value={formatCurrency(total, 0)} bold />
        )}
      </div>
    </PharosChartTooltip>
  );
}
```

- [ ] **Step 3: Remove the RECHARTS_TOOLTIP_STYLES import if no longer needed in this file**

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | grep blacklist`
Expected: No errors.

- [ ] **Step 5: Visual verification in dev**

Run: `npm run dev` → navigate to a page showing blacklist charts → verify tooltip matches design system.

- [ ] **Step 6: Commit**

```bash
git add src/components/blacklist-chart.tsx
git commit -m "refactor: migrate BlacklistTooltip to PharosChartTooltip shell"
```

### Task A3: Migrate FlowTooltip to PharosChartTooltip shell

**Files:**
- Modify: `src/components/flow-chart.tsx:183-225`

- [ ] **Step 1: Read current FlowTooltip**

Read `src/components/flow-chart.tsx` lines 180-230.

- [ ] **Step 2: Refactor using PharosChartTooltip + TooltipLabel + TooltipRow**

Keep the existing flow-specific logic (time formatting, mint/burn/net ordering, signed values) but wrap in `PharosChartTooltip`. Use `TooltipRow` for each item.

- [ ] **Step 3: Verify types compile and visual check**

- [ ] **Step 4: Commit**

```bash
git add src/components/flow-chart.tsx
git commit -m "refactor: migrate FlowTooltip to PharosChartTooltip shell"
```

### Task A4: Migrate YieldScatterTooltip to PharosChartTooltip shell

**Files:**
- Modify: `src/components/yield-scatter-plot.tsx:110-146`

- [ ] **Step 1: Read current CustomTooltip**
- [ ] **Step 2: Refactor — this tooltip has a logo, so use PharosChartTooltip directly with custom children (don't force TooltipRow)**
- [ ] **Step 3: Verify types compile and visual check**
- [ ] **Step 4: Commit**

```bash
git add src/components/yield-scatter-plot.tsx
git commit -m "refactor: migrate yield scatter tooltip to PharosChartTooltip shell"
```

### Task A5: Migrate PegTooltip and remaining custom tooltips

**Files:**
- Modify: `src/components/peg-diversity-chart.tsx:38-85`
- Modify: `src/components/reserve-treemap.tsx:102-121`
- Modify: `src/components/cemetery-charts.tsx` (ChartTooltip wrapper)

- [ ] **Step 1: Read each file's tooltip implementation**
- [ ] **Step 2: Refactor each to PharosChartTooltip shell**
- [ ] **Step 3: Verify types compile**
- [ ] **Step 4: Commit**

```bash
git add src/components/peg-diversity-chart.tsx src/components/reserve-treemap.tsx src/components/cemetery-charts.tsx
git commit -m "refactor: migrate remaining chart tooltips to PharosChartTooltip shell"
```

### Task A6: Update RECHARTS_TOOLTIP_STYLES to match PharosChartTooltip elevation

**Files:**
- Modify: `src/lib/chart-colors.ts:46-55`

The `RECHARTS_TOOLTIP_STYLES` is still used by `DateTooltip` for charts that don't need a custom render function. Update it so its visual output is closer to the new shell.

- [ ] **Step 1: Update RECHARTS_TOOLTIP_STYLES contentStyle**

```ts
export const RECHARTS_TOOLTIP_STYLES = {
  contentStyle: {
    backgroundColor: "var(--color-card)",
    border: "1px solid color-mix(in oklch, var(--color-border) 70%, transparent)",
    borderRadius: "var(--radius-xl, 0.75rem)",
    fontFamily: "var(--font-mono)",
    boxShadow: "var(--elevation-rest)",
    padding: "0.75rem 0.875rem",
    backdropFilter: "blur(4px)",
  },
  labelStyle: { color: "var(--color-foreground)", fontFamily: "var(--font-sans)", fontWeight: 500, fontSize: "0.75rem", marginBottom: "0.5rem" },
  itemStyle: { color: "var(--color-muted-foreground)", fontFamily: "var(--font-mono)", fontSize: "0.875rem" },
} as const;
```

- [ ] **Step 2: Verify types compile, visual check on homepage charts (marketcap, PSI history)**
- [ ] **Step 3: Commit**

```bash
git add src/lib/chart-colors.ts
git commit -m "refactor: update RECHARTS_TOOLTIP_STYLES to match design system elevation and spacing"
```

---

## Workstream B: Stablecoin Detail Page SSR Skeleton

**Problem:** The stablecoin detail page renders its entire body client-side via `StablecoinDetailClient`. Before JS hydrates, the page is blank — hurting perceived performance, accessibility, and crawlability. The `<h1>` is `sr-only`, so there's no visible page title without JS.

**Approach:** Add a visible server-rendered header section (coin name, logo, key metadata) and a skeleton layout for the main content area. The client component then replaces skeletons with real data.

### Task B1: Add visible server-rendered header to detail page

**Files:**
- Modify: `src/app/stablecoin/[id]/page.tsx:68-84`

- [ ] **Step 1: Read current page.tsx**

Read full file at `src/app/stablecoin/[id]/page.tsx`.

- [ ] **Step 2: Replace sr-only h1 with a visible server-rendered header**

In `StablecoinDetailPage`, replace the `sr-only` div (lines 70-75) and add a visible header before the client component. The server already has `coin` (StablecoinMeta) and `logoSrc`.

**Important:** Add `import Image from "next/image"` at the top of the file (it's not currently imported). Properties are on `coin.flags`, not `coin` directly — use `coin.flags.backing`, `coin.flags.governance`, `coin.flags.pegCurrency`.

```tsx
{/* Visible server-rendered header — shows immediately before client hydrates */}
<div className="space-y-2">
  <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-muted-foreground sm:text-sm">
    <Link
      href="/"
      className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background/60 px-3 text-foreground hover:text-foreground sm:min-h-0 sm:rounded-sm sm:border-0 sm:bg-transparent sm:px-0 sm:text-inherit"
    >
      Dashboard
    </Link>
    <span>/</span>
    <span className="text-foreground">{coin.name}</span>
  </nav>
  <div className="flex items-center gap-3">
    {typedLogos[coin.id] && (
      <Image src={typedLogos[coin.id]} alt="" width={40} height={40} className="rounded-lg" />
    )}
    <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
      {coin.name} <span className="text-muted-foreground font-semibold">({coin.symbol})</span>
    </h1>
  </div>
  <p className="text-sm text-muted-foreground">
    {BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing} · {GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance} · Pegged to {PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}
  </p>
</div>
```

- [ ] **Step 3: Verify build succeeds**

Run: `npm run build 2>&1 | tail -20`
Expected: Build succeeds, detail pages render.

- [ ] **Step 4: Commit**

```bash
git add src/app/stablecoin/[id]/page.tsx
git commit -m "feat: add server-rendered header to stablecoin detail page for instant first paint"
```

### Task B2: Add skeleton layout below the header

**Files:**
- Modify: `src/app/stablecoin/[id]/page.tsx`

- [ ] **Step 1: Add a lightweight skeleton grid as fallback content**

Below the header div and above `<StablecoinDetailClient>`, add a `<noscript>`-friendly skeleton that the client component will replace:

```tsx
{/* Structural skeleton — visible until client hydrates */}
<div className="space-y-6" aria-hidden="true">
  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
    {Array.from({ length: 4 }, (_, i) => (
      <div key={i} className="pharos-card-shell px-4 py-3">
        <Skeleton className="h-3 w-16 mb-2" />
        <Skeleton className="h-6 w-24" />
      </div>
    ))}
  </div>
  <div className="pharos-card-shell h-[300px]" />
</div>
```

The skeleton should only be visible before hydration. Since `page.tsx` is a **Server Component** (it uses `async`/`await`), we cannot use `next/dynamic` here — `dynamic()` is only available in Client Components. Instead, use React `<Suspense>` with a fallback.

**Important:** `StablecoinDetailClient` is a `"use client"` component. In Next.js static export, Server Components import Client Components directly and render them during the build. `<Suspense>` boundaries in Server Components will render the fallback into the static HTML, which is then replaced on client hydration.

- [ ] **Step 2: Wrap StablecoinDetailClient in Suspense with a skeleton fallback**

In `page.tsx`, add the `Suspense` import and skeleton wrapper:

```tsx
// Add to imports at top of file:
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";

// In the return JSX, wrap StablecoinDetailClient:
<Suspense fallback={
  <div className="space-y-6" aria-hidden="true">
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="pharos-card-shell px-4 py-3">
          <Skeleton className="h-3 w-16 mb-2" />
          <Skeleton className="h-6 w-24" />
        </div>
      ))}
    </div>
    <div className="pharos-card-shell h-[300px]" />
  </div>
}>
  <StablecoinDetailClient id={id} summary={typedSummaries[id] ?? null} coin={coin} logoSrc={typedLogos[coin.id]} />
</Suspense>
```

Keep the existing `import StablecoinDetailClient from "./client"` — no need to convert to `dynamic()`.

**Note:** In static export, the Suspense fallback is rendered into the HTML during build. The client component hydrates and replaces it. If the Suspense fallback is not rendered in static export (which depends on Next.js 16's behavior for synchronous Client Components), the alternative approach is to add loading state handling inside `StablecoinDetailClient` itself — which it already does (lines 112-118 render a skeleton when `status === "loading"`). In that case, Step 2 is optional and the server-rendered header from Step 1 already solves the "blank page before JS" problem on its own.

- [ ] **Step 3: Verify with `npm run build`, check that the skeleton appears in the static HTML output**

Run: `npm run build && grep -l "pharos-card-shell" out/stablecoin/usdt-tether/index.html 2>/dev/null || echo "check build output path"`

- [ ] **Step 4: Commit**

```bash
git add src/app/stablecoin/[id]/page.tsx
git commit -m "feat: add SSR skeleton to detail page for perceived performance"
```

---

## Workstream C: Homepage Restructure — Table as Hero

**Problem:** The homepage stacks 16 filter controls above the table before users see any data. The user confirmed the table should be the hero, with monitoring/research sections moved below.

**Approach:** Restructure `HomepageClient` section order: (1) SiteHeader + KpiBar (unchanged), (2) StablecoinTable with search only, (3) MarketHighlights + DailyDigest, (4) Monitoring sections, (5) Research sections. Move density/columns into a settings popover. Keep filters but collapse them by default.

### Task C1: Collapse filter bar by default

**Files:**
- Modify: `src/components/homepage-client.tsx:321`

- [ ] **Step 1: Change initial state of showFilters to false**

```tsx
// Line 321: change true → false
const [showFilters, setShowFilters] = useState(false);
```

- [ ] **Step 2: Add a "Show filters" button next to the "Key Stablecoin Data" heading**

In the table section (around line 434), add a toggle button:

```tsx
<div className="flex items-center justify-between">
  <h2 className="text-xl font-semibold tracking-tight text-foreground">Key Stablecoin Data</h2>
  <Button
    variant="ghost"
    size="sm"
    onClick={() => setShowFilters((prev) => !prev)}
    className="gap-1.5 text-xs text-muted-foreground"
  >
    <SlidersHorizontal className="h-3.5 w-3.5" />
    {showFilters ? "Hide filters" : "Filters"}
    {filters.hasFilters && (
      <span className="inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold size-4">
        {filters.activeFilters.length}
      </span>
    )}
  </Button>
</div>
```

Import `SlidersHorizontal` from `lucide-react`.

- [ ] **Step 3: Verify the toggle works**

Run: `npm run dev` → homepage → filters should be hidden by default, "Filters" button toggles them.

- [ ] **Step 4: Commit**

```bash
git add src/components/homepage-client.tsx
git commit -m "refactor: collapse homepage filters by default, add toggle button"
```

### Task C2: Move table section above highlights and digest

**Files:**
- Modify: `src/components/homepage-client.tsx:398-550` (reorder sections)

- [ ] **Step 1: Read the full render return of HomepageClient**

Read lines 398-560 to understand the current section order.

- [ ] **Step 2: Reorder sections**

Current order in the JSX return:
1. DataLiveRegion + QueryErrorNotice + StaleDataBanner
2. CampaignCallout + StartHereCallout
3. **MarketHighlights** ← move down
4. **DailyDigest** ← move down
5. **StablecoinTable (with filters)** ← move up
6. UpcomingStablecoins
7. Core Monitoring (DEWS, Flows, Safety, PSI)
8. Research (CategoryStats, Marketcap, NonUSD charts)

New order:
1. DataLiveRegion + QueryErrorNotice + StaleDataBanner (unchanged)
2. CampaignCallout + StartHereCallout (unchanged)
3. **StablecoinTable (with filters)** ← promoted to position 3
4. **MarketHighlights** ← moved after table
5. **DailyDigest** ← moved after highlights
6. UpcomingStablecoins (unchanged)
7. Core Monitoring (unchanged)
8. Research (unchanged)

Move the `SectionErrorBoundary name="table"` block (lines 433-454) above the `SectionErrorBoundary name="highlights"` block (lines 425-427). Move the `SectionErrorBoundary name="digest"` block (lines 429-431) after highlights.

- [ ] **Step 3: Verify layout in dev**

Run: `npm run dev` → homepage → table should appear first after KPI bar.

- [ ] **Step 4: Commit**

```bash
git add src/components/homepage-client.tsx
git commit -m "refactor: promote stablecoin table to homepage hero position"
```

### Task C3: Move density toggle and column picker into a settings popover

**Files:**
- Modify: `src/components/table-toolbar.tsx`
- Modify: `src/components/stablecoin-table.tsx` (if toolbar rendering changes)

- [ ] **Step 1: Read current toolbar files**

Read full files:
- `src/components/table-toolbar.tsx` — confirm component name, props, layout
- `src/components/density-toggle.tsx` — confirm DensityToggle component interface
- `src/components/stablecoin-table-column-visibility.tsx` — confirm ColumnVisibilityDropdown component interface and whether its content can be extracted into an inline variant

- [ ] **Step 2: Wrap density toggle and column picker in a Popover**

Replace the side-by-side toolbar layout with:

```tsx
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Settings2 } from "lucide-react";

// Inside the toolbar component:
<Popover>
  <PopoverTrigger asChild>
    <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-muted-foreground">
      <Settings2 className="h-3.5 w-3.5" />
      Table settings
    </Button>
  </PopoverTrigger>
  <PopoverContent align="end" className="w-64 space-y-4 p-4">
    <div className="space-y-2">
      <p className="pharos-kicker">Density</p>
      <DensityToggle value={density} onChange={onDensityChange} />
    </div>
    <div className="space-y-2">
      <p className="pharos-kicker">Columns</p>
      {/* Column visibility checkboxes — inline, not in a separate dropdown */}
      <ColumnVisibilityInline
        visibleColumns={visibleColumns}
        setVisibleColumns={setVisibleColumns}
        resetColumns={resetColumns}
      />
    </div>
  </PopoverContent>
</Popover>
```

This may require extracting the column checkbox content from `ColumnVisibilityDropdown` into a headless `ColumnVisibilityInline` variant, or simply nesting the existing dropdown content.

- [ ] **Step 3: Verify the popover works**
- [ ] **Step 4: Run merge gate to ensure nothing breaks**

Run: `npm run test:merge-gate`

- [ ] **Step 5: Commit**

```bash
git add src/components/table-toolbar.tsx src/components/stablecoin-table-column-visibility.tsx
git commit -m "refactor: consolidate density + columns into table settings popover"
```

---

## Workstream D: Feature Page Visual Differentiation

**Problem:** All feature pages use `FeaturePageShell` identically — breadcrumb, title, lead paragraph. There's no visual hook to distinguish depeg from yield from liquidity.

**Approach:** Add an optional `accent` prop to `FeaturePageShell` that renders a thin colored top border (3px) using the feature's semantic color. Each feature page picks its own accent from the design system's existing severity/brand palette. Minimal change, big visual impact.

### Task D1: Add accent prop to FeaturePageShell

**Files:**
- Modify: `src/components/feature-page-shell.tsx:6-90`

- [ ] **Step 1: Add `accent` prop to FeaturePageShellProps**

```tsx
export interface FeaturePageShellProps {
  // ... existing props ...
  /** Semantic top accent color — 3px border-top to visually distinguish feature pages. */
  accent?: string; // Tailwind border-color class, e.g. "border-t-blue-500"
}
```

- [ ] **Step 2: Apply accent to the wrapper div**

In the component's return, add the accent border:

```tsx
<div className={cn(variantClassName, containerClassName, accent && `border-t-[3px] ${accent} pt-5`)}>
```

If no accent is provided, rendering is unchanged (backwards-compatible).

**Tailwind purge note:** The `accent` value (e.g., `"border-t-red-500"`) is a complete static class string provided at each call site. Tailwind's scanner finds it there. The `border-t-[3px]` is a static literal in this file. The `cn()` call concatenates static strings — this is safe for purge.

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/components/feature-page-shell.tsx
git commit -m "feat: add optional accent prop to FeaturePageShell for visual differentiation"
```

### Task D2: Apply accents to feature pages

**Files:**
- Modify: Shell props in each feature page file or `createClientFeaturePage` call

Feature-to-accent mapping (using existing design tokens):
- **Depeg Tracker** → `border-t-red-500` (risk/severity)
- **Safety Scores** → `border-t-emerald-500` (safety/health)
- **Liquidity** → `border-t-blue-500` (primary/analytical)
- **Yield** → `border-t-amber-500` (opportunity/reward)
- **Flows** → `border-t-teal-500` (movement/flow)
- **Stability Index** → `border-t-cyan-500` (system/global)
- **Blacklist** → `border-t-orange-500` (warning/enforcement)
- **Coverage** → `border-t-purple-500` (completeness/scope)

- [ ] **Step 1: Find all feature page shell configurations**

Search for `createClientFeaturePage` calls and direct `FeaturePageShell` usage. Add `accent` to each shell config.

- [ ] **Step 2: Add accent to each feature page**

For `createClientFeaturePage` calls, add to the `shell` object:
```tsx
shell: {
  // ... existing props ...
  accent: "border-t-red-500",
}
```

For direct `FeaturePageShell` usage:
```tsx
<FeaturePageShell accent="border-t-red-500" ...>
```

- [ ] **Step 3: Visual verification**

Run: `npm run dev` → visit each feature page → verify the accent border appears.

- [ ] **Step 4: Commit**

```bash
git add src/app/depeg/ src/app/safety-scores/ src/app/liquidity/ src/app/yield/ src/app/flows/ src/app/stability-index/ src/app/blacklist/ src/app/coverage/
git commit -m "feat: apply semantic accent borders to all feature pages"
```

### Task D3: Also update createClientFeaturePage to pass accent through

**Files:**
- Modify: `src/lib/client-feature-page.tsx` (if `accent` isn't already covered by the spread)

- [ ] **Step 1: Verify that `Omit<FeaturePageShellProps, "children">` already includes `accent`**

Since `accent` was added to `FeaturePageShellProps`, the `Omit<..., "children">` type should automatically include it. Verify by checking types compile.

- [ ] **Step 2: If needed, no changes — the spread `{...shell}` passes accent through**

- [ ] **Step 3: Commit if any changes were needed**

---

## Workstream E: Methodology Interactive Teaching

**Problem:** The methodology page documents formulas and thresholds but doesn't let users explore interactively. The Reader/Analyst toggle is brilliant — extending it to let users plug in values and see scores compute live would transform the page from reference to teaching tool.

**Approach:** Add an interactive "Score Calculator" widget to the Safety Scores methodology section. Users input dimension values (0-100) and see the overall grade compute in real-time. Uses the actual `computeOverallGrade` function from `shared/lib/` to guarantee the math is identical to production.

**Accuracy caveat:** The calculator teaches how *weights, thresholds, and the peg multiplier* interact — it does not simulate the upstream pipelines that compute each dimension score from on-chain data. A disclaimer makes this explicit. The formula, weights (`liquidity: 0.3, dependencyRisk: 0.25, resilience: 0.2, decentralization: 0.15`), peg multiplier exponent (`0.2`), and grade thresholds (`A+ ≥ 87 ... F ≥ 0`) are all production-identical. Scoped to one section first; can extend to PSI/PegScore later.

### Task E1: Create SafetyScoreCalculator component

**Files:**
- Create: `src/components/methodology/safety-score-calculator.tsx`
- Reference: `shared/lib/report-cards.ts` (the actual grading function)

- [ ] **Step 1: Read the grading function signature**

Read `shared/lib/report-cards.ts` to understand `computeOverallGrade` inputs and outputs. Identify what dimension values it needs (transparency, stability, liquidity, governance, etc.) and what it returns (letter grade, score, dimension breakdowns).

- [ ] **Step 2: Create the interactive calculator component**

The function signature is:
```ts
// shared/lib/report-cards.ts:766
computeOverallGrade(
  dimensions: Record<DimensionKey, ReportCardDimension>,
  opts?: { navToken?: boolean },
): { grade: ReportCardGrade; score: number | null; baseScore: number | null; ratedDimensions: number }

// DimensionKey = "pegStability" | "liquidity" | "resilience" | "decentralization" | "dependencyRisk"
// ReportCardDimension = { grade: string; score: number | null; detail: string }
// Weights: pegStability: 0 (applied as multiplier), liquidity: 0.3, resilience: 0.2, decentralization: 0.15, dependencyRisk: 0.25
```

**Verified imports:**
- `computeOverallGrade` and `DIMENSION_LABELS` are named exports from `shared/lib/report-cards.ts` (lines 766, 64)
- `DimensionKey`, `ReportCardDimension`, `ReportCardGrade` are re-exported from `@shared/types` via `shared/types/index.ts` → `shared/types/report-cards.ts`
- `GradeBadge` at `src/components/grade-badge.tsx:7` has signature: `({ grade: ReportCardGrade, score: number | null, size?: "sm" | "lg" })` — both `grade` and `score` are required
- `ReportCardDimension` = `{ grade: ReportCardGrade; score: number | null; detail: string }` — the `grade` field is `ReportCardGrade`, not `string`
- `DIMENSION_WEIGHTS`: `pegStability: 0, liquidity: 0.3, resilience: 0.2, decentralization: 0.15, dependencyRisk: 0.25`
- `PEG_MULTIPLIER_EXPONENT`: `0.2`
- `GRADE_THRESHOLDS`: `A+ ≥ 87, A ≥ 83, A- ≥ 80, B+ ≥ 75, B ≥ 70, B- ≥ 65, C+ ≥ 60, C ≥ 55, C- ≥ 50, D ≥ 40, F ≥ 0`

```tsx
// src/components/methodology/safety-score-calculator.tsx
"use client";

import { useMemo, useState } from "react";
import { GradeBadge } from "@/components/grade-badge";
import {
  computeOverallGrade,
  DIMENSION_LABELS,
  DIMENSION_WEIGHTS,
  PEG_MULTIPLIER_EXPONENT,
} from "@shared/lib/report-cards";
import type { DimensionKey, ReportCardDimension } from "@shared/types";

const CALCULATOR_DIMENSIONS: { key: DimensionKey; defaultValue: number }[] = [
  { key: "pegStability", defaultValue: 95 },
  { key: "liquidity", defaultValue: 65 },
  { key: "resilience", defaultValue: 55 },
  { key: "decentralization", defaultValue: 50 },
  { key: "dependencyRisk", defaultValue: 60 },
];

const INITIAL_VALUES = Object.fromEntries(
  CALCULATOR_DIMENSIONS.map((d) => [d.key, d.defaultValue]),
) as Record<DimensionKey, number>;

function makeDimension(score: number): ReportCardDimension {
  // grade field is unused by computeOverallGrade — only score matters.
  // "NR" is a valid ReportCardGrade literal.
  return { grade: "NR", score, detail: "interactive" };
}

export function SafetyScoreCalculator() {
  const [values, setValues] = useState<Record<DimensionKey, number>>(INITIAL_VALUES);

  const result = useMemo(() => {
    const dimensions = Object.fromEntries(
      Object.entries(values).map(([key, score]) => [key, makeDimension(score)]),
    ) as Record<DimensionKey, ReportCardDimension>;
    return computeOverallGrade(dimensions);
  }, [values]);

  return (
    <div className="space-y-4 rounded-2xl border border-border/60 bg-background/45 p-4">
      <div className="flex items-center justify-between">
        <p className="pharos-kicker">Interactive: Try your own inputs</p>
        <button
          onClick={() => setValues(INITIAL_VALUES)}
          className="pharos-focus-ring rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Reset
        </button>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Scores below use the same formula, weights, and thresholds as production.
        In practice each dimension is derived from on-chain data, not chosen
        directly — use this to explore how the grading math works, not to predict
        a specific coin&apos;s grade.
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CALCULATOR_DIMENSIONS.map((dim) => {
          const weight = DIMENSION_WEIGHTS[dim.key];
          const weightLabel =
            weight > 0
              ? `${(weight * 100).toFixed(0)}% weight`
              : `×(v/100)^${PEG_MULTIPLIER_EXPONENT} multiplier`;
          return (
            <div key={dim.key} className="space-y-1.5">
              <label className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {DIMENSION_LABELS[dim.key]}{" "}
                  <span className="text-muted-foreground/60">({weightLabel})</span>
                </span>
                <span className="font-mono tabular-nums text-foreground">{values[dim.key]}</span>
              </label>
              <input
                type="range"
                min={0}
                max={100}
                value={values[dim.key]}
                onChange={(e) =>
                  setValues((prev) => ({ ...prev, [dim.key]: Number(e.target.value) }))
                }
                className="w-full accent-[var(--brand-accent)]"
                aria-label={`${DIMENSION_LABELS[dim.key]} score`}
              />
            </div>
          );
        })}
      </div>

      {result.score !== null && (
        <div className="flex flex-wrap items-center gap-3 border-t border-border/50 pt-3">
          <span className="text-sm text-muted-foreground">Computed grade:</span>
          <GradeBadge grade={result.grade} score={result.score} />
          <span className="font-mono tabular-nums text-sm text-foreground">
            {result.score} / 100
          </span>
          {result.baseScore !== null && result.baseScore !== result.score && (
            <span className="text-xs text-muted-foreground">
              (base {result.baseScore.toFixed(1)}, peg multiplier applied)
            </span>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify types compile**
- [ ] **Step 4: Commit**

```bash
git add src/components/methodology/safety-score-calculator.tsx
git commit -m "feat: add interactive Safety Score Calculator for methodology page"
```

### Task E2: Integrate calculator into methodology page

**Files:**
- Modify: `src/app/methodology/sections/core-sections.tsx`

- [ ] **Step 1: Read the Safety Scores section in core-sections.tsx**

Find the `safety-scores-methodology` section. Identify where to insert the calculator (after the "Worked example" disclosure, before or inside the "Technical details" disclosure).

- [ ] **Step 2: Add dynamic import of SafetyScoreCalculator**

```tsx
const SafetyScoreCalculator = dynamic(
  () => import("@/components/methodology/safety-score-calculator").then((m) => m.SafetyScoreCalculator),
  { loading: () => <Skeleton className="h-[200px] rounded-2xl" /> },
);
```

- [ ] **Step 3: Insert the calculator after the worked example in the Safety Scores section**

```tsx
{/* After WorkedExample, before MethodologyDetails */}
<SafetyScoreCalculator />
```

- [ ] **Step 4: Verify in dev**

Run: `npm run dev` → `/methodology` → scroll to Safety Scores → sliders should compute grade.

- [ ] **Step 5: Commit**

```bash
git add src/app/methodology/sections/core-sections.tsx src/components/methodology/safety-score-calculator.tsx
git commit -m "feat: integrate interactive score calculator into methodology page"
```

---

## Workstream F: Normalization & Polish Pass

**Problem:** Several one-off values bypass the design token system. These are low-severity but compound into subtle visual inconsistency.

### Task F1: Normalize SiteHeader metric pill color

**Files:**
- Modify: `src/components/site-header.tsx:17`

- [ ] **Step 1: Replace raw OKLCh text color with semantic token**

In `METRIC_PILL_CLASS` (line 17), replace `text-[oklch(0.43_0.01_255)]` with `text-muted-foreground`. (Note: `text-secondary` maps to `--color-secondary` which is a background color, not a text color. The semantic text token `--text-secondary` is wired as `--muted-foreground` in the design system.)

- [ ] **Step 2: Verify visual appearance matches**
- [ ] **Step 3: Commit**

```bash
git add src/components/site-header.tsx
git commit -m "fix: normalize SiteHeader pill text color to semantic token"
```

### Task F2: Normalize KPI bar trend colors

**Files:**
- Modify: `src/components/kpi-bar.tsx:32-34`

- [ ] **Step 1: Replace Tailwind color classes with severity tokens**

```tsx
function trendTextClass(value: number): string {
  if (value > 0) return "text-[var(--severity-healthy)]";
  if (value < 0) return "text-[var(--severity-severe)]";
  return "text-muted-foreground";
}
```

- [ ] **Step 2: Verify green/red tones match existing palette**
- [ ] **Step 3: Commit**

```bash
git add src/components/kpi-bar.tsx
git commit -m "fix: normalize KPI trend colors to severity tokens"
```

### Task F3: Normalize mobile header shadow

**Files:**
- Modify: `src/components/header.tsx:53`

- [ ] **Step 1: Replace inline OKLCh shadow with elevation token**

Replace `shadow-[0_6px_20px_oklch(0_0_0_/0.08)]` with an inline style instead: `style={{ boxShadow: "var(--elevation-rest)" }}` and remove the `shadow-[...]` class. Reason: `--elevation-rest` is a multi-shadow string with commas that may confuse Tailwind's arbitrary value parser.

- [ ] **Step 2: Verify header shadow appearance in both themes**
- [ ] **Step 3: Commit**

```bash
git add src/components/header.tsx
git commit -m "fix: normalize mobile header shadow to elevation token"
```

### Task F4: Remove decorative sparklines from compare empty state

**Files:**
- Modify: `src/components/compare-empty-state.tsx:59-64`

- [ ] **Step 1: Read the ComparePreview component (lines 16-107)**

- [ ] **Step 2: Replace fake chart bars with dashed-outline placeholders**

Replace the colored bar divs (lines 59-64) with:

```tsx
<div className="flex h-24 items-end gap-2">
  <div className="h-full flex-1 rounded-lg border-2 border-dashed border-border/40" />
</div>
```

This signals "chart will go here" without using decorative non-semantic colors.

- [ ] **Step 3: Verify visual appearance**
- [ ] **Step 4: Commit**

```bash
git add src/components/compare-empty-state.tsx
git commit -m "fix: replace decorative sparklines in compare empty state with dashed placeholders"
```

### Task F5: Deduplicate footer responsive blocks

**Files:**
- Modify: `src/components/footer.tsx:78-125`

- [ ] **Step 1: Read current footer duplication pattern**

Lines 78-96 (mobile category links) and 98-109 (desktop category links) render the same `CATEGORY_LINKS`. Lines 110-115 (desktop privacy) and 118-124 (mobile privacy) duplicate the disclaimer.

- [ ] **Step 2: Unify category links into a single block with responsive classes**

```tsx
<nav
  aria-label="Browse by category"
  className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground"
>
  {CATEGORY_LINKS.map((cat) => (
    <Link
      key={cat.href}
      href={cat.href}
      className="pharos-focus-ring hover:text-foreground transition-colors"
    >
      {cat.label}
    </Link>
  ))}
</nav>
```

Keep the mobile `<details>` disclosure pattern (it's a deliberate UX optimization that reduces visual clutter on small screens). Only deduplicate the desktop category links block and the privacy/disclaimer blocks. The goal is to remove DOM duplication for screen readers while preserving the mobile-friendly progressive disclosure.

- [ ] **Step 3: Unify privacy/disclaimer into a single responsive block**

```tsx
<div className="flex flex-wrap items-center justify-between gap-4 border-t border-border/50 pt-4">
  <nav aria-label="Browse by category" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
    {CATEGORY_LINKS.map((cat) => (
      <Link key={cat.href} href={cat.href} className="pharos-focus-ring hover:text-foreground transition-colors">
        {cat.label}
      </Link>
    ))}
  </nav>
  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
    <Link href="/privacy/" className="pharos-focus-ring rounded-sm hover:text-foreground">Privacy</Link>
    <p>Not financial advice. Data is provided as-is for informational purposes only.</p>
  </div>
</div>
```

- [ ] **Step 4: Verify mobile and desktop rendering**
- [ ] **Step 5: Run merge gate**

Run: `npm run test:merge-gate`

- [ ] **Step 6: Commit**

```bash
git add src/components/footer.tsx
git commit -m "refactor: deduplicate footer responsive blocks into single unified markup"
```

---

## Workstream G: PSI Regime Context Bar

**Problem:** PSI defines 6 named condition bands — Pharos's single most original intellectual contribution. But it's only visible in the KPI bar on the homepage. Users navigating other pages have no ambient awareness of the current market regime.

**Approach:** Add a persistent 3px-tall full-bleed bar at the very top of every page, colored by the current PSI band. In calm states (BEDROCK/STEADY), it's a subtle green/teal — barely noticeable. In elevated states (TREMOR+), it shifts to amber/orange/red and gains a slow pulse. On hover/tap, it expands to show a one-line context strip with the current PSI state.

**Design principles:**
- Ambient, not intrusive — the bar is felt, not read
- Color transition is slow (600ms) so users notice regime shifts
- Pulse animation only in FRACTURE+ bands (matching `PSI_PULSE_DURATION`)
- Mobile: tap to expand, tap again to collapse
- When PSI data is loading or unavailable, the bar is transparent (invisible)

### Task G1: Create RegimeBar client component

**Files:**
- Create: `src/components/regime-bar.tsx`

- [ ] **Step 1: Create the RegimeBar component**

```tsx
// src/components/regime-bar.tsx
"use client";

import { useState } from "react";
import { useStabilityIndex } from "@/hooks/api-hooks";
import { PSI_HEX_COLORS, type ConditionBand } from "@shared/lib/psi-colors";
import { cn } from "@/lib/utils";

/** Persistent 3px bar at the top of every page, colored by current PSI band. */
export function RegimeBar() {
  const { data: psiData } = useStabilityIndex();
  const [expanded, setExpanded] = useState(false);

  const current = psiData?.current;
  if (!current) return null;

  const band = (current.avg24hBand ?? current.band) as ConditionBand;
  const score = current.avg24h ?? current.score;
  const color = PSI_HEX_COLORS[band];
  const isElevated = band === "FRACTURE" || band === "CRISIS" || band === "MELTDOWN";

  // Dark text for BEDROCK/STEADY (green/teal bg + white fails WCAG contrast)
  const useDarkText = band === "BEDROCK" || band === "STEADY";

  // Walk history to compute days in current band
  const daysInBand = (() => {
    const history = psiData?.history;
    if (!history?.length) return null;
    let count = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].band === band) count++;
      else break;
    }
    return count || null;
  })();

  return (
    <div
      className={cn(
        "relative z-[60] w-full cursor-pointer select-none overflow-hidden",
        "transition-[background-color] duration-[600ms] ease-out",
        isElevated && "animate-[pharos-regime-pulse_1.5s_ease-in-out_infinite]",
      )}
      style={{ backgroundColor: color }}
      onClick={() => setExpanded((prev) => !prev)}
      role="status"
      aria-label={`Market regime: ${band}, PSI ${Math.round(score)}`}
    >
      {/* Use grid-template-rows for smooth expand/collapse (height:auto can't transition) */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className={cn(
            "flex items-center justify-center gap-3 px-4 py-1.5 text-[11px] font-mono tabular-nums",
            useDarkText ? "text-gray-900/90" : "text-white/90",
          )}>
            <span className="font-semibold tracking-wide">{band}</span>
            {daysInBand && <span>for {daysInBand}d</span>}
            <span className={useDarkText ? "text-gray-900/50" : "text-white/60"}>·</span>
            <span>PSI {Math.round(score)}</span>
            <span className={useDarkText ? "text-gray-900/50" : "text-white/60"}>·</span>
            <span>
              sev {current.components.severity.toFixed(1)} · breadth{" "}
              {current.components.breadth.toFixed(1)}
              {current.components.stressBreadth != null &&
                ` · stress ${current.components.stressBreadth.toFixed(1)}`}
              {" "}· trend {current.components.trend > 0 ? "+" : ""}
              {current.components.trend.toFixed(1)}
            </span>
          </div>
        </div>
      </div>
      {/* Collapsed minimum: 3px colored bar via min-height on the outer div */}
      {!expanded && <div className="h-[3px]" />}
    </div>
  );
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/components/regime-bar.tsx
git commit -m "feat: add PSI Regime Context Bar component — ambient market state indicator"
```

### Task G2: Add regime-pulse animation to globals.css

**Files:**
- Modify: `src/app/globals.css`

- [ ] **Step 1: Add the regime pulse keyframe**

Add to the `@keyframes` section in `globals.css`:

```css
@keyframes pharos-regime-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}
```

This is a subtle opacity pulse — not a color change. The bar dims slightly and returns, creating an ambient "breathing" effect that signals elevated state without being distracting.

- [ ] **Step 2: Commit**

```bash
git add src/app/globals.css
git commit -m "feat: add regime-pulse keyframe animation for elevated PSI bands"
```

### Task G3: Mount RegimeBar in root layout

**Files:**
- Modify: `src/app/layout.tsx:109-110`

- [ ] **Step 1: Add RegimeBar to the layout**

The RegimeBar should be the very first visual element after the skip-link, before `<Header />`. It must be inside `<Providers>` (to access QueryClientProvider for `useStabilityIndex()`).

In `layout.tsx`, between `<Providers>` (line 109) and `<Header />` (line 110):

```tsx
<Providers>
  <RegimeBar />
  <Header />
  {/* ... rest unchanged ... */}
```

Add the import: `import { RegimeBar } from "@/components/regime-bar";`

- [ ] **Step 2: Verify the bar renders**

Run: `npm run dev` → check homepage. A thin green/teal bar should appear at the very top of the viewport. Clicking it should expand to show the PSI context strip.

- [ ] **Step 3: Verify it works on mobile**

The `<Header />` component is `md:hidden sticky top-0` — the RegimeBar must sit above it. Since RegimeBar is rendered before Header in the DOM and is not sticky, it will scroll away on mobile (which is fine — the 3px bar is meant to be seen on page load, not permanently occupying mobile space).

If sticky behavior is desired on desktop: add `sticky top-0` to the RegimeBar wrapper. But for v1, non-sticky is cleaner.

- [ ] **Step 4: Commit**

```bash
git add src/app/layout.tsx
git commit -m "feat: mount PSI Regime Context Bar in root layout — visible on every page"
```

---

## Workstream H: Confidence Typography

**Problem:** Pharos computes price confidence levels (high, single-source, low, fallback) but this signal is only visible inside the Price Transparency card on detail pages. On the homepage table and in KPI displays, a $1.0002 price from 6 agreeing sources looks identical to a $1.0002 price from a single stale fallback source.

**Approach:** Encode confidence into the visual weight of price numbers — full opacity for high confidence, reduced opacity + dashed underline for lower confidence. No extra text, no extra pixels. The information is communicated by *subtracting* visual weight.

**Confidence levels** (from `shared/types/core.ts:435`):
- `"high"` → full rendering (no change)
- `"single-source"` → 75% opacity + subtle dashed underline
- `"low"` → 60% opacity + dashed underline
- `"fallback"` → 50% opacity + dashed underline + italic

**Where it applies:** Price display in the homepage stablecoin table, and the hero price on the detail page. NOT on safety scores or PSI (those always have known confidence).

### Task H1: Create confidence-text utility classes

**Files:**
- Modify: `src/app/globals.css`

- [ ] **Step 1: Add confidence utility classes**

Add to `globals.css` in the `@layer components` block:

```css
/* Confidence typography — visual weight reflects data confidence */
.pharos-confidence-high {
  /* No modification — full rendering is the default */
}
.pharos-confidence-single-source {
  opacity: 0.78;
  text-decoration: underline;
  text-decoration-style: dashed;
  text-decoration-color: var(--border-default);
  text-underline-offset: 3px;
  text-decoration-thickness: 1px;
}
.pharos-confidence-low {
  opacity: 0.62;
  text-decoration: underline;
  text-decoration-style: dashed;
  text-decoration-color: var(--border-strong);
  text-underline-offset: 3px;
  text-decoration-thickness: 1px;
}
.pharos-confidence-fallback {
  opacity: 0.50;
  text-decoration: underline;
  text-decoration-style: dashed;
  text-decoration-color: var(--border-strong);
  text-underline-offset: 3px;
  text-decoration-thickness: 1px;
  font-style: italic;
}
```

- [ ] **Step 2: Create a helper function to map confidence to class**

Create a dedicated file:

```tsx
// src/lib/confidence.ts

import type { PriceConfidence } from "@shared/types";

const CONFIDENCE_CLASSES: Record<PriceConfidence, string> = {
  high: "pharos-confidence-high",
  "single-source": "pharos-confidence-single-source",
  low: "pharos-confidence-low",
  fallback: "pharos-confidence-fallback",
};

/** Returns a CSS class that reduces visual weight for lower-confidence prices. */
export function confidenceClass(confidence: PriceConfidence | null | undefined): string {
  return confidence ? CONFIDENCE_CLASSES[confidence] ?? "" : "";
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/app/globals.css src/lib/confidence.ts
git commit -m "feat: add confidence typography utility classes — visual weight reflects data quality"
```

### Task H2: Apply confidence typography to homepage stablecoin table

**Files:**
- Modify: `src/components/stablecoin-table.tsx` — the price column cell renderer

- [ ] **Step 1: Read the price column definition in stablecoin-table.tsx**

Find where the price value is rendered in the table row. It will be in a column definition or a cell renderer function. Look for `price` or `formatPrice` usage.

- [ ] **Step 2: Wrap the price text in a span with the confidence class**

```tsx
import { confidenceClass } from "@/lib/confidence";

// In the price cell renderer:
<span className={confidenceClass(coin.priceConfidence)}>
  {formattedPrice}
</span>
```

The `coin` object (from `StablecoinData` / `PegAssetBase`) already has `priceConfidence` available in the list API response.

- [ ] **Step 3: Verify visual result**

Run: `npm run dev` → homepage table. Most prices should be full opacity (high confidence). Any coins with lower confidence should appear slightly faded with a dashed underline — immediately visible without adding any extra UI elements.

- [ ] **Step 4: Commit**

```bash
git add src/components/stablecoin-table.tsx
git commit -m "feat: apply confidence typography to homepage price column"
```

### Task H3: Apply confidence typography to detail page hero price

**Files:**
- Modify: `src/components/stablecoin-detail/hero-card.tsx` — the price display

- [ ] **Step 1: Read hero-card.tsx to find the price rendering location**

Read `src/components/stablecoin-detail/hero-card.tsx` lines 130-190. Find where `coinData.price` is formatted and displayed.

- [ ] **Step 2: Wrap the price text with confidence class**

```tsx
import { confidenceClass } from "@/lib/confidence";

// In the price display:
<span className={confidenceClass(coinData.priceConfidence)}>
  {formattedPrice}
</span>
```

- [ ] **Step 3: Verify visual result**

Run: `npm run dev` → `/stablecoin/usdt-tether/` → hero price should be full opacity (USDT has high confidence). Check a lower-confidence coin to verify the effect.

- [ ] **Step 4: Commit**

```bash
git add src/components/stablecoin-detail/hero-card.tsx
git commit -m "feat: apply confidence typography to detail page hero price"
```

---

## Final Validation

### Task Z1: Full merge gate

- [ ] **Step 1: Run the complete merge gate**

Run: `npm run test:merge-gate`
Expected: All lint, typecheck, tests, and coverage pass.

- [ ] **Step 2: Visual spot-check key pages**

Run: `npm run dev` and verify in browser:
- **Every page**: thin PSI-colored regime bar at top of viewport
- **Regime bar hover/click**: expands to show band + score + components
- Homepage: table is hero, filters collapsed, search visible
- Homepage table: prices at varying confidence show different visual weight
- `/stablecoin/usdt-tether/`: visible server-rendered header; hero price full opacity (high confidence)
- `/depeg/`: red accent border visible, regime bar visible above header
- `/safety-scores/`: emerald accent visible
- `/methodology/`: interactive calculator works
- Any chart page: tooltips styled consistently
- Footer: no duplicate DOM blocks

- [ ] **Step 3: Commit any final fixes**

---

## Execution Order & Dependencies

```
Workstream A (tooltips)        — independent
Workstream B (detail SSR)      — independent
Workstream C (homepage)        — independent
Workstream D (accents)         — independent
Workstream E (methodology)     — independent
Workstream F (normalize)       — independent
Workstream G (regime bar)      — independent (needs G2 before G3)
Workstream H (confidence typo) — independent

All workstreams are independent. Recommended parallel execution:
  - Agent 1: Workstream A (6 tasks)
  - Agent 2: Workstream B (2 tasks) + Workstream D (3 tasks)
  - Agent 3: Workstream C (3 tasks) + Workstream G (3 tasks)
  - Agent 4: Workstream E (2 tasks) + Workstream H (3 tasks)
  - Agent 5: Workstream F (5 tasks)
  - Final: Task Z1 (merge gate)
```
