# PSI Dedicated Page Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a dedicated `/stability-index` page showing historical PSI scores with band-colored zones, event annotations, component breakdown charts, and a methodology explainer.

**Architecture:** Extend the existing `/api/stability-index` endpoint with a `?detail=true` param to return full history with component breakdowns. Create a new Next.js page following the peg-tracker/liquidity pattern (server page.tsx + client.tsx). Two Recharts charts — score over time with band ReferenceAreas, and a stacked component breakdown. Add nav entry in header.

**Tech Stack:** Next.js 16, React 19, Recharts (AreaChart, ReferenceArea, ReferenceLine), TanStack Query, Tailwind CSS v4, shadcn/ui Card

**Design doc:** `docs/plans/2026-02-25-psi-page-design.md`

---

### Task 1: Extend the API to support `?detail=true`

**Files:**
- Modify: `worker/src/api/stability-index.ts`

**Context:** The current API queries the last 91 rows and returns components only for the current (latest) row. The DB `stability_index` table stores `components` TEXT (JSON) for every row. We need to optionally return full history with component data.

**Step 1: Read the current handler**

Read `worker/src/api/stability-index.ts` to confirm the current implementation.

**Step 2: Modify the handler to accept a `detail` query param**

The handler function signature is `async (db: D1Database): Promise<Response>`. It's wrapped in `withErrorHandler`. We need to accept the request URL. Check how `withErrorHandler` passes the request — look at `worker/src/lib/api-utils.ts` for the signature.

The handler needs to:
1. Accept the `Request` object (check if `withErrorHandler` passes it)
2. Parse `?detail=true` from the URL
3. When `detail=true`: query ALL rows (no LIMIT), include `components` in history entries
4. When no param: existing behavior (LIMIT 91, no components in history)

Modify the handler:

```typescript
export const handleStabilityIndex = withErrorHandler("stability-index", async (db: D1Database, _env: unknown, request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const detail = url.searchParams.get("detail") === "true";

  const limit = detail ? "" : "LIMIT 91";
  const rows = await db
    .prepare(`SELECT computed_at, score, band, components FROM stability_index ORDER BY computed_at DESC ${limit}`)
    .all<{ computed_at: number; score: number; band: string; components: string }>();
  const results = rows.results ?? [];

  if (results.length === 0) {
    return new Response(JSON.stringify({ current: null, history: [] }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": CACHE_PROFILES.slow,
      },
    });
  }

  const current = results[0];
  const history = results.slice(1).map((r) => {
    const point: Record<string, unknown> = { date: r.computed_at, score: r.score, band: r.band };
    if (detail) point.components = JSON.parse(r.components);
    return point;
  });

  return new Response(JSON.stringify({
    current: {
      score: current.score,
      band: current.band,
      components: JSON.parse(current.components),
      computedAt: current.computed_at,
    },
    history,
  }), {
    headers: addFreshnessHeaders({
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.slow,
    }, current.computed_at, 86400),
  });
});
```

**Important:** Check the `withErrorHandler` signature first. It may already pass `request` as a parameter. If not, you'll need to modify it or find another way to access the URL. Look at other API handlers that read query params (e.g., `worker/src/api/backfill-depegs.ts` or `worker/src/api/supply-history.ts`) for the pattern.

**Step 3: Type-check the worker**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add worker/src/api/stability-index.ts
git commit -m "feat(api): add ?detail=true param to stability-index endpoint

Returns full history with component breakdowns when detail=true.
Default behavior unchanged (90-day, no components).

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Add the `useStabilityIndexDetail` hook

**Files:**
- Modify: `src/hooks/use-stability-index.ts`

**Context:** The homepage widget uses `useStabilityIndex()` which calls `/api/stability-index` (lightweight, 90-day). The dedicated page needs a separate hook that calls `?detail=true` for full history with components.

**Step 1: Add the detail history point type and hook**

Add to `src/hooks/use-stability-index.ts` after the existing `useStabilityIndex` function:

