# UI Polish & Refinement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Systematically polish the Pharos stablecoin dashboard's visual consistency, typography, spacing, interactive states, and visual hierarchy across all pages.

**Architecture:** Component-first approach — polish shared components (Phase 1), then page-level sweep (Phase 2), then cross-cutting refinements (Phase 3). Changes cascade from shared components to all pages automatically.

**Tech Stack:** Next.js 16, React 19, Tailwind CSS v4, shadcn/ui components

**Verification:** `npm run build` after each task group. No test suite for CSS — visual correctness verified via build + type-check.

---

## Phase 1: Shared Component Polish (Tasks 1-3, parallelizable)

### Task 1: Typography Normalization

Replace all `text-[11px]` and `text-[10px]` with `text-xs` (12px) across the codebase. These custom pixel sizes serve the same role as `text-xs` but create inconsistency.

**Files to modify:**

| File | Lines | Change |
|------|-------|--------|
| `src/components/kpi-bar.tsx` | 26 | `text-[11px]` → `text-xs` |
| `src/components/category-stats.tsx` | 155, 166, 177 | `text-[11px]` → `text-xs` |
| `src/components/filter-bar.tsx` | 36 | `text-[10px]` → `text-xs` |
| `src/components/stablecoin-table.tsx` | 107 | `text-[10px]` → `text-xs` |
| `src/components/depeg-feed.tsx` | 63, 72, 81 | `text-[10px]` → `text-xs` |
| `src/components/cemetery-tombstones.tsx` | 301, 306 | `text-[10px]` → `text-xs` |
| `src/components/peg-heatmap.tsx` | 171, 172 | `text-[10px]` → `text-xs` |
| `src/components/dex-liquidity-card.tsx` | 182, 317, 389 | `text-[10px]` → `text-xs` |
| `src/components/cemetery-timeline.tsx` | 67, 111 | `text-[10px]` → `text-xs` |
| `src/components/sidebar.tsx` | 149, 164 | `text-[10px]` → `text-xs` |
| `src/components/market-pulse.tsx` | 67, 138, 192, 294 | `text-[11px]` → `text-xs` |
| `src/components/report-card-mini.tsx` | 49 | `text-[10px]` → `text-xs` |
| `src/app/safety-scores/client.tsx` | 211 | `text-[10px]` → `text-xs` |

**Step 1:** Read each file, find the exact `text-[11px]` or `text-[10px]` occurrences, replace with `text-xs`.

**Step 2:** Run `npm run build` to verify no breakage.

**Step 3:** Commit: `style: normalize typography — replace text-[11px]/text-[10px] with text-xs`

---

### Task 2: Table Component Polish

Update the shared table component and all table implementations for consistent hover states, cell padding, sticky headers, and empty states.

**Files to modify:**

| File | Change |
|------|--------|
| `src/components/ui/table.tsx` | TableRow: `hover:bg-muted/30` → `hover:bg-muted/40`; TableCell: `p-2` → `px-3 py-2`; TableHead: add `px-3` |
| `src/components/stablecoin-table.tsx` | Verify sticky header uses `bg-muted/80 backdrop-blur-sm`; empty state padding `py-8` → `py-12` |
| `src/components/liquidity-table.tsx` | Same sticky header normalization; empty state `py-8` → `py-12` |
| `src/components/blacklist-table.tsx` | Header bg `bg-muted/50` → `bg-muted/80 backdrop-blur-sm`; verify empty state consistency |

**Step 1:** Edit `src/components/ui/table.tsx`:
- In TableRow: change `hover:bg-muted/30` to `hover:bg-muted/40`
- In TableCell: change `p-2` to `px-3 py-2`
- In TableHead: ensure `px-3` padding matches TableCell

**Step 2:** Edit table implementations to normalize sticky headers to `bg-muted/80 backdrop-blur-sm` where they differ.

**Step 3:** Normalize empty state padding to `py-12` in stablecoin-table.tsx and liquidity-table.tsx.

**Step 4:** Run `npm run build` to verify.

**Step 5:** Commit: `style(tables): normalize hover states, cell padding, and empty states`

---

### Task 3: Interactive State Fixes

