# Depeg Tracker Page Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a dedicated `/depeg` page that consolidates three homepage depeg components (DEWSSummary, PegHeatmap, DepegFeed) with new summary stats cards and a comprehensive peg data table.

**Architecture:** Server page.tsx handles metadata/SEO + dynamic client import. Client.tsx orchestrates three hooks (`usePegSummary`, `useStressSignals`, `useDepegEvents`) and distributes data to child components. Unified URL-persisted filter state shared between table and heatmap. Two new components: `DepegTrackerStats` (summary cards) and `DepegTrackerTable` (sortable/paginated table with smart default sort and row severity accents).

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS v4, shadcn/ui, TanStack Query

**Design doc:** `docs/plans/2026-03-01-depeg-tracker-page-design.md`

---

### Task 1: Add route to navigation

**Files:**
- Modify: `src/lib/nav-config.ts`

**Step 1: Add the Activity icon import**

In the import block at the top of `nav-config.ts`, add `Activity` to the lucide-react import:

```typescript
import {
  Activity,        // <-- add this
  LayoutDashboard,
  Droplets,
  // ... rest unchanged
```

**Step 2: Add Depeg Tracker to the Data group**

In the `NAV_GROUPS` array, find the `Data` group and add the new item after Liquidity:

```typescript
{
  label: "Data",
  items: [
    { href: "/liquidity", label: "Liquidity", icon: Droplets, description: "DEX liquidity analysis" },
    { href: "/depeg", label: "Depeg Tracker", icon: Activity, description: "Live peg monitoring & early warnings" },
    { href: "/blacklist", label: "Blacklist Tracker", icon: ShieldBan, description: "Frozen address events" },
  ],
},
```

**Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: no type errors

**Step 4: Commit**

```bash
git add src/lib/nav-config.ts
git commit -m "feat(nav): add Depeg Tracker to Data group"
```

---

### Task 2: Create page.tsx (server component)

**Files:**
- Create: `src/app/depeg/page.tsx`

**Step 1: Create the page file**

```typescript
import dynamic from "next/dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { Skeleton } from "@/components/ui/skeleton";

const DepegClient = dynamic(
  () => import("./client").then((m) => ({ default: m.DepegClient })),
  { loading: () => <Skeleton className="h-[400px] w-full rounded-xl" /> },
);

const depegDescription = `Live peg monitoring, deviation heatmaps, early warning scores, and depeg event tracking for ${TRACKED_STABLECOINS.length} stablecoins.`;

export const metadata: Metadata = {
  title: "Depeg Tracker: Live Peg Monitoring & Early Warnings",
  description: depegDescription,
  alternates: {
    canonical: "/depeg/",
  },
  openGraph: {
    title: "Depeg Tracker: Live Peg Monitoring & Early Warnings",
    description: depegDescription,
    url: "/depeg/",
  },
};

export default function DepegPage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Depeg Tracker" path="/depeg/" />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Depeg Tracker</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter">Depeg Tracker</h1>
        <p className="text-sm text-muted-foreground">
          Real-time peg monitoring across {TRACKED_STABLECOINS.length} stablecoins.
          Peg scores, DEWS early warning signals, live deviation heatmaps, and a
          full history of depeg events — all in one place.
        </p>
      </div>
      <DepegClient />
    </div>
  );
}
```

**Step 2: Create a stub client.tsx so the page compiles**

```typescript
"use client";

export function DepegClient() {
  return <div className="text-muted-foreground text-sm">Depeg Tracker loading...</div>;
}
```

**Step 3: Verify build**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 4: Commit**

```bash
git add src/app/depeg/
git commit -m "feat(depeg): scaffold page.tsx with metadata and stub client"
```

---

### Task 3: Create DepegTrackerStats component

**Files:**
- Create: `src/components/depeg-tracker-stats.tsx`

**Step 1: Write the stats component**

This mirrors the `LiquidityStats` card grid pattern. It receives the `PegSummaryStats` type from the peg-summary API response.

