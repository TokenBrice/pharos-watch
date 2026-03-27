# Yield Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface multi-source yield data through search, a source explorer sheet, multi-source chart overlay, URL-persisted source selection, delta indicators, and improved source navigation on the detail page.

**Architecture:** All data comes from existing `yield-rankings` and `yield-history` API endpoints — no new backend work. The leaderboard gets a search filter + source explorer sheet. The detail page gets toggleable source pills with multi-line chart overlay, URL-persisted source selection, a sortable source table with delta indicators, and source count pill. One new component file (`yield-source-sheet.tsx`), three modified files.

**Enhancements beyond original spec:**
1. **Multi-source chart overlay (detail page):** Source pills are toggleable (multi-select), rendering overlaid APY lines on the same chart for visual comparison. Up to 4 sources can be active simultaneously.
2. **URL-persisted source selection (detail page):** Selected sources stored in `?sources=` query param via `useSearchParams` + shallow `router.replace`, enabling shareable/bookmarkable source views.
3. **Delta indicators (source table + sheet):** Each alt source shows a colored delta vs best source APY (e.g., `−1.2%` in muted red, `+0.3%` in green) for instant opportunity-cost assessment.

**Tech Stack:** React 19, shadcn/ui (Sheet, Command), TanStack Query (existing hooks), Tailwind CSS v4, Recharts (existing `YieldHistoryChart`)

**Spec:** `docs/superpowers/specs/2026-03-26-yield-navigation-design.md`

---

### Task 1: Install shadcn Command component

The search combobox requires the `Command` component which doesn't exist yet in `src/components/ui/`.

**Files:**
- Create: `src/components/ui/command.tsx` (via shadcn CLI)

- [ ] **Step 1: Install the Command component**

Run:
```bash
npx shadcn@latest add command
```

This installs `cmdk` as a dependency and creates `src/components/ui/command.tsx`.

- [ ] **Step 2: Verify the component was created**

Run:
```bash
ls src/components/ui/command.tsx && npm run build 2>&1 | tail -5
```

Expected: file exists, build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/command.tsx package.json package-lock.json
git commit -m "chore: add shadcn Command component for yield search"
```

---

### Task 2: Add `sourceCount` sort key to yield table logic

The Sources column needs to be sortable. Add the sort key before touching the leaderboard.

**Files:**
- Modify: `src/components/yield-table-logic.ts`

- [ ] **Step 1: Add `sourceCount` to `YieldTableSortKey` and comparator**

In `src/components/yield-table-logic.ts`, change the type and add the accessor:

```typescript
export type YieldTableSortKey = "pys" | "apy30d" | "safetyScore" | "tvl" | "yieldStability" | "yieldType" | "sourceCount";

export const compareYieldRows: (
  a: YieldRanking,
  b: YieldRanking,
  sort: TableSortState<YieldTableSortKey>,
) => number = createTableComparator<YieldTableSortKey, YieldRanking>({
  pys: (r) => r.pharosYieldScore ?? -1,
  apy30d: (r) => r.apy30d,
  safetyScore: (r) => r.safetyScore ?? -1,
  tvl: (r) => r.sourceTvlUsd ?? 0,
  yieldStability: (r) => r.yieldStability ?? -1,
  yieldType: (r) => r.yieldType,
  sourceCount: (r) => 1 + (r.altSources?.length ?? 0),
});
```

- [ ] **Step 2: Verify types compile**

Run:
```bash
npm run build 2>&1 | tail -5
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/yield-table-logic.ts
git commit -m "feat(yield): add sourceCount sort key for Sources column"
```

---

### Task 3: Add `hideSourceSelector` and multi-source overlay support to `YieldHistoryChart`

The sheet and detail page will use external source pills, so the chart's internal source dropdown needs to be hideable. Additionally, the detail page needs multi-source overlay — rendering multiple APY lines on the same chart for visual comparison.

**Files:**
- Modify: `src/components/yield-history-chart.tsx`

- [ ] **Step 1: Add new props to `YieldHistoryChartProps`**

Add to the interface:

```typescript
  hideSourceSelector?: boolean;
  externalSourceKey?: string;          // single source (sheet)
  externalSourceKeys?: string[];       // multi-source overlay (detail page)