Add missing `transition-colors` and `focus-visible:ring` classes to interactive elements.

**Files to modify (missing transitions):**

| File | Line | Fix |
|------|------|-----|
| `src/components/report-card.tsx` | 166 | Add `transition-colors` to dependency link |
| `src/components/blacklist-table.tsx` | 192 | Add `transition-colors` to external link |
| `src/components/filter-bar.tsx` | 62 | Add `transition-colors` to clear button |
| `src/components/peg-heatmap.tsx` | 70 | Add `transition-colors` to button group item |
| `src/components/peg-heatmap.tsx` | 129 | Add `transition-colors` to clear button |
| `src/components/page-error.tsx` | 19 | Add `transition-colors` to back link |
| `src/components/coin-selector.tsx` | 208 | Add `transition-colors` to dropdown items |

**Files to modify (missing focus rings):**

| File | Line | Fix |
|------|------|-----|
| `src/components/detail-section-nav.tsx` | 74 | Add `focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50` |
| `src/components/sidebar.tsx` | 83-96 | Add focus ring to theme toggle button |
| `src/components/contract-addresses.tsx` | 36-43 | Add focus ring to copy button |
| `src/components/contract-addresses.tsx` | 75-82 | Add focus ring to chain selector buttons |
| `src/components/stablecoin-table.tsx` | 688, 696 | Add focus ring to clear search/filter buttons |

**Step 1:** Read each file, add the missing classes.

**Step 2:** Run `npm run build` to verify.

**Step 3:** Commit: `a11y: add missing transition-colors and focus-visible rings`

---

## Phase 2: Page-Level Polish (Tasks 4-6, parallelizable)

### Task 4: Homepage Hero Elevation

Refine the identity zone, KPI bar, and section transitions on the homepage.

**Files to modify:**

| File | Change |
|------|--------|
| `src/components/homepage-client.tsx` | Hero identity zone refinement; section label update; spacing normalization |
| `src/components/kpi-bar.tsx` | Soften dividers, tighten cell padding |

**Step 1:** Edit `src/components/homepage-client.tsx`:
- Identity zone (lines 36-43): Add subtle surface treatment — wrap the identity row in a container with `bg-muted/30 rounded-lg px-4 py-3` for a frosted panel effect
- Section heading "Dashboard Highlights" (line 119): Rename to "Live Indicators" to match the design
- Ensure `space-y-6` between identity zone → KPI bar → section content

**Step 2:** Edit `src/components/kpi-bar.tsx`:
- Soften grid dividers: `divide-border` → `divide-border/50`
- Tighten cell padding if needed

**Step 3:** Run `npm run build` to verify.

**Step 4:** Commit: `style(homepage): elevate hero identity zone and refine KPI bar`

---

### Task 5: Card Container Refinement

Add hover elevation to clickable cards and ensure footer link consistency.

**Files to modify:**

| File | Change |
|------|--------|
| `src/components/report-card-mini.tsx` | Add `hover:shadow-md transition-shadow duration-150` to Card; add `active:scale-[0.995] transition-transform` to Link wrapper |
| `src/components/liquidity-summary.tsx` | Verify footer link uses `text-xs text-muted-foreground hover:text-foreground transition-colors` |
| `src/components/blacklist-summary.tsx` | Same footer link verification |
| `src/components/cemetery-summary.tsx` | Same footer link verification |
| `src/components/report-cards-summary.tsx` | Same footer link verification |
| `src/components/stability-index-summary.tsx` | Same footer link verification |
| `src/components/digest-archive-summary.tsx` | Same footer link verification |

**Step 1:** Edit `report-card-mini.tsx` to add hover elevation and press feedback on the Card element.

**Step 2:** Verify all 6 summary card footer links are consistent (they appear to already be — confirm and fix any that diverge).

**Step 3:** Run `npm run build` to verify.

**Step 4:** Commit: `style(cards): add hover elevation to clickable cards`

---

### Task 6: Chart Animation Consistency

Add `animate-in fade-in duration-300` to charts that currently pop in without transition.

**Files to modify:**