```typescript
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PegSummaryStats } from "@/lib/types";

interface DepegTrackerStatsProps {
  stats: PegSummaryStats;
}

export function DepegTrackerStats({ stats }: DepegTrackerStatsProps) {
  const eventDelta = stats.depegEventsToday - stats.depegEventsYesterday;
  const deltaLabel =
    eventDelta > 0 ? `+${eventDelta} vs yesterday` :
    eventDelta < 0 ? `${eventDelta} vs yesterday` :
    "same as yesterday";

  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-6">
      <Card className="rounded-xl border-l-[3px] border-l-red-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Active Depegs
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold font-mono tabular-nums">{stats.activeDepegCount}</p>
          <p className="text-xs text-muted-foreground">ongoing events</p>
        </CardContent>
      </Card>

      <Card className="rounded-xl border-l-[3px] border-l-green-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Coins at Peg
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold font-mono tabular-nums">{stats.coinsAtPeg}</p>
          <p className="text-xs text-muted-foreground">of {stats.totalTracked} tracked</p>
        </CardContent>
      </Card>

      <Card className="rounded-xl border-l-[3px] border-l-blue-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Median Deviation
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold font-mono tabular-nums">{stats.medianDeviationBps} bps</p>
          <p className="text-xs text-muted-foreground">across all coins</p>
        </CardContent>
      </Card>

      <Card className="rounded-xl border-l-[3px] border-l-violet-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Total Tracked
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold font-mono tabular-nums">{stats.totalTracked}</p>
          <p className="text-xs text-muted-foreground">stablecoins monitored</p>
        </CardContent>
      </Card>

      <Card className="rounded-xl border-l-[3px] border-l-amber-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Events Today
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold font-mono tabular-nums">{stats.depegEventsToday}</p>
          <p className="text-xs text-muted-foreground">{deltaLabel}</p>
        </CardContent>
      </Card>

      <Card className="rounded-xl border-l-[3px] border-l-orange-500">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Worst Current
          </CardTitle>
        </CardHeader>
        <CardContent>
          {stats.worstCurrent ? (
            <>
              <p className="text-2xl font-bold font-mono tabular-nums">{Math.abs(stats.worstCurrent.bps)} bps</p>
              <p className="text-xs text-muted-foreground">{stats.worstCurrent.symbol}</p>
            </>
          ) : (
            <>
              <p className="text-2xl font-bold font-mono tabular-nums">0 bps</p>
              <p className="text-xs text-muted-foreground">all healthy</p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
```

**Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/components/depeg-tracker-stats.tsx
git commit -m "feat(depeg): add DepegTrackerStats summary cards component"
```

---

### Task 4: Create DepegTrackerTable component

**Files:**
- Create: `src/components/depeg-tracker-table.tsx`

This is the largest new component. It follows the `LiquidityTable` pattern: `useSort` hook, `SortableTableHead`, `TablePagination`, responsive column hiding, row click navigation.

**Key refinements baked in:**
- Default sort: active depegs first → DEWS band descending → absolute deviation descending
- Row severity accents: 3px left border (red = active depeg, orange = DEWS WARNING+)

**Step 1: Write the table component**

```typescript
"use client";