```typescript
interface StabilityIndexDetailHistoryPoint {
  date: number;
  score: number;
  band: string;
  components: StabilityIndexComponents;
}

export interface StabilityIndexDetailData {
  current: StabilityIndexCurrent | null;
  history: StabilityIndexDetailHistoryPoint[];
}

export function useStabilityIndexDetail() {
  return useApiQuery<StabilityIndexDetailData>(
    ["stability-index-detail"],
    "/api/stability-index?detail=true",
    CRON_24H,
  );
}
```

**Step 2: Build**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/hooks/use-stability-index.ts
git commit -m "feat(hooks): add useStabilityIndexDetail hook for full PSI history

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Export `PsiLighthouse` and add size prop

**Files:**
- Modify: `src/components/stability-index.tsx`

**Context:** The `PsiLighthouse` component is currently a private function. The dedicated page needs to render a larger version (64px). Add an optional `size` prop and export it.

**Step 1: Add size prop to PsiLighthouse**

Change the function signature and SVG width/height:

```typescript
// Change from:
function PsiLighthouse({ band, color }: { band: string; color: string }) {

// To:
export function PsiLighthouse({ band, color, size = 36 }: { band: string; color: string; size?: number }) {
```

Update the SVG element to use the size prop:

```tsx
<svg
  width={size}
  height={size}
  viewBox="0 0 88 88"
  // ...rest stays the same
```

**Step 2: Build**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/components/stability-index.tsx
git commit -m "feat(psi): export PsiLighthouse with configurable size prop

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Create the server page component

**Files:**
- Create: `src/app/stability-index/page.tsx`

**Context:** Follow the exact pattern from `src/app/peg-tracker/page.tsx` — server component with metadata, breadcrumb JSON-LD, breadcrumb nav, h1, description, Suspense-wrapped client component.

**Step 1: Create the page**

```tsx
import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { StabilityIndexClient } from "./client";

const description = "Historical Pharos Stability Index scores, component breakdowns, and condition band analysis for the stablecoin market.";

export const metadata: Metadata = {
  title: "Stability Index — Pharos Stablecoin Market Health",
  description,
  alternates: { canonical: "/stability-index/" },
  openGraph: {
    title: "Stability Index — Pharos Stablecoin Market Health",
    description,
    url: "/stability-index/",
  },
};

export default function StabilityIndexPage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Stability Index" path="/stability-index/" />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Stability Index</span>
        </nav>
        <h1 className="text-3xl font-bold tracking-tight">Pharos Stability Index</h1>
        <p className="text-sm text-muted-foreground">
          Historical stablecoin market health scores, component breakdowns, and condition band analysis.
        </p>
      </div>
      <Suspense>
        <StabilityIndexClient />
      </Suspense>
    </div>
  );
}
```

**Step 2: Create a placeholder client component**

Create `src/app/stability-index/client.tsx` with a minimal placeholder so the build succeeds:

```tsx
"use client";

export function StabilityIndexClient() {
  return <div>Coming soon</div>;
}
```

**Step 3: Build**

Run: `npm run build`
Expected: PASS — new route `/stability-index` appears in the build output.

**Step 4: Commit**

```bash
git add src/app/stability-index/page.tsx src/app/stability-index/client.tsx
git commit -m "feat(psi): add stability-index page scaffold

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: Add navigation entry

**Files:**
- Modify: `src/components/header.tsx`

**Context:** Add the PSI page to the nav bar. Insert it after "Dashboard" and before "Freeze Tracker" since it's a top-level market indicator. Use the `Gauge` icon from Lucide (or `Lighthouse` if available, otherwise `Gauge`).

**Step 1: Add the nav entry**

In `src/components/header.tsx`, add the import for the icon and the nav entry:

```typescript
// Add to Lucide imports:
import { Activity, ClipboardCheck, Droplets, Gauge, Info, LayoutDashboard, Menu, ShieldBan, Skull } from "lucide-react";