| File | Change |
|------|--------|
| `src/components/mcap-chart.tsx` | Add `animate-in fade-in duration-300` to Card wrapper |
| `src/components/blacklist-chart.tsx` | Add `animate-in fade-in duration-300` to Card wrapper |
| `src/components/scroll-to-top.tsx` | Add `duration-300 shadow-md` to Button classes |

**Step 1:** Read each chart file, add animation classes to the outermost wrapper that renders when data is present.

**Step 2:** Edit scroll-to-top to add explicit `duration-300` and `shadow-md`.

**Step 3:** Run `npm run build` to verify.

**Step 4:** Commit: `style: add consistent fade-in animation to charts and scroll-to-top`

---

## Phase 3: Cross-Cutting Refinements (Tasks 7-9, sequential)

### Task 7: Spacing Normalization

Normalize grid gaps, section margins, and page padding across all pages.

**Files to modify:**

| File | Change |
|------|--------|
| `src/components/homepage-client.tsx` | Verify all grids use `gap-3 sm:gap-5`; all h2 use `mb-4` |
| `src/components/category-stats.tsx` | Verify grid uses `gap-3 sm:gap-5` |
| `src/components/blacklist-stats.tsx` | Verify grid uses `gap-3 sm:gap-5` |

**Step 1:** Read each file and normalize:
- All card grids: `gap-3 sm:gap-5`
- All section h2 headings: `mb-4`
- Verify page-level spacing uses `space-y-6`

**Step 2:** Run `npm run build` to verify.

**Step 3:** Commit: `style: normalize spacing across grids and section headings`

---

### Task 8: Visual Hierarchy Through Restraint

Mute secondary visual elements to improve data prominence.

**Files to modify:**

| File | Change |
|------|--------|
| `src/components/kpi-bar.tsx` | Soften structural borders: dividers already handled in Task 4 |
| `src/components/homepage-client.tsx` | Verify label/value prominence ratio |
| Various table headers | Ensure header text uses `text-muted-foreground` not `text-foreground` |
| `src/components/market-pulse.tsx` | Section labels should be clearly subordinate to data values |

**Step 1:** Read key components. For each, assess whether structural elements (borders, labels, dividers) compete visually with data values. Where they do:
- Lighten border opacity (`border-border` → `border-border/50` for non-accent borders)
- Reduce label weight where it matches value weight
- Ensure values use `font-semibold` or `font-bold` while labels stay `font-medium` or `font-normal`

**Step 2:** Run `npm run build` to verify.

**Step 3:** Commit: `style: improve visual hierarchy — mute secondary elements`

---

### Task 9: State Parity & Final Polish

Verify all changes work in both light/dark themes. Fix skeleton dimension mismatches.

**Files to check:**

| File | Check |
|------|-------|
| `src/components/kpi-bar.tsx` | Skeleton dimensions match loaded KPI cells |
| `src/components/liquidity-summary.tsx` | Loading skeleton height matches loaded content |
| `src/components/blacklist-summary.tsx` | Same check |
| `src/components/stability-index-summary.tsx` | Same check |
| `src/components/report-cards-summary.tsx` | Same check |
| `src/components/digest-archive-summary.tsx` | Same check |
| `src/components/ui/table.tsx` | Verify `hover:bg-muted/40` is visible in dark mode |

**Step 1:** Read each file's loading/skeleton state and compare dimensions to the loaded state. Fix mismatches.

**Step 2:** Run `npm run build` to verify.

**Step 3:** Commit: `style: fix skeleton dimensions and verify dark mode parity`

---

## Phase 4: Final Verification

### Task 10: Build & Type-Check

**Step 1:** Run `npm run build` — must pass with zero errors.

**Step 2:** If build fails, fix issues and re-run.

**Step 3:** If all passes, the implementation is complete.

---

## Task Dependency Graph

```
Phase 1 (parallel):  Task 1 ──┐
                     Task 2 ──┼── All must pass build
                     Task 3 ──┘
                                │
Phase 2 (parallel):  Task 4 ──┐
                     Task 5 ──┼── All must pass build
                     Task 6 ──┘
                                │
Phase 3 (sequential): Task 7 → Task 8 → Task 9
                                │
Phase 4:             Task 10 (final build verification)
```

Tasks within the same phase can run in parallel (different files). Tasks across phases are sequential.