import { useState, useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { SortableTableHead } from "@/components/sortable-table-head";
import { TablePagination } from "@/components/table-pagination";
import { DEWSBadge } from "@/components/dews-badge";
import { useSort } from "@/hooks/use-sort";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { deviationColorClass, pegScoreColor } from "@/lib/severity-colors";
import type { PegSummaryCoin } from "@/lib/types";
import type { ThreatBand } from "@/lib/classification";
import type { StressSignalEntry } from "@/hooks/use-stress-signals";

const PAGE_SIZE = 25;

/** DEWS threat bands ordered by severity for sorting */
const BAND_ORDER: Record<string, number> = {
  CALM: 0,
  WATCH: 1,
  ALERT: 2,
  WARNING: 3,
  DANGER: 4,
};

type SortKey =
  | "pegScore"
  | "dewsScore"
  | "currentDeviationBps"
  | "pegPct"
  | "eventCount"
  | "worstDeviationBps"
  | "activeDepeg"
  | "dexAgrees"
  | "trackingSpanDays";

export interface DepegTrackerRow {
  coin: PegSummaryCoin;
  dews: StressSignalEntry | null;
}

interface DepegTrackerTableProps {
  rows: DepegTrackerRow[];
  logos: Record<string, string> | undefined;
  onRowClick: (id: string) => void;
}

/** Composite sort for default "needs attention" ordering */
function attentionScore(row: DepegTrackerRow): number {
  // Active depeg = huge boost (1_000_000)
  let score = row.coin.activeDepeg ? 1_000_000 : 0;
  // DEWS band: DANGER=40000, WARNING=30000, ALERT=20000, WATCH=10000, CALM=0
  const band = row.dews?.band ?? "CALM";
  score += (BAND_ORDER[band] ?? 0) * 10_000;
  // Absolute deviation for fine-grained ordering
  score += Math.abs(row.coin.currentDeviationBps ?? 0);
  return score;
}

/** Row left-border class based on severity */
function rowAccentClass(row: DepegTrackerRow): string {
  if (row.coin.activeDepeg) return "border-l-[3px] border-l-red-500";
  const band = row.dews?.band ?? "CALM";
  if (band === "WARNING" || band === "DANGER") return "border-l-[3px] border-l-orange-500";
  return "";
}

export function DepegTrackerTable({ rows, logos, onRowClick }: DepegTrackerTableProps) {
  const { sortKey, sortDirection, toggleSort, getAriaSortValue, handleSortKeyDown } =
    useSort<SortKey | "__attention">("__attention" as SortKey, "desc");
  const sort = useMemo(() => ({ key: sortKey, direction: sortDirection }), [sortKey, sortDirection]);
  const [page, setPage] = useState(0);
  const prefetch = usePrefetchStablecoin();

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      // Default "attention" sort
      if (sort.key === ("__attention" as SortKey)) {
        return attentionScore(b) - attentionScore(a);
      }

      let aVal: number, bVal: number;
      switch (sort.key) {
        case "pegScore":
          aVal = a.coin.pegScore ?? -1;
          bVal = b.coin.pegScore ?? -1;
          break;
        case "dewsScore":
          aVal = a.dews?.score ?? -1;
          bVal = b.dews?.score ?? -1;
          break;
        case "currentDeviationBps":
          aVal = Math.abs(a.coin.currentDeviationBps ?? 0);
          bVal = Math.abs(b.coin.currentDeviationBps ?? 0);
          break;
        case "pegPct":
          aVal = a.coin.pegPct;
          bVal = b.coin.pegPct;
          break;
        case "eventCount":
          aVal = a.coin.eventCount;
          bVal = b.coin.eventCount;
          break;
        case "worstDeviationBps":
          aVal = Math.abs(a.coin.worstDeviationBps ?? 0);
          bVal = Math.abs(b.coin.worstDeviationBps ?? 0);
          break;
        case "activeDepeg":
          aVal = a.coin.activeDepeg ? 1 : 0;
          bVal = b.coin.activeDepeg ? 1 : 0;
          break;
        case "dexAgrees":
          aVal = a.coin.dexPriceCheck?.agrees ? 1 : 0;
          bVal = b.coin.dexPriceCheck?.agrees ? 1 : 0;
          break;
        case "trackingSpanDays":
          aVal = a.coin.trackingSpanDays;
          bVal = b.coin.trackingSpanDays;
          break;
        default:
          return attentionScore(b) - attentionScore(a);
      }
      return sort.direction === "asc" ? aVal - bVal : bVal - aVal;
    });
  }, [rows, sort]);

  // Reset page when row count changes (filter change)
  const [prevRowCount, setPrevRowCount] = useState(rows.length);
  if (prevRowCount !== rows.length) {
    setPrevRowCount(rows.length);
    setPage(0);
  }

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const paginated = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="rounded-xl border overflow-x-auto scroll-shadow">
      <Table>
        <TableHeader className="bg-muted/80">
          <TableRow>
            <TableHead className="w-[50px] text-right">#</TableHead>
            <TableHead className="w-[70px] xl:w-[200px] max-w-[70px] xl:max-w-none">Name</TableHead>
            <SortableTableHead
              sortKey="pegScore"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Peg Score"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right"
            />
            <SortableTableHead
              sortKey="dewsScore"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="DEWS"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right"
            />
            <SortableTableHead
              sortKey="currentDeviationBps"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Deviation"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right"
            />
            <SortableTableHead
              sortKey="pegPct"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Peg %"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right hidden md:table-cell"
            />
            <SortableTableHead
              sortKey="eventCount"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Events"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right hidden md:table-cell"
            />
            <SortableTableHead
              sortKey="worstDeviationBps"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Worst"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right hidden lg:table-cell"
            />
            <SortableTableHead
              sortKey="activeDepeg"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Status"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-center hidden lg:table-cell"
            />
            <SortableTableHead
              sortKey="dexAgrees"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="DEX"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-center hidden xl:table-cell"
            />
            <SortableTableHead
              sortKey="trackingSpanDays"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Tracking"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right hidden xl:table-cell"
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {paginated.map((row, i) => {
            const coin = row.coin;
            const dews = row.dews;
            const absDev = Math.abs(coin.currentDeviationBps ?? 0);
            const accent = rowAccentClass(row);
            const rank = page * PAGE_SIZE + i + 1;

            return (
              <TableRow
                key={coin.id}
                className={`cursor-pointer hover:bg-muted/50 transition-colors ${accent}`}
                onClick={() => onRowClick(coin.id)}
                onMouseEnter={() => prefetch(coin.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(coin.id); } }}
                tabIndex={0}
                role="link"
              >
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground text-sm">
                  {rank}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2 min-w-0">
                    <StablecoinLogo src={logos?.[coin.id]} name={coin.name} size={20} />
                    <span className="font-medium text-sm truncate">{coin.symbol}</span>
                    <span className="text-xs text-muted-foreground truncate hidden xl:inline">{coin.name}</span>
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm">
                  {coin.pegScore !== null ? (
                    <span className={pegScoreColor(coin.pegScore)}>{coin.pegScore}</span>
                  ) : (
                    <span className="text-muted-foreground">NR</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {dews ? (
                    <div className="flex items-center justify-end gap-1.5">
                      <DEWSBadge score={dews.score} band={dews.band as ThreatBand} signals={dews.signals} />
                      <span className="text-xs font-mono tabular-nums text-muted-foreground w-5 text-right">
                        {dews.score}
                      </span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground text-sm">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm">
                  {coin.currentDeviationBps !== null ? (
                    <span className={deviationColorClass(absDev)}>
                      {coin.currentDeviationBps > 0 ? "+" : ""}{coin.currentDeviationBps} bps
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm hidden md:table-cell">
                  {coin.pegPct.toFixed(1)}%
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm hidden md:table-cell">
                  {coin.eventCount}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm hidden lg:table-cell">
                  {coin.worstDeviationBps !== null ? (
                    <span className={deviationColorClass(Math.abs(coin.worstDeviationBps))}>
                      {coin.worstDeviationBps > 0 ? "+" : ""}{coin.worstDeviationBps} bps
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-center hidden lg:table-cell">
                  {coin.activeDepeg ? (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-500">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                      </span>
                      LIVE
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-sm">—</span>
                  )}
                </TableCell>
                <TableCell className="text-center hidden xl:table-cell">
                  {coin.dexPriceCheck ? (
                    coin.dexPriceCheck.agrees ? (
                      <span className="text-green-500 text-sm" title="DEX price agrees">✓</span>
                    ) : (
                      <span className="text-red-500 text-sm" title="DEX price disagrees">✗</span>
                    )
                  ) : (
                    <span className="text-muted-foreground text-sm">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm hidden xl:table-cell">
                  {formatTrackingSpan(coin.trackingSpanDays)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <TablePagination
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        totalItems={sorted.length}
        pageSize={PAGE_SIZE}
      />
    </div>
  );
}

/** Format tracking span in days to a human-readable string */
function formatTrackingSpan(days: number): string {
  if (days >= 365) {
    const years = Math.floor(days / 365);
    const months = Math.floor((days % 365) / 30);
    return months > 0 ? `${years}y ${months}mo` : `${years}y`;
  }
  if (days >= 30) {
    const months = Math.floor(days / 30);
    return `${months}mo`;
  }
  return `${days}d`;
}
```

**Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/components/depeg-tracker-table.tsx
git commit -m "feat(depeg): add DepegTrackerTable with smart sort and row accents"
```

---

### Task 5: Write the full client.tsx orchestrator

**Files:**
- Modify: `src/app/depeg/client.tsx` (replace the stub)

This is the orchestrator that wires hooks to components and manages unified filter state.

**Step 1: Replace the stub with the full client**

```typescript
"use client";

import { useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { useStressSignals } from "@/hooks/use-stress-signals";
import { useDepegEvents } from "@/hooks/use-depeg-events";
import { useLogos } from "@/hooks/use-logos";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { CRON_15MIN } from "@/hooks/use-api-query";
import { DepegTrackerStats } from "@/components/depeg-tracker-stats";
import { DepegTrackerTable } from "@/components/depeg-tracker-table";
import { DEWSSummary } from "@/components/dews-summary";
import { PegHeatmap } from "@/components/peg-heatmap";
import { DepegFeed } from "@/components/depeg-feed";
import { trackEvent, trackSearch } from "@/lib/analytics";
import type { PegCurrency, GovernanceType } from "@/lib/types";
import type { DepegTrackerRow } from "@/components/depeg-tracker-table";

const PEG_FILTERS: { value: PegCurrency | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "USD", label: "USD" },
  { value: "EUR", label: "EUR" },
  { value: "GOLD", label: "Gold" },
];

const TYPE_FILTERS: { value: GovernanceType | "all"; label: string }[] = [
  { value: "all", label: "All Types" },
  { value: "centralized", label: "CeFi" },
  { value: "centralized-dependent", label: "CeFi-Dep" },
  { value: "decentralized", label: "DeFi" },
];

export function DepegClient() {
  const { data: pegData, isLoading: isPegLoading, isError: isPegError, error: pegError, dataUpdatedAt: pegUpdatedAt } = usePegSummary();
  const { data: dewsData } = useStressSignals();
  const { data: eventsData } = useDepegEvents();
  const { data: logos } = useLogos();
  const router = useRouter();

  // Unified filter state (shared by table + heatmap)
  const { getParam, setParam } = useUrlFilters();
  const pegFilter = getParam("peg", "all") as PegCurrency | "all";
  const typeFilter = getParam("type", "all") as GovernanceType | "all";
  const searchQuery = getParam("q");

  const setPegFilter = useCallback((v: PegCurrency | "all") => {
    trackEvent("filter_applied", { page: "depeg", filter_type: "peg", filter_value: v });
    setParam("peg", v);
  }, [setParam]);
  const setTypeFilter = useCallback((v: GovernanceType | "all") => {
    trackEvent("filter_applied", { page: "depeg", filter_type: "type", filter_value: v });
    setParam("type", v);
  }, [setParam]);
  const setSearchQuery = useCallback((v: string) => {
    trackSearch("depeg", v.length);
    setParam("q", v);
  }, [setParam]);

  // Filter peg coins (shared between table + heatmap)
  const filteredPegCoins = useMemo(
    () =>
      (pegData?.coins ?? []).filter((c) => {
        if (pegFilter !== "all" && c.pegCurrency !== pegFilter) return false;
        if (typeFilter !== "all" && c.governance !== typeFilter) return false;
        if (searchQuery) {
          const q = searchQuery.toLowerCase();
          if (!c.name.toLowerCase().includes(q) && !c.symbol.toLowerCase().includes(q)) return false;
        }
        return true;
      }),
    [pegData, pegFilter, typeFilter, searchQuery],
  );

  // Merge peg coins with DEWS data for table rows
  const tableRows = useMemo((): DepegTrackerRow[] => {
    return filteredPegCoins.map((coin) => ({
      coin,
      dews: dewsData?.signals?.[coin.id] ?? null,
    }));
  }, [filteredPegCoins, dewsData]);

  const handleRowClick = useCallback((id: string) => {
    router.push(`/stablecoin/${id}`);
  }, [router]);

  // Loading state
  if (isPegLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="rounded-xl">
              <CardHeader className="pb-1"><Skeleton className="h-3 w-24" /></CardHeader>
              <CardContent><Skeleton className="h-8 w-32" /></CardContent>
            </Card>
          ))}
        </div>
        <Skeleton className="h-[400px]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {isPegError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load peg data. {pegError instanceof Error ? pegError.message : "Please check your connection."}
        </div>
      )}
      {!isPegError && (
        <StaleDataBanner
          queries={[{ label: "Peg Data", dataUpdatedAt: pegUpdatedAt, staleTime: CRON_15MIN }]}
        />
      )}

      {/* Summary Stats */}
      {pegData?.summary && (
        <SectionErrorBoundary name="depeg-stats">
          <DepegTrackerStats stats={pegData.summary} />
        </SectionErrorBoundary>
      )}

      {/* DEWS Summary (moved from homepage) */}
      <SectionErrorBoundary name="dews">
        <DEWSSummary logos={logos} />
      </SectionErrorBoundary>

      {/* Filters + Table */}
      <SectionErrorBoundary name="depeg-table">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">Peg Leaderboard</h2>
            <div className="flex flex-wrap items-center gap-3">
              <ToggleGroup
                type="single"
                value={pegFilter}
                onValueChange={(v) => v && setPegFilter(v as PegCurrency | "all")}
                className="flex gap-1"
              >
                {PEG_FILTERS.map((f) => (
                  <ToggleGroupItem key={f.value} value={f.value} variant="outline" size="sm" className="text-xs">
                    {f.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <ToggleGroup
                type="single"
                value={typeFilter}
                onValueChange={(v) => v && setTypeFilter(v as GovernanceType | "all")}
                className="flex gap-1"
              >
                {TYPE_FILTERS.map((f) => (
                  <ToggleGroupItem key={f.value} value={f.value} variant="outline" size="sm" className="text-xs">
                    {f.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <div className="relative w-full sm:w-44">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8 h-8 text-xs"
                  aria-label="Search stablecoins by name or symbol"
                />
              </div>
            </div>
          </div>

          <DepegTrackerTable
            rows={tableRows}
            logos={logos}
            onRowClick={handleRowClick}
          />
        </div>
      </SectionErrorBoundary>

      {/* Peg Heatmap (moved from homepage) — shares filter state */}
      <SectionErrorBoundary name="heatmap">
        <PegHeatmap
          coins={filteredPegCoins}
          logos={logos}
          isLoading={isPegLoading}
          pegFilter={pegFilter}
          typeFilter={typeFilter}
          onPegFilterChange={setPegFilter}
          onTypeFilterChange={setTypeFilter}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
        />
      </SectionErrorBoundary>

      {/* Recent Depeg Events (moved from homepage) */}
      <SectionErrorBoundary name="depeg-feed">
        <DepegFeed
          events={eventsData?.events ?? []}
          logos={logos}
        />
      </SectionErrorBoundary>
    </div>
  );
}
```

**Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Verify dev server renders the page**

Run: `npm run dev` and navigate to `http://localhost:3000/depeg`
Expected: page renders with stats, DEWS summary, table, heatmap, and feed

**Step 4: Commit**

```bash
git add src/app/depeg/client.tsx
git commit -m "feat(depeg): wire up full client with unified filters and all sections"
```

---

### Task 6: Remove three components from the homepage

**Files:**
- Modify: `src/components/homepage-client.tsx`

This is the most delicate task — we must ONLY remove the three specified components and clean up their now-unused dependencies.

**Step 1: Remove imports that are now only used by the three components**

Remove these imports from homepage-client.tsx:
- `PegHeatmap`
- `DepegFeed`
- `DEWSSummary`

Also remove any `useState` imports for `pegFilter`/`typeFilter` if they become unused.

**Step 2: Remove the filter state for the heatmap**

Remove these lines:
```typescript
const [pegFilter, setPegFilter] = useState<PegCurrency | "all">("all");
const [typeFilter, setTypeFilter] = useState<GovernanceType | "all">("all");
```

And the `filteredPegCoins` memo that filtered for the heatmap.

**Step 3: Remove the `useDepegEvents` hook call if unused elsewhere**

The homepage calls `useDepegEvents()` — check if it's used by anything other than `DepegFeed`. If not, remove the call and its import.

**Step 4: Remove the three rendered sections**

Remove these JSX blocks:
1. The `<SectionErrorBoundary name="dews">` block containing `<DEWSSummary>`
2. The `<SectionErrorBoundary name="heatmap">` block containing `<PegHeatmap>`
3. The `<SectionErrorBoundary name="depeg-feed">` block containing `<DepegFeed>`

**Step 5: Clean up now-unused imports**

After removal, check if these are still used anywhere in the file:
- `usePegSummary` — still needed for `pegScores` map used by `StablecoinTable`
- `derivePegRates` — still needed for `pegRates` used by `MarketHighlights` and `StablecoinTable`
- `PegCurrency`, `GovernanceType` types — may still be needed by remaining code
- `useState` — check if any other state uses it

Remove only imports that are fully unused after the three component removals.

**Step 6: Verify build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors, homepage still renders all remaining sections

**Step 7: Commit**

```bash
git add src/components/homepage-client.tsx
git commit -m "refactor(home): move DEWSSummary, PegHeatmap, DepegFeed to /depeg page"
```

---

### Task 7: Test the custom sort logic

**Files:**
- Create: `src/__tests__/depeg-tracker-sort.test.ts`

**Step 1: Write tests for the attention-based default sort**

```typescript
import { describe, it, expect } from "vitest";

// Extract the sort logic for testability
// We test via the exported types and replicate the sort function

const BAND_ORDER: Record<string, number> = {
  CALM: 0, WATCH: 1, ALERT: 2, WARNING: 3, DANGER: 4,
};

interface MockRow {
  activeDepeg: boolean;
  band: string;
  absDev: number;
}

function attentionScore(row: MockRow): number {
  let score = row.activeDepeg ? 1_000_000 : 0;
  score += (BAND_ORDER[row.band] ?? 0) * 10_000;
  score += row.absDev;
  return score;
}

describe("depeg tracker attention sort", () => {
  it("ranks active depegs above everything else", () => {
    const active: MockRow = { activeDepeg: true, band: "CALM", absDev: 10 };
    const danger: MockRow = { activeDepeg: false, band: "DANGER", absDev: 999 };
    expect(attentionScore(active)).toBeGreaterThan(attentionScore(danger));
  });

  it("ranks DANGER above WARNING when neither is active", () => {
    const danger: MockRow = { activeDepeg: false, band: "DANGER", absDev: 0 };
    const warning: MockRow = { activeDepeg: false, band: "WARNING", absDev: 0 };
    expect(attentionScore(danger)).toBeGreaterThan(attentionScore(warning));
  });

  it("uses deviation as tiebreaker within same band", () => {
    const high: MockRow = { activeDepeg: false, band: "ALERT", absDev: 300 };
    const low: MockRow = { activeDepeg: false, band: "ALERT", absDev: 100 };
    expect(attentionScore(high)).toBeGreaterThan(attentionScore(low));
  });

  it("CALM coins with zero deviation score lowest", () => {
    const calm: MockRow = { activeDepeg: false, band: "CALM", absDev: 0 };
    expect(attentionScore(calm)).toBe(0);
  });
});
```

**Step 2: Run the test**

Run: `npm test -- --run src/__tests__/depeg-tracker-sort.test.ts`
Expected: all 4 tests pass

**Step 3: Commit**

```bash
git add src/__tests__/depeg-tracker-sort.test.ts
git commit -m "test(depeg): add attention-sort unit tests"
```

---

### Task 8: Full build verification

**Step 1: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 2: Run lint**

Run: `npm run lint`
Expected: 0 errors (warnings acceptable)

**Step 3: Run all tests**

Run: `npm test`
Expected: all tests pass

**Step 4: Run full build**

Run: `npm run build`
Expected: successful static export including `/depeg` page

**Step 5: Commit any lint/type fixes if needed**

---

### Task 9: Update documentation

**Files:**
- Modify: `docs/architecture.md` — add `/depeg` to the page list
- Modify: `CLAUDE.md` — add `depeg` to the Directory Overview pages list

**Step 1: Add `/depeg` route to architecture.md page list**

Find the pages section and add:
```
src/app/depeg/       — Depeg Tracker: live peg monitoring, DEWS, heatmap, event feed
```

**Step 2: Add `depeg` to CLAUDE.md Directory Overview**

Update the `src/app/` line to include `depeg` in the parenthetical list.

**Step 3: Commit**

```bash
git add docs/architecture.md CLAUDE.md
git commit -m "docs: add /depeg page to architecture and CLAUDE.md"
```