```

- [ ] **Step 2: Thread the props through the component**

When `externalSourceKey` is provided, use it instead of internal state. When `externalSourceKeys` (array) is provided, fetch and render multiple lines.

For multi-source overlay:
- Use `externalSourceKeys` to fire multiple `useYieldHistory` calls (one per selected source)
- Render each as a separate Recharts `<Line>` with a distinct color from a fixed palette
- The primary/first source uses the existing thick line style; overlay sources use thinner dashed lines
- Legend labels show source names

Multi-source color palette (max 4 sources):
```typescript
const OVERLAY_COLORS = ["hsl(var(--chart-1))", "hsl(var(--chart-2))", "hsl(var(--chart-3))", "hsl(var(--chart-4))"];
```

- [ ] **Step 3: Pass `hideSourceSelector` to `Controls`**

Add `hideSourceSelector` to both `Controls` call sites. Wrap the source selector `<label>` block:

```typescript
        {availableSources.length > 0 && !hideSourceSelector ? (
          <label>...</label>
        ) : null}
```

- [ ] **Step 4: Verify build**

Run:
```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add src/components/yield-history-chart.tsx
git commit -m "feat(yield): add hideSourceSelector, externalSourceKey, and multi-source overlay to YieldHistoryChart"
```

---

### Task 4: Create `YieldSourceSheet` component

The main new component — a right-side sheet showing all yield sources for a stablecoin.

**Files:**
- Create: `src/components/yield-source-sheet.tsx`

- [ ] **Step 1: Create the component file**

Create `src/components/yield-source-sheet.tsx`:

```tsx
"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from "@/components/ui/sheet";
import { YieldHistoryChart } from "@/components/yield-history-chart";
import { YieldSourceLink } from "@/components/yield-source-link";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import type { YieldRanking } from "@shared/types";

interface YieldSourceSheetProps {
  ranking: YieldRanking | null;
  logo: string | undefined;
  riskFreeRate: number;
  medianApy: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function YieldSourceSheet({
  ranking,
  logo,
  riskFreeRate,
  medianApy,
  open,
  onOpenChange,
}: YieldSourceSheetProps) {
  const [selectedSourceKey, setSelectedSourceKey] = useState<string | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);

  // Reset source selection when sheet opens for a different coin
  const prevIdRef = useRef<string | null>(null);
  if (ranking && ranking.id !== prevIdRef.current) {
    prevIdRef.current = ranking.id;
    setSelectedSourceKey(null);
  }

  if (!ranking) return null;

  const bestSourceKey = ranking.provenance?.sourceKey ?? null;
  const effectiveSourceKey = selectedSourceKey ?? bestSourceKey ?? "best";
  const totalSources = 1 + (ranking.altSources?.length ?? 0);

  const allSources = [
    ...(bestSourceKey
      ? [{ sourceKey: bestSourceKey, yieldSource: ranking.yieldSource }]
      : []),
    ...(ranking.altSources ?? []).map((s) => ({
      sourceKey: s.sourceKey,
      yieldSource: s.yieldSource,
    })),
  ];

