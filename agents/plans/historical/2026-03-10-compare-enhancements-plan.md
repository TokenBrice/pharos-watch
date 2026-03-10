# Compare Page Enhancements — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add mint/burn flow signals and a "Net Flow 30D" table row to the compare page, surfacing on-chain intelligence alongside the existing side-by-side metrics.

**Architecture:** Three targeted additions — a new table row sourced from the existing `useMintBurnFlows()` aggregate, a new "Live Flow Signals" section (per-coin flow cards + net flow line chart) between the table and charts, and optionally a peg deviation chart. All flow UI helpers already exist in `src/lib/flow-signal-ui.ts` and `shared/lib/format.ts`.

**Tech Stack:** React 19, TypeScript strict, Recharts, TanStack Query, Tailwind CSS v4, Vitest + `renderToStaticMarkup` for component tests.

**Design spec:** `agents/plans/2026-03-10-compare-enhancements-design.md`

---

## Chunk 1: Net Flow 30D — table row

**Files:**
- Modify: `src/components/comparison-table.tsx`

### Task 1: Add Net Flow 30D row to ComparisonTable

The `useMintBurnFlows()` aggregate already returns `netFlow30dUsd` on each coin entry. We pass the data in as a new prop — no new API calls needed.

**Relevant helpers** (already imported in the project):
- `getNetColor(value)` → `"text-emerald-700 dark:text-emerald-400"` / red / muted — from `@shared/lib/format`
- `getNetPrefix(value)` → `"+"` or `""` — from `@shared/lib/format`
- `formatCurrency(value)` — already imported in comparison-table.tsx

**Interface addition:** add `netFlow30d: number | null` per coin (null = not tracked).

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/comparison-table.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ComparisonTable } from "@/components/comparison-table";

const baseCoin = {
  id: "usdt-tether",
  symbol: "USDT",
  name: "Tether",
  data: {
    price: 1.0001,
    pegType: "peggedUSD",
    circulating: { peggedUSD: 143_200_000_000 },
    circulatingPrevDay: { peggedUSD: 142_000_000_000 },
    circulatingPrevWeek: { peggedUSD: 140_000_000_000 },
  } as any,
  meta: { flags: { pegCurrency: "USD", governance: "centralized", backing: "fiat-backed" }, commodityOunces: undefined } as any,
  pegScore: 91.4,
  liquidityScore: 84.1,
  safetyGrade: "B+" as const,
  netFlow30d: 1_240_000_000,
};

const coin2 = { ...baseCoin, id: "usdc-circle", symbol: "USDC", name: "USD Coin", netFlow30d: -340_000_000 };
const coinNoFlow = { ...baseCoin, id: "usds-sky", symbol: "USDS", name: "Sky Dollar", netFlow30d: null };

