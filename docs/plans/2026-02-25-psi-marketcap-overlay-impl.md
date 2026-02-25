# PSI Marketcap Overlay Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Overlay the Pharos Stability Index as a teal line on the homepage total stablecoin marketcap chart with a dual Y-axis.

**Architecture:** Upgrade `<AreaChart>` to `<ComposedChart>` in `total-mcap-chart.tsx`, add a `<Line>` for PSI with a right-side `<YAxis>` fixed 0–100. Forward-fill daily PSI scores into the sub-daily marketcap data array. Data comes from `useStabilityIndex()` (already cached on homepage).

**Tech Stack:** React 19, Recharts (`ComposedChart`, `Line`, dual `YAxis`), TanStack Query, TypeScript strict.

**Design doc:** `docs/plans/2026-02-25-psi-marketcap-overlay-design.md`

---

### Task 1: Add CHART_TEAL color constant

**Files:**
- Modify: `src/lib/chart-colors.ts:9-10`

**Step 1: Add the constant**

After line 9 (`CHART_GREEN`), add:

```typescript
export const CHART_TEAL = CHART_PALETTE[9]; // #14b8a6
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds with no type errors.

**Step 3: Commit**

```bash
git add src/lib/chart-colors.ts
git commit -m "feat: add CHART_TEAL color constant for PSI overlay"
```

---

### Task 2: Add PSI data merging and upgrade chart

This is the main task. All changes are in `src/components/total-mcap-chart.tsx`.

**Files:**
- Modify: `src/components/total-mcap-chart.tsx`

**Step 1: Update imports**

Replace the current Recharts imports (lines 4-12):

```typescript
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
```

Add `CHART_TEAL` to the chart-colors import (line 18):

```typescript
import { CHART_BLUE, CHART_TEAL, RECHARTS_TOOLTIP_STYLES } from "@/lib/chart-colors";
```

Add the PSI hook import after line 19:

```typescript
import { useStabilityIndex } from "@/hooks/use-stability-index";
```

**Step 2: Add PSI data fetching and merging**

Inside `TotalMcapChart()`, after the existing `useStablecoinCharts()` call (line 22), add the PSI hook:

```typescript
const { data: psiData } = useStabilityIndex();
```

Replace the existing `chartData` useMemo (lines 24-37) with one that merges both datasets:

```typescript
const chartData = useMemo(() => {
  if (!Array.isArray(data) || data.length === 0) return [];

  // Build sorted PSI lookup: oldest-first array of { ts (ms), score }
  const psiPoints: { ts: number; score: number }[] = [];
  if (psiData?.history) {
    const reversed = [...psiData.history].reverse(); // API returns newest-first
    for (const p of reversed) {
      psiPoints.push({ ts: p.date * 1000, score: p.score });
    }
  }
  if (psiData?.current) {
    psiPoints.push({ ts: psiData.current.computedAt * 1000, score: psiData.current.score });
  }

  // Forward-fill PSI scores into marketcap data
  let psiIdx = 0;
  return data.map((point) => {
    const ts = point.date * 1000;
    const total = Object.values(point.totalCirculatingUSD).reduce(
      (sum, v) => sum + (v ?? 0),
      0,
    );

    // Advance PSI index to the latest point at or before this timestamp
    while (psiIdx < psiPoints.length - 1 && psiPoints[psiIdx + 1].ts <= ts) {
      psiIdx++;
    }

    const score = psiPoints.length > 0 && psiPoints[psiIdx].ts <= ts
      ? psiPoints[psiIdx].score
      : undefined;

    return { ts, total, score };
  });
}, [data, psiData]);
```

**Step 3: Upgrade AreaChart to ComposedChart and add PSI series**

Replace the `<AreaChart>` opening tag (line 73) with:

```tsx
<ComposedChart data={filteredData} margin={{ top: 5, right: 45, bottom: 20, left: 5 }}>
```

Note: `right: 45` (was 5) to make room for the right Y-axis labels.

Add a right Y-axis for PSI after the existing left `<YAxis>` (after line 102):

```tsx
<YAxis
  yAxisId="psi"
  orientation="right"
  domain={[0, 100]}
  tick={{ fontSize: 12 }}
  tickLine={false}
  axisLine={false}
  tickFormatter={(val: number) => String(val)}