// Add to NAV_ITEMS array (after Dashboard, before Freeze Tracker):
{ href: "/stability-index", label: "Stability", icon: Gauge },
```

**Step 2: Build**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/components/header.tsx
git commit -m "feat(nav): add Stability Index to navigation

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: Build the hero section in the client component

**Files:**
- Modify: `src/app/stability-index/client.tsx`

**Context:** The hero section shows the current PSI score prominently with the lighthouse icon, band name, delta, and a "days in band" streak counter. It reuses the `PsiLighthouse` component at 64px.

**Step 1: Implement the hero section**

Replace the placeholder client component with the hero:

```tsx
"use client";

import { useMemo } from "react";
import { useStabilityIndexDetail } from "@/hooks/use-stability-index";
import { PsiLighthouse } from "@/components/stability-index";
import { Skeleton } from "@/components/ui/skeleton";

const BAND_COLORS: Record<string, string> = {
  BEDROCK: "text-green-500",
  STEADY: "text-teal-500",
  TREMOR: "text-yellow-500",
  FRACTURE: "text-orange-500",
  CRISIS: "text-red-500",
  MELTDOWN: "text-red-800",
};

const SPARKLINE_COLORS: Record<string, string> = {
  BEDROCK: "#22c55e",
  STEADY: "#14b8a6",
  TREMOR: "#eab308",
  FRACTURE: "#f97316",
  CRISIS: "#ef4444",
  MELTDOWN: "#991b1b",
};