describe("ComparisonTable Net Flow 30D row", () => {
  it("renders net flow 30D row for tracked coins", () => {
    const html = renderToStaticMarkup(
      <ComparisonTable coins={[baseCoin, coin2]} pegRates={{}} logos={{}} />
    );
    expect(html).toContain("Net Flow 30D");
    expect(html).toContain("+$1.24B");
    expect(html).toContain("$340M");
  });

  it("renders em-dash for untracked coins", () => {
    const html = renderToStaticMarkup(
      <ComparisonTable coins={[baseCoin, coinNoFlow]} pegRates={{}} logos={{}} />
    );
    expect(html).toContain("Net Flow 30D");
    // null → "—"
    expect(html).toContain("—");
  });

  it("applies best-value class to the highest net flow", () => {
    const html = renderToStaticMarkup(
      <ComparisonTable coins={[baseCoin, coin2]} pegRates={{}} logos={{}} />
    );
    // USDT has higher net flow (+$1.24B > -$340M), should get best-class
    // Best class contains "font-semibold"
    const rows = html.split("Net Flow 30D");
    expect(rows[1]).toMatch(/font-semibold/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --reporter=verbose comparison-table
```

Expected: FAIL — `ComparisonTable` does not have a `netFlow30d` prop or "Net Flow 30D" row.

- [ ] **Step 3: Update `ComparisonCoin` interface and add the row**

In `src/components/comparison-table.tsx`:

**3a.** Add `netFlow30d: number | null` to the `ComparisonCoin` interface:

```ts
interface ComparisonCoin {
  id: string;
  symbol: string;
  name: string;
  data: StablecoinData;
  meta: StablecoinMeta;
  pegScore: number | null;
  liquidityScore: number | null;
  safetyGrade: ReportCardGrade | null;
  netFlow30d: number | null;           // ← add this
}
```

**3b.** Extend the existing `@shared/lib/format` import to add `getNetColor` and `getNetPrefix` (these are not yet imported in `comparison-table.tsx`):

```ts
import { formatCurrency, formatNativePrice, formatScore, getNetColor, getNetPrefix } from "@shared/lib/format";
```

**3c.** In `rowData` useMemo, add:

```ts
const netFlow30dValues = coins.map((c) => c.netFlow30d);
const bestNetFlow30d = bestHighestIndex(netFlow30dValues);
```

And include them in the return object:

```ts
return {
  // ... existing fields ...
  netFlow30dValues,
  bestNetFlow30d,
};
```

**3d.** In the desktop `<TableBody>`, add a new `<TableRow>` after the Safety Rating row:

```tsx
{/* Net Flow 30D */}
<TableRow>
  <TableCell className="font-medium">Net Flow 30D</TableCell>
  {coins.map((coin, i) => {
    const val = rowData.netFlow30dValues[i];
    return (
      <TableCell
        key={coin.id}
        className={`text-center font-mono tabular-nums ${i === rowData.bestNetFlow30d ? BEST_CLASS : val != null ? getNetColor(val) : ""}`}
      >
        {val != null
          ? `${getNetPrefix(val)}${formatCurrency(val)}`
          : "—"}
      </TableCell>
    );
  })}
</TableRow>
```

**3e.** In the mobile stacked cards section, add after the Safety Rating `<dd>`:

```tsx
<dt className="text-muted-foreground">Net Flow 30D</dt>
<dd className={`text-right font-mono tabular-nums ${i === rowData.bestNetFlow30d ? BEST_CLASS : rowData.netFlow30dValues[i] != null ? getNetColor(rowData.netFlow30dValues[i]!) : ""}`}>
  {rowData.netFlow30dValues[i] != null
    ? `${getNetPrefix(rowData.netFlow30dValues[i]!)}${formatCurrency(rowData.netFlow30dValues[i]!)}`
    : "—"}
</dd>
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
npm test -- --reporter=verbose comparison-table
```

Expected: 3 passing tests.

- [ ] **Step 5: Type-check**

```bash
npm run build 2>&1 | head -30
```

Expected: no type errors in `comparison-table.tsx`.

- [ ] **Step 6: Commit**

```bash
git add src/components/comparison-table.tsx src/components/__tests__/comparison-table.test.tsx
git commit -m "feat(compare): add Net Flow 30D row to comparison table"
```

---

### Task 2: Pass flow data from CompareClient into ComparisonTable

The compare client needs to fetch `useMintBurnFlows()` and pass `netFlow30d` per coin into `ComparisonTable`.

- [ ] **Step 1: Add the hook and enrich `comparisonCoins` in `client.tsx`**

In `src/app/compare/client.tsx`:

**1a.** Add import at top:

```ts
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
```

**1b.** In the "Global data hooks" block (around line 184), add:

```ts
const { data: flowData } = useMintBurnFlows();
```

> **Why default `hours=24`?** `useMintBurnFlows()` with the default `hours=24` parameter is all that's needed. The `netFlow30dUsd` field on each coin entry is a **pre-computed rolling 30-day aggregate** stored by the cron — it is present on every coin record regardless of the `hours` parameter. No separate `useMintBurnFlows(720)` call is needed for the table row.

**1c.** In `comparisonCoins` useMemo, add `netFlow30d` to each enriched coin:

```ts
const flowCoin = flowData?.coins.find((c) => c.stablecoinId === id);
return {
  id,
  symbol: data.symbol,
  name: data.name,
  data,
  meta,
  pegScore: pegCoin?.pegScore ?? null,
  liquidityScore: dexCoin?.liquidityScore ?? null,
  safetyGrade: cardMap.get(id)?.overallGrade ?? null,
  netFlow30d: flowCoin?.netFlow30dUsd ?? null,   // ← add this
};
```

- [ ] **Step 2: Type-check**

```bash
npm run build 2>&1 | head -30
```

Expected: no errors. TypeScript will confirm `netFlow30d` now satisfies the updated `ComparisonCoin` interface.

- [ ] **Step 3: Commit**

```bash
git add src/app/compare/client.tsx
git commit -m "feat(compare): wire Net Flow 30D data from useMintBurnFlows into comparison table"
```

---

## Chunk 2: CoinFlowCard component

**Files:**
- Create: `src/components/coin-flow-card.tsx`
- Create: `src/components/__tests__/coin-flow-card.test.tsx`

### Task 3: CoinFlowCard — per-coin flow summary card

This is a pure presentational component. It receives pre-resolved data (no hooks inside). The `CompareClient` will resolve the data from `useMintBurnFlows()` and pass it down.

**Props interface:**

```ts
interface CoinFlowCardProps {
  symbol: string;
  color: string;                              // COMPARE_COLORS[i]
  netFlow24hUsd: number;
  pressureShiftScore: number | null;
  netFlowDirection24h: NetFlowDirection24h;
  pressureShiftState: PressureShiftState;
}
```

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/coin-flow-card.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CoinFlowCard } from "@/components/coin-flow-card";

const mintingProps = {
  symbol: "USDT",
  color: "#3b82f6",
  netFlow24hUsd: 1_240_000_000,
  pressureShiftScore: 58,
  netFlowDirection24h: "minting" as const,
  pressureShiftState: "improving" as const,
};

const burningProps = {
  symbol: "USDC",
  color: "#ef4444",
  netFlow24hUsd: -340_000_000,
  pressureShiftScore: -28,
  netFlowDirection24h: "burning" as const,
  pressureShiftState: "worsening" as const,
};

const nrProps = {
  symbol: "USDS",
  color: "#10b981",
  netFlow24hUsd: 0,
  pressureShiftScore: null,
  netFlowDirection24h: "inactive" as const,
  pressureShiftState: "nr" as const,
};

describe("CoinFlowCard", () => {
  it("renders symbol", () => {
    const html = renderToStaticMarkup(<CoinFlowCard {...mintingProps} />);
    expect(html).toContain("USDT");
  });

  it("renders formatted net 24h flow", () => {
    const html = renderToStaticMarkup(<CoinFlowCard {...mintingProps} />);
    expect(html).toContain("+$1.24B");
  });

  it("renders NR when pressureShiftScore is null", () => {
    const html = renderToStaticMarkup(<CoinFlowCard {...nrProps} />);
    expect(html).toContain("NR");
  });

  it("renders pressure shift score for burning coin", () => {
    const html = renderToStaticMarkup(<CoinFlowCard {...burningProps} />);
    // score is -28, displayed as "-28"
    expect(html).toContain("-28");
  });

  it("renders a pressure bar track element", () => {
    const html = renderToStaticMarkup(<CoinFlowCard {...mintingProps} />);
    // The pressure bar container should be present
    expect(html).toContain("pressure-track");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --reporter=verbose coin-flow-card
```

Expected: FAIL — module `@/components/coin-flow-card` not found.

- [ ] **Step 3: Create `src/components/coin-flow-card.tsx`**

```tsx
"use client";

import { cn } from "@/lib/utils";
import { formatCurrency, getNetColor, getNetPrefix } from "@shared/lib/format";
import { getPressureShiftDisplay } from "@/lib/flow-intensity";
import { getFlowDirectionUi, getFlowPressureUi } from "@/lib/flow-signal-ui";
import type { NetFlowDirection24h, PressureShiftState } from "@shared/lib/mint-burn-signals";

export interface CoinFlowCardProps {
  symbol: string;
  color: string;
  netFlow24hUsd: number;
  pressureShiftScore: number | null;
  netFlowDirection24h: NetFlowDirection24h;
  pressureShiftState: PressureShiftState;
}

export function CoinFlowCard({
  symbol,
  color,
  netFlow24hUsd,
  pressureShiftScore,
  netFlowDirection24h,
  pressureShiftState,
}: CoinFlowCardProps) {
  const directionUi = getFlowDirectionUi(netFlowDirection24h, "summary");
  const pressureUi = getFlowPressureUi(pressureShiftState, "summary");
  const pressureDisplay = pressureShiftScore != null
    ? getPressureShiftDisplay(pressureShiftScore)
    : null;

  // Map -100..+100 to 0..100% fill, centered at 50%
  const barFillPct = pressureShiftScore != null
    ? Math.round(((pressureShiftScore + 100) / 200) * 100)
    : 50;

  return (
    <div className="rounded-xl border border-border/60 bg-background/35 p-3 space-y-2">
      {/* Coin identifier */}
      <div className="flex items-center gap-2">
        <span
          className="h-2.5 w-2.5 rounded-full shrink-0"
          style={{ backgroundColor: color }}
          aria-hidden
        />
        <span className="text-sm font-semibold">{symbol}</span>
      </div>

      {/* Net 24h */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Net 24h</span>
        <span className={cn("text-xs font-mono tabular-nums font-semibold", directionUi.valueClass)}>
          {netFlowDirection24h === "inactive"
            ? "—"
            : `${getNetPrefix(netFlow24hUsd)}${formatCurrency(netFlow24hUsd)}`}
        </span>
      </div>

      {/* Pressure vs 30D */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">vs 30D</span>
        <span className={cn(
          "inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold",
          pressureUi.badgeClass,
        )}>
          {pressureDisplay != null
            ? `${getNetPrefix(pressureDisplay)}${pressureDisplay}`
            : "NR"}
        </span>
      </div>

      {/* Pressure bar */}
      <div className="pressure-track h-1 w-full rounded-full bg-border/40">
        <div
          className={cn("h-1 rounded-full transition-all", pressureUi.valueClass.replace("text-", "bg-")
            // fallback for muted
            .replace("bg-muted-foreground", "bg-muted"))}
          style={{ width: `${barFillPct}%` }}
        />
      </div>
    </div>
  );
}
```

> **Note on bar color:** The `valueClass` is a Tailwind text-color class. We can't dynamically swap `text-` for `bg-` in Tailwind (purge won't find it). Instead, use a static color map:

Replace the `<div className={cn(...)}` for the bar fill with:

```tsx
const PRESSURE_BAR_COLOR: Record<PressureShiftState, string> = {
  improving: "bg-emerald-500",
  stable: "bg-border",
  worsening: "bg-red-500",
  nr: "bg-muted",
};

// Then in JSX:
<div
  className={cn("h-1 rounded-full transition-all", PRESSURE_BAR_COLOR[pressureShiftState])}
  style={{ width: `${barFillPct}%` }}
/>
```

The full final file after this fix:

```tsx
"use client";

import { cn } from "@/lib/utils";
import { formatCurrency, getNetColor, getNetPrefix } from "@shared/lib/format";
import { getPressureShiftDisplay } from "@/lib/flow-intensity";
import { getFlowDirectionUi, getFlowPressureUi } from "@/lib/flow-signal-ui";
import type { NetFlowDirection24h, PressureShiftState } from "@shared/lib/mint-burn-signals";

const PRESSURE_BAR_COLOR: Record<PressureShiftState, string> = {
  improving: "bg-emerald-500",
  stable: "bg-border",
  worsening: "bg-red-500",
  nr: "bg-muted",
};

export interface CoinFlowCardProps {
  symbol: string;
  color: string;
  netFlow24hUsd: number;
  pressureShiftScore: number | null;
  netFlowDirection24h: NetFlowDirection24h;
  pressureShiftState: PressureShiftState;
}

export function CoinFlowCard({
  symbol,
  color,
  netFlow24hUsd,
  pressureShiftScore,
  netFlowDirection24h,
  pressureShiftState,
}: CoinFlowCardProps) {
  const directionUi = getFlowDirectionUi(netFlowDirection24h, "summary");
  const pressureUi = getFlowPressureUi(pressureShiftState, "summary");
  const pressureDisplay = pressureShiftScore != null
    ? getPressureShiftDisplay(pressureShiftScore)
    : null;

  const barFillPct = pressureShiftScore != null
    ? Math.round(((pressureShiftScore + 100) / 200) * 100)
    : 50;

  return (
    <div className="rounded-xl border border-border/60 bg-background/35 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span
          className="h-2.5 w-2.5 rounded-full shrink-0"
          style={{ backgroundColor: color }}
          aria-hidden
        />
        <span className="text-sm font-semibold">{symbol}</span>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Net 24h</span>
        <span className={cn("text-xs font-mono tabular-nums font-semibold", directionUi.valueClass)}>
          {netFlowDirection24h === "inactive"
            ? "—"
            : `${getNetPrefix(netFlow24hUsd)}${formatCurrency(netFlow24hUsd)}`}
        </span>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">vs 30D</span>
        <span className={cn(
          "inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold",
          pressureUi.badgeClass,
        )}>
          {pressureDisplay != null
            ? `${getNetPrefix(pressureDisplay)}${pressureDisplay}`
            : "NR"}
        </span>
      </div>

      <div className="pressure-track h-1 w-full rounded-full bg-border/40">
        <div
          className={cn("h-1 rounded-full transition-all", PRESSURE_BAR_COLOR[pressureShiftState])}
          style={{ width: `${barFillPct}%` }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
npm test -- --reporter=verbose coin-flow-card
```

Expected: 5 passing tests.

- [ ] **Step 5: Type-check**

```bash
npm run build 2>&1 | head -30
```

Expected: no errors in `coin-flow-card.tsx`.

- [ ] **Step 6: Commit**

```bash
git add src/components/coin-flow-card.tsx src/components/__tests__/coin-flow-card.test.tsx
git commit -m "feat(compare): add CoinFlowCard component for per-coin flow summary"
```

---

## Chunk 3: FlowComparisonChart component

**Files:**
- Create: `src/components/flow-comparison-chart.tsx`

### Task 4: FlowComparisonChart — net flow lines chart

Follows the exact same pattern as `src/components/comparison-chart.tsx`. One colored `<Line>` per coin, a `ReferenceLine` at y=0, a time range selector. Data comes from `useMintBurnFlowsCoin` per coin (passed in as pre-merged series, same shape as ComparisonChart).

No unit test needed here — it's a Recharts rendering wrapper with no extractable pure logic. Integration is verified by the build + manual smoke test.

- [ ] **Step 1: Create `src/components/flow-comparison-chart.tsx`**

```tsx
"use client";

import {
  LineChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatChartDate } from "@shared/lib/format";
import { MonoYAxis, TimeXAxis } from "@/components/chart-primitives";

export interface FlowSeries {
  id: string;
  label: string;
  color: string;
  data: { ts: number; netFlowUsd: number }[];
}

interface FlowComparisonChartProps {
  series: FlowSeries[];
  hours: number;
  onHoursChange: (hours: number) => void;
}

const HOUR_OPTIONS = [
  { label: "24h", value: 24 },
  { label: "7d", value: 168 },
  { label: "30d", value: 720 },
] as const;

export function FlowComparisonChart({ series, hours, onHoursChange }: FlowComparisonChartProps) {
  // Merge all series into flat array keyed by timestamp
  const mergedData: Record<string, number>[] = (() => {
    const tsMap = new Map<number, Record<string, number>>();
    for (const s of series) {
      for (const d of s.data) {
        let entry = tsMap.get(d.ts);
        if (!entry) {
          entry = { ts: d.ts };
          tsMap.set(d.ts, entry);
        }
        entry[s.id] = d.netFlowUsd;
      }
    }
    return Array.from(tsMap.values()).sort((a, b) => a.ts - b.ts);
  })();

  if (mergedData.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm font-semibold">Net Flow Over Time</CardTitle>
          <div className="flex gap-1">
            {HOUR_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => onHoursChange(opt.value)}
                className={`rounded px-2 py-0.5 text-xs transition-colors ${
                  hours === opt.value
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={mergedData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <TimeXAxis dataKey="ts" />
            <MonoYAxis tickFormatter={(v: number) => v >= 1e9 ? `$${(v/1e9).toFixed(1)}B` : `$${(v/1e6).toFixed(0)}M`} />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeDasharray="4 4" />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                return (
                  <div className="rounded-lg border border-border/60 bg-card px-3 py-2 text-xs shadow-md space-y-1">
                    <p className="text-muted-foreground">{formatChartDate(label)}</p>
                    {payload.map((p) => (
                      <div key={p.dataKey as string} className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
                        <span className="text-muted-foreground">{p.name}:</span>
                        <span className="font-mono font-semibold" style={{ color: p.color }}>
                          {p.value != null
                            ? `${(p.value as number) >= 0 ? "+" : ""}${formatCurrency(p.value as number)}`
                            : "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              }}
            />
            {series.map((s) => (
              <Line
                key={s.id}
                type="monotone"
                dataKey={s.id}
                name={s.label}
                stroke={s.color}
                strokeWidth={1.5}
                dot={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>

        {/* Legend */}
        <div className="mt-2 flex flex-wrap gap-3">
          {series.map((s) => (
            <div key={s.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.label}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
```

> **Note:** `MonoYAxis` and `TimeXAxis` come from `@/components/chart-primitives` — the same import used by `comparison-chart.tsx`.

- [ ] **Step 2: Type-check**

```bash
npm run build 2>&1 | head -30
```

Expected: no errors in `flow-comparison-chart.tsx`.

- [ ] **Step 3: Commit**

```bash
git add src/components/flow-comparison-chart.tsx
git commit -m "feat(compare): add FlowComparisonChart component for net flow lines"
```

---

## Chunk 4: CompareClient — Live Flow Signals section

**Files:**
- Modify: `src/app/compare/client.tsx`

### Task 5: Wire Live Signals section into CompareClient

This task adds `useQueries` for per-coin flow data, builds the flow card data, and renders the "Live Flow Signals" section between the comparison table and the charts grid.

- [ ] **Step 1: Add per-coin flow queries and derived data**

In `src/app/compare/client.tsx`:

**1a.** Add imports at top:

```ts
import { useMintBurnFlowsCoin } from "@/hooks/use-mint-burn-flows";
import { CoinFlowCard } from "@/components/coin-flow-card";
```

Add dynamic imports for the new chart (alongside existing `ComparisonChart` dynamic import):

```ts
const FlowComparisonChart = dynamic(
  () => import("@/components/flow-comparison-chart").then((m) => ({ default: m.FlowComparisonChart })),
  { loading: () => <ChartSkeleton className="h-[280px] rounded-xl" /> },
);
```

**1b.** Add flow hours state (near existing `range` state):

```ts
const [flowHours, setFlowHours] = useState<24 | 168 | 720>(24);
```

**1c.** Add the Zod schema and per-coin flow queries (after the existing `detailQueries` block):

> **Why `apiFetch` directly instead of `useMintBurnFlowsCoin`?** `useQueries` maps over `selectedIds` in a callback — hooks cannot be called inside callbacks. Direct `apiFetch` is the correct pattern here, identical to how `detailQueries` works elsewhere in this file.

First, add `import { z } from "zod"` to imports. Then add:

```ts
const mintBurnPerCoinSchema = z.object({
  hourly: z.array(z.object({
    hourTs: z.number(),
    netFlowUsd: z.number(),
  })).default([]),
});
type MintBurnPerCoinResponse = z.infer<typeof mintBurnPerCoinSchema>;

const flowCoinQueries = useQueries({
  queries: selectedIds.map((id) => ({
    queryKey: ["mint-burn-flows", id, flowHours],
    queryFn: async () => {
      const raw = await apiFetch(`/api/mint-burn-flows?stablecoin=${encodeURIComponent(id)}&hours=${flowHours}`);
      return mintBurnPerCoinSchema.parse(raw);
    },
    staleTime: CRON_20MIN,
    enabled: !!id,
  })),
});
```

Also add `CRON_20MIN` to the `@/hooks/use-api-query` import line.

**1d.** Build flow series for the chart (alongside existing `supplySeries` useMemo):

```ts
const flowSeries = useMemo(() => {
  return selectedIds
    .map((id, i) => {
      const detail = flowCoinQueries[i]?.data;
      if (!detail?.hourly?.length) return null;
      const meta = TRACKED_META_BY_ID.get(id);
      return {
        id,
        label: meta?.symbol ?? id,
        color: COMPARE_COLORS[i % COMPARE_COLORS.length],
        data: detail.hourly.map((h) => ({ ts: h.hourTs * 1000, netFlowUsd: h.netFlowUsd })),
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);
}, [selectedIds, flowCoinQueries]);
```

**1e.** Build per-coin flow card data (alongside flow series useMemo):

```ts
const flowCardData = useMemo(() => {
  if (!flowData?.coins) return [];
  return selectedIds
    .map((id, i) => {
      const coin = flowData.coins.find((c) => c.stablecoinId === id);
      if (!coin) return null;
      const meta = TRACKED_META_BY_ID.get(id);
      // netFlowDirection24h and pressureShiftState are always set by normalizeMintBurnFlowsResponse
      // in useMintBurnFlows() — no fallback computation needed.
      return {
        id,
        symbol: meta?.symbol ?? coin.symbol,
        color: COMPARE_COLORS[i % COMPARE_COLORS.length],
        netFlow24hUsd: coin.netFlow24hUsd,
        pressureShiftScore: coin.pressureShiftScore ?? null,
        netFlowDirection24h: coin.netFlowDirection24h,
        pressureShiftState: coin.pressureShiftState,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
}, [selectedIds, flowData]);
```

- [ ] **Step 2: Render the Live Flow Signals section**

In the JSX of `CompareClient`, find the block:

```tsx
{selectedIds.length >= 2 && (
  <div className="space-y-6 animate-in fade-in duration-300">
    <ComparisonTable ... />
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
      ...
    </div>
  </div>
)}
```

Insert the Live Flow Signals section **between** `<ComparisonTable>` and the charts grid `<div>`:

```tsx
{/* Live Flow Signals */}
{(flowCardData.length > 0 || flowSeries.length > 0) && (
  <div className="rounded-2xl border border-border/60 bg-card/50 p-4 space-y-4">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
        Live Flow Signals
      </h3>
      {flowData?.updatedAt && (
        <span className="text-xs text-muted-foreground">
          Updated {Math.round((Date.now() / 1000 - flowData.updatedAt) / 60)} min ago · Ethereum
        </span>
      )}
    </div>

    {/* Per-coin flow cards */}
    {flowCardData.length > 0 && (
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${Math.min(flowCardData.length, 5)}, minmax(0, 1fr))` }}
      >
        {flowCardData.map((card) => (
          <CoinFlowCard key={card.id} {...card} />
        ))}
      </div>
    )}

    {/* Net flow chart */}
    {flowSeries.length >= 2 && (
      <FlowComparisonChart
        series={flowSeries}
        hours={flowHours}
        onHoursChange={(h) => setFlowHours(h as 24 | 168 | 720)}
      />
    )}

    {/* Coverage note */}
    {selectedIds.length > flowCardData.length && (
      <p className="text-xs text-muted-foreground">
        {flowCardData.length} of {selectedIds.length} selected coins have Ethereum flow tracking.
      </p>
    )}
  </div>
)}
```

> **Note on dynamic grid columns:** Tailwind purges dynamic class strings. The inline `style` approach here is intentional and correct — CLAUDE.md explicitly notes "Tailwind classes must be static strings". The `style` attribute bypasses the purge issue for the column count.

- [ ] **Step 3: Type-check and build**

```bash
npm run build 2>&1 | head -50
```

Expected: no errors. Fix any TypeScript issues (likely missing import for `MintBurnPerCoinResponse`).

- [ ] **Step 4: Check for CRON_20MIN import**

```bash
grep -n "CRON_20MIN" src/app/compare/client.tsx
```

If missing, add to the `use-api-query` import line:

```ts
import { CRON_1H, CRON_20MIN } from "@/hooks/use-api-query";
```

- [ ] **Step 5: Run all tests**

```bash
npm test
```

Expected: all tests pass. No regressions.

- [ ] **Step 6: Commit**

```bash
git add src/app/compare/client.tsx
git commit -m "feat(compare): add Live Flow Signals section with per-coin cards and net flow chart"
```

---

## Chunk 5: Peg Deviation chart (conditional)

**Files:**
- Modify: `src/hooks/use-stablecoins.ts` (if price derivable)
- Create: `src/components/peg-deviation-chart.tsx` (if price derivable)
- Modify: `src/app/compare/client.tsx` (add chart to grid)

### Task 6: Investigate and implement peg deviation history

- [ ] **Step 1: Check if price is derivable from detail tokens**

In `src/hooks/use-stablecoins.ts`, `detailToSupplyHistory` currently sets `price: null`. Investigate whether `totalCirculatingUSD / totalCirculating` gives a usable price:

```bash
# Fetch a coin detail to inspect the token shape
curl -s "https://api.pharos.watch/api/stablecoin/usdt-tether" | jq '.tokens[0]'
```

Look for both `totalCirculatingUSD` and `totalCirculating` keys. If both are non-null objects with matching peg-type keys, price = `totalCirculatingUSD.peggedUSD / totalCirculating.peggedUSD`.

- [ ] **Step 2a (if price IS derivable): Update `detailToSupplyHistory`**

In `src/hooks/use-stablecoins.ts`, update the map function:

```ts
.map((t) => {
  const usdCirculating = sumCirculating(t.totalCirculatingUSD) || sumCirculating(t.circulating);
  const nativeCirculating = sumCirculating(t.totalCirculating);
  const price = usdCirculating > 0 && nativeCirculating > 0
    ? usdCirculating / nativeCirculating
    : null;
  return { date: t.date, circulatingUsd: usdCirculating, price };
})
```

- [ ] **Step 2b (if price is NOT derivable): Skip this chunk**

Note in a comment in `agents/plans/2026-03-10-compare-enhancements-plan.md` that the peg deviation chart is deferred. No placeholder UI needed.

- [ ] **Step 3 (if proceeding): Create `src/components/peg-deviation-chart.tsx`**

```tsx
"use client";

import {
  LineChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MonoYAxis, TimeXAxis } from "@/components/chart-primitives";
import { formatChartDate } from "@shared/lib/format";

export interface PegDeviationSeries {
  id: string;
  label: string;
  color: string;
  data: { ts: number; deviation: number }[];
}

interface PegDeviationChartProps {
  series: PegDeviationSeries[];
}

export function PegDeviationChart({ series }: PegDeviationChartProps) {
  const mergedData: Record<string, number>[] = (() => {
    const tsMap = new Map<number, Record<string, number>>();
    for (const s of series) {
      for (const d of s.data) {
        let entry = tsMap.get(d.ts);
        if (!entry) {
          entry = { ts: d.ts };
          tsMap.set(d.ts, entry);
        }
        entry[s.id] = d.deviation;
      }
    }
    return Array.from(tsMap.values()).sort((a, b) => a.ts - b.ts);
  })();

  if (mergedData.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Peg Deviation History</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={mergedData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <TimeXAxis dataKey="ts" />
            <MonoYAxis
              domain={[-5, 5]}
              tickFormatter={(v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`}
            />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeDasharray="4 4" />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                return (
                  <div className="rounded-lg border border-border/60 bg-card px-3 py-2 text-xs shadow-md space-y-1">
                    <p className="text-muted-foreground">{formatChartDate(label)}</p>
                    {payload.map((p) => (
                      <div key={p.dataKey as string} className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
                        <span className="text-muted-foreground">{p.name}:</span>
                        <span className="font-mono font-semibold" style={{ color: p.color }}>
                          {p.value != null
                            ? `${(p.value as number) >= 0 ? "+" : ""}${(p.value as number).toFixed(3)}%`
                            : "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              }}
            />
            {series.map((s) => (
              <Line
                key={s.id}
                type="monotone"
                dataKey={s.id}
                name={s.label}
                stroke={s.color}
                strokeWidth={1.5}
                dot={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
        <div className="mt-2 flex flex-wrap gap-3">
          {series.map((s) => (
            <div key={s.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.label}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
```

In `CompareClient`, derive `pegDeviationSeries` from the existing `detailQueries` data — add `price` to `SupplyHistoryPoint` in `detailToSupplyHistory`, then map: `deviation = ((price / pegRef) - 1) * 100` using `getPegReference` from `@shared/lib/peg-rates`.

- [ ] **Step 4 (if proceeding): Add chart to compare client**

Add `PegDeviationChart` to the charts grid in `CompareClient`, placed below the supply + radar pair and spanning both columns using `lg:col-span-2`:

```tsx
<div className="lg:col-span-2">
  <PegDeviationChart series={pegDeviationSeries} />
</div>
```

- [ ] **Step 5 (if proceeding): Build and commit**

```bash
npm run build 2>&1 | head -30
git add src/hooks/use-stablecoins.ts src/components/peg-deviation-chart.tsx src/app/compare/client.tsx
git commit -m "feat(compare): add peg deviation history chart"
```

---

## Final verification

- [ ] **Full build + type-check**

```bash
npm run build && cd worker && npx tsc --noEmit
```

Expected: clean build, no worker type errors (we didn't touch the worker).

- [ ] **Run all tests**

```bash
npm test
```

Expected: all existing tests pass, new tests for `comparison-table` and `coin-flow-card` pass.

- [ ] **Smoke test on dev server**

```bash
npm run dev
```

Open `http://localhost:3000/compare?coins=usdt-tether,usdc-circle,usds-sky`.

Check:
1. "Net Flow 30D" row visible in comparison table with colored values
2. "Live Flow Signals" section appears between table and charts
3. Per-coin flow cards show direction + pressure badge
4. Net Flow Over Time chart renders with colored lines and zero reference line
5. 24h / 7d / 30d buttons change the chart time window
6. Coverage note appears if any selected coin has no flow data

- [ ] **Final commit + push**

```bash
git push
```