/>
```

Add `yAxisId="mcap"` to the existing left `<YAxis>` (line 96):

```tsx
<YAxis
  yAxisId="mcap"
  tick={{ fontSize: 12 }}
  tickLine={false}
  axisLine={false}
  tickFormatter={(val: number) => formatCurrency(val, 0)}
  domain={yDomain}
/>
```

Add `yAxisId="mcap"` to the existing `<Area>` (line 114):

```tsx
<Area
  yAxisId="mcap"
  type="monotone"
  dataKey="total"
  stroke={CHART_BLUE}
  fill="url(#mcapGradient)"
  strokeWidth={2}
  name="Market Cap"
/>
```

Add the PSI Line after the Area (before `</ComposedChart>`):

```tsx
<Line
  yAxisId="psi"
  type="monotone"
  dataKey="score"
  stroke={CHART_TEAL}
  strokeWidth={2}
  dot={false}
  connectNulls
  name="PSI"
/>
```

Close with `</ComposedChart>` instead of `</AreaChart>`.

**Step 4: Update tooltip to show both series**

Replace the existing Tooltip formatter (lines 103-113):

```tsx
<Tooltip
  formatter={(value, name) => {
    if (name === "Market Cap") return [formatCurrency(Number(value)), "Market Cap"];
    if (name === "PSI") return [Number(value).toFixed(1), "Pharos Stability Index"];
    return [String(value), String(name)];
  }}
  labelFormatter={(label) =>
    new Date(Number(label)).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
  }
  {...RECHARTS_TOOLTIP_STYLES}
/>
```

**Step 5: Add inline legend**

Add a small legend between `<CardHeader>` and `<CardContent>` (after line 68, inside the Card). Actually, place it inside `<CardContent>` before the chart div:

```tsx
<div className="flex flex-wrap gap-4 mb-4">
  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: CHART_BLUE }} />
    Market Cap
  </div>
  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: CHART_TEAL }} />
    Pharos Stability Index
  </div>
</div>
```

This follows the exact pattern from the ComponentChart legend in `src/app/stability-index/client.tsx:284-290`.

**Step 6: Verify build**

Run: `npm run build`
Expected: Build succeeds with no type errors.

**Step 7: Commit**

```bash
git add src/components/total-mcap-chart.tsx
git commit -m "feat: overlay PSI line on homepage marketcap chart

Adds a teal Pharos Stability Index line with right Y-axis (0-100)
to the total stablecoin market cap chart, showing the correlation
between market cap growth and stability."
```

---

### Task 3: Visual verification and cleanup

**Step 1: Run dev server and verify**

Run: `npm run dev`

Check the homepage at `http://localhost:3000`:
- Blue area for market cap (left Y-axis, currency formatted)
- Teal line for PSI (right Y-axis, 0-100 fixed)
- Legend shows both series with colored dots
- Tooltip shows both "Market Cap: $X" and "Pharos Stability Index: X.X" on hover
- Time range buttons work (7d/30d/90d/1y/all) — PSI line should be visible on 30d/90d, may have no data on 1y/all if history < 91 days
- Chart renders correctly if PSI data hasn't loaded yet (just shows market cap)
- Right margin accommodates the PSI axis labels without clipping

**Step 2: Fix any visual issues found**

Adjust margins, colors, or formatting as needed based on visual inspection.

**Step 3: Final build verification**

Run: `npm run build`
Expected: Clean build, no warnings.

**Step 4: Commit any adjustments**

```bash
git add -A
git commit -m "fix: visual adjustments for PSI overlay chart"
```