export function StabilityIndexClient() {
  const { data, isLoading } = useStabilityIndexDetail();

  const daysInBand = useMemo(() => {
    if (!data?.current || !data.history.length) return 0;
    const currentBand = data.current.band;
    let count = 1; // today
    for (const point of data.history) {
      if (point.band === currentBand) count++;
      else break;
    }
    return count;
  }, [data]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-6">
          <Skeleton className="h-16 w-16 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-10 w-48" />
            <Skeleton className="h-5 w-32" />
          </div>
        </div>
        <Skeleton className="h-[350px] w-full" />
      </div>
    );
  }

  if (!data?.current) return null;

  const { score, band, computedAt } = data.current;
  const yesterday = data.history.length > 0 ? data.history[0] : null;
  const delta = yesterday ? Math.round((score - yesterday.score) * 10) / 10 : null;
  const colorClass = BAND_COLORS[band] ?? "text-foreground";
  const hexColor = SPARKLINE_COLORS[band] ?? "#888";

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="flex items-center gap-6">
        <PsiLighthouse band={band} color={hexColor} size={64} />
        <div>
          <div className="flex items-baseline gap-3">
            <span className={`text-4xl font-bold tabular-nums ${colorClass}`}>
              {score.toFixed(1)}
            </span>
            <span className={`text-xl font-bold uppercase tracking-wide ${colorClass}`}>
              {band}
            </span>
            {delta !== null && (
              <span className={`text-base font-medium tabular-nums ${delta >= 0 ? "text-green-500" : "text-red-500"}`}>
                {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {daysInBand} {daysInBand === 1 ? "day" : "days"} in {band}
          </p>
        </div>
      </div>

      {/* Charts will go here in Tasks 7 and 8 */}
    </div>
  );
}
```

**Step 2: Build**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/app/stability-index/client.tsx
git commit -m "feat(psi): implement hero section with lighthouse, score, and band streak

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 7: Build the main score chart

**Files:**
- Modify: `src/app/stability-index/client.tsx`

**Context:** This is the centerpiece — an AreaChart showing the PSI score over time with horizontal band zones (ReferenceArea) and vertical event annotations (ReferenceLine). Uses the same chart patterns as `src/components/total-mcap-chart.tsx` but with Recharts `ReferenceArea` for band zones and `ReferenceLine` for events.

**Reference:** Check `src/components/total-mcap-chart.tsx` for the exact Recharts import/usage pattern. Check `src/lib/chart-colors.ts` for `RECHARTS_TOOLTIP_STYLES`.

**Step 1: Add imports**

Add to the top of `src/app/stability-index/client.tsx`:

```tsx
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea,
  ReferenceLine,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { RECHARTS_TOOLTIP_STYLES } from "@/lib/chart-colors";
```

**Step 2: Add constants for band zones and events**

Add after the `SPARKLINE_COLORS` constant:

```tsx
/** Band zone definitions for ReferenceArea backgrounds */
const BAND_ZONES = [
  { y1: 90, y2: 100, color: "#22c55e", label: "BEDROCK" },
  { y1: 75, y2: 90,  color: "#14b8a6", label: "STEADY" },
  { y1: 60, y2: 75,  color: "#eab308", label: "TREMOR" },
  { y1: 40, y2: 60,  color: "#f97316", label: "FRACTURE" },
  { y1: 20, y2: 40,  color: "#ef4444", label: "CRISIS" },
  { y1: 0,  y2: 20,  color: "#991b1b", label: "MELTDOWN" },
];

/** Notable events to annotate on the chart */
const PSI_EVENTS = [
  { date: Date.UTC(2022, 4, 7), label: "UST Collapse" },
  { date: Date.UTC(2023, 2, 10), label: "SVB Weekend" },
];
```

**Step 3: Add the `ScoreChart` component**

Add a private component inside the file (before `StabilityIndexClient`):

```tsx
function ScoreChart({ data, currentBand }: { data: { ts: number; score: number; band: string }[]; currentBand: string }) {
  const { range, setRange, filteredData, options } = useTimeRangeFilter(data, "ts");
  const hexColor = SPARKLINE_COLORS[currentBand] ?? "#888";

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle as="h2">Score History</CardTitle>
        <TimeRangeButtons options={options} value={range} onChange={setRange} />
      </CardHeader>
      <CardContent>
        {filteredData.length > 0 ? (
          <div className="h-[300px] sm:h-[400px]" role="figure" aria-label="Stability index score over time">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={filteredData} margin={{ top: 5, right: 5, bottom: 20, left: 5 }}>
                <defs>
                  <linearGradient id="psiScoreGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={hexColor} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={hexColor} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.1} />

                {/* Band zone backgrounds */}
                {BAND_ZONES.map((zone) => (
                  <ReferenceArea
                    key={zone.label}
                    y1={zone.y1}
                    y2={zone.y2}
                    fill={zone.color}
                    fillOpacity={0.06}
                  />
                ))}

                {/* Event annotations */}
                {PSI_EVENTS.map((evt) => (
                  <ReferenceLine
                    key={evt.label}
                    x={evt.date}
                    stroke="var(--color-muted-foreground)"
                    strokeDasharray="3 3"
                    strokeOpacity={0.5}
                    label={{
                      value: evt.label,
                      position: "top",
                      fill: "var(--color-muted-foreground)",
                      fontSize: 11,
                    }}
                  />
                ))}

                <XAxis
                  dataKey="ts"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  tick={{ fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(ts: number) =>
                    new Date(ts).toLocaleDateString("en-US", { month: "short", year: "2-digit" })
                  }
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  formatter={(value: number) => [value.toFixed(1), "Score"]}
                  labelFormatter={(label) =>
                    new Date(Number(label)).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })
                  }
                  {...RECHARTS_TOOLTIP_STYLES}
                />
                <Area
                  type="monotone"
                  dataKey="score"
                  stroke={hexColor}
                  fill="url(#psiScoreGradient)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-[300px] sm:h-[400px] items-center justify-center text-muted-foreground">
            No stability index data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

**Step 4: Integrate ScoreChart into StabilityIndexClient**

In the `StabilityIndexClient` return JSX, prepare chart data from history and add the chart:

```tsx
// Add useMemo for chart data (before the return):
const chartData = useMemo(() => {
  if (!data?.history) return [];
  const points = [...data.history]
    .reverse()
    .map((p) => ({ ts: p.date * 1000, score: p.score, band: p.band }));
  // Add current as last point
  if (data.current) {
    points.push({ ts: data.current.computedAt * 1000, score: data.current.score, band: data.current.band });
  }
  return points;
}, [data]);

// In the return JSX, after the hero section, replace the comment with:
<ScoreChart data={chartData} currentBand={band} />
```

**Step 5: Build**

Run: `npm run build`
Expected: PASS

**Step 6: Commit**

```bash
git add src/app/stability-index/client.tsx
git commit -m "feat(psi): add score history chart with band zones and event annotations

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 8: Build the component breakdown chart

**Files:**
- Modify: `src/app/stability-index/client.tsx`

**Context:** A stacked area chart showing severity, breadth, freezes, and trend over time. This lets users see what drove score dips. Severity/breadth/freezes are stacked (they're all penalties subtracted from 100). Trend is a separate line since it can be negative.

**Step 1: Add the `ComponentChart` private component**

```tsx
const COMPONENT_COLORS = {
  severity: "#f97316", // orange
  breadth: "#3b82f6",  // blue
  freezes: "#ef4444",  // red
  trend: "#22c55e",    // green (separate line)
};

function ComponentChart({ data }: { data: { ts: number; severity: number; breadth: number; freezes: number; trend: number }[] }) {
  const { range, setRange, filteredData, options } = useTimeRangeFilter(data, "ts");

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle as="h2">Component Breakdown</CardTitle>
        <TimeRangeButtons options={options} value={range} onChange={setRange} />
      </CardHeader>
      <CardContent>
        {filteredData.length > 0 ? (
          <div className="h-[250px] sm:h-[350px]" role="figure" aria-label="Stability index component breakdown over time">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={filteredData} margin={{ top: 5, right: 5, bottom: 20, left: 5 }}>
                <defs>
                  <linearGradient id="severityGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COMPONENT_COLORS.severity} stopOpacity={0.4} />
                    <stop offset="95%" stopColor={COMPONENT_COLORS.severity} stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="breadthGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COMPONENT_COLORS.breadth} stopOpacity={0.4} />
                    <stop offset="95%" stopColor={COMPONENT_COLORS.breadth} stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="freezesGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COMPONENT_COLORS.freezes} stopOpacity={0.4} />
                    <stop offset="95%" stopColor={COMPONENT_COLORS.freezes} stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
                <XAxis
                  dataKey="ts"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  tick={{ fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(ts: number) =>
                    new Date(ts).toLocaleDateString("en-US", { month: "short", year: "2-digit" })
                  }
                />
                <YAxis
                  tick={{ fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  formatter={(value: number, name: string) => [value.toFixed(2), name.charAt(0).toUpperCase() + name.slice(1)]}
                  labelFormatter={(label) =>
                    new Date(Number(label)).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })
                  }
                  {...RECHARTS_TOOLTIP_STYLES}
                />
                <Area type="monotone" dataKey="severity" stackId="penalties" stroke={COMPONENT_COLORS.severity} fill="url(#severityGrad)" strokeWidth={1.5} />
                <Area type="monotone" dataKey="breadth" stackId="penalties" stroke={COMPONENT_COLORS.breadth} fill="url(#breadthGrad)" strokeWidth={1.5} />
                <Area type="monotone" dataKey="freezes" stackId="penalties" stroke={COMPONENT_COLORS.freezes} fill="url(#freezesGrad)" strokeWidth={1.5} />
                <Area type="monotone" dataKey="trend" stroke={COMPONENT_COLORS.trend} fill="none" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-[250px] sm:h-[350px] items-center justify-center text-muted-foreground">
            No component data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

**Step 2: Prepare component chart data and integrate**

In `StabilityIndexClient`, add a `componentData` memo and render the chart:

```tsx
const componentData = useMemo(() => {
  if (!data?.history) return [];
  const points = [...data.history]
    .reverse()
    .map((p) => ({
      ts: p.date * 1000,
      severity: p.components.severity,
      breadth: p.components.breadth,
      freezes: p.components.freezes,
      trend: p.components.trend,
    }));
  if (data.current) {
    const c = data.current.components;
    points.push({
      ts: data.current.computedAt * 1000,
      severity: c.severity,
      breadth: c.breadth,
      freezes: c.freezes,
      trend: c.trend,
    });
  }
  return points;
}, [data]);

// In the return JSX, after <ScoreChart>:
{componentData.length > 0 && <ComponentChart data={componentData} />}
```

**Step 3: Build**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/app/stability-index/client.tsx
git commit -m "feat(psi): add component breakdown stacked area chart

Shows severity, breadth, freezes (stacked) and trend (line) over time.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 9: Add the methodology section

**Files:**
- Modify: `src/app/stability-index/client.tsx`

**Context:** A collapsible section at the bottom explaining the scoring formula, component definitions, and band thresholds. Keep it static — no data fetching needed.

**Step 1: Add the methodology component**

```tsx
function Methodology() {
  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle as="h2">Methodology</CardTitle>
      </CardHeader>
      <CardContent className="prose prose-sm dark:prose-invert max-w-none">
        <p>
          The Pharos Stability Index is a daily score from 0 to 100 measuring overall stablecoin market health.
          It is computed deterministically from on-chain data already tracked by Pharos.
        </p>
        <p className="font-mono text-sm">
          Score = 100 − severity − breadth − freezes + trend
        </p>
        <h3 className="text-base font-semibold mt-4">Components</h3>
        <div className="overflow-x-auto">
          <table className="text-sm">
            <thead>
              <tr>
                <th className="text-left pr-4">Component</th>
                <th className="text-left pr-4">Range</th>
                <th className="text-left">Description</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="pr-4 font-medium">Severity</td><td className="pr-4">0–60</td><td>Depeg impact weighted by market cap and systemic importance</td></tr>
              <tr><td className="pr-4 font-medium">Breadth</td><td className="pr-4">0–15</td><td>Number of coins depegging, weighted by market cap</td></tr>
              <tr><td className="pr-4 font-medium">Freezes</td><td className="pr-4">0–10</td><td>Blacklist/freeze events in the last 24 hours</td></tr>
              <tr><td className="pr-4 font-medium">Trend</td><td className="pr-4">−5 to +5</td><td>7-day total stablecoin market cap change</td></tr>
            </tbody>
          </table>
        </div>
        <h3 className="text-base font-semibold mt-4">Condition Bands</h3>
        <div className="overflow-x-auto">
          <table className="text-sm">
            <thead>
              <tr>
                <th className="text-left pr-4">Range</th>
                <th className="text-left pr-4">Band</th>
                <th className="text-left">Meaning</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="pr-4">90–100</td><td className="pr-4 font-medium text-green-500">BEDROCK</td><td>Boring. The way stablecoins should be.</td></tr>
              <tr><td className="pr-4">75–89</td><td className="pr-4 font-medium text-teal-500">STEADY</td><td>Minor noise, nothing systemic.</td></tr>
              <tr><td className="pr-4">60–74</td><td className="pr-4 font-medium text-yellow-500">TREMOR</td><td>Something real is happening.</td></tr>
              <tr><td className="pr-4">40–59</td><td className="pr-4 font-medium text-orange-500">FRACTURE</td><td>Multiple signals firing.</td></tr>
              <tr><td className="pr-4">20–39</td><td className="pr-4 font-medium text-red-500">CRISIS</td><td>Active contagion risk.</td></tr>
              <tr><td className="pr-4">0–19</td><td className="pr-4 font-medium text-red-800">MELTDOWN</td><td>Generational event.</td></tr>
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
```

**Step 2: Add to the return JSX**

After the component chart:

```tsx
<Methodology />
```

**Step 3: Build**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/app/stability-index/client.tsx
git commit -m "feat(psi): add methodology section with formula, components, and bands

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 10: Final build verification

**Files:** None (verification only)

**Step 1: Full build**

Run: `npm run build`
Expected: PASS with `/stability-index` in the output page list.

**Step 2: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 3: Visual smoke test**

Run: `npm run dev`
Open http://localhost:3000/stability-index and verify:
- Hero shows lighthouse (64px), score, band, delta, days-in-band
- Score chart renders with band-colored zones
- Event annotations appear (if historical data goes back to 2022/2023)
- Time range filter works (30d/90d/1y/All)
- Component breakdown chart shows stacked areas
- Methodology section is readable
- Nav link appears in header
- Mobile responsive