  const handleSourceClick = (sourceKey: string) => {
    setSelectedSourceKey(sourceKey);
    chartRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-md overflow-y-auto"
      >
        <SheetHeader>
          <div className="flex items-center gap-3">
            <StablecoinLogo src={logo} name={ranking.name} size={32} />
            <div>
              <SheetTitle>{ranking.name}</SheetTitle>
              <SheetDescription>
                {totalSources} yield source{totalSources !== 1 ? "s" : ""}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="space-y-4 px-4">
          {/* Best source card */}
          <div className="rounded-xl border border-border/60 border-l-[3px] border-l-emerald-500 bg-background/55 px-3 py-2.5">
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Best Source
            </p>
            <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-2">
              <div className="flex items-center gap-2">
                <YieldSourceLink href={ranking.yieldSourceUrl} className="text-sm font-medium text-foreground">
                  {ranking.yieldSource}
                </YieldSourceLink>
                <Badge
                  variant="outline"
                  className={cn("text-xs", YIELD_TYPE_STYLES[ranking.yieldType]?.badge ?? "")}
                >
                  {YIELD_TYPE_LABELS[ranking.yieldType] ?? ranking.yieldType}
                </Badge>
              </div>
              <span className="font-mono text-lg tabular-nums text-foreground">
                {formatPercent(ranking.apy30d)}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              {ranking.sourceTvlUsd !== null && (
                <span>TVL {formatCurrency(ranking.sourceTvlUsd)}</span>
              )}
              {ranking.provenance?.confidenceTier && (
                <span className="rounded-full border border-border/60 bg-muted/20 px-1.5 py-0.5 text-[10px]">
                  {ranking.provenance.confidenceTier}
                </span>
              )}
            </div>
          </div>

          {/* Alternative sources */}
          {(ranking.altSources?.length ?? 0) > 0 && (
            <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
              <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Alternative Sources
              </p>
              <div className="mt-2 space-y-1.5">
                {ranking.altSources.map((source) => {
                  const isSelected = effectiveSourceKey === source.sourceKey;
                  return (
                    <button
                      key={source.sourceKey}
                      type="button"
                      onClick={() => handleSourceClick(source.sourceKey)}
                      className={cn(
                        "pharos-focus-ring flex w-full items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/55 px-3 py-2 text-left transition-colors hover:bg-muted/30",
                        isSelected && "ring-1 ring-primary/40",
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm text-foreground">{source.yieldSource}</span>
                        <Badge
                          variant="outline"
                          className={cn("shrink-0 text-[10px]", YIELD_TYPE_STYLES[source.yieldType]?.badge ?? "")}
                        >
                          {YIELD_TYPE_LABELS[source.yieldType] ?? source.yieldType}
                        </Badge>
                      </div>
                      <div className="flex shrink-0 items-center gap-2 text-xs">
                        <span className="font-mono tabular-nums text-foreground">
                          {formatPercent(source.apy30d)}
                        </span>
                        {/* Delta vs best source */}
                        {(() => {
                          const delta = source.apy30d - ranking.apy30d;
                          const sign = delta >= 0 ? "+" : "";
                          return (
                            <span className={cn("font-mono tabular-nums text-[10px]", delta >= 0 ? "text-emerald-500" : "text-muted-foreground")}>
                              {sign}{formatPercent(delta)}
                            </span>
                          );
                        })()}
                        {source.sourceTvlUsd !== null && (
                          <span className="text-muted-foreground">
                            {formatCurrency(source.sourceTvlUsd)}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Inline history chart */}
          <div ref={chartRef} className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              Showing:{" "}
              <span className="font-medium text-foreground">
                {allSources.find((s) => s.sourceKey === effectiveSourceKey)?.yieldSource ?? "Best source"}
              </span>
            </p>
            <YieldHistoryChart
              stablecoinId={ranking.id}
              benchmarkRate={ranking.benchmarkRate ?? riskFreeRate}
              benchmarkLabel={ranking.benchmarkLabel}
              benchmarkIsFallback={
                ranking.benchmarkSelectionMode === "fallback-usd" || ranking.benchmarkIsFallback
              }
              medianApy={medianApy}
              compact
              availableSources={allSources}
              hideSourceSelector
              externalSourceKey={effectiveSourceKey}
            />
          </div>
        </div>

        <SheetFooter>
          <Link
            href={`/stablecoin/${ranking.id}`}
            className="pharos-focus-ring text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => onOpenChange(false)}
          >
            View full dossier &rarr;
          </Link>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 2: Verify build**

Run:
```bash
npm run build 2>&1 | tail -5
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/yield-source-sheet.tsx
git commit -m "feat(yield): add YieldSourceSheet component for multi-source exploration"
```

---

### Task 5: Add search combobox and Sources column to leaderboard

Modify the leaderboard to add the search filter, Sources column, and sheet trigger.

**Files:**
- Modify: `src/components/yield-leaderboard.tsx`
- Modify: `src/components/interactive-table-row.tsx` (add `id` prop forwarding)

- [ ] **Step 1: Add imports**

Add at the top of `src/components/yield-leaderboard.tsx`:

```typescript
import { Search } from "lucide-react";
import { YieldSourceSheet } from "@/components/yield-source-sheet";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
```

- [ ] **Step 2: Add Sources column to `YIELD_COLUMNS`**

Insert after the `signals` column (before `expand`):

```typescript
  { id: "sources", label: "Sources", sortKey: "sourceCount", className: "hidden md:table-cell text-center", title: "Number of yield sources tracked" },
```

- [ ] **Step 3: Delete the `AltSourcesPopover` component**

Remove the entire `AltSourcesPopover` function (lines 57-116).

- [ ] **Step 4: Add state for search and sheet**

Inside `YieldLeaderboard`, after the existing state declarations (after line 133), add:

```typescript
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sheetRankingId, setSheetRankingId] = useState<string | null>(null);
  const sheetRanking = sheetRankingId ? rankings.find((r) => r.id === sheetRankingId) ?? null : null;
```

- [ ] **Step 5: Add search filtering**

After `warningFiltered` (line 139), add the search filter:

```typescript
  const searchFiltered = searchQuery.trim()
    ? warningFiltered.filter((r) => {
        const q = searchQuery.trim().toLowerCase();
        return r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q);
      })
    : warningFiltered;
```

Then change the `useSortedPaginatedTable` call to use `searchFiltered` instead of `warningFiltered`.

- [ ] **Step 6: Restructure the `topSlot`**

Replace the current `topSlot` content with the `flex flex-col` layout. The search combobox goes first, the type pills second:

```tsx
topSlot={
  <div className="flex flex-col gap-2 px-3 pt-3 mb-3">
    {/* Search combobox */}
    <Popover open={searchOpen} onOpenChange={setSearchOpen}>
      <PopoverTrigger asChild>
        <div className="relative max-w-xs">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchOpen(e.target.value.trim().length > 0);
            }}
            onFocus={() => { if (searchQuery.trim()) setSearchOpen(true); }}
            placeholder="Search stablecoin..."
            className="pharos-focus-ring w-full rounded-full border border-border/60 bg-background/60 py-1.5 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
        </div>
      </PopoverTrigger>
      {searchQuery.trim() && (
        <PopoverContent className="w-[280px] p-0" align="start" onOpenAutoFocus={(e) => e.preventDefault()}>
          <Command shouldFilter={false}>
            <CommandList>
              <CommandEmpty className="py-3 text-center text-xs text-muted-foreground">
                No matches
              </CommandEmpty>
              <CommandGroup>
                {warningFiltered
                  .filter((r) => {
                    const q = searchQuery.trim().toLowerCase();
                    return r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q);
                  })
                  .slice(0, 5)
                  .map((r) => (
                    <CommandItem
                      key={r.id}
                      value={r.id}
                      onSelect={() => {
                        setSearchQuery("");
                        setSearchOpen(false);
                        setExpandedId(r.id);
                        // Scroll to row after next render
                        requestAnimationFrame(() => {
                          document.getElementById(`yield-row-${r.id}`)?.scrollIntoView({
                            behavior: "smooth",
                            block: "center",
                          });
                        });
                      }}
                      className="flex items-center justify-between gap-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-medium">{r.symbol}</span>
                        <span className="text-xs text-muted-foreground">{r.name}</span>
                      </div>
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">
                        {formatPercent(r.apy30d)}
                      </span>
                    </CommandItem>
                  ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      )}
    </Popover>

    {/* Type filter pills */}
    <div className="flex flex-wrap items-center gap-2">
      {visibleLabels.map((label) => {
        const repType = (Object.entries(YIELD_TYPE_LABELS) as [YieldType, string][]).find(
          ([, l]) => l === label,
        )?.[0];
        return (
          <button
            key={label}
            type="button"
            onClick={() => {
              setActiveLabels((prev) => {
                const next = new Set(prev);
                if (next.has(label)) {
                  next.delete(label);
                } else {
                  next.add(label);
                }
                return next;
              });
            }}
            className={
              activeLabels.has(label)
                ? `pharos-focus-ring rounded-full border px-2 py-0.5 text-xs font-medium ${repType ? YIELD_TYPE_STYLES[repType].badge : ""}`
                : "pharos-focus-ring rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground"
            }
          >
            {label}
          </button>
        );
      })}
      <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={hideWarnings}
          onChange={(e) => setHideWarnings(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-border"
        />
        Hide warned
      </label>
    </div>
  </div>
}
```

- [ ] **Step 7: Add `id` forwarding to `InteractiveTableRow` and use it for scroll targeting**

`InteractiveTableRow` (in `src/components/interactive-table-row.tsx`) does NOT currently accept an `id` prop. It destructures only `{ onActivate, onHover, className, role, children }`. You need to add `id` to its interface and forward it to `TableRow`.

In `src/components/interactive-table-row.tsx`, add `id` to the interface and destructure:

```tsx
interface InteractiveTableRowProps {
  id?: string;
  onActivate: () => void;
  onHover?: () => void;
  className?: string;
  role?: React.AriaRole;
  children: React.ReactNode;
}

export function InteractiveTableRow({
  id,
  onActivate,
  onHover,
  className = "",
  role,
  children,
}: InteractiveTableRowProps) {
  return (
    <TableRow
      id={id}
      className={`cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none ${className}`}
      onClick={onActivate}
      // ... rest unchanged
```

`TableRow` accepts `React.ComponentProps<"tr">` which includes `id`, so this just works.

Then in the leaderboard, add the `id` to each row:

```tsx
<InteractiveTableRow
  id={`yield-row-${row.id}`}
  onActivate={() => setExpandedId((current) => (current === row.id ? null : row.id))}
  // ... rest unchanged
>
```

- [ ] **Step 8: Add the Sources cell and replace `AltSourcesPopover` usage**

In the Source column cell (around line 322-344), remove the `AltSourcesPopover` usage:

```tsx
{(row.altSources?.length ?? 0) > 0 && <AltSourcesPopover altSources={row.altSources} />}
```

Replace with nothing — the `+N` chip moves to the Sources column.

Add the Sources column cell after the Signals cell (before the expand cell):

```tsx
<TableCell className="hidden md:table-cell text-center">
  {1 + (row.altSources?.length ?? 0) > 1 ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setSheetRankingId(row.id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") e.stopPropagation();
      }}
      className="pharos-focus-ring inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      aria-label={`${1 + row.altSources.length} yield sources — open source explorer`}
    >
      {1 + row.altSources.length}
    </button>
  ) : (
    <span className="font-mono text-xs text-muted-foreground">1</span>
  )}
</TableCell>
```

- [ ] **Step 9: Add sheet trigger in expanded row for mobile**

In the expanded row content (around line 460 where `AltSourcesPopover` was used), replace with a sheet-opening button:

```tsx
{(row.altSources?.length ?? 0) > 0 ? (
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation();
      setSheetRankingId(row.id);
    }}
    className="pharos-focus-ring inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
    aria-label={`${1 + row.altSources.length} yield sources — open source explorer`}
  >
    +{row.altSources.length} sources
  </button>
) : null}
```

- [ ] **Step 10: Render the `YieldSourceSheet` at the bottom of the component**

Just before the closing `</TooltipProvider>`, add:

```tsx
      <YieldSourceSheet
        ranking={sheetRanking}
        logo={sheetRankingId ? logos[sheetRankingId] : undefined}
        riskFreeRate={riskFreeRate}
        medianApy={medianApy}
        open={sheetRankingId !== null}
        onOpenChange={(open) => { if (!open) setSheetRankingId(null); }}
      />
```

- [ ] **Step 11: Verify build and lint**

Run:
```bash
npm run build 2>&1 | tail -10 && npm run lint 2>&1 | tail -10
```

Expected: build and lint both pass.

- [ ] **Step 12: Commit**

```bash
git add src/components/yield-leaderboard.tsx src/components/interactive-table-row.tsx
git commit -m "feat(yield): add search combobox, Sources column, and source explorer sheet to leaderboard"
```

---

### Task 6: Add source count pill, multi-select source pills with overlay, URL-persisted selection, delta indicators, and sortable source table to detail page

Modify the yield detail section on `/stablecoin/[id]`.

**Files:**
- Modify: `src/components/yield-detail-section.tsx`

- [ ] **Step 1: Add the source count pill to the section header**

In `yield-detail-section.tsx`, in the `CardHeader` (around line 241), add a pill after the title:

```tsx
<div className="flex flex-wrap items-center justify-between gap-3">
  <div className="flex items-center gap-2">
    <CardTitle as="h2" id="yield-intelligence-heading" className={DETAIL_SECTION_TITLE_CLASS}>
      Yield Intelligence
    </CardTitle>
    {ranking.altSources.length > 0 && (
      <span className="rounded-full border border-border/60 bg-muted/20 px-2 py-0.5 text-xs font-mono text-muted-foreground">
        Sources ({1 + ranking.altSources.length})
      </span>
    )}
  </div>
  <span
    className={cn(
      "rounded-full border px-2 py-0.5 text-xs font-medium",
      YIELD_TYPE_STYLES[ranking.yieldType].badge,
    )}
  >
    {YIELD_TYPE_LABELS[ranking.yieldType]}
  </span>
</div>
```

- [ ] **Step 2: Add state for external source selection**

At the top of the rendering block (after `historySources` is defined, around line 232), add:

```typescript
  const [detailSourceKey, setDetailSourceKey] = useState<string>("best");
```

`useState` is NOT currently imported in this file. Change the existing React import from:

```typescript
import type { ReactNode } from "react";
```

to:

```typescript
import { useState, type ReactNode } from "react";
```

- [ ] **Step 3: Add source selector pills above the history chart**

Before the `YieldHistoryChart` in the history chart section (around line 289), add the pills:

```tsx
<div className="space-y-3">
  <p className="text-sm text-muted-foreground">
    APY trend against the current benchmark hurdle rate and peer median.
  </p>

  {/* Source selector pills */}
  {historySources.length > 1 && (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => setDetailSourceKey("best")}
        className={cn(
          "pharos-control-pill text-xs font-mono",
          detailSourceKey === "best" && "pharos-control-pill-active",
        )}
      >
        Best source
      </button>
      {historySources.map((source) => (
        <button
          key={source.sourceKey}
          type="button"
          onClick={() => setDetailSourceKey(source.sourceKey)}
          className={cn(
            "pharos-control-pill text-xs font-mono",
            detailSourceKey === source.sourceKey && "pharos-control-pill-active",
          )}
        >
          {source.yieldSource}
        </button>
      ))}
    </div>
  )}

  <YieldHistoryChart
    stablecoinId={stablecoinId}
    benchmarkRate={ranking.benchmarkRate ?? data?.riskFreeRate ?? 0}
    benchmarkLabel={ranking.benchmarkLabel}
    benchmarkIsFallback={ranking.benchmarkSelectionMode === "fallback-usd" || ranking.benchmarkIsFallback}
    medianApy={medianApy}
    availableSources={historySources}
    hideSourceSelector={historySources.length > 1}
    externalSourceKey={historySources.length > 1 ? detailSourceKey : undefined}
  />
</div>
```

- [ ] **Step 4: Replace alt-source card grid with sortable source table**

Replace the "Alternative Sources" section (lines 376-395) with:

```tsx
{ranking.altSources.length >= 2 ? (
  <AltSourceTable
    altSources={ranking.altSources}
    bestSourceKey={ranking.provenance?.sourceKey ?? null}
    onSelectSource={(sourceKey) => {
      setDetailSourceKey(sourceKey);
      document.getElementById("yield")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }}
    selectedSourceKey={detailSourceKey}
  />
) : ranking.altSources.length === 1 ? (
  <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Alternative Sources</p>
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {ranking.altSources.map((source) => (
        <div
          key={source.sourceKey}
          className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/55 px-3 py-2"
        >
          <YieldSourceLink href={source.yieldSourceUrl} className="max-w-full text-sm text-foreground">
            {source.yieldSource}
          </YieldSourceLink>
          <span className="font-mono text-sm tabular-nums text-muted-foreground">
            {formatPercent(source.currentApy)}
          </span>
        </div>
      ))}
    </div>
  </div>
) : null}
```

- [ ] **Step 5: Add the `AltSourceTable` component**

Add this component above the default export in the same file. First, update the imports at the top of the file:

1. Change the lucide import to include `BarChart3`:
```typescript
import { AlertTriangle, BarChart3, ChevronDown } from "lucide-react";
```

2. Add `AltYieldSource` to the shared types import. Currently the file does not import from `@shared/types` — add:
```typescript
import type { AltYieldSource } from "@shared/types";
```

Then add the component:

```tsx
function AltSourceTable({
  altSources,
  bestSourceKey,
  onSelectSource,
  selectedSourceKey,
}: {
  altSources: AltYieldSource[];
  bestSourceKey: string | null;
  onSelectSource: (sourceKey: string) => void;
  selectedSourceKey: string;
}) {
  const [sortField, setSortField] = useState<"apy" | "tvl">("apy");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const toggleSort = (field: "apy" | "tvl") => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const sorted = [...altSources].sort((a, b) => {
    const mul = sortDir === "asc" ? 1 : -1;
    if (sortField === "apy") return mul * (a.apy30d - b.apy30d);
    return mul * ((a.sourceTvlUsd ?? 0) - (b.sourceTvlUsd ?? 0));
  });

  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Alternative Sources
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/40 text-muted-foreground">
              <th className="pb-2 text-left font-medium">Source</th>
              <th className="pb-2 text-center font-medium">Type</th>
              <th
                className="cursor-pointer pb-2 text-right font-medium hover:text-foreground transition-colors"
                onClick={() => toggleSort("apy")}
              >
                APY 30d {sortField === "apy" ? (sortDir === "desc" ? "↓" : "↑") : ""}
              </th>
              <th
                className="cursor-pointer pb-2 text-right font-medium hover:text-foreground transition-colors"
                onClick={() => toggleSort("tvl")}
              >
                TVL {sortField === "tvl" ? (sortDir === "desc" ? "↓" : "↑") : ""}
              </th>
              <th className="pb-2 text-center font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((source) => {
              const isSelected = selectedSourceKey === source.sourceKey;
              const isBest = source.sourceKey === bestSourceKey;
              return (
                <tr
                  key={source.sourceKey}
                  className={cn(
                    "border-b border-border/30 last:border-0 transition-colors",
                    isSelected && "bg-primary/5",
                  )}
                >
                  <td className="py-2 pr-2">
                    <div className="flex items-center gap-1.5">
                      <YieldSourceLink href={source.yieldSourceUrl} className="text-foreground">
                        {source.yieldSource}
                      </YieldSourceLink>
                      {isBest && (
                        <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                          Best
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2 text-center">
                    <Badge
                      variant="outline"
                      className={cn("text-[10px]", YIELD_TYPE_STYLES[source.yieldType]?.badge ?? "")}
                    >
                      {YIELD_TYPE_LABELS[source.yieldType] ?? source.yieldType}
                    </Badge>
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums">
                    {formatPercent(source.apy30d)}
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums text-muted-foreground">
                    {source.sourceTvlUsd !== null ? formatCurrency(source.sourceTvlUsd) : "—"}
                  </td>
                  <td className="py-2 text-center">
                    <button
                      type="button"
                      onClick={() => onSelectSource(source.sourceKey)}
                      className="pharos-focus-ring inline-flex items-center rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                      aria-label={`Show ${source.yieldSource} on chart`}
                      title="Show on chart"
                    >
                      <BarChart3 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

Add the `BarChart3` import to the existing lucide import line:

```typescript
import { AlertTriangle, ChevronDown, BarChart3 } from "lucide-react";
```

Add `useState` to the React import if not already there.

- [ ] **Step 6: Verify build and lint**

Run:
```bash
npm run build 2>&1 | tail -10 && npm run lint 2>&1 | tail -10
```

Expected: build and lint pass.

- [ ] **Step 7: Commit**

```bash
git add src/components/yield-detail-section.tsx
git commit -m "feat(yield): add source count pill, source selector pills, and sortable source table to detail page"
```

---

### Task 7: End-to-end validation

Run the full merge gate to ensure nothing is broken.

**Files:** None (validation only)

- [ ] **Step 1: Run merge gate**

Run:
```bash
npm run test:merge-gate
```

Expected: all checks pass.

- [ ] **Step 2: Visual spot-check**

Start the dev server and verify:

```bash
npm run dev
```

Check in browser:
1. `/yield` — search filters the table, dropdown shows top 5, selecting scrolls + expands
2. `/yield` — Sources column shows counts, clicking opens the sheet
3. `/yield` — sheet shows best source, alt sources, chart updates when source clicked
4. `/yield` — mobile: expanded row has "+N sources" button opening the sheet
5. `/stablecoin/usdc` (or any coin with alt sources) — source pills above chart work, source table sorts

- [ ] **Step 3: Commit any fixes**

If any issues found, fix and commit individually.
